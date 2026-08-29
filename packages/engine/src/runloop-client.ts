export type RunloopFetch = typeof globalThis.fetch;

export interface RunloopClientTimeouts {
  /** Maximum time for one HTTP request. Server long-polls hold for at most 30s. */
  requestMs: number;
  createMs: number;
  executeMs: number;
  snapshotMs: number;
  shutdownMs: number;
  deleteSnapshotMs: number;
  fileMs: number;
  snapshotPollIntervalMs: number;
}

export interface RunloopClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: RunloopFetch;
  timeouts?: Partial<RunloopClientTimeouts>;
  signal?: AbortSignal;
}

export interface RunloopCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type RunloopDevboxStatus =
  | "scheduled"
  | "queued"
  | "provisioning"
  | "initializing"
  | "running"
  | "suspending"
  | "suspended"
  | "resuming"
  | "failure"
  | "shutdown";

export interface RunloopDevbox {
  id: string;
  name?: string | null;
  status: RunloopDevboxStatus;
  create_time_ms: number;
  end_time_ms: number | null;
  snapshot_id?: string | null;
  blueprint_id?: string | null;
  metadata: Record<string, string>;
  failure_reason?: string | null;
  shutdown_reason?: string | null;
  [key: string]: unknown;
}

export interface RunloopDevboxCreateParams {
  name?: string | null;
  environment_variables?: Record<string, string> | null;
  secrets?: Record<string, string> | null;
  entrypoint?: string | null;
  blueprint_id?: string | null;
  blueprint_name?: string | null;
  snapshot_id?: string | null;
  metadata?: Record<string, string> | null;
  launch_parameters?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type RunloopExecutionStatus = "queued" | "running" | "completed";

export interface RunloopExecution {
  devbox_id: string;
  execution_id: string;
  status: RunloopExecutionStatus;
  shell_name?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  exit_status?: number | null;
  stdout_truncated?: boolean | null;
  stderr_truncated?: boolean | null;
}

/** Response shape used by write_file_contents (it is not an async execution). */
export interface RunloopCommandResult {
  devbox_id: string;
  stdout: string;
  stderr: string;
  exit_status: number;
  shell_name?: string | null;
  execution_id?: string;
}

export interface RunloopExecuteOptions extends RunloopCallOptions {
  shellName?: string;
  attachStdin?: boolean;
  /** Number of trailing output lines returned by Runloop. */
  lastN?: number;
}

export interface RunloopStartOptions extends RunloopCallOptions {
  shellName?: string;
  attachStdin?: boolean;
}

export interface RunloopSnapshotParams {
  name?: string | null;
  metadata?: Record<string, string> | null;
  commit_message?: string | null;
}

export interface RunloopSnapshot {
  id: string;
  name?: string | null;
  create_time_ms: number;
  metadata: Record<string, string>;
  source_devbox_id: string;
  source_blueprint_id?: string | null;
  commit_message?: string | null;
  size_bytes?: number | null;
}

export type RunloopSnapshotStatus = "in_progress" | "error" | "complete" | "deleted";

export interface RunloopSnapshotStatusView {
  status: RunloopSnapshotStatus;
  snapshot?: RunloopSnapshot | null;
  error_message?: string | null;
}

export class RunloopApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly responseBody: string;

  constructor(method: string, path: string, status: number, responseBody: string) {
    const suffix = responseBody.trim() ? `: ${responseBody.trim().slice(0, 1_000)}` : "";
    super(`Runloop ${method} ${path} returned ${status}${suffix}`);
    this.name = "RunloopApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.responseBody = responseBody;
  }
}

export class RunloopTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number, cause?: unknown) {
    super(`Runloop operation '${operation}' timed out after ${timeoutMs}ms`, { cause });
    this.name = "RunloopTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export class RunloopCommandError extends Error {
  readonly execution: RunloopExecution | RunloopCommandResult;

