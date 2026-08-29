import { randomUUID } from "node:crypto";
import type { Run, Suite } from "@branchpoint/schema";
import type { RunInput } from "@branchpoint/engine";
import { EngineRunError } from "@branchpoint/engine";
import { HttpError, StoreConflictError } from "./errors.js";
import type { BranchpointStore } from "./store.js";
import { parseTreePatch, validateSuite } from "./validation.js";

export interface RunExecutor {
  readonly configured: boolean;
  run(input: RunInput): Promise<Run>;
}

export interface ServiceLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, error: unknown, fields?: Record<string, unknown>): void;
}

export interface RunServiceOptions {
  store: BranchpointStore;
  executor: RunExecutor;
  maxActiveRuns?: number;
  createId?: () => string;
  now?: () => Date;
  logger?: ServiceLogger;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
  abortKind?: "user" | "shutdown";
  /** Engine settled; cancellation now waits for the terminal store write. */
  finishing?: boolean;
}

const consoleLogger: ServiceLogger = {
  info(event, fields = {}) {
    process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`);
  },
  error(event, error, fields = {}) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        event,
        ...fields,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      })}\n`,
    );
  },
};

function terminal(status: Run["executionStatus"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function terminalFailure(
  base: Run,
  finishedAt: string,
  status: "failed" | "cancelled",
  code: string,
  message: string,
): Run {
  return {
    ...base,
    executionStatus: status,
    finishedAt,
    error: { code, message },
  };
}

export class RunService {
  readonly #store: BranchpointStore;
  readonly #executor: RunExecutor;
  readonly #maxActiveRuns: number;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #logger: ServiceLogger;
  readonly #queue: string[] = [];
  readonly #suiteSnapshots = new Map<string, Suite>();
  readonly #active = new Map<string, ActiveRun>();
  #accepting = false;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #shutdownPromise?: Promise<void>;

  constructor(options: RunServiceOptions) {
    this.#store = options.store;
    this.#executor = options.executor;
    this.#maxActiveRuns = options.maxActiveRuns ?? 1;
    if (!Number.isInteger(this.#maxActiveRuns) || this.#maxActiveRuns < 1) {
      throw new Error("maxActiveRuns must be a positive integer");
    }
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? consoleLogger;
  }

  get ready(): boolean {
    return this.#accepting && this.#executor.configured;
  }

  get activeRunCount(): number {
    return this.#active.size;
  }

  async initialize(): Promise<void> {
    await this.#store.initialize();
    const recovered = await this.#store.recoverInterruptedRuns(this.#timestamp());
    for (const run of recovered) {
      this.#logger.info("run_recovered_as_failed", { runId: run.id });
    }
    this.#accepting = true;
  }

  async listSuites(): Promise<Suite[]> {
    return this.#store.listSuites();
  }

  async getSuite(id: string): Promise<Suite> {
    const suite = await this.#store.getSuite(id);
    if (!suite) throw new HttpError(404, "suite_not_found", `suite '${id}' does not exist`);
    return suite;
  }

  async createSuite(value: unknown): Promise<Suite> {
    const suite = validateSuite(value);
    try {
      return await this.#store.insertSuite(suite);
    } catch (error) {
      if (error instanceof StoreConflictError) {
        throw new HttpError(409, "suite_exists", error.message);
      }
      throw error;
    }
  }

  async updateTree(id: string, value: unknown): Promise<Suite> {
    const current = await this.getSuite(id);
    const updated = parseTreePatch(value, current);
    return this.#store.replaceSuite(updated);
  }

  async listRuns(suiteId?: string): Promise<Run[]> {
    return this.#store.listRuns(suiteId);
  }

  async getRun(id: string): Promise<Run> {
    const run = await this.#store.getRun(id);
    if (!run) throw new HttpError(404, "run_not_found", `run '${id}' does not exist`);
    return run;
  }

  async startRun(suiteId: string, ref?: string): Promise<{ runId: string }> {
    return this.#withLifecycle(async () => {
      if (!this.#accepting) {
        throw new HttpError(503, "server_draining", "the server is shutting down");
      }
      if (!this.#executor.configured) {
        throw new HttpError(503, "engine_not_configured", "RUNLOOP_API_KEY is not configured");
      }

      const suite = await this.getSuite(suiteId);
      const acceptedAt = this.#timestamp();
      const runId = this.#createId();
      const targetRef = ref ?? suite.repo.ref;
      const run: Run = {
        id: runId,
        suiteId,
        ref: targetRef,
        createdAt: acceptedAt,
        startedAt: acceptedAt,
        executionStatus: "queued",
        fixtureSnapshotId: suite.fixture.snapshotId,
        results: [],
        discovered: [],
        costUsd: 0,
        wallClockMs: 0,
        sequentialEstimateMs: 0,
      };
      await this.#store.insertRun(run);
      this.#suiteSnapshots.set(runId, structuredClone(suite));
      this.#queue.push(runId);
      this.#logger.info("run_queued", { runId, suiteId, ref: targetRef });
      this.#pump();
      return { runId };
    });
  }

  async cancelRun(id: string): Promise<Run> {
    const run = await this.getRun(id);
    if (terminal(run.executionStatus)) return run;

    const queuedIndex = this.#queue.indexOf(id);
    if (queuedIndex >= 0) {
      this.#queue.splice(queuedIndex, 1);
      this.#suiteSnapshots.delete(id);
      const cancelled = terminalFailure(
        run,
        this.#timestamp(),
        "cancelled",
        "cancelled_by_user",
        "The run was cancelled before it started.",
      );
      await this.#store.replaceRun(cancelled);
      this.#logger.info("run_cancelled", { runId: id, phase: "queued" });
      return cancelled;
    }

    const active = this.#active.get(id);
    if (!active) {
      throw new HttpError(409, "run_not_active", `run '${id}' cannot be cancelled in its current state`);
    }
    if (active.finishing) {
      await active.promise;
      return this.getRun(id);
    }
    active.abortKind = "user";
    const cancelling: Run = { ...run, executionStatus: "cancelling" };
    await this.#store.replaceRun(cancelling);
    active.controller.abort(new Error("run cancelled by user"));
    this.#logger.info("run_cancelling", { runId: id });
    return cancelling;
  }

  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#performShutdown();
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    const state = await this.#withLifecycle(async () => {
      if (!this.#accepting && this.#active.size === 0) return undefined;
      this.#accepting = false;
      return {
        now: this.#timestamp(),
        queued: this.#queue.splice(0),
        active: [...this.#active.entries()],
      };
    });
    if (!state) return;

    await Promise.all(
      state.queued.map(async (runId) => {
        this.#suiteSnapshots.delete(runId);
        const run = await this.#store.getRun(runId);
        if (!run || run.executionStatus !== "queued") return;
        await this.#store.replaceRun(
          terminalFailure(
            run,
            state.now,
            "failed",
            "server_shutdown",
            "The server shut down before this run started; start a new run.",
          ),
        );
      }),
    );

    await Promise.all(
      state.active.map(async ([runId, entry]) => {
        if (entry.finishing) return;
        entry.abortKind = "shutdown";
        const run = await this.#store.getRun(runId);
        if (run && run.executionStatus === "running") {
          await this.#store.replaceRun({ ...run, executionStatus: "cancelling" });
        }
        entry.controller.abort(new Error("server shutting down"));
      }),
    );
    await Promise.allSettled(state.active.map(([, entry]) => entry.promise));
  }

  #pump(): void {
    while (this.#accepting && this.#active.size < this.#maxActiveRuns) {
      const runId = this.#queue.shift();
      if (!runId) return;
      const controller = new AbortController();
      const active: ActiveRun = { controller, promise: Promise.resolve() };
      this.#active.set(runId, active);
      const promise = this.#execute(runId, active)
        .catch((error: unknown) => {
          this.#logger.error("run_service_unexpected_error", error, { runId });
        })
        .finally(() => {
          this.#active.delete(runId);
          this.#suiteSnapshots.delete(runId);
          this.#pump();
        });
      active.promise = promise;
    }
  }

  async #execute(runId: string, active: ActiveRun): Promise<void> {
    const queued = await this.#store.getRun(runId);
    const suite = this.#suiteSnapshots.get(runId);
    if (!queued || !suite) return;
    if (active.controller.signal.aborted || queued.executionStatus === "cancelling") {
      const shutdown = active.abortKind === "shutdown";
      await this.#store.replaceRun(
        terminalFailure(
          queued,
          this.#timestamp(),
          shutdown ? "failed" : "cancelled",
          shutdown ? "server_shutdown" : "cancelled_by_user",
          shutdown
            ? "The server shut down before this run started; start a new run."
            : "The run was cancelled before it started.",
        ),
      );
      return;
    }
    if (queued.executionStatus !== "queued") return;

    const running: Run = {
      ...queued,
      startedAt: this.#timestamp(),
      executionStatus: "running",
    };
    await this.#store.replaceRun(running);
    this.#logger.info("run_started", { runId, suiteId: suite.id, ref: running.ref });
    const createdAt = queued.createdAt ?? queued.startedAt;
    const preserveAcceptedAt = (run: Run): Run => ({ ...run, createdAt });

    try {
      const result = await this.#executor.run({
        suite,
        ref: running.ref,
        runId,
        signal: active.controller.signal,
        onProgress: async (partial) => {
          const current = await this.#store.getRun(runId);
          await this.#store.replaceRun({
            ...partial,
            createdAt: queued.createdAt ?? queued.startedAt,
            executionStatus:
              active.abortKind || current?.executionStatus === "cancelling"
                ? "cancelling"
                : "running",
          });
        },
      });
      active.finishing = true;
      const completed = preserveAcceptedAt(result);
      if (active.abortKind === "user") {
        await this.#store.replaceRun(
          terminalFailure(
            completed,
            this.#timestamp(),
            "cancelled",
            "cancelled_by_user",
            "The run was cancelled and its Runloop resources were cleaned up.",
          ),
        );
        this.#logger.info("run_cancelled", { runId, phase: "running" });
        return;
      }
      if (active.abortKind === "shutdown") {
        await this.#store.replaceRun(
          terminalFailure(
            completed,
            this.#timestamp(),
            "failed",
            "server_shutdown",
            "The server shut down during this run; start a new run.",
          ),
        );
        this.#logger.info("run_stopped_for_shutdown", { runId });
        return;
      }
      await this.#store.replaceRun({
        ...completed,
        executionStatus: "succeeded",
      });
      this.#logger.info("run_succeeded", {
        runId,
        resultCount: result.results.length,
        wallClockMs: result.wallClockMs,
      });
    } catch (error) {
      active.finishing = true;
      const partial = preserveAcceptedAt(
        error instanceof EngineRunError
          ? error.partialRun
          : ((await this.#store.getRun(runId)) ?? running),
      );
      const finishedAt = this.#timestamp();
      if (active.abortKind === "user") {
        await this.#store.replaceRun(
          terminalFailure(
            partial,
            finishedAt,
            "cancelled",
            "cancelled_by_user",
            "The run was cancelled and its Runloop resources were cleaned up.",
          ),
        );
        this.#logger.info("run_cancelled", { runId, phase: "running" });
        return;
      }
      if (active.abortKind === "shutdown") {
        await this.#store.replaceRun(
          terminalFailure(
            partial,
            finishedAt,
            "failed",
            "server_shutdown",
            "The server shut down during this run; start a new run.",
          ),
        );
        this.#logger.info("run_stopped_for_shutdown", { runId });
        return;
      }

      await this.#store.replaceRun(
        terminalFailure(
          partial,
          finishedAt,
          "failed",
          error instanceof EngineRunError ? "engine_infrastructure_error" : "engine_error",
          "The QA engine could not complete the run. Server logs contain the infrastructure details.",
        ),
      );
      this.#logger.error("run_failed", error, { runId });
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  async #withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTail;
    let release!: () => void;
    this.#lifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
