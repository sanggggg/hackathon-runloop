import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentNodeRequest,
  AgentNodeResult,
  ContainerRef,
  ContainerRuntime,
  RuntimeContext,
  SnapshotRef,
} from "./types.js";
import type { ScreenshotArtifactStore } from "./artifact-store.js";
import { RunloopClient } from "./runloop-client.js";

export interface RunloopRuntimeTimeouts {
  createMs: number;
  prepareMs: number;
  startMs: number;
  healthMs: number;
  agentMs: number;
  snapshotMs: number;
  shutdownMs: number;
  deleteSnapshotMs: number;
}

export interface RunloopRuntimeOptions {
  client: RunloopClient;
  /** Absolute path below /home/user, or a path relative to /home/user. */
  workDir?: string;
  /**
   * Trusted shell program used to run one browser-agent step. The runtime sets
   * BRANCHPOINT_REQUEST_PATH and BRANCHPOINT_RESULT_PATH to absolute paths.
   */
  agentCommand: string;
  /** UTF-8 files injected once into the root box; relative paths use workDir. */
  bootstrapFiles?: Readonly<Record<string, string>>;
  /** Non-sensitive variables applied again to every root/fork devbox. */
  environmentVariables?: Readonly<Record<string, string>>;
  /** Devbox env name -> existing Runloop Secret name. Values are never raw secrets. */
  secrets?: Readonly<Record<string, string>>;
  /** Receives every final PNG before its devbox is shut down. */
  artifactStore: ScreenshotArtifactStore;
  /** HTTP path checked on 127.0.0.1 after repo.startCmd is launched. */
  healthPath?: string;
  timeouts?: Partial<RunloopRuntimeTimeouts>;
  /** Applied to forward work. Cleanup deliberately gets its own timeout. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUTS: RunloopRuntimeTimeouts = {
  createMs: 180_000,
  prepareMs: 600_000,
  startMs: 60_000,
  healthMs: 60_000,
  agentMs: 300_000,
  snapshotMs: 300_000,
  shutdownMs: 60_000,
  deleteSnapshotMs: 60_000,
};

const HOME = "/home/user";
const REQUEST_DIRECTORY = ".branchpoint/requests";
const RESULT_DIRECTORY = ".branchpoint/results";
const CHECKPOINT_FILE = ".branchpoint/browser-checkpoint.json";
const SCREENSHOT_DIRECTORY = ".branchpoint/screenshots";

function quoteShell(value: string): string {
  if (value.includes("\0")) throw new Error("shell value must not contain NUL");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeWorkDir(value: string | undefined): string {
  const requested = value ?? `${HOME}/workspace`;
  const absolute = path.posix.isAbsolute(requested)
    ? path.posix.normalize(requested)
    : path.posix.resolve(HOME, requested);
  if (absolute !== HOME && !absolute.startsWith(`${HOME}/`)) {
    throw new Error(`workDir must be inside ${HOME}: '${requested}'`);
  }
  return absolute;
}

function homeRelative(absolutePath: string): string {
  const normalized = path.posix.normalize(absolutePath);
  if (normalized === HOME) throw new Error("A file path below /home/user is required");
  if (!normalized.startsWith(`${HOME}/`)) {
    throw new Error(`Runloop file path must be below ${HOME}: '${absolutePath}'`);
  }
  return normalized.slice(HOME.length + 1);
}

function positiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function validateEnvironmentMap(
  name: string,
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${name} has invalid environment variable name '${key}'`);
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new Error(`${name}.${key} must be a string without NUL`);
    }
    result[key] = entry;
  }
  return result;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

function safeName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized || "branchpoint";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAgentResult(
  contents: string,
  resultPath: string,
  request: AgentNodeRequest,
): AgentNodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Browser agent wrote invalid JSON to '${resultPath}'`, { cause: error });
  }
  if (!isRecord(parsed) || (parsed.status !== "pass" && parsed.status !== "fail")) {
    throw new Error(`Browser agent result '${resultPath}' must be an object with status 'pass' or 'fail'`);
  }
  if (parsed.failReason !== undefined && !["unresolved", "error-screen", "timeout"].includes(String(parsed.failReason))) {
    throw new Error(`Browser agent result '${resultPath}' has invalid failReason '${String(parsed.failReason)}'`);
  }
  if (parsed.note !== undefined && !["ui-changed", "new-path"].includes(String(parsed.note))) {
    throw new Error(`Browser agent result '${resultPath}' has invalid note '${String(parsed.note)}'`);
  }
  if (
    parsed.elapsedMs !== undefined &&
    (typeof parsed.elapsedMs !== "number" || !Number.isFinite(parsed.elapsedMs) || parsed.elapsedMs < 0)
  ) {
    throw new Error(`Browser agent result '${resultPath}' has invalid elapsedMs`);
  }
  if (
    parsed.costUsd !== undefined &&
    (typeof parsed.costUsd !== "number" || !Number.isFinite(parsed.costUsd) || parsed.costUsd < 0)
  ) {
    throw new Error(`Browser agent result '${resultPath}' has invalid costUsd`);
  }
  if (
    parsed.modelCalls !== undefined &&
    (typeof parsed.modelCalls !== "number" ||
      !Number.isInteger(parsed.modelCalls) ||
      parsed.modelCalls < 0)
  ) {
    throw new Error(`Browser agent result '${resultPath}' has invalid modelCalls`);
  }
  if (parsed.log !== undefined && !Array.isArray(parsed.log)) {
    throw new Error(`Browser agent result '${resultPath}' has invalid log`);
  }
  if (parsed.discovered !== undefined && !Array.isArray(parsed.discovered)) {
    throw new Error(`Browser agent result '${resultPath}' has invalid discovered nodes`);
  }
  if (
    typeof parsed.screenshotId !== "string" ||
    !parsed.screenshotId.trim() ||
    parsed.screenshotId.includes("\0")
  ) {
    throw new Error(`Browser agent result '${resultPath}' must include a screenshot path`);
  }
  if (parsed.checkpoint !== undefined) {
    if (
      !isRecord(parsed.checkpoint) ||
      typeof parsed.checkpoint.path !== "string" ||
      !parsed.checkpoint.path.trim() ||
      typeof parsed.checkpoint.url !== "string" ||
      !parsed.checkpoint.url.trim()
    ) {
      throw new Error(`Browser agent result '${resultPath}' has invalid checkpoint`);
    }
    if (!path.posix.isAbsolute(parsed.checkpoint.path) || parsed.checkpoint.path.includes("\0")) {
      throw new Error(`Browser agent checkpoint path must be an absolute path`);
    }
    let checkpointUrl: URL;
    try {
      checkpointUrl = new URL(parsed.checkpoint.url);
    } catch (error) {
      throw new Error(`Browser agent checkpoint URL is invalid`, { cause: error });
    }
    if (checkpointUrl.protocol !== "http:" && checkpointUrl.protocol !== "https:") {
      throw new Error(`Browser agent checkpoint URL must use http or https`);
    }
  }
  if (parsed.status === "pass" && !request.isGoal && parsed.checkpoint === undefined) {
    throw new Error(`Browser agent must persist a checkpoint after passing non-goal node '${request.node.id}'`);
  }
  return parsed as unknown as AgentNodeResult;
}

export class RunloopRuntime implements ContainerRuntime {
  readonly #client: RunloopClient;
  readonly #workDir: string;
  readonly #agentCommand: string;
  readonly #bootstrapFiles: ReadonlyArray<readonly [string, string]>;
  readonly #environmentVariables: Readonly<Record<string, string>>;
  readonly #secrets: Readonly<Record<string, string>>;
  readonly #artifactStore: ScreenshotArtifactStore;
  readonly #healthPath: string;
  readonly #timeouts: RunloopRuntimeTimeouts;
  readonly #signal?: AbortSignal;

  constructor(options: RunloopRuntimeOptions) {
    if (!options.client) throw new Error("RunloopRuntime requires a client");
    if (!options.agentCommand?.trim()) throw new Error("RunloopRuntime requires a non-empty agentCommand");
    if (options.agentCommand.includes("\0")) throw new Error("agentCommand must not contain NUL");
    if (!options.artifactStore || typeof options.artifactStore.saveScreenshot !== "function") {
      throw new Error("RunloopRuntime requires an artifactStore");
    }

    this.#client = options.client;
    this.#workDir = normalizeWorkDir(options.workDir);
    this.#agentCommand = options.agentCommand;
    this.#bootstrapFiles = Object.entries(options.bootstrapFiles ?? {});
    this.#environmentVariables = validateEnvironmentMap(
      "environmentVariables",
      options.environmentVariables,
    );
    this.#secrets = validateEnvironmentMap("secrets", options.secrets);
    this.#artifactStore = options.artifactStore;
    for (const [filePath, contents] of this.#bootstrapFiles) {
      if (!filePath || filePath.includes("\0")) throw new Error("bootstrap file paths must be non-empty");
      if (typeof contents !== "string") throw new Error(`bootstrap file '${filePath}' must contain UTF-8 text`);
      this.#resolveBootstrapPath(filePath);
    }
    this.#healthPath = options.healthPath ?? "/";
    if (!this.#healthPath.startsWith("/") || /[\0\r\n]/.test(this.#healthPath)) {
      throw new Error("healthPath must begin with '/' and contain no control characters");
    }
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#signal = options.signal;

    for (const [name, value] of Object.entries(this.#timeouts)) {
      positiveFinite(`timeouts.${name}`, value);
    }
  }

  async createFromSnapshot(snapshotId: string, context: RuntimeContext): Promise<ContainerRef> {
    const leaf = context.branchPath.at(-1) ?? context.kind;
    const signal = combineSignals(this.#signal, context.signal);
    const devbox = await this.#client.createFromSnapshot(
      snapshotId,
      {
        name: safeName(`branchpoint-${context.runId}-${leaf}`),
        ...(Object.keys(this.#environmentVariables).length > 0
          ? { environment_variables: { ...this.#environmentVariables } }
          : {}),
        ...(Object.keys(this.#secrets).length > 0
          ? { secrets: { ...this.#secrets } }
          : {}),
        metadata: {
          branchpoint_run_id: context.runId,
          branchpoint_suite_id: context.suiteId,
          branchpoint_ref: context.ref,
          branchpoint_kind: context.kind,
          branchpoint_path: JSON.stringify(context.branchPath),
        },
      },
      { timeoutMs: this.#timeouts.createMs, signal },
    );
    return { id: devbox.id };
  }

  async prepare(container: ContainerRef, context: RuntimeContext): Promise<void> {
    const signal = combineSignals(this.#signal, context.signal);
    if (context.kind === "root") {
      await this.#client.execute(container.id, this.#checkoutAndBuildCommand(context), {
        timeoutMs: this.#timeouts.prepareMs,
        signal,
        lastN: 1_000,
      });
    }

    const bootstrapPaths =
      context.kind === "root"
        ? this.#bootstrapFiles.map(([filePath]) => this.#resolveBootstrapPath(filePath))
        : [];
    const stateDirectories = [
      path.posix.join(this.#workDir, REQUEST_DIRECTORY),
      path.posix.join(this.#workDir, RESULT_DIRECTORY),
      ...bootstrapPaths.map((filePath) => path.posix.dirname(filePath)),
    ];
    await this.#client.execute(
      container.id,
      `mkdir -p -- ${stateDirectories.map(quoteShell).join(" ")}`,
      { timeoutMs: this.#timeouts.prepareMs, signal },
    );

    if (context.kind === "root") {
      for (const [filePath, contents] of this.#bootstrapFiles) {
        await this.#client.writeFile(
          container.id,
          homeRelative(this.#resolveBootstrapPath(filePath)),
          contents,
          { timeoutMs: this.#timeouts.prepareMs, signal },
        );
      }
    }

    await this.#client.start(container.id, this.#startCommand(context), {
      timeoutMs: this.#timeouts.startMs,
      signal,
    });
    await this.#client.execute(container.id, this.#healthCommand(context), {
      timeoutMs: this.#timeouts.healthMs,
      signal,
      lastN: 200,
    });
  }

  async executeNode(
    container: ContainerRef,
    request: AgentNodeRequest,
    context: RuntimeContext,
  ): Promise<AgentNodeResult> {
    const token = `${safeName(request.node.id).slice(0, 48)}-${randomUUID()}`;
    const requestPath = path.posix.join(this.#workDir, REQUEST_DIRECTORY, `${token}.json`);
    const resultPath = path.posix.join(this.#workDir, RESULT_DIRECTORY, `${token}.json`);
    const checkpointPath = path.posix.join(this.#workDir, CHECKPOINT_FILE);
    const appUrl = this.#appUrl(context);
    const signal = combineSignals(this.#signal, context.signal);

    await this.#client.execute(container.id, `rm -f -- ${quoteShell(resultPath)}`, {
      timeoutMs: this.#timeouts.agentMs,
      signal,
    });
    await this.#client.writeFile(
      container.id,
      homeRelative(requestPath),
      `${JSON.stringify(request, null, 2)}\n`,
      { timeoutMs: this.#timeouts.agentMs, signal },
    );

    const command = [
      `cd -- ${quoteShell(this.#workDir)}`,
      [
        "env",
        `BRANCHPOINT_REQUEST_PATH=${quoteShell(requestPath)}`,
        `BRANCHPOINT_RESULT_PATH=${quoteShell(resultPath)}`,
        `BRANCHPOINT_CHECKPOINT_PATH=${quoteShell(checkpointPath)}`,
        `BRANCHPOINT_APP_URL=${quoteShell(appUrl)}`,
        `BRANCHPOINT_RUN_ID=${quoteShell(context.runId)}`,
        `BRANCHPOINT_SUITE_ID=${quoteShell(context.suiteId)}`,
        `BRANCHPOINT_REF=${quoteShell(context.ref)}`,
        "bash",
        "-c",
        quoteShell(this.#agentCommand),
      ].join(" "),
    ].join(" && ");

    await this.#client.execute(container.id, command, {
      timeoutMs: this.#timeouts.agentMs,
      signal,
      lastN: 1_000,
    });
    const contents = await this.#client.readFile(container.id, homeRelative(resultPath), {
      timeoutMs: this.#timeouts.agentMs,
      signal,
    });
    const result = parseAgentResult(contents, resultPath, request);
    if (result.status === "pass" && !request.isGoal) {
      const actualPath = path.posix.normalize(result.checkpoint!.path);
      if (actualPath !== checkpointPath) {
        throw new Error(
          `Browser agent checkpoint must be written to '${checkpointPath}', got '${result.checkpoint!.path}'`,
        );
      }
    }
    const screenshotPath = path.posix.normalize(result.screenshotId!);
    const screenshotDirectory = path.posix.join(this.#workDir, SCREENSHOT_DIRECTORY);
    if (
      !path.posix.isAbsolute(screenshotPath) ||
      !screenshotPath.startsWith(`${screenshotDirectory}/`) ||
      path.posix.extname(screenshotPath).toLowerCase() !== ".png"
    ) {
      throw new Error(
        `Browser agent screenshot must be a PNG below '${screenshotDirectory}', got '${result.screenshotId}'`,
      );
    }
    const screenshot = await this.#client.downloadFile(
      container.id,
      homeRelative(screenshotPath),
      { timeoutMs: this.#timeouts.agentMs, signal },
    );
    const screenshotId = await this.#artifactStore.saveScreenshot({
      runId: context.runId,
      suiteId: context.suiteId,
      nodeId: request.node.id,
      containerId: container.id,
      contentType: "image/png",
      data: screenshot,
    });
    if (!screenshotId || screenshotId.includes("\0")) {
      throw new Error("artifactStore returned an invalid screenshot id");
    }
    return { ...result, screenshotId };
  }

  async snapshot(container: ContainerRef, context: RuntimeContext): Promise<SnapshotRef> {
    const leaf = context.branchPath.at(-1) ?? context.kind;
    const signal = combineSignals(this.#signal, context.signal);
    const snapshot = await this.#client.snapshotDisk(
      container.id,
      {
        name: safeName(`branchpoint-${context.runId}-${leaf}`),
        metadata: {
          branchpoint_run_id: context.runId,
          branchpoint_suite_id: context.suiteId,
          branchpoint_ref: context.ref,
          branchpoint_source_snapshot_id: context.sourceSnapshotId,
          branchpoint_path: JSON.stringify(context.branchPath),
        },
        commit_message: `Branchpoint checkpoint at ${context.branchPath.join(" / ") || "root"}`.slice(
          0,
          1_000,
        ),
      },
      { timeoutMs: this.#timeouts.snapshotMs, signal },
    );
    return { id: snapshot.id };
  }

  async deleteSnapshot(snapshot: SnapshotRef): Promise<void> {
    await this.#client.deleteSnapshot(snapshot.id, { timeoutMs: this.#timeouts.deleteSnapshotMs });
  }

  async shutdown(container: ContainerRef): Promise<void> {
    // Every prepared box intentionally owns a long-running startCmd execution.
    // Force shutdown is therefore the normal cleanup path, not an exceptional
    // fallback, and must not inherit the run's cancellation signal.
    await this.#client.shutdown(container.id, {
      timeoutMs: this.#timeouts.shutdownMs,
      force: true,
    });
  }

  #checkoutAndBuildCommand(context: RuntimeContext): string {
    const build = context.repo.buildCmd.trim();
    const lines = [
      "set -euo pipefail",
      `cd -- ${quoteShell(this.#workDir)}`,
      `target_ref=${quoteShell(context.ref)}`,
      'if [[ "$target_ref" =~ ^[0-9a-fA-F]{40}$ ]] && git cat-file -e "$target_ref^{commit}" 2>/dev/null; then',
      '  target_commit="$(git rev-parse --verify "$target_ref^{commit}")"',
      "else",
      '  git fetch --depth=1 origin "$target_ref"',
      '  target_commit="$(git rev-parse --verify FETCH_HEAD^{commit})"',
      "fi",
      'current_commit="$(git rev-parse --verify HEAD^{commit})"',
      'if [ "$current_commit" != "$target_commit" ]; then',
      '  git checkout --detach "$target_commit"',
      ...(build ? [`  bash -c ${quoteShell(build)}`] : []),
      "fi",
    ];
    return `bash -c ${quoteShell(lines.join("\n"))}`;
  }

  #startCommand(context: RuntimeContext): string {
    return [
      `cd -- ${quoteShell(this.#workDir)}`,
      [
        "env",
        `PORT=${quoteShell(String(context.repo.port))}`,
        "bash",
        "-c",
        quoteShell(context.repo.startCmd),
      ].join(" "),
    ].join(" && ");
  }

  #healthCommand(context: RuntimeContext): string {
    const url = `${this.#appUrl(context)}${this.#healthPath}`;
    const loopSeconds = Math.max(1, Math.floor(this.#timeouts.healthMs / 1_000) - 1);
    const curlMaxSeconds = Math.max(1, Math.min(2, loopSeconds));
    const script = [
      "set -euo pipefail",
      `deadline=$((SECONDS + ${loopSeconds}))`,
      "while true; do",
      `  if curl --fail --silent --show-error --max-time ${curlMaxSeconds} --output /dev/null ${quoteShell(url)}; then`,
      "    exit 0",
      "  fi",
      '  if [ "$SECONDS" -ge "$deadline" ]; then',
      `    echo ${quoteShell(`health check timed out: ${url}`)} >&2`,
      "    exit 1",
      "  fi",
      "  sleep 0.25",
      "done",
    ].join("\n");
    return `bash -c ${quoteShell(script)}`;
  }

  #appUrl(context: RuntimeContext): string {
    if (!Number.isInteger(context.repo.port) || context.repo.port < 1 || context.repo.port > 65_535) {
      throw new Error(`repo.port must be an integer from 1 to 65535, got ${String(context.repo.port)}`);
    }
    return `http://127.0.0.1:${context.repo.port}`;
  }

  #resolveBootstrapPath(filePath: string): string {
    const absolute = path.posix.isAbsolute(filePath)
      ? path.posix.normalize(filePath)
      : path.posix.resolve(this.#workDir, filePath);
    if (absolute === HOME || !absolute.startsWith(`${HOME}/`)) {
      throw new Error(`bootstrap file must be below ${HOME}: '${filePath}'`);
    }
    if (
      !path.posix.isAbsolute(filePath) &&
      absolute !== this.#workDir &&
      !absolute.startsWith(`${this.#workDir}/`)
    ) {
      throw new Error(`relative bootstrap file escaped workDir: '${filePath}'`);
    }
    return absolute;
  }
}
