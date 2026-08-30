import assert from "node:assert/strict";
import test from "node:test";
import type { Node, Repo } from "@branchpoint/schema";
import type {
  RunloopCallOptions,
  RunloopClient,
  RunloopDevbox,
  RunloopDevboxCreateParams,
  RunloopExecuteOptions,
  RunloopExecution,
  RunloopSnapshot,
  RunloopSnapshotParams,
  RunloopStartOptions,
} from "../src/runloop-client.js";
import type { ScreenshotArtifact, ScreenshotArtifactStore } from "../src/artifact-store.js";
import { RunloopRuntime } from "../src/runloop-runtime.js";
import type { AgentNodeRequest, RuntimeContext } from "../src/types.js";

type ClientEvent =
  | { op: "createFromSnapshot"; snapshotId: string }
  | { op: "execute"; devboxId: string; command: string }
  | { op: "start"; devboxId: string; command: string }
  | { op: "writeFile"; devboxId: string; filePath: string }
  | { op: "readFile"; devboxId: string; filePath: string }
  | { op: "downloadFile"; devboxId: string; filePath: string }
  | { op: "snapshotDisk"; devboxId: string }
  | { op: "deleteSnapshot"; snapshotId: string }
  | { op: "shutdown"; devboxId: string };

class RecordingRunloopClient {
  readonly events: ClientEvent[] = [];
  readonly createCalls: Array<{
    snapshotId: string;
    params: Omit<RunloopDevboxCreateParams, "snapshot_id" | "blueprint_id" | "blueprint_name">;
    options: RunloopCallOptions;
  }> = [];
  readonly executeCalls: Array<{
    devboxId: string;
    command: string;
    options: RunloopExecuteOptions;
  }> = [];
  readonly startCalls: Array<{
    devboxId: string;
    command: string;
    options: RunloopStartOptions;
  }> = [];
  readonly writeCalls: Array<{
    devboxId: string;
    filePath: string;
    contents: string;
    options: RunloopCallOptions;
  }> = [];
  readonly readCalls: Array<{
    devboxId: string;
    filePath: string;
    options: RunloopCallOptions;
  }> = [];
  readonly downloadCalls: Array<{
    devboxId: string;
    filePath: string;
    options: RunloopCallOptions;
  }> = [];
  readonly snapshotCalls: Array<{
    devboxId: string;
    params: RunloopSnapshotParams;
    options: RunloopCallOptions;
  }> = [];
  readonly deleteCalls: Array<{ snapshotId: string; options: RunloopCallOptions }> = [];
  readonly shutdownCalls: Array<{
    devboxId: string;
    options: RunloopCallOptions & { force?: boolean };
  }> = [];
  readonly readResults: string[] = [];
  readonly downloadResults: Uint8Array[] = [];

  asClient(): RunloopClient {
    return this as unknown as RunloopClient;
  }

  async createFromSnapshot(
    snapshotId: string,
    params: Omit<RunloopDevboxCreateParams, "snapshot_id" | "blueprint_id" | "blueprint_name"> = {},
    options: RunloopCallOptions = {},
  ): Promise<RunloopDevbox> {
    this.createCalls.push({ snapshotId, params: structuredClone(params), options });
    this.events.push({ op: "createFromSnapshot", snapshotId });
    return {
      id: `created-${this.createCalls.length}`,
      status: "running",
      create_time_ms: 1,
      end_time_ms: null,
      metadata: {},
    };
  }

  async execute(
    devboxId: string,
    command: string,
    options: RunloopExecuteOptions = {},
  ): Promise<RunloopExecution> {
    this.executeCalls.push({ devboxId, command, options });
    this.events.push({ op: "execute", devboxId, command });
    return {
      devbox_id: devboxId,
      execution_id: `exec-${this.executeCalls.length}`,
      status: "completed",
      stdout: "",
      stderr: "",
      exit_status: 0,
    };
  }

