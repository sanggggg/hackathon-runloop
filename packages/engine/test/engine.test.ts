import assert from "node:assert/strict";
import test from "node:test";
import type { Node, Suite } from "@branchpoint/schema";
import {
  BranchpointEngine,
  EngineRunError,
  RunInputValidationError,
  TreeValidationError,
} from "../src/index.js";
import { FakeRuntime, node } from "./fake-runtime.js";

function suite(tree: Node[], runtime: FakeRuntime): Suite {
  return {
    id: "suite-1",
    name: "engine test suite",
    repo: {
      url: "https://example.test/repo.git",
      ref: "fixture-ref",
      buildCmd: "npm run build",
      startCmd: "npm start",
      port: 3000,
    },
    blueprintId: "blueprint-1",
    fixture: {
      snapshotId: runtime.fixtureSnapshotId,
      ref: "fixture-ref",
      description: "signed in at onboarding root",
    },
    tree,
  };
}

function engine(runtime: FakeRuntime, maxConcurrency = 8): BranchpointEngine {
  return new BranchpointEngine({
    runtime,
    maxConcurrency,
    createId: () => "run-1",
    clock: { now: () => 1_000 },
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function completesWithin<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("engine run deadlocked")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("invalid trees fail before any runtime side effect", async (t) => {
  const cases: Array<{ name: string; tree: Node[] }> = [
    { name: "empty", tree: [] },
    {
      name: "duplicate ids",
      tree: [node("root", null, "fixture"), node("goal", "root", "goal"), node("goal", "root", "goal")],
    },
    {
      name: "missing parent",
      tree: [node("root", null, "fixture"), node("goal", "missing", "goal")],
    },
    {
      name: "multiple roots",
      tree: [
        node("root", null, "fixture"),
        node("other-root", null, "fixture"),
        node("goal", "root", "goal"),
      ],
    },
    {
      name: "cycle",
      tree: [
        node("root", null, "fixture"),
        node("valid-goal", "root", "goal"),
        node("a", "b", "step"),
        node("b", "a", "step"),
      ],
    },
  ];

  for (const value of cases) {
    await t.test(value.name, async () => {
      const runtime = new FakeRuntime();
      await assert.rejects(engine(runtime).run({ suite: suite(value.tree, runtime) }), TreeValidationError);
      assert.deepEqual(runtime.events, []);
      assert.equal(runtime.creations.length, 0);
      assert.equal(runtime.snapshotRecords.size, 1);
    });
  }
});

test("invalid suite configuration fails before provisioning a container", async () => {
  const runtime = new FakeRuntime();
  const invalidSuite = suite(
    [node("root", null, "fixture"), node("goal", "root", "goal")],
    runtime,
  );
  invalidSuite.repo.port = 0;

  await assert.rejects(
    engine(runtime).run({ suite: invalidSuite }),
    (error: unknown) =>
      error instanceof RunInputValidationError &&
      error.issues.includes("suite.repo.port must be an integer from 1 to 65535"),
  );
  assert.deepEqual(runtime.events, []);
});

test("a straight chain reuses one prepared container and takes no snapshots", async () => {
  const runtime = new FakeRuntime();
  const tree = [
    node("root", null, "fixture"),
    node("a", "root", "step"),
    node("b", "a", "step"),
    node("goal", "b", "goal"),
  ];

  const run = await engine(runtime).run({ suite: suite(tree, runtime) });

  assert.deepEqual(run.results.map((result) => result.nodeId), ["a", "b", "goal"]);
  assert.equal(runtime.creations.length, 1);
  assert.equal(new Set(runtime.executions.map((entry) => entry.containerId)).size, 1);
  assert.equal([...runtime.snapshotRecords.values()].filter((record) => record.ephemeral).length, 0);
  assert.deepEqual(runtime.deletedSnapshots, []);
  assert.deepEqual(runtime.containers.get("box-1")?.browser.path, ["a", "b", "goal"]);
  runtime.assertFullyCleaned();
});

test("result elapsed time and logs stay cumulative within a reused branch container", async () => {
  const runtime = new FakeRuntime();
  runtime.setOutcome("a", {
    status: "pass",
    elapsedMs: 5,
    log: [{ t: 1, text: "a", level: "info" }],
  });
  runtime.setOutcome("goal", {
    status: "pass",
    elapsedMs: 5,
    log: [{ t: 1, text: "goal", level: "info" }],
  });
  let now = 0;
  const value = new BranchpointEngine({
    runtime,
    createId: () => "run-1",
    clock: { now: () => (now += 10) },
  });
  const tree = [
    node("root", null, "fixture"),
    node("a", "root", "step"),
    node("goal", "a", "goal"),
  ];

  const run = await value.run({ suite: suite(tree, runtime) });
  const first = run.results.find((result) => result.nodeId === "a");
  const goal = run.results.find((result) => result.nodeId === "goal");

  assert(first && goal);
  assert(goal.elapsedMs > first.elapsedMs);
  assert((goal.log[0]?.t ?? 0) > (first.log[0]?.t ?? 0));
  assert.equal(run.sequentialEstimateMs, goal.elapsedMs);
  runtime.assertFullyCleaned();
});

test("model call receipts aggregate independently from provider billing", async () => {
  const runtime = new FakeRuntime();
  runtime.setOutcome("a", {
    status: "pass",
    modelCalls: 1,
    costUsd: 0,
  });
  runtime.setOutcome("goal", {
    status: "pass",
    modelCalls: 2,
    costUsd: 0,
  });
  const tree = [
    node("root", null, "fixture"),
    node("a", "root", "step"),
    node("goal", "a", "goal"),
  ];

  const run = await engine(runtime).run({ suite: suite(tree, runtime) });

  assert.equal(run.modelCalls, 3);
  assert.equal(run.costUsd, 0, "BYOK may complete real model calls with zero reported cost");
  assert.deepEqual(run.results.map((result) => result.modelCalls), [1, 2]);
  runtime.assertFullyCleaned();
});

test("mixed nested tree snapshots only root and a1 and forks siblings from the same immutable state", async () => {
  const runtime = new FakeRuntime();
  const tree = [
    node("root", null, "fixture"),
    node("a", "root", "step"),
    node("a1", "a", "step"),
    node("a11", "a1", "goal"),
    node("a12", "a1", "goal"),
    node("b", "root", "step"),
    node("b1", "b", "goal"),
  ];

  const run = await engine(runtime).run({ suite: suite(tree, runtime) });

  assert.deepEqual(run.results.map((result) => result.nodeId), ["a", "a1", "a11", "a12", "b", "b1"]);
  const ephemeral = [...runtime.snapshotRecords.values()].filter((record) => record.ephemeral);
  assert.equal(ephemeral.length, 2);
  assert.deepEqual(ephemeral.map((record) => record.browser.path), [[], ["a", "a1"]]);

  const aBox = runtime.executionFor("a")?.containerId;
  const a1Box = runtime.executionFor("a1")?.containerId;
  const bBox = runtime.executionFor("b")?.containerId;
  const b1Box = runtime.executionFor("b1")?.containerId;
  assert.equal(aBox, a1Box, "single-child prefix a -> a1 should stay on one container");
  assert.equal(bBox, b1Box, "single-child prefix b -> b1 should stay on one container");

  const sourceFor = (nodeId: string): string | undefined => {
    const containerId = runtime.executionFor(nodeId)?.containerId;
    return runtime.creations.find((entry) => entry.containerId === containerId)?.sourceSnapshotId;
  };
  assert.equal(sourceFor("a"), "snapshot-1");
  assert.equal(sourceFor("b"), "snapshot-1");
  assert.equal(sourceFor("a11"), "snapshot-2");
  assert.equal(sourceFor("a12"), "snapshot-2");

  // Child mutations must not leak back into either snapshot or a sibling.
  assert.deepEqual(runtime.snapshotRecords.get("snapshot-1")?.browser.path, []);
  assert.deepEqual(runtime.snapshotRecords.get("snapshot-2")?.browser.path, ["a", "a1"]);
  assert.equal(runtime.creations.length, 5);
  assert.deepEqual(runtime.deletedSnapshots, ["snapshot-1", "snapshot-2"]);
  assert.equal(
    run.sequentialEstimateMs,
    5,
    "each cold path includes the last cumulative result from every devbox segment",
  );
  runtime.assertFullyCleaned();
});

test("an unresolved tree node prunes its entire subtree before execution", async () => {
  const runtime = new FakeRuntime();
  const tree = [
    node("root", null, "fixture"),
    node("unresolved", "root", "step", "unresolved"),
    node("never-run", "unresolved", "goal"),
    node("healthy", "root", "goal"),
  ];

  const run = await engine(runtime).run({ suite: suite(tree, runtime) });

  assert.deepEqual(runtime.startedNodeIds(), ["healthy"]);
  assert.deepEqual(run.results.map((result) => result.nodeId), ["healthy"]);
  assert.equal([...runtime.snapshotRecords.values()].filter((record) => record.ephemeral).length, 0);
  runtime.assertFullyCleaned();
});

test("a branch with only unresolved goals is pruned back to the nearest runnable fork", async () => {
  const runtime = new FakeRuntime();
  const tree = [
    node("root", null, "fixture"),
    node("dead-prefix", "root", "step"),
    node("dead-goal", "dead-prefix", "goal", "unresolved"),
    node("healthy", "root", "goal"),
  ];

  const run = await engine(runtime).run({ suite: suite(tree, runtime) });

  assert.deepEqual(runtime.startedNodeIds(), ["healthy"]);
  assert.deepEqual(run.results.map((result) => result.nodeId), ["healthy"]);
  assert.equal([...runtime.snapshotRecords.values()].filter((record) => record.ephemeral).length, 0);
  runtime.assertFullyCleaned();
});

test("a product failure prunes only its descendants and does not stop a sibling", async () => {
  const runtime = new FakeRuntime();
  runtime.setOutcome("a", { status: "fail", failReason: "error-screen", elapsedMs: 2 });
  const tree = [
    node("root", null, "fixture"),
    node("a", "root", "step"),
    node("a-goal", "a", "goal"),
    node("b", "root", "step"),
    node("b-goal", "b", "goal"),
  ];

  const run = await engine(runtime).run({ suite: suite(tree, runtime) });

  assert.deepEqual(runtime.startedNodeIds().sort(), ["a", "b", "b-goal"]);
  assert.equal(runtime.executionFor("a-goal"), undefined);
  assert.deepEqual(run.results.map((result) => result.nodeId), ["a", "b", "b-goal"]);
  assert.equal(run.results.find((result) => result.nodeId === "a")?.failReason, "error-screen");
  assert.deepEqual(runtime.deletedSnapshots, ["snapshot-1"]);
  runtime.assertFullyCleaned();
});

test("parallel completion order does not change result order", async () => {
  const runtime = new FakeRuntime();
  const releaseA = runtime.blockNode("a");
  const releaseB = runtime.blockNode("b");
  const releaseC = runtime.blockNode("c");
  const tree = [
    node("root", null, "fixture"),
    node("a", "root", "goal"),
    node("b", "root", "goal"),
    node("c", "root", "goal"),
  ];

  const running = engine(runtime).run({ suite: suite(tree, runtime) });
  await waitUntil(() => ["a", "b", "c"].every((id) => runtime.startedNodeIds().includes(id)));
  releaseC();
  await waitUntil(() => runtime.finishedNodeIds().includes("c"));
  releaseB();
  await waitUntil(() => runtime.finishedNodeIds().includes("b"));
  releaseA();
  const run = await running;

  assert.deepEqual(runtime.finishedNodeIds(), ["c", "b", "a"]);
  assert.deepEqual(run.results.map((result) => result.nodeId), ["a", "b", "c"]);
  assert.deepEqual(runtime.deletedSnapshots, ["snapshot-1"]);
  runtime.assertFullyCleaned();
});

test("an infrastructure failure becomes EngineRunError after all containers and snapshots are cleaned", async () => {
  const runtime = new FakeRuntime();
  runtime.throwWhileExecuting("a", new Error("agent process crashed"));
  const tree = [
    node("root", null, "fixture"),
    node("a", "root", "goal"),
    node("b", "root", "goal"),
  ];

  let caught: unknown;
  try {
    await engine(runtime).run({ suite: suite(tree, runtime) });
  } catch (error) {
    caught = error;
  }

  assert(caught instanceof EngineRunError);
  assert.equal(caught.runId, "run-1");
  assert.equal(caught.partialRun.finishedAt, undefined);
  assert.deepEqual(caught.partialRun.results.map((result) => result.nodeId), ["b"]);
  assert(runtime.startedNodeIds().includes("b"), "sibling branch should be settled despite another branch crashing");
  assert.deepEqual(runtime.deletedSnapshots, ["snapshot-1"]);
  runtime.assertFullyCleaned();
});

test("a failed shutdown remains tracked and is retried during final cleanup", async () => {
  const runtime = new FakeRuntime();
  runtime.failShutdown("box-1");
  const tree = [node("root", null, "fixture"), node("goal", "root", "goal")];

  await assert.rejects(
    engine(runtime).run({ suite: suite(tree, runtime) }),
    EngineRunError,
  );

  assert.deepEqual(runtime.shutdownAttempts, ["box-1", "box-1"]);
  runtime.assertFullyCleaned();
});

test("maxConcurrency=1 completes a nested fork without holding a parent permit", async () => {
  const runtime = new FakeRuntime();
  const tree = [
    node("root", null, "fixture"),
    node("a", "root", "step"),
    node("a1", "a", "step"),
    node("a11", "a1", "goal"),
    node("a12", "a1", "goal"),
    node("b", "root", "goal"),
  ];

  const run = await completesWithin(
    engine(runtime, 1).run({ suite: suite(tree, runtime) }),
    2_000,
  );

  assert.deepEqual(run.results.map((result) => result.nodeId), ["a", "a1", "a11", "a12", "b"]);
  assert.equal(runtime.maxLiveContainers, 1);
  assert.deepEqual(runtime.deletedSnapshots, ["snapshot-1", "snapshot-2"]);
  runtime.assertFullyCleaned();
});
