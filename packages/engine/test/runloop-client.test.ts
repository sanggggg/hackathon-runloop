import assert from "node:assert/strict";
import test from "node:test";
import {
  RunloopClient,
  RunloopCommandError,
  type RunloopDevbox,
  type RunloopExecution,
  type RunloopSnapshot,
} from "../src/runloop-client.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal?: AbortSignal | null;
}

type ScriptedReply = Response | ((call: FetchCall) => Response | Promise<Response>);

class ScriptedFetch {
  readonly calls: FetchCall[] = [];
  readonly #replies: ScriptedReply[];

  constructor(replies: ScriptedReply[]) {
    this.#replies = [...replies];
  }

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const call: FetchCall = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody) as unknown,
      signal: init?.signal,
    };
    this.calls.push(call);
    const reply = this.#replies.shift();
    assert(reply, `unexpected fetch: ${call.method} ${call.url}`);
    return typeof reply === "function" ? reply(call) : reply;
  }) as typeof globalThis.fetch;

  assertDrained(): void {
    assert.equal(this.#replies.length, 0, "not all scripted fetch responses were consumed");
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function devbox(status: RunloopDevbox["status"], id = "db/one"): RunloopDevbox {
  return {
    id,
    status,
    create_time_ms: 1,
    end_time_ms: null,
    metadata: {},
  };
}

function execution(
  status: RunloopExecution["status"],
  exitStatus: number | null = null,
): RunloopExecution {
  return {
    devbox_id: "db/one",
    execution_id: "exec/one",
    status,
    stdout: status === "completed" ? "done" : "",
    stderr: "",
    exit_status: exitStatus,
  };
}

function snapshot(id: string, sizeBytes?: number): RunloopSnapshot {
  return {
    id,
    create_time_ms: 1,
    metadata: {},
    source_devbox_id: "db/one",
    ...(sizeBytes === undefined ? {} : { size_bytes: sizeBytes }),
  };
}

function client(script: ScriptedFetch): RunloopClient {
  return new RunloopClient({
    apiKey: "test-key",
    baseUrl: "https://runloop.test/",
    fetch: script.fetch,
    timeouts: {
      requestMs: 5_000,
      createMs: 5_000,
      executeMs: 5_000,
      snapshotMs: 5_000,
      fileMs: 5_000,
      snapshotPollIntervalMs: 1,
    },
  });
}

test("createFromSnapshot waits for running and retries a 408 long-poll", async () => {
  const script = new ScriptedFetch([
    jsonResponse(devbox("scheduled")),
    new Response("server poll expired", { status: 408 }),
    jsonResponse(devbox("running")),
  ]);

  const created = await client(script).createFromSnapshot("snapshot / one", {
    name: "child",
    metadata: { branch: "team" },
  });

  assert.equal(created.status, "running");
  assert.equal(script.calls.length, 3);
  assert.equal(script.calls[0]?.url, "https://runloop.test/v1/devboxes");
  assert.equal(script.calls[0]?.method, "POST");
  assert.equal(script.calls[0]?.headers.get("Authorization"), "Bearer test-key");
  assert.deepEqual(script.calls[0]?.body, {
    name: "child",
    metadata: { branch: "team" },
    snapshot_id: "snapshot / one",
  });
  for (const poll of script.calls.slice(1)) {
    assert.equal(poll.url, "https://runloop.test/v1/devboxes/db%2Fone/wait_for_status");
    assert.deepEqual((poll.body as { statuses: string[] }).statuses, [
      "running",
      "failure",
      "shutdown",
    ]);
    assert.equal(typeof (poll.body as { timeout_seconds: unknown }).timeout_seconds, "number");
  }
  script.assertDrained();
});

test("a devbox allocated before readiness polling aborts is force-shutdown by an independent operation", async () => {
  const controller = new AbortController();
  const primary = new Error("caller cancelled readiness wait");
  const script = new ScriptedFetch([
    jsonResponse(devbox("scheduled", "orphan/devbox")),
    () => {
      controller.abort(primary);
      throw new Error("transport observed cancellation");
    },
    (call) => {
      assert.equal(call.signal?.aborted, false, "cleanup request inherited the cancelled signal");
      return jsonResponse(devbox("shutdown", "orphan/devbox"));
    },
  ]);

  await assert.rejects(
    client(script).createDevbox({}, { signal: controller.signal }),
    (error: unknown) => error === primary,
  );

  assert.deepEqual(
    script.calls.map((call) => `${call.method} ${call.url}`),
    [
      "POST https://runloop.test/v1/devboxes",
      "POST https://runloop.test/v1/devboxes/orphan%2Fdevbox/wait_for_status",
      "POST https://runloop.test/v1/devboxes/orphan%2Fdevbox/shutdown?force=true",
    ],
  );
  script.assertDrained();
});

test("execute uses execute_async, retries wait 408, forwards last_n, and validates exit status", async (t) => {
  await t.test("successful execution", async () => {
    const script = new ScriptedFetch([
      jsonResponse(execution("queued")),
      new Response("long poll expired", { status: 408 }),
      jsonResponse(execution("completed", 0)),
    ]);

    const result = await client(script).execute("db/one", "npm test", {
      shellName: "bash",
      attachStdin: false,
      lastN: 77,
    });

    assert.equal(result.exit_status, 0);
    assert.equal(script.calls[0]?.url, "https://runloop.test/v1/devboxes/db%2Fone/execute_async");
    assert.deepEqual(script.calls[0]?.body, {
      command: "npm test",
      shell_name: "bash",
      attach_stdin: false,
    });
    for (const wait of script.calls.slice(1)) {
      assert.equal(
        wait.url,
        "https://runloop.test/v1/devboxes/db%2Fone/executions/exec%2Fone/wait_for_status?last_n=77",
      );
      assert.deepEqual((wait.body as { statuses: string[] }).statuses, ["completed"]);
    }
    script.assertDrained();
  });

  await t.test("non-zero exit", async () => {
    const failed = { ...execution("completed", 17), stderr: "test failed" };
    const script = new ScriptedFetch([jsonResponse(failed)]);
    await assert.rejects(
      client(script).execute("db/one", "npm test"),
      (error: unknown) =>
        error instanceof RunloopCommandError &&
        error.execution.exit_status === 17 &&
        /test failed/.test(error.message),
    );
    script.assertDrained();
  });
});

test("snapshotDisk returns only on the exact complete status", async (t) => {
  await t.test("in_progress then complete", async () => {
    const initial = snapshot("snapshot/one");
    const completed = snapshot("snapshot/one", 42);
    const script = new ScriptedFetch([
      jsonResponse(initial),
      jsonResponse({ status: "in_progress" }),
      jsonResponse({ status: "complete", snapshot: completed }),
    ]);

    const result = await client(script).snapshotDisk("db/one", {
      name: "fork point",
      commit_message: "after team",
    });

    assert.deepEqual(result, completed);
    assert.equal(
      script.calls[0]?.url,
      "https://runloop.test/v1/devboxes/db%2Fone/snapshot_disk_async",
    );
    assert.deepEqual(script.calls[0]?.body, {
      name: "fork point",
      commit_message: "after team",
    });
    assert.equal(
      script.calls[1]?.url,
      "https://runloop.test/v1/devboxes/disk_snapshots/snapshot%2Fone/status",
    );
    assert.equal(script.calls[2]?.url, script.calls[1]?.url);
    script.assertDrained();
  });

  await t.test("completed is not accepted as an alias", async () => {
    const script = new ScriptedFetch([
      jsonResponse(snapshot("snapshot-2")),
      jsonResponse({ status: "completed" }),
    ]);
    await assert.rejects(
      client(script).snapshotDisk("db/one"),
      /returned unknown status 'completed'/,
    );
    script.assertDrained();
  });
});

test("an interrupted snapshot poll independently waits for exact complete, deletes the orphan, and rethrows", async () => {
  const controller = new AbortController();
  const primary = new Error("caller cancelled snapshot wait");
  const initial = snapshot("orphan/snapshot");
  const statusUrl =
    "https://runloop.test/v1/devboxes/disk_snapshots/orphan%2Fsnapshot/status";
  const script = new ScriptedFetch([
    jsonResponse(initial),
    () => {
      controller.abort(primary);
      throw new Error("transport observed cancellation");
    },
    (call) => {
      assert.equal(call.signal?.aborted, false, "cleanup poll inherited the cancelled signal");
      return jsonResponse({ status: "in_progress" });
    },
    (call) => {
      assert.equal(call.signal?.aborted, false, "cleanup poll inherited the cancelled signal");
      return jsonResponse({ status: "complete", snapshot: initial });
    },
    (call) => {
      assert.equal(call.signal?.aborted, false, "snapshot delete inherited the cancelled signal");
      return jsonResponse({});
    },
  ]);

  await assert.rejects(
    client(script).snapshotDisk("db/one", {}, { signal: controller.signal }),
    (error: unknown) => error === primary,
  );

  assert.deepEqual(
    script.calls.map((call) => `${call.method} ${call.url}`),
    [
      "POST https://runloop.test/v1/devboxes/db%2Fone/snapshot_disk_async",
      `GET ${statusUrl}`,
      `GET ${statusUrl}`,
      `GET ${statusUrl}`,
      "POST https://runloop.test/v1/devboxes/disk_snapshots/orphan%2Fsnapshot/delete",
    ],
  );
  script.assertDrained();
});

test("file APIs use home-relative paths and preserve binary downloads", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const script = new ScriptedFetch([
    jsonResponse({
      devbox_id: "db/one",
      stdout: "",
      stderr: "",
      exit_status: 0,
    }),
    new Response("checkpoint contents", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }),
    new Response(png, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    }),
  ]);
  const value = client(script);

  await value.writeFile("db/one", "workspace/request.json", "{\"ok\":true}");
  const contents = await value.readFile("db/one", "workspace/result.json");
  const downloaded = await value.downloadFile("db/one", "workspace/screenshots/final.png");

  assert.equal(contents, "checkpoint contents");
  assert.equal(
    script.calls[0]?.url,
    "https://runloop.test/v1/devboxes/db%2Fone/write_file_contents",
  );
  assert.deepEqual(script.calls[0]?.body, {
    file_path: "workspace/request.json",
    contents: "{\"ok\":true}",
  });
  assert.equal(
    script.calls[1]?.url,
    "https://runloop.test/v1/devboxes/db%2Fone/read_file_contents",
  );
  assert.deepEqual(script.calls[1]?.body, { file_path: "workspace/result.json" });
  assert.equal(script.calls[1]?.headers.get("Accept"), "text/plain");
  assert.deepEqual(downloaded, png);
  assert.equal(
    script.calls[2]?.url,
    "https://runloop.test/v1/devboxes/db%2Fone/download_file",
  );
  assert.deepEqual(script.calls[2]?.body, { path: "workspace/screenshots/final.png" });
  assert.equal(script.calls[2]?.headers.get("Accept"), "application/octet-stream");
  await assert.rejects(value.readFile("db/one", "/home/user/result.json"), /must be non-empty and relative/);
  await assert.rejects(value.downloadFile("db/one", "../secret.png"), /must be non-empty and relative/);
  assert.equal(script.calls.length, 3, "invalid paths must fail before fetch");
  script.assertDrained();
});