  async start(
    devboxId: string,
    command: string,
    options: RunloopStartOptions = {},
  ): Promise<RunloopExecution> {
    this.startCalls.push({ devboxId, command, options });
    this.events.push({ op: "start", devboxId, command });
    return {
      devbox_id: devboxId,
      execution_id: `start-${this.startCalls.length}`,
      status: "running",
      stdout: "",
      stderr: "",
      exit_status: null,
    };
  }

  async writeFile(
    devboxId: string,
    filePath: string,
    contents: string,
    options: RunloopCallOptions = {},
  ): Promise<void> {
    this.writeCalls.push({ devboxId, filePath, contents, options });
    this.events.push({ op: "writeFile", devboxId, filePath });
  }

  async readFile(
    devboxId: string,
    filePath: string,
    options: RunloopCallOptions = {},
  ): Promise<string> {
    this.readCalls.push({ devboxId, filePath, options });
    this.events.push({ op: "readFile", devboxId, filePath });
    const value = this.readResults.shift();
    if (value === undefined) throw new Error(`no fake read result for '${filePath}'`);
    return value;
  }

  async downloadFile(
    devboxId: string,
    filePath: string,
    options: RunloopCallOptions = {},
  ): Promise<Uint8Array> {
    this.downloadCalls.push({ devboxId, filePath, options });
    this.events.push({ op: "downloadFile", devboxId, filePath });
    return (
      this.downloadResults.shift() ??
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    );
  }

  async snapshotDisk(
    devboxId: string,
    params: RunloopSnapshotParams = {},
    options: RunloopCallOptions = {},
  ): Promise<RunloopSnapshot> {
    this.snapshotCalls.push({ devboxId, params: structuredClone(params), options });
    this.events.push({ op: "snapshotDisk", devboxId });
    return {
      id: `snapshot-${this.snapshotCalls.length}`,
      create_time_ms: 1,
      metadata: {},
      source_devbox_id: devboxId,
    };
  }

  async deleteSnapshot(snapshotId: string, options: RunloopCallOptions = {}): Promise<void> {
    this.deleteCalls.push({ snapshotId, options });
    this.events.push({ op: "deleteSnapshot", snapshotId });
  }

  async shutdown(
    devboxId: string,
    options: RunloopCallOptions & { force?: boolean } = {},
  ): Promise<RunloopDevbox> {
    this.shutdownCalls.push({ devboxId, options });
    this.events.push({ op: "shutdown", devboxId });
    return {
      id: devboxId,
      status: "shutdown",
      create_time_ms: 1,
      end_time_ms: 2,
      metadata: {},
    };
  }
}

class RecordingArtifactStore implements ScreenshotArtifactStore {
  readonly artifacts: ScreenshotArtifact[] = [];

  async saveScreenshot(artifact: ScreenshotArtifact): Promise<string> {
    this.artifacts.push(artifact);
    return `${artifact.runId}/${artifact.nodeId}.png`;
  }
}

const repo: Repo = {
  url: "https://github.com/example/demo.git",
  ref: "main",
  buildCmd: "pnpm build",
  startCmd: "QA_PROFILE=demo-head pnpm start -- --host 127.0.0.1",
  port: 4173,
};

function context(
  kind: RuntimeContext["kind"],
  branchPath: string[] = [],
  signal?: AbortSignal,
): RuntimeContext {
  return {
    runId: "run 42",
    suiteId: "suite/onboarding",
    ref: "feature/ref",
    repo,
    branchPath,
    sourceSnapshotId: kind === "root" ? "fixture-snapshot" : "parent-snapshot",
    kind,
    ...(signal ? { signal } : {}),
  };
}

function request(kind: Node["kind"] = "step"): AgentNodeRequest {
  const node: Node = {
    id: kind === "goal" ? "finish" : "team",
    parentId: "root",
    label: kind === "goal" ? "Finish" : "Team plan",
    intent: kind === "goal" ? "Finish setup" : "Choose team",
    ...(kind === "goal" ? { expectedOutcome: "Workspace is ready" } : {}),
    kind,
    state: "verified",
  };
  return {
    protocolVersion: 1,
    runId: "run 42",
    suiteId: "suite/onboarding",
    ref: "feature/ref",
    node,
    isGoal: kind === "goal",
    ...(kind === "goal" ? { expectedOutcome: node.expectedOutcome } : {}),
    branchPath: [],
  };
}

