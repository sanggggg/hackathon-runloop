import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalArtifactStore } from "./artifact-store.js";
import { BranchpointEngine } from "./engine.js";
import { RunloopClient } from "./runloop-client.js";
import { RunloopRuntime } from "./runloop-runtime.js";

export interface CreateRunloopEngineOptions {
  runloopApiKey?: string;
  /** Defaults to RUNLOOP_API_URL, then the RunloopClient production URL. */
  runloopBaseUrl?: string;
  maxConcurrency?: number;
  workDir?: string;
  agentCommand?: string;
  healthPath?: string;
  openrouterModel?: string;
  /** Existing Runloop Secret name, never the raw OpenRouter key. */
  openrouterSecret?: string;
  artifactDir?: string;
  /** Cancels forward runtime work. Resource cleanup uses independent timeouts. */
  signal?: AbortSignal;
}

export interface RunloopEngineBundle {
  engine: BranchpointEngine;
  client: RunloopClient;
  runtime: RunloopRuntime;
  artifactStore: LocalArtifactStore;
}

interface BrowserAgentAsset {
  path: string;
  source: string;
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function loadBrowserAgentAsset(moduleUrl: string | URL): Promise<BrowserAgentAsset> {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [...new Set([
    path.resolve(moduleDirectory, "../runner/browser-agent.py"),
    path.resolve(moduleDirectory, "../../runner/browser-agent.py"),
  ])];
  const missingErrors: unknown[] = [];

  for (const candidate of candidates) {
    try {
      return { path: candidate, source: await readFile(candidate, "utf8") };
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new Error(`Could not read browser agent at '${candidate}'`, { cause: error });
      }
      missingErrors.push(error);
    }
  }

  throw new Error(`Could not locate browser-agent.py; tried ${candidates.join(", ")}`, {
    cause: new AggregateError(missingErrors, "browser agent path resolution failed"),
  });
}

/**
 * Locate the bundled browser agent from either src/*.ts execution or the
 * compiled dist/src/*.js layout. The Python asset intentionally remains at the
 * package root so snapshots receive the exact same runner in both modes.
 */
export async function resolveBrowserAgentPath(
  moduleUrl: string | URL = import.meta.url,
): Promise<string> {
  return (await loadBrowserAgentAsset(moduleUrl)).path;
}

/** Build the production Runloop-backed engine used by both HTTP and CLI entrypoints. */
export async function createRunloopEngine(
  options: CreateRunloopEngineOptions = {},
): Promise<RunloopEngineBundle> {
  if (Boolean(options.openrouterModel) !== Boolean(options.openrouterSecret)) {
    throw new Error("openrouterModel and openrouterSecret must be configured together");
  }

  const runnerSource = (await loadBrowserAgentAsset(import.meta.url)).source;
  const runloopBaseUrl = options.runloopBaseUrl ?? process.env.RUNLOOP_API_URL;
  const client = new RunloopClient({
    ...(options.runloopApiKey ? { apiKey: options.runloopApiKey } : {}),
    ...(runloopBaseUrl ? { baseUrl: runloopBaseUrl } : {}),
  });
  const artifactStore = new LocalArtifactStore(
    options.artifactDir ?? ".branchpoint-artifacts",
  );
  const runtime = new RunloopRuntime({
    client,
    artifactStore,
    workDir: options.workDir ?? "/home/user/workspace",
    agentCommand: options.agentCommand ?? "python3 .branchpoint/browser-agent.py",
    healthPath: options.healthPath ?? "/",
    bootstrapFiles: {
      ".branchpoint/browser-agent.py": runnerSource,
    },
    ...(options.openrouterModel
      ? { environmentVariables: { BRANCHPOINT_OPENROUTER_MODEL: options.openrouterModel } }
      : {}),
    ...(options.openrouterSecret
      ? { secrets: { OPENROUTER_API_KEY: options.openrouterSecret } }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const engine = new BranchpointEngine({
    runtime,
    ...(options.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: options.maxConcurrency }),
  });

  return { engine, client, runtime, artifactStore };
}
