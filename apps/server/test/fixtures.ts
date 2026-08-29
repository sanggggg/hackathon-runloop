import type { NodeResult, Run, Suite } from "@branchpoint/schema";

export function makeSuite(id = "suite-1"): Suite {
  return {
    id,
    name: id,
    repo: {
      url: "https://github.com/example/app",
      ref: "0123456789012345678901234567890123456789",
      buildCmd: "pnpm build",
      startCmd: "pnpm start",
      port: 3000,
    },
    blueprintId: "bpt_example",
    fixture: {
      snapshotId: "snp_example",
      ref: "0123456789012345678901234567890123456789",
      description: "signed in",
    },
    tree: [
      {
        id: "root",
        parentId: null,
        label: "Signed in",
        intent: "Begin from a signed-in account",
        kind: "fixture",
        state: "verified",
      },
      {
        id: "goal",
        parentId: "root",
        label: "Finish setup",
        intent: "Finish the setup flow",
        expectedOutcome: "The workspace is ready",
        kind: "goal",
        state: "verified",
      },
    ],
  };
}

export function makeResult(nodeId = "goal"): NodeResult {
  return {
    nodeId,
    status: "pass",
    resolvedTo: '"Finish setup" button',
    devboxId: "dbx_test",
    elapsedMs: 25,
    log: [{ t: 25, text: "finished", level: "info" }],
  };
}

export function makeRun(
  status: NonNullable<Run["executionStatus"]> = "succeeded",
  id = "run-1",
): Run {
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
  return {
    id,
    suiteId: "suite-1",
    ref: "0123456789012345678901234567890123456789",
    createdAt: "2026-08-29T20:00:00.000Z",
    startedAt: "2026-08-29T20:00:01.000Z",
    ...(terminal ? { finishedAt: "2026-08-29T20:00:02.000Z" } : {}),
    executionStatus: status,
    fixtureSnapshotId: "snp_example",
    results: status === "queued" ? [] : [makeResult()],
    discovered: [],
    costUsd: 0,
    wallClockMs: terminal ? 1_000 : 500,
    sequentialEstimateMs: terminal ? 1_000 : 500,
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
