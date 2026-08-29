import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Run } from "@branchpoint/schema";
import { EngineRunError, type RunInput } from "@branchpoint/engine";
import { RunService, type RunExecutor } from "../src/run-service.js";
import { JsonFileStore } from "../src/store.js";
import { makeResult, makeRun, makeSuite, waitFor } from "./fixtures.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

class DeferredExecutor implements RunExecutor {
  readonly configured = true;
  readonly started = deferred<RunInput>();
  readonly completion = deferred<Run>();

  async run(input: RunInput): Promise<Run> {
    this.started.resolve(input);
    return this.completion.promise;
  }
}

const quietLogger = { info() {}, error() {} };

async function createService(
  t: test.TestContext,
  executor: RunExecutor,
  ids = ["run-1"],
  maxActiveRuns = 1,
): Promise<RunService> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branchpoint-service-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileStore(path.join(directory, "server.json"));
  let idIndex = 0;
  const service = new RunService({
    store,
    executor,
    maxActiveRuns,
    createId: () => ids[idIndex++] ?? `run-${idIndex}`,
    logger: quietLogger,
  });
  await service.initialize();
  await service.createSuite(makeSuite());
  return service;
}

test("run service persists queued, partial, and successful run states", async (t) => {
  const executor = new DeferredExecutor();
  const service = await createService(t, executor);
  const { runId } = await service.startRun("suite-1", "target-ref");
  assert.equal(runId, "run-1");

  const input = await executor.started.promise;
  assert.equal(input.runId, runId);
  assert.equal(input.ref, "target-ref");
  await waitFor(async () => (await service.getRun(runId)).executionStatus === "running");

  const partial: Run = {
    ...makeRun("running", runId),
    ref: "target-ref",
    finishedAt: undefined,
    executionStatus: undefined,
  };
  await input.onProgress?.(partial);
  const persistedPartial = await service.getRun(runId);
  assert.equal(persistedPartial.executionStatus, "running");
  assert.deepEqual(persistedPartial.results.map((result) => result.nodeId), ["goal"]);

  const finished: Run = {
    ...partial,
    finishedAt: "2026-08-29T20:00:03.000Z",
    wallClockMs: 2_000,
  };
  executor.completion.resolve(finished);
  await waitFor(async () => (await service.getRun(runId)).executionStatus === "succeeded");
  const persisted = await service.getRun(runId);
  assert.equal(persisted.executionStatus, "succeeded");
  assert(persisted.createdAt);
  assert.equal(persisted.finishedAt, finished.finishedAt);
});

test("EngineRunError becomes a terminal failed API run with partial results", async (t) => {
  const partial = {
    ...makeRun("running", "run-1"),
    finishedAt: undefined,
    executionStatus: undefined,
  };
  const executor: RunExecutor = {
    configured: true,
    async run() {
      throw new EngineRunError("run-1", partial, new Error("devbox unavailable"));
    },
  };
  const service = await createService(t, executor);
  await service.startRun("suite-1");
  await waitFor(async () => (await service.getRun("run-1")).executionStatus === "failed");

  const failed = await service.getRun("run-1");
  assert.equal(failed.error?.code, "engine_infrastructure_error");
  assert(failed.createdAt, "engine-native partial runs must retain the server acceptance time");
  assert(failed.finishedAt, "failed runs must stop polling");
  assert.deepEqual(failed.results, [makeResult()]);
});

test("queued runs can be cancelled without reaching the executor", async (t) => {
  const first = new DeferredExecutor();
  const service = await createService(t, first, ["first", "second"]);
  await service.startRun("suite-1");
  await first.started.promise;
  await service.startRun("suite-1");
  assert.equal((await service.getRun("second")).executionStatus, "queued");

  const cancelled = await service.cancelRun("second");
  assert.equal(cancelled.executionStatus, "cancelled");
  assert.equal(cancelled.error?.code, "cancelled_by_user");
  assert(cancelled.finishedAt);

  first.completion.resolve({
    ...makeRun("succeeded", "first"),
    suiteId: "suite-1",
  });
  await waitFor(async () => (await service.getRun("first")).executionStatus === "succeeded");
});