  constructor(execution: RunloopExecution | RunloopCommandResult) {
    const detail = (execution.stderr || execution.stdout || "").trim().slice(0, 2_000);
    super(
      `Runloop command '${execution.execution_id ?? "file operation"}' exited with status ${String(execution.exit_status)}` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "RunloopCommandError";
    this.execution = execution;
  }
}

interface OperationContext {
  operation: string;
  deadlineMs: number;
  timeoutMs: number;
  signals: readonly AbortSignal[];
}

interface RequestOptions {
  body?: unknown;
  accept?: string;
}

class RunloopSnapshotStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunloopSnapshotStateError";
  }
}

const DEFAULT_TIMEOUTS: RunloopClientTimeouts = {
  requestMs: 60_000,
  createMs: 180_000,
  executeMs: 600_000,
  snapshotMs: 300_000,
  shutdownMs: 60_000,
  deleteSnapshotMs: 60_000,
  fileMs: 60_000,
  snapshotPollIntervalMs: 1_000,
};

function positiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function executionPath(devboxId: string, executionId: string): string {
  return `/v1/devboxes/${encodeURIComponent(devboxId)}/executions/${encodeURIComponent(executionId)}`;
}

function assertRelativeHomePath(filePath: string): void {
  let depth = 0;
  const escapesHome = filePath.split("/").some((segment) => {
    if (!segment || segment === ".") return false;
    if (segment === "..") {
      depth -= 1;
      return depth < 0;
    }
    depth += 1;
    return false;
  });
  if (!filePath || filePath.startsWith("/") || filePath.includes("\0") || escapesHome) {
    throw new Error(`Runloop file path must be non-empty and relative to /home/user: '${filePath}'`);
  }
}

