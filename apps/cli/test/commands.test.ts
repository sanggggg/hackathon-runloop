import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Run, Suite } from "@branchpoint/schema";
import type { BranchpointApi } from "../src/client.js";
import { executeCommand } from "../src/commands.js";
import { EXIT_CODE, SignalInterruption } from "../src/errors.js";
import { writeGitHubMetadata } from "../src/github.js";

function result(status: "pass" | "fail") {
  return {
    nodeId: status === "pass" ? "passed" : "failed",
    status,
    ...(status === "fail" ? { failReason: "error-screen" as const } : {}),
    devboxId: "devbox",
    elapsedMs: 10,
    log: [],
  };
}

function run(executionStatus: Run["executionStatus"], statuses: Array<"pass" | "fail"> = []): Run {
  return {
    id: "run-1",
    suiteId: "suite-1",
    ref: "deadbeef",
    startedAt: "2026-08-29T00:00:00.000Z",
    executionStatus,
    ...(executionStatus === "succeeded" || executionStatus === "failed" || executionStatus === "cancelled"
      ? { finishedAt: "2026-08-29T00:01:00.000Z" }
      : {}),
    fixtureSnapshotId: "snapshot",
    results: statuses.map(result),
    discovered: [],
    costUsd: 0,
    wallClockMs: 60_000,
    sequentialEstimateMs: 60_000,
  };
}

function suite(): Suite {
  return {
    id: "suite-1",
    name: "Suite",
    repo: { url: "https://example.test/repo", ref: "main", buildCmd: "", startCmd: "npm start", port: 3000 },
    blueprintId: "blueprint",
    fixture: { snapshotId: "snapshot", ref: "main", description: "ready" },
    tree: [],
  };
}

function fakeApi(overrides: Partial<BranchpointApi> = {}): BranchpointApi {
  return {
    async startRun() {
      return { runId: "run-1" };
    },
    async getRun() {
      return run("succeeded", ["pass"]);
    },
    async listRuns() {
      return [];
    },
    async cancelRun() {
      return run("cancelled");
    },
    async listSuites() {
      return [suite()];
    },
    async getSuite() {
      return suite();
    },
    async createSuite() {
      return suite();
    },
    ...overrides,
  };
}

const runCommand = {
  kind: "run" as const,
  suiteId: "suite-1",
  ref: "deadbeef",
  detach: false,
  pollIntervalMs: 1,
  timeoutMs: 1_000,
};

test("run polling maps pass, product regression, and infrastructure terminal states", async () => {
  const pass = await executeCommand(runCommand, fakeApi());
  assert.equal(pass.exitCode, EXIT_CODE.ok);
  assert.equal(pass.outcome, "passed");

  const regression = await executeCommand(
    runCommand,
    fakeApi({ async getRun() { return run("succeeded", ["pass", "fail"]); } }),
  );
  assert.equal(regression.exitCode, EXIT_CODE.regression);
  assert.equal(regression.outcome, "regression");

  const stale = await executeCommand(
    runCommand,
    fakeApi({
      async getRun() {
        return {
          ...run("succeeded"),
          results: [
            { ...result("fail"), failReason: "unresolved" },
            { ...result("fail"), nodeId: "another", failReason: "unresolved" },
          ],
        };
      },
    }),
  );
  assert.equal(stale.exitCode, EXIT_CODE.stale);
  assert.equal(stale.outcome, "stale");

  const mixed = await executeCommand(
    runCommand,
    fakeApi({
      async getRun() {
        return {
          ...run("succeeded"),
          results: [
            { ...result("fail"), failReason: "unresolved" },
            { ...result("fail"), nodeId: "product", failReason: "timeout" },
          ],
        };
      },
    }),
  );
  assert.equal(mixed.exitCode, EXIT_CODE.regression);
  assert.equal(mixed.outcome, "regression");

  const failure = await executeCommand(
    runCommand,
    fakeApi({ async getRun() { return { ...run("failed"), error: { code: "engine_error", message: "failed" } }; } }),
  );
  assert.equal(failure.exitCode, EXIT_CODE.remote);
  assert.equal(failure.outcome, "failed");
});

test("run observes intermediate states and detach never polls", async () => {
  const states = [run("queued"), run("running"), run("succeeded", ["pass"])];
  const observed: Array<Run["executionStatus"]> = [];
  const api = fakeApi({
    async getRun() {
      const next = states.shift();
      assert(next);
      return next;
    },
  });
  const completed = await executeCommand(runCommand, api, {
    sleep: async () => {},
    onProgress(value) {
      observed.push(value.executionStatus);
    },
  });
  assert.equal(completed.exitCode, 0);
  assert.deepEqual(observed, ["queued", "running", "succeeded"]);

  const detached = await executeCommand(
    { ...runCommand, detach: true },
    fakeApi({ async getRun() { throw new Error("must not poll"); } }),
  );
  assert.equal(detached.exitCode, 0);
  assert.equal(detached.outcome, "detached");
});

test("timeout and signals attempt cancellation and keep their conventional exit codes", async () => {
  let timeoutCancels = 0;
  const timedOut = await executeCommand(
    { ...runCommand, timeoutMs: 5 },
    fakeApi({
      async getRun() { return run("running"); },
      async cancelRun() { timeoutCancels += 1; return run("cancelled"); },
    }),
  );
  assert.equal(timedOut.exitCode, EXIT_CODE.timeout);
  assert.equal(timeoutCancels, 1);

  let signalCancels = 0;
  const controller = new AbortController();
  const interrupted = executeCommand(
    runCommand,
    fakeApi({
      async getRun(_id, signal) {
        return new Promise<Run>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async cancelRun() { signalCancels += 1; return run("cancelled"); },
    }),
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(new SignalInterruption("SIGTERM")), 0);
  const signalled = await interrupted;
  assert.equal(signalled.exitCode, EXIT_CODE.sigterm);
  assert.equal(signalCancels, 1);
});

test("Suite push parses a local JSON document and reports local parse errors as usage failures", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branchpoint-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = path.join(directory, "suite.json");
  const invalid = path.join(directory, "invalid.json");
  await writeFile(valid, JSON.stringify(suite()));
  await writeFile(invalid, "{");
  let received: unknown;
  const pushed = await executeCommand(
    { kind: "suites-push", filename: valid },
    fakeApi({ async createSuite(value) { received = value; return suite(); } }),
  );
  assert.equal(pushed.exitCode, 0);
  assert.equal((received as Suite).id, "suite-1");
  await assert.rejects(
    () => executeCommand({ kind: "suites-push", filename: invalid }, fakeApi()),
    (error: unknown) => (error as { exitCode?: number }).exitCode === EXIT_CODE.usage,
  );
});

test("GitHub metadata writes a safe summary and stable run outputs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branchpoint-cli-github-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = path.join(directory, "summary.md");
  const outputs = path.join(directory, "outputs.txt");
  await writeGitHubMetadata(
    {
      exitCode: EXIT_CODE.regression,
      runId: "run-1",
      outcome: "regression",
      run: run("succeeded", ["pass", "fail"]),
      output: {},
    },
    { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs },
  );
  assert.match(await readFile(summary, "utf8"), /Branchpoint QA/);
  assert.match(await readFile(summary, "utf8"), /Failed nodes/);
  assert.equal(await readFile(outputs, "utf8"), "run-id=run-1\noutcome=regression\n");
});
