import { readFile } from "node:fs/promises";
import type { Run } from "@branchpoint/schema";
import type { Command } from "./args.js";
import type { BranchpointApi } from "./client.js";
import {
  ApiError,
  CliError,
  EXIT_CODE,
  RemoteError,
  SignalInterruption,
  UsageError,
  WaitTimeoutError,
  type CliExitCode,
} from "./errors.js";

export type RunOutcome =
  | "passed"
  | "regression"
  | "stale"
  | "failed"
  | "cancelled"
  | "timeout"
  | "detached";

export interface CommandResult {
  exitCode: CliExitCode;
  output: Record<string, unknown>;
  runId?: string;
  outcome?: RunOutcome;
  run?: Run;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (run: Run) => void;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForTerminal(
  api: BranchpointApi,
  runId: string,
  intervalMs: number,
  signal: AbortSignal,
  options: ExecuteOptions,
): Promise<Run> {
  let lastStatus: Run["executionStatus"];
  while (true) {
    if (signal.aborted) throw signal.reason;
    const run = await api.getRun(runId, signal);
    if (run.executionStatus !== lastStatus) {
      options.onProgress?.(run);
      lastStatus = run.executionStatus;
    }
    if (TERMINAL.has(String(run.executionStatus))) return run;
    await (options.sleep ?? sleep)(intervalMs, signal);
  }
}

async function bestEffortCancel(api: BranchpointApi, runId: string): Promise<void> {
  try {
    await api.cancelRun(runId, AbortSignal.timeout(5_000));
  } catch {
    // The original timeout/signal remains authoritative. Cancellation is best-effort.
  }
}

function errorDocument(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof CliError) return { code: error.code, message: error.message };
  return { code: "unexpected_error", message: error instanceof Error ? error.message : String(error) };
}

async function executeRun(
  command: Extract<Command, { kind: "run" }>,
  api: BranchpointApi,
  options: ExecuteOptions,
): Promise<CommandResult> {
  const { runId } = await api.startRun(
    {
      suiteId: command.suiteId,
      ...(command.ref ? { ref: command.ref } : {}),
    },
    options.signal,
  );
  if (command.detach) {
    return {
      exitCode: EXIT_CODE.ok,
      runId,
      outcome: "detached",
      output: { command: "run", outcome: "detached", runId },
    };
  }

  const timeoutSignal = AbortSignal.timeout(command.timeoutMs);
  const pollSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const run = await waitForTerminal(api, runId, command.pollIntervalMs, pollSignal, options);
    if (run.executionStatus === "succeeded") {
      const failedResults = run.results.filter((result) => result.status === "fail");
      const stale =
        failedResults.length > 0 &&
        failedResults.every((result) => result.failReason === "unresolved");
      const outcome: RunOutcome = stale
        ? "stale"
        : failedResults.length > 0
          ? "regression"
          : "passed";
      return {
        exitCode: stale
          ? EXIT_CODE.stale
          : failedResults.length > 0
            ? EXIT_CODE.regression
            : EXIT_CODE.ok,
        runId,
        outcome,
        run,
        output: { command: "run", outcome, runId, run },
      };
    }
    const outcome: RunOutcome = run.executionStatus === "cancelled" ? "cancelled" : "failed";
    return {
      exitCode: EXIT_CODE.remote,
      runId,
      outcome,
      run,
      output: { command: "run", outcome, runId, run },
    };
  } catch (error) {
    const signalReason = options.signal?.aborted ? options.signal.reason : undefined;
    if (signalReason instanceof SignalInterruption) {
      await bestEffortCancel(api, runId);
      return {
        exitCode: signalReason.exitCode,
        runId,
        outcome: "cancelled",
        output: {
          command: "run",
          outcome: "cancelled",
          runId,
          error: errorDocument(signalReason),
        },
      };
    }
    if (timeoutSignal.aborted) {
      await bestEffortCancel(api, runId);
      const timeout = new WaitTimeoutError(
        `run '${runId}' did not finish within ${command.timeoutMs / 1_000} seconds`,
      );
      return {
        exitCode: EXIT_CODE.timeout,
        runId,
        outcome: "timeout",
        output: { command: "run", outcome: "timeout", runId, error: errorDocument(timeout) },
      };
    }
    const remote = error instanceof RemoteError ? error : new RemoteError("run polling failed", "poll_failed", { cause: error });
    return {
      exitCode: EXIT_CODE.remote,
      runId,
      outcome: "failed",
      output: { command: "run", outcome: "failed", runId, error: errorDocument(remote) },
    };
  }
}

export async function executeCommand(
  command: Exclude<Command, { kind: "help" }>,
  api: BranchpointApi,
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  if (command.kind === "run") return executeRun(command, api, options);
  if (command.kind === "runs-list") {
    const runs = await api.listRuns(command.suiteId, options.signal);
    return { exitCode: EXIT_CODE.ok, output: { command: "runs list", runs } };
  }
  if (command.kind === "runs-get") {
    const run = await api.getRun(command.runId, options.signal);
    return { exitCode: EXIT_CODE.ok, runId: run.id, run, output: { command: "runs get", run } };
  }
  if (command.kind === "runs-cancel") {
    const run = await api.cancelRun(command.runId, options.signal);
    return {
      exitCode: EXIT_CODE.ok,
      runId: run.id,
      run,
      output: { command: "runs cancel", run },
    };
  }
  if (command.kind === "suites-list") {
    const suites = await api.listSuites(options.signal);
    return { exitCode: EXIT_CODE.ok, output: { command: "suites list", suites } };
  }
  if (command.kind === "suites-get") {
    const suite = await api.getSuite(command.suiteId, options.signal);
    return { exitCode: EXIT_CODE.ok, output: { command: "suites get", suite } };
  }
  let contents: string;
  try {
    contents = await readFile(command.filename, "utf8");
  } catch (error) {
    throw new UsageError(`could not read Suite file '${command.filename}'`, "suite_file_error", {
      cause: error,
    });
  }
  let suite: unknown;
  try {
    suite = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new UsageError(`Suite file '${command.filename}' is not valid JSON`, "invalid_suite_json", {
      cause: error,
    });
  }
  const created = await api.createSuite(suite, options.signal);
  return { exitCode: EXIT_CODE.ok, output: { command: "suites push", suite: created } };
}

export function serializeError(error: unknown): { exitCode: CliExitCode; output: Record<string, unknown> } {
  if (error instanceof CliError) {
    return { exitCode: error.exitCode, output: { error: errorDocument(error) } };
  }
  return {
    exitCode: EXIT_CODE.remote,
    output: {
      error: errorDocument(
        new RemoteError("the CLI could not complete the command", "unexpected_error", {
          cause: error,
        }),
      ),
    },
  };
}