export class RunloopClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: RunloopFetch;
  readonly #timeouts: RunloopClientTimeouts;
  readonly #signal?: AbortSignal;

  constructor(options: RunloopClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.RUNLOOP_API_KEY;
    if (!apiKey) throw new Error("RUNLOOP_API_KEY is required");

    this.#apiKey = apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.runloop.ai").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#fetch) throw new Error("A fetch implementation is required");
    this.#signal = options.signal;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

    for (const [name, value] of Object.entries(this.#timeouts)) {
      positiveFinite(`timeouts.${name}`, value);
    }
  }

  async createDevbox(
    params: RunloopDevboxCreateParams = {},
    options: RunloopCallOptions = {},
  ): Promise<RunloopDevbox> {
    const operation = this.#operation(
      "create devbox",
      options.timeoutMs ?? this.#timeouts.createMs,
      options.signal,
    );
    const created = await this.#requestJson<RunloopDevbox>("POST", "/v1/devboxes", operation, {
      body: params,
    });
    let terminal: RunloopDevbox | undefined;
    try {
      terminal = await this.#waitForDevbox(created, ["running", "failure", "shutdown"], operation);
      if (terminal.status === "failure") {
        throw new Error(
          `Runloop devbox '${terminal.id}' failed${terminal.failure_reason ? `: ${terminal.failure_reason}` : ""}`,
        );
      }
      if (terminal.status === "shutdown") {
        throw new Error(
          `Runloop devbox '${terminal.id}' shut down before becoming ready` +
            (terminal.shutdown_reason ? `: ${terminal.shutdown_reason}` : ""),
        );
      }
      return terminal;
    } catch (error) {
      // The POST allocated a devbox, but the caller never receives its id if
      // readiness polling fails. Cleanup must outlive the cancelled operation.
      if (terminal?.status === "failure" || terminal?.status === "shutdown") throw error;
      try {
        await this.#discardDevbox(created.id);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `creating devbox '${created.id}' and cleanup both failed`,
        );
      }
      throw error;
    }
  }

  async createFromSnapshot(
    snapshotId: string,
    params: Omit<RunloopDevboxCreateParams, "snapshot_id" | "blueprint_id" | "blueprint_name"> = {},
    options: RunloopCallOptions = {},
  ): Promise<RunloopDevbox> {
    if (!snapshotId) throw new Error("snapshotId is required");
    return this.createDevbox({ ...params, snapshot_id: snapshotId }, options);
  }

  /** Execute a finite command via execute_async, then long-poll it to completion. */
  async execute(
    devboxId: string,
    command: string,
    options: RunloopExecuteOptions = {},
  ): Promise<RunloopExecution> {
    const operation = this.#operation(
      `execute command on ${devboxId}`,
      options.timeoutMs ?? this.#timeouts.executeMs,
      options.signal,
    );
    const execution = await this.#startExecution(devboxId, command, options, operation);
    return this.#waitForExecution(execution, options.lastN, operation);
  }

  /** Start a long-running command and return as soon as Runloop has accepted it. */
  async start(
    devboxId: string,
    command: string,
    options: RunloopStartOptions = {},
  ): Promise<RunloopExecution> {
    const operation = this.#operation(
      `start command on ${devboxId}`,
      options.timeoutMs ?? this.#timeouts.requestMs,
      options.signal,
    );
    const execution = await this.#startExecution(devboxId, command, options, operation);
    if (execution.status === "completed" && execution.exit_status !== 0) {
      this.#assertSuccessfulExecution(execution);
    }
    return execution;
  }

  async getExecution(
    devboxId: string,
    executionId: string,
    options: RunloopCallOptions & { lastN?: number } = {},
  ): Promise<RunloopExecution> {
    const operation = this.#operation(
      `get execution ${executionId}`,
      options.timeoutMs ?? this.#timeouts.requestMs,
      options.signal,
    );
    const query = options.lastN === undefined ? "" : `?last_n=${encodeURIComponent(String(options.lastN))}`;
    return this.#requestJson<RunloopExecution>(
      "GET",
      `${executionPath(devboxId, executionId)}${query}`,
      operation,
    );
  }

  async snapshotDisk(
    devboxId: string,
    params: RunloopSnapshotParams = {},
    options: RunloopCallOptions = {},
  ): Promise<RunloopSnapshot> {
    const operation = this.#operation(
      `snapshot devbox ${devboxId}`,
      options.timeoutMs ?? this.#timeouts.snapshotMs,
      options.signal,
    );
    const initial = await this.#requestJson<RunloopSnapshot>(
      "POST",
      `/v1/devboxes/${encodeURIComponent(devboxId)}/snapshot_disk_async`,
      operation,
      { body: params },
    );

    try {
      return await this.#waitForSnapshot(initial, operation);
    } catch (error) {
      // A terminal or unknown server state is already an authoritative result;
      // only interrupted observation needs the orphan-recovery path below.
      if (error instanceof RunloopSnapshotStateError) throw error;
      // Once the POST succeeds, failure must not hide the snapshot id from the
      // only layer able to delete it.
      try {
        await this.#discardSnapshot(initial.id);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `snapshotting devbox '${devboxId}' and cleanup both failed`,
        );
      }
      throw error;
    }
  }

  async shutdown(
    devboxId: string,
    options: RunloopCallOptions & { force?: boolean } = {},
  ): Promise<RunloopDevbox> {
    const operation = this.#operation(
      `shutdown devbox ${devboxId}`,
      options.timeoutMs ?? this.#timeouts.shutdownMs,
      options.signal,
    );
    return this.#shutdownWithOperation(devboxId, options.force === true, operation);
  }

  async deleteSnapshot(snapshotId: string, options: RunloopCallOptions = {}): Promise<void> {
    const operation = this.#operation(
      `delete snapshot ${snapshotId}`,
      options.timeoutMs ?? this.#timeouts.deleteSnapshotMs,
      options.signal,
    );
    await this.#deleteSnapshotWithOperation(snapshotId, operation);
  }

  async writeFile(
    devboxId: string,
    filePath: string,
    contents: string,
    options: RunloopCallOptions = {},
  ): Promise<void> {
    assertRelativeHomePath(filePath);
    const operation = this.#operation(
      `write ${filePath} on ${devboxId}`,
      options.timeoutMs ?? this.#timeouts.fileMs,
      options.signal,
    );
    const result = await this.#requestJson<RunloopCommandResult>(
      "POST",
      `/v1/devboxes/${encodeURIComponent(devboxId)}/write_file_contents`,
      operation,
      { body: { file_path: filePath, contents } },
    );
    this.#assertSuccessfulCommand(result);
  }

  async readFile(
    devboxId: string,
    filePath: string,
    options: RunloopCallOptions = {},
  ): Promise<string> {
    assertRelativeHomePath(filePath);
    const operation = this.#operation(
      `read ${filePath} on ${devboxId}`,
      options.timeoutMs ?? this.#timeouts.fileMs,
      options.signal,
    );
    return this.#requestText(
      "POST",
      `/v1/devboxes/${encodeURIComponent(devboxId)}/read_file_contents`,
      operation,
      { body: { file_path: filePath }, accept: "text/plain" },
    );
  }

  /** Download binary contents before the owning devbox is shut down. */
  async downloadFile(
    devboxId: string,
    filePath: string,
    options: RunloopCallOptions = {},
  ): Promise<Uint8Array> {
    assertRelativeHomePath(filePath);
    const operation = this.#operation(
      `download ${filePath} from ${devboxId}`,
      options.timeoutMs ?? this.#timeouts.fileMs,
      options.signal,
    );
    return this.#requestBytes(
      "POST",
      `/v1/devboxes/${encodeURIComponent(devboxId)}/download_file`,
      operation,
      { body: { path: filePath }, accept: "application/octet-stream" },
    );
  }

  async #startExecution(
    devboxId: string,
    command: string,
    options: RunloopStartOptions,
    operation: OperationContext,
  ): Promise<RunloopExecution> {
    if (!command.trim()) throw new Error("command is required");
    return this.#requestJson<RunloopExecution>(
      "POST",
      `/v1/devboxes/${encodeURIComponent(devboxId)}/execute_async`,
      operation,
      {
        body: {
          command,
          ...(options.shellName ? { shell_name: options.shellName } : {}),
          ...(options.attachStdin === undefined ? {} : { attach_stdin: options.attachStdin }),
        },
      },
    );
  }

  async #waitForExecution(
    initial: RunloopExecution,
    lastN: number | undefined,
    operation: OperationContext,
  ): Promise<RunloopExecution> {
    let execution = initial;
    const basePath = `${executionPath(execution.devbox_id, execution.execution_id)}/wait_for_status`;
    const query = lastN === undefined ? "" : `?last_n=${encodeURIComponent(String(lastN))}`;

    while (execution.status !== "completed") {
      this.#throwIfDone(operation);
      try {
        execution = await this.#requestJson<RunloopExecution>("POST", `${basePath}${query}`, operation, {
          body: {
            statuses: ["completed"],
            timeout_seconds: this.#serverTimeoutSeconds(operation, 25),
          },
        });
      } catch (error) {
        if (error instanceof RunloopApiError && error.status === 408) continue;
        throw error;
      }
    }

    this.#assertSuccessfulExecution(execution);
    return execution;
  }

  async #waitForSnapshot(
    initial: RunloopSnapshot,
    operation: OperationContext,
  ): Promise<RunloopSnapshot> {
    const statusPath = `/v1/devboxes/disk_snapshots/${encodeURIComponent(initial.id)}/status`;
    while (true) {
      this.#throwIfDone(operation);
      const view = await this.#requestJson<RunloopSnapshotStatusView>("GET", statusPath, operation);
      if (view.status === "complete") return view.snapshot ?? initial;
      if (view.status === "error") {
        throw new RunloopSnapshotStateError(
          `Runloop snapshot '${initial.id}' failed: ${view.error_message ?? "unknown error"}`,
        );
      }
      if (view.status === "deleted") {
        throw new RunloopSnapshotStateError(
          `Runloop snapshot '${initial.id}' was deleted before it completed`,
        );
      }
      if (view.status !== "in_progress") {
        throw new RunloopSnapshotStateError(
          `Runloop snapshot '${initial.id}' returned unknown status '${String(view.status)}'`,
        );
      }
      await this.#delay(this.#timeouts.snapshotPollIntervalMs, operation);
    }
  }

  #assertSuccessfulExecution(execution: RunloopExecution): void {
    if (execution.exit_status === null || execution.exit_status === undefined) {
      throw new Error(
        `Runloop execution '${execution.execution_id ?? "unknown"}' completed without exit_status`,
      );
    }
    if (execution.exit_status !== 0) throw new RunloopCommandError(execution);
  }

  #assertSuccessfulCommand(result: RunloopCommandResult): void {
    if (result.exit_status !== 0) throw new RunloopCommandError(result);
  }

  async #waitForDevbox(
    initial: RunloopDevbox,
    statuses: RunloopDevboxStatus[],
    operation: OperationContext,
  ): Promise<RunloopDevbox> {
    let devbox = initial;
    const desired = new Set(statuses);
    const path = `/v1/devboxes/${encodeURIComponent(devbox.id)}/wait_for_status`;

    while (!desired.has(devbox.status)) {
      this.#throwIfDone(operation);
      try {
        devbox = await this.#requestJson<RunloopDevbox>("POST", path, operation, {
          body: {
            statuses,
            timeout_seconds: this.#serverTimeoutSeconds(operation, 30),
          },
        });
      } catch (error) {
        if (error instanceof RunloopApiError && error.status === 408) continue;
        throw error;
      }
    }

    return devbox;
  }

  async #shutdownWithOperation(
    devboxId: string,
    force: boolean,
    operation: OperationContext,
  ): Promise<RunloopDevbox> {
    const query = force ? "?force=true" : "";
    const result = await this.#requestJson<RunloopDevbox>(
      "POST",
      `/v1/devboxes/${encodeURIComponent(devboxId)}/shutdown${query}`,
      operation,
    );
    if (result.status === "shutdown" || result.status === "failure") return result;
    return this.#waitForDevbox(result, ["shutdown", "failure"], operation);
  }

  async #discardDevbox(devboxId: string): Promise<void> {
    const operation = this.#cleanupOperation(
      `cleanup failed devbox creation ${devboxId}`,
      this.#timeouts.shutdownMs,
    );
    try {
      await this.#shutdownWithOperation(devboxId, true, operation);
    } catch (error) {
      if (error instanceof RunloopApiError && error.status === 404) return;
      throw error;
    }
  }

  async #deleteSnapshotWithOperation(
    snapshotId: string,
    operation: OperationContext,
  ): Promise<void> {
    try {
      await this.#requestJson<unknown>(
        "POST",
        `/v1/devboxes/disk_snapshots/${encodeURIComponent(snapshotId)}/delete`,
        operation,
      );
    } catch (error) {
      // Snapshot deletion is a cleanup primitive and should be idempotent.
      if (error instanceof RunloopApiError && error.status === 404) return;
      throw error;
    }
  }

  async #discardSnapshot(snapshotId: string): Promise<void> {
    const operation = this.#cleanupOperation(
      `cleanup failed snapshot ${snapshotId}`,
      this.#timeouts.deleteSnapshotMs,
    );
    const statusPath = `/v1/devboxes/disk_snapshots/${encodeURIComponent(snapshotId)}/status`;
    while (true) {
      this.#throwIfDone(operation);
      let view: RunloopSnapshotStatusView;
      try {
        view = await this.#requestJson<RunloopSnapshotStatusView>("GET", statusPath, operation);
      } catch (error) {
        if (error instanceof RunloopApiError && error.status === 404) return;
        throw error;
      }
      if (view.status === "complete") {
        await this.#deleteSnapshotWithOperation(snapshotId, operation);
        return;
      }
      if (view.status === "error" || view.status === "deleted") return;
      if (view.status !== "in_progress") {
        throw new Error(`Runloop snapshot '${snapshotId}' returned unknown status '${String(view.status)}'`);
      }
      await this.#delay(this.#timeouts.snapshotPollIntervalMs, operation);
    }
  }

  #operation(operation: string, timeoutMs: number, signal?: AbortSignal): OperationContext {
    return this.#newOperation(operation, timeoutMs, [this.#signal, signal]);
  }

  #cleanupOperation(operation: string, timeoutMs: number): OperationContext {
    return this.#newOperation(operation, timeoutMs, []);
  }

  #newOperation(
    operation: string,
    timeoutMs: number,
    candidateSignals: readonly (AbortSignal | undefined)[],
  ): OperationContext {
    positiveFinite("timeoutMs", timeoutMs);
    const signals = candidateSignals.filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const context = {
      operation,
      timeoutMs,
      deadlineMs: Date.now() + timeoutMs,
      signals,
    };
    this.#throwIfDone(context);
    return context;
  }

  #serverTimeoutSeconds(operation: OperationContext, maximum: number): number {
    const remainingMs = operation.deadlineMs - Date.now();
    this.#throwIfDone(operation);
    return Math.max(1, Math.min(maximum, Math.floor(remainingMs / 1_000)));
  }

  #throwIfDone(operation: OperationContext): void {
    for (const signal of operation.signals) {
      if (signal.aborted) throw signal.reason ?? new Error(`Runloop operation '${operation.operation}' aborted`);
    }
    if (Date.now() >= operation.deadlineMs) {
      throw new RunloopTimeoutError(operation.operation, operation.timeoutMs);
    }
  }

  async #delay(ms: number, operation: OperationContext): Promise<void> {
    this.#throwIfDone(operation);
    const duration = Math.min(ms, Math.max(1, operation.deadlineMs - Date.now()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, duration);
      const listeners: Array<[AbortSignal, () => void]> = [];

      function cleanup(): void {
        clearTimeout(timer);
        for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      }
      function done(): void {
        cleanup();
        resolve();
      }
      for (const signal of operation.signals) {
        const listener = (): void => {
          cleanup();
          reject(signal.reason ?? new Error(`Runloop operation '${operation.operation}' aborted`));
        };
        listeners.push([signal, listener]);
        signal.addEventListener("abort", listener, { once: true });
        // Abort may have happened between the preflight check and listener
        // registration. EventTarget does not replay an already-fired event.
        if (signal.aborted) {
          listener();
          break;
        }
      }
    });
    this.#throwIfDone(operation);
  }

  async #requestJson<T>(
    method: string,
    path: string,
    operation: OperationContext,
    options: RequestOptions = {},
  ): Promise<T> {
    const text = await this.#requestText(method, path, operation, {
      ...options,
      accept: options.accept ?? "application/json",
    });
    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`Runloop ${method} ${path} returned invalid JSON`, { cause: error });
    }
  }

  async #requestText(
    method: string,
    path: string,
    operation: OperationContext,
    options: RequestOptions = {},
  ): Promise<string> {
    return this.#request(method, path, operation, options, (response) => response.text());
  }

  async #requestBytes(
    method: string,
    path: string,
    operation: OperationContext,
    options: RequestOptions = {},
  ): Promise<Uint8Array> {
    return this.#request(method, path, operation, options, async (response) =>
      new Uint8Array(await response.arrayBuffer()),
    );
  }

  async #request<T>(
    method: string,
    path: string,
    operation: OperationContext,
    options: RequestOptions,
    readSuccess: (response: Response) => Promise<T>,
  ): Promise<T> {
    this.#throwIfDone(operation);
    const remainingMs = operation.deadlineMs - Date.now();
    const requestTimeoutMs = Math.min(this.#timeouts.requestMs, remainingMs);
    const controller = new AbortController();
    const listeners: Array<[AbortSignal, () => void]> = [];
    let requestTimedOut = false;
    const timer = setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
    }, Math.max(1, requestTimeoutMs));

    for (const signal of operation.signals) {
      const listener = (): void => controller.abort(signal.reason);
      listeners.push([signal, listener]);
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) {
        listener();
        break;
      }
    }

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: options.accept ?? "application/json",
      };
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        // Consume the body before removing abort listeners so request
        // deadlines also cover a stalled error response stream.
        const responseBody = await response.text();
        this.#throwIfDone(operation);
        throw new RunloopApiError(method, path, response.status, responseBody);
      }
      const responseBody = await readSuccess(response);
      this.#throwIfDone(operation);
      return responseBody;
    } catch (error) {
      for (const signal of operation.signals) {
        if (signal.aborted) throw signal.reason ?? error;
      }
      if (requestTimedOut || Date.now() >= operation.deadlineMs) {
        throw new RunloopTimeoutError(operation.operation, operation.timeoutMs, error);
      }
      if (error instanceof RunloopApiError) throw error;
      throw new Error(`Runloop ${method} ${path} request failed`, { cause: error });
    } finally {
      clearTimeout(timer);
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    }
  }
}