function runtime(
  client: RecordingRunloopClient,
  signal?: AbortSignal,
  artifactStore: ScreenshotArtifactStore = new RecordingArtifactStore(),
): RunloopRuntime {
  return new RunloopRuntime({
    client: client.asClient(),
    artifactStore,
    workDir: "workspace",
    agentCommand: "python3 .branchpoint/browser-agent.py --once",
    bootstrapFiles: {
      ".branchpoint/browser-agent.py": "print('agent')\n",
      "agent-assets/config.json": "{}\n",
    },
    environmentVariables: { BRANCHPOINT_OPENROUTER_MODEL: "test/model" },
    secrets: { OPENROUTER_API_KEY: "BRANCHPOINT_TEST_OPENROUTER" },
    healthPath: "/healthz",
    ...(signal ? { signal } : {}),
  });
}

test("root prepare checks out/builds and injects bootstrap files; fork prepare relies on snapshot inheritance", async (t) => {
  await t.test("root", async () => {
    const client = new RecordingRunloopClient();
    const signal = new AbortController().signal;
    await runtime(client).prepare({ id: "root-box" }, context("root", [], signal));

    assert.deepEqual(client.events.map((event) => event.op), [
      "execute",
      "execute",
      "writeFile",
      "writeFile",
      "start",
      "execute",
    ]);
    assert.equal(client.executeCalls.length, 3);
    assert.match(client.executeCalls[0]?.command ?? "", /git fetch --depth=1 origin --/);
    assert.match(client.executeCalls[0]?.command ?? "", /pnpm build/);
    assert.match(client.executeCalls[1]?.command ?? "", /\/home\/user\/workspace\/agent-assets/);
    assert.deepEqual(client.writeCalls.map((call) => call.filePath), [
      "workspace/.branchpoint/browser-agent.py",
      "workspace/agent-assets/config.json",
    ]);
    assert.equal(client.startCalls.length, 1);
    assert.match(client.startCalls[0]?.command ?? "", /PORT='4173'/);
    assert.match(
      client.startCalls[0]?.command ?? "",
      /QA_PROFILE=demo-head pnpm start -- --host 127\.0\.0\.1/,
    );
    assert.doesNotMatch(client.startCalls[0]?.command ?? "", /exec QA_PROFILE=/);
    assert.match(client.executeCalls[2]?.command ?? "", /http:\/\/127\.0\.0\.1:4173\/healthz/);
    assert(client.executeCalls.every((call) => call.options.signal === signal));
    assert(client.writeCalls.every((call) => call.options.signal === signal));
    assert(client.startCalls.every((call) => call.options.signal === signal));
  });

  await t.test("fork", async () => {
    const client = new RecordingRunloopClient();
    const signal = new AbortController().signal;
    await runtime(client).prepare({ id: "fork-box" }, context("fork", ["team"], signal));

    assert.deepEqual(client.events.map((event) => event.op), ["execute", "start", "execute"]);
    assert.equal(client.writeCalls.length, 0, "bootstrap files must be inherited, not rewritten in forks");
    assert.doesNotMatch(client.executeCalls[0]?.command ?? "", /git fetch|pnpm build|agent-assets/);
    assert.match(client.executeCalls[0]?.command ?? "", /\.branchpoint\/requests/);
    assert.match(client.executeCalls[0]?.command ?? "", /\.branchpoint\/results/);
    assert.match(client.startCalls[0]?.command ?? "", /PORT='4173'/);
    assert.match(client.executeCalls[1]?.command ?? "", /\/healthz/);
    assert(client.executeCalls.every((call) => call.options.signal === signal));
    assert(client.startCalls.every((call) => call.options.signal === signal));
  });
});