test("running cancellation aborts the engine and terminalizes after cleanup", async (t) => {
  const executor: RunExecutor = {
    configured: true,
    async run(input) {
      return new Promise<Run>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => {
            reject(
              new EngineRunError(
                input.runId ?? "run-1",
                {
                  ...makeRun("running", input.runId ?? "run-1"),
                  finishedAt: undefined,
                  executionStatus: undefined,
                },
                input.signal?.reason,
              ),
            );
          },
          { once: true },
        );
      });
    },
  };
  const service = await createService(t, executor);
  await service.startRun("suite-1");
  await waitFor(async () => (await service.getRun("run-1")).executionStatus === "running");

  const cancelling = await service.cancelRun("run-1");
  assert.equal(cancelling.executionStatus, "cancelling");
  await waitFor(async () => (await service.getRun("run-1")).executionStatus === "cancelled");
  const cancelled = await service.getRun("run-1");
  assert.equal(cancelled.error?.code, "cancelled_by_user");
  assert(cancelled.finishedAt);
});

test("an executor that resolves after abort cannot overwrite cancellation with success", async (t) => {
  const started = deferred<RunInput>();
  const completion = deferred<Run>();
  const executor: RunExecutor = {
    configured: true,
    async run(input) {
      started.resolve(input);
      return completion.promise;
    },
  };
  const service = await createService(t, executor);
  await service.startRun("suite-1");
  await started.promise;
  await waitFor(async () => (await service.getRun("run-1")).executionStatus === "running");

  const cancelling = await service.cancelRun("run-1");
  assert.equal(cancelling.executionStatus, "cancelling");
  completion.resolve(makeRun("succeeded", "run-1"));
  await waitFor(async () => (await service.getRun("run-1")).executionStatus === "cancelled");
  const cancelled = await service.getRun("run-1");
  assert.equal(cancelled.error?.code, "cancelled_by_user");
  assert(cancelled.createdAt);
});

test("start admission cannot append a permanently queued run after shutdown drains", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branchpoint-admission-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileStore(path.join(directory, "server.json"));
  await store.initialize();
  await store.insertSuite(makeSuite());
  const lookupStarted = deferred<void>();
  const releaseLookup = deferred<void>();
  const originalGetSuite = store.getSuite.bind(store);
  store.getSuite = async (id: string) => {
    lookupStarted.resolve();
    await releaseLookup.promise;
    return originalGetSuite(id);
  };
  const executor: RunExecutor = {
    configured: true,
    async run(input) {
      const aborted = () =>
        new EngineRunError(
          input.runId ?? "run-race",
          {
            ...makeRun("running", input.runId ?? "run-race"),
            finishedAt: undefined,
            executionStatus: undefined,
          },
          input.signal?.reason,
        );
      if (input.signal?.aborted) throw aborted();
      return new Promise<Run>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => reject(aborted()),
          { once: true },
        );
      });
    },
  };
  const service = new RunService({
    store,
    executor,
    createId: () => "run-race",
    logger: quietLogger,
  });
  await service.initialize();

  const starting = service.startRun("suite-1");
  await lookupStarted.promise;
  const shuttingDown = service.shutdown();
  releaseLookup.resolve();
  const { runId } = await starting;
  await shuttingDown;

  const run = await service.getRun(runId);
  assert.notEqual(run.executionStatus, "queued");
  assert.equal(run.executionStatus, "failed");
  assert.equal(run.error?.code, "server_shutdown");
  assert.equal(service.ready, false);
  assert.equal(service.activeRunCount, 0);
});

test("shutdown rejects queued work and waits for active engine cleanup", async (t) => {
  const started = deferred<RunInput>();
  const executor: RunExecutor = {
    configured: true,
    async run(input) {
      started.resolve(input);
      return new Promise<Run>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => {
            reject(
              new EngineRunError(
                input.runId ?? "first",
                {
                  ...makeRun("running", input.runId ?? "first"),
                  finishedAt: undefined,
                  executionStatus: undefined,
                },
                input.signal?.reason,
              ),
            );
          },
          { once: true },
        );
      });
    },
  };
  const service = await createService(t, executor, ["first", "second"]);
  await service.startRun("suite-1");
  await started.promise;
  await service.startRun("suite-1");

  await service.shutdown();
  assert.equal(service.ready, false);
  assert.equal(service.activeRunCount, 0);
  for (const id of ["first", "second"]) {
    const run = await service.getRun(id);
    assert.equal(run.executionStatus, "failed");
    assert.equal(run.error?.code, "server_shutdown");
    assert(run.finishedAt);
  }
});

test("an unconfigured executor rejects new runs while suite management remains available", async (t) => {
  const service = await createService(t, {
    configured: false,
    async run() {
      throw new Error("must not run");
    },
  });
  assert.equal(service.ready, false);
  await assert.rejects(
    service.startRun("suite-1"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "engine_not_configured",
  );
  assert.equal((await service.listSuites()).length, 1);
});
