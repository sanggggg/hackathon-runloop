import assert from "node:assert/strict";
import test from "node:test";
import type { Run, Suite } from "@branchpoint/schema";
import { ApiClient } from "../src/client.js";
import { ApiError, RemoteError } from "../src/errors.js";

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function run(status: Run["executionStatus"] = "running"): Run {
  return {
    id: "run/one",
    suiteId: "suite-1",
    ref: "deadbeef",
    startedAt: "2026-08-29T00:00:00.000Z",
    executionStatus: status,
    fixtureSnapshotId: "snapshot",
    results: [],
    discovered: [],
    costUsd: 0,
    wallClockMs: 0,
    sequentialEstimateMs: 0,
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

test("POST start is authenticated, encoded as JSON, and never retried", async () => {
  let calls = 0;
  let captured: RequestInit | undefined;
  const client = new ApiClient({
    baseUrl: "https://api.example/",
    token: "top-secret",
    fetchImpl: (async (_url, init) => {
      calls += 1;
      captured = init;
      return response({ code: "server_draining", error: "try later" }, 503);
    }) as typeof fetch,
    sleep: async () => {},
  });
  await assert.rejects(() => client.startRun({
    suiteId: "suite-1",
    ref: "sha",
  }), (error: unknown) => {
    assert(error instanceof ApiError);
    assert.equal(error.code, "server_draining");
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(new Headers(captured?.headers).get("authorization"), "Bearer top-secret");
  assert.equal(captured?.redirect, "error");
  assert.deepEqual(JSON.parse(String(captured?.body)), {
    suiteId: "suite-1",
    ref: "sha",
  });
});

test("GET retries are bounded and path/query identifiers are encoded", async () => {
  const urls: string[] = [];
  let calls = 0;
  const client = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    fetchImpl: (async (url) => {
      urls.push(String(url));
      calls += 1;
      if (calls < 3) return response({ error: "temporary" }, 503);
      return response(run());
    }) as typeof fetch,
    sleep: async () => {},
  });
  assert.equal((await client.getRun("run/one")).id, "run/one");
  assert.equal(calls, 3);
  assert(urls.every((url) => url.endsWith("/runs/run%2Fone")));

  const queryClient = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    fetchImpl: (async (url) => {
      urls.push(String(url));
      return response([]);
    }) as typeof fetch,
  });
  await queryClient.listRuns("suite/a b");
  assert(urls.at(-1)?.endsWith("/runs?suiteId=suite%2Fa%20b"));
});

test("GET retries rate limits, honors a bounded Retry-After, and validates NodeResult verdicts", async () => {
  const delays: number[] = [];
  let calls = 0;
  const client = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    sleep: async (delay) => { delays.push(delay); },
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "retry-after": "60" },
        });
      }
      return response({ ...run("succeeded"), results: [{ nodeId: "goal", status: "maybe" }] });
    }) as typeof fetch,
  });
  await assert.rejects(() => client.getRun("run"), /invalid NodeResult/);
  assert.deepEqual(delays, [5_000]);
  assert.equal(calls, 2);
});

test("each request has a deadline and POST timeout is not retried", async () => {
  let calls = 0;
  const client = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    requestTimeoutMs: 5,
    fetchImpl: (async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => client.startRun({ suiteId: "suite" }),
    (error: unknown) => error instanceof RemoteError && error.code === "request_timeout",
  );
  assert.equal(calls, 1);
});

test("the API bearer token is redacted from reflected server errors", async () => {
  const apiToken = "api-bearer-secret";
  const client = new ApiClient({
    baseUrl: "https://api.example",
    token: apiToken,
    fetchImpl: (async () =>
      response(
        {
          code: "clone_failed",
          error: `request rejected for ${apiToken}`,
          details: [`never expose ${apiToken}`],
        },
        422,
      )) as typeof fetch,
  });

  await assert.rejects(
    () => client.startRun({ suiteId: "suite-1" }),
    (error: unknown) => {
      assert(error instanceof ApiError);
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      assert.equal(serialized.includes(apiToken), false);
      assert.equal(error.message, "request rejected for [REDACTED]");
      return true;
    },
  );
});

test("API errors preserve safe diagnostics and malformed documents fail as protocol errors", async () => {
  const errorClient = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    fetchImpl: (async () =>
      response(
        { code: "unauthorized", error: "bad token", requestId: "request-1", details: ["detail"] },
        401,
      )) as typeof fetch,
  });
  await assert.rejects(() => errorClient.listSuites(), (error: unknown) => {
    assert(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.requestId, "request-1");
    assert.deepEqual(error.details, ["detail"]);
    return true;
  });

  const malformed = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    fetchImpl: (async () => response({ id: "run", results: [] })) as typeof fetch,
  });
  await assert.rejects(() => malformed.getRun("run"), RemoteError);

  const suites = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    fetchImpl: (async () => response([suite()])) as typeof fetch,
  });
  assert.equal((await suites.listSuites())[0]?.id, "suite-1");

  const rootOnlyRun = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    fetchImpl: (async () => response(run("succeeded"))) as typeof fetch,
  });
  assert.equal((await rootOnlyRun.getRun("run")).results.length, 0);
});

test("network GET failures stop after the configured attempt bound", async () => {
  let calls = 0;
  const client = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    maxGetAttempts: 2,
    sleep: async () => {},
    fetchImpl: (async () => {
      calls += 1;
      throw new Error("offline");
    }) as typeof fetch,
  });
  await assert.rejects(() => client.listRuns(), /could not reach/);
  assert.equal(calls, 2);
});