test("create, snapshot, delete, and shutdown forward branch identity and cleanup timeouts", async () => {
  const client = new RecordingRunloopClient();
  const controller = new AbortController();
  const value = runtime(client);
  const forkContext = context("fork", ["team", "invite"], controller.signal);

  const created = await value.createFromSnapshot("source-snapshot", forkContext);
  const captured = await value.snapshot(created, forkContext);
  await value.deleteSnapshot(captured);
  await value.shutdown(created);

  assert.equal(created.id, "created-1");
  assert.equal(captured.id, "snapshot-1");
  assert.equal(client.createCalls[0]?.snapshotId, "source-snapshot");
  assert.deepEqual(client.createCalls[0]?.params.environment_variables, {
    BRANCHPOINT_OPENROUTER_MODEL: "test/model",
  });
  assert.deepEqual(client.createCalls[0]?.params.secrets, {
    OPENROUTER_API_KEY: "BRANCHPOINT_TEST_OPENROUTER",
  });
  assert.deepEqual(client.createCalls[0]?.params.metadata, {
    branchpoint_run_id: "run 42",
    branchpoint_suite_id: "suite/onboarding",
    branchpoint_ref: "feature/ref",
    branchpoint_kind: "fork",
    branchpoint_path: JSON.stringify(["team", "invite"]),
  });
  assert.equal(client.createCalls[0]?.options.signal, controller.signal);
  assert.deepEqual(client.snapshotCalls[0]?.params.metadata, {
    branchpoint_run_id: "run 42",
    branchpoint_suite_id: "suite/onboarding",
    branchpoint_ref: "feature/ref",
    branchpoint_source_snapshot_id: "parent-snapshot",
    branchpoint_path: JSON.stringify(["team", "invite"]),
  });
  assert.equal(
    client.snapshotCalls[0]?.params.commit_message,
    "Branchpoint checkpoint at team / invite",
  );
  assert.equal(client.snapshotCalls[0]?.options.signal, controller.signal);
  assert.deepEqual(client.deleteCalls.map((call) => call.snapshotId), ["snapshot-1"]);
  assert.deepEqual(client.shutdownCalls.map((call) => call.devboxId), ["created-1"]);
  assert.equal(client.deleteCalls[0]?.options.signal, undefined, "cleanup must not inherit cancellation");
  assert.equal(client.shutdownCalls[0]?.options.signal, undefined, "cleanup must not inherit cancellation");
  assert.equal(client.shutdownCalls[0]?.options.force, true, "runtime cleanup must force-stop the app process");
});

test("executeNode writes the request, supplies branch environment, reads and validates the result", async () => {
  const client = new RecordingRunloopClient();
  const input = request("step");
  const agentResult = {
    status: "pass",
    resolvedTo: '"Team plan" card',
    resolvedLabel: "Team plan",
    elapsedMs: 25,
    modelCalls: 2,
    costUsd: 0.01,
    log: [{ t: 2, text: "clicked", level: "info" }],
    screenshotId: "/home/user/workspace/.branchpoint/screenshots/team-source.png",
    checkpoint: {
      path: "/home/user/workspace/.branchpoint/browser-checkpoint.json",
      url: "http://127.0.0.1:4173/team",
    },
  };
  client.readResults.push(JSON.stringify(agentResult));
  const artifactStore = new RecordingArtifactStore();
  const signal = new AbortController().signal;

  const persistedValue = runtime(client, undefined, artifactStore);
  const result = await persistedValue.executeNode(
    { id: "box-1" },
    input,
    context("fork", [], signal),
  );

  assert.deepEqual(result, { ...agentResult, screenshotId: "run 42/team.png" });
  assert.deepEqual(client.events.map((event) => event.op), [
    "execute",
    "writeFile",
    "execute",
    "readFile",
    "downloadFile",
  ]);
  assert.equal(client.writeCalls.length, 1);
  assert.match(client.writeCalls[0]?.filePath ?? "", /^workspace\/\.branchpoint\/requests\/team-/);
  assert.deepEqual(JSON.parse(client.writeCalls[0]?.contents ?? "null"), input);
  assert.match(client.readCalls[0]?.filePath ?? "", /^workspace\/\.branchpoint\/results\/team-/);

  const requestAbsolute = `/home/user/${client.writeCalls[0]?.filePath}`;
  const resultAbsolute = `/home/user/${client.readCalls[0]?.filePath}`;
  assert.match(client.executeCalls[0]?.command ?? "", new RegExp(`rm -f -- '${resultAbsolute}'`));
  const agentCommand = client.executeCalls[1]?.command ?? "";
  assert.match(agentCommand, new RegExp(`BRANCHPOINT_REQUEST_PATH='${requestAbsolute}'`));
  assert.match(agentCommand, new RegExp(`BRANCHPOINT_RESULT_PATH='${resultAbsolute}'`));
  assert.match(
    agentCommand,
    /BRANCHPOINT_CHECKPOINT_PATH='\/home\/user\/workspace\/\.branchpoint\/browser-checkpoint\.json'/,
  );
  assert.match(agentCommand, /BRANCHPOINT_APP_URL='http:\/\/127\.0\.0\.1:4173'/);
  assert.match(agentCommand, /BRANCHPOINT_RUN_ID='run 42'/);
  assert.match(agentCommand, /BRANCHPOINT_SUITE_ID='suite\/onboarding'/);
  assert.match(agentCommand, /BRANCHPOINT_REF='feature\/ref'/);
  assert.match(agentCommand, /python3 \.branchpoint\/browser-agent\.py --once/);
  assert.equal(client.executeCalls[1]?.options.lastN, 1_000);
  assert(client.executeCalls.every((call) => call.options.signal === signal));
  assert(client.writeCalls.every((call) => call.options.signal === signal));
  assert(client.readCalls.every((call) => call.options.signal === signal));
  assert(client.downloadCalls.every((call) => call.options.signal === signal));
  assert.deepEqual(client.downloadCalls.map((call) => call.filePath), [
    "workspace/.branchpoint/screenshots/team-source.png",
  ]);
  assert.equal(artifactStore.artifacts.length, 1);
  assert.deepEqual(
    {
      runId: artifactStore.artifacts[0]?.runId,
      suiteId: artifactStore.artifacts[0]?.suiteId,
      nodeId: artifactStore.artifacts[0]?.nodeId,
      containerId: artifactStore.artifacts[0]?.containerId,
      contentType: artifactStore.artifacts[0]?.contentType,
    },
    {
      runId: "run 42",
      suiteId: "suite/onboarding",
      nodeId: "team",
      containerId: "box-1",
      contentType: "image/png",
    },
  );
});

test("a passing non-goal result is rejected unless the browser agent persisted a checkpoint", async (t) => {
  await t.test("non-goal requires checkpoint", async () => {
    const client = new RecordingRunloopClient();
    client.readResults.push(JSON.stringify({
      status: "pass",
      resolvedTo: "Team plan",
      screenshotId: "/home/user/workspace/.branchpoint/screenshots/team.png",
    }));
    await assert.rejects(
      runtime(client).executeNode({ id: "box-1" }, request("step"), context("fork")),
      /must persist a checkpoint after passing non-goal node 'team'/,
    );
  });

  await t.test("non-goal checkpoint must use the configured fixed path", async () => {
    const client = new RecordingRunloopClient();
    client.readResults.push(JSON.stringify({
      status: "pass",
      resolvedTo: "Team plan",
      screenshotId: "/home/user/workspace/.branchpoint/screenshots/team.png",
      checkpoint: {
        path: "/home/user/workspace/other-checkpoint.json",
        url: "http://127.0.0.1:4173/team",
      },
    }));
    await assert.rejects(
      runtime(client).executeNode({ id: "box-1" }, request("step"), context("fork")),
      /checkpoint must be written to '\/home\/user\/workspace\/\.branchpoint\/browser-checkpoint\.json'/,
    );
  });

  await t.test("terminal goal may finish without another checkpoint", async () => {
    const client = new RecordingRunloopClient();
    client.readResults.push(JSON.stringify({
      status: "pass",
      resolvedTo: "Workspace",
      screenshotId: "/home/user/workspace/.branchpoint/screenshots/finish.png",
    }));
    const result = await runtime(client).executeNode(
      { id: "box-1" },
      request("goal"),
      context("fork", ["team"]),
    );
    assert.equal(result.status, "pass");
    assert.equal(result.checkpoint, undefined);
  });
});
