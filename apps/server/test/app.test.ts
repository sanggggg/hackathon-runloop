import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Run } from "@branchpoint/schema";
import { LocalArtifactStore, type RunInput } from "@branchpoint/engine";
import { createBranchpointHttpServer } from "../src/app.js";
import { RunService, type RunExecutor } from "../src/run-service.js";
import { JsonFileStore } from "../src/store.js";
import { makeResult, makeSuite, waitFor } from "./fixtures.js";

const TOKEN = "test-api-token";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const quietLogger = { info() {}, error() {} };

class ImmediateExecutor implements RunExecutor {
  readonly configured = true;

  async run(input: RunInput): Promise<Run> {
    const startedAt = new Date().toISOString();
    const partial: Run = {
      id: input.runId ?? "generated",
      suiteId: input.suite.id,
      ref: input.ref ?? input.suite.repo.ref,
      startedAt,
      fixtureSnapshotId: input.suite.fixture.snapshotId,
      results: [makeResult()],
      discovered: [],
      costUsd: 0,
      wallClockMs: 25,
      sequentialEstimateMs: 25,
    };
    await input.onProgress?.(partial);
    return { ...partial, finishedAt: new Date().toISOString() };
  }
}

interface TestApp {
  baseUrl: string;
  service: RunService;
  artifacts: LocalArtifactStore;
}

async function startApp(
  t: test.TestContext,
  executor: RunExecutor = new ImmediateExecutor(),
  maxBodyBytes = 1_048_576,
  apiToken: string | undefined = TOKEN,
): Promise<TestApp> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branchpoint-app-test-"));
  const store = new JsonFileStore(path.join(directory, "server.json"));
  const artifacts = new LocalArtifactStore(path.join(directory, "artifacts"));
  let sequence = 0;
  const service = new RunService({
    store,
    executor,
    createId: () => `run-${++sequence}`,
    logger: quietLogger,
  });
  await service.initialize();
  const server = createBranchpointHttpServer({
    service,
    artifactStore: artifacts,
    ...(apiToken ? { apiToken } : {}),
    corsOrigins: new Set(["http://localhost:3000"]),
    maxBodyBytes,
    logger: quietLogger,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  t.after(async () => {
    await service.shutdown();
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, service, artifacts };
}

function apiFetch(baseUrl: string, pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

test("public probes, auth, and CORS preflight are enforced", async (t) => {
  const app = await startApp(t);
  const root = await fetch(`${app.baseUrl}/`);
  assert.equal(root.status, 200);
  assert.equal((await root.json()).name, "branchpoint-server");
  assert.equal((await fetch(`${app.baseUrl}/healthz`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/readyz`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/openapi.json`)).status, 200);

  const unauthorized = await fetch(`${app.baseUrl}/suites`);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /Bearer/);

  const preflight = await fetch(`${app.baseUrl}/runs`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "POST",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:3000");

  const forbidden = await fetch(`${app.baseUrl}/runs`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(forbidden.status, 403);
});

test("a disallowed simple cross-origin request cannot mutate an insecure local server", async (t) => {
  const app = await startApp(t, new ImmediateExecutor(), 1_048_576, undefined);
  const response = await fetch(`${app.baseUrl}/runs/not-a-run/cancel`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "origin_not_allowed");
});

test("suite registration, tree updates, run polling, and filtering share one HTTP contract", async (t) => {
  const app = await startApp(t);
  const suite = makeSuite();
  const created = await apiFetch(app.baseUrl, "/suites", {
    method: "POST",
    body: JSON.stringify(suite),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), suite);

  const whitespaceId = await apiFetch(app.baseUrl, "/suites", {
    method: "POST",
    body: JSON.stringify(makeSuite(" suite-with-space ")),
  });
  assert.equal(whitespaceId.status, 422);
  assert.match(JSON.stringify(await whitespaceId.json()), /must not have leading or trailing whitespace/);

  const duplicate = await apiFetch(app.baseUrl, "/suites", {
    method: "POST",
    body: JSON.stringify(suite),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, "suite_exists");

  const invalidTree = await apiFetch(app.baseUrl, `/suites/${suite.id}`, {
    method: "PATCH",
    body: JSON.stringify({ tree: suite.tree.slice(1) }),
  });
  assert.equal(invalidTree.status, 422);
  assert.equal((await invalidTree.json()).code, "invalid_suite");

  const renamedTree = suite.tree.map((node) =>
    node.id === "goal" ? { ...node, label: "Complete onboarding" } : node,
  );
  const patched = await apiFetch(app.baseUrl, `/suites/${suite.id}`, {
    method: "PATCH",
    body: JSON.stringify({ tree: renamedTree }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).tree[1].label, "Complete onboarding");

  const started = await apiFetch(app.baseUrl, "/runs", {
    method: "POST",
    body: JSON.stringify({ suiteId: suite.id, ref: "target-sha" }),
  });
  assert.equal(started.status, 202);
  const { runId } = (await started.json()) as { runId: string };
  await waitFor(async () => {
    const response = await apiFetch(app.baseUrl, `/runs/${runId}`);
    const run = (await response.json()) as Run;
    return run.executionStatus === "succeeded";
  });

  const runResponse = await apiFetch(app.baseUrl, `/runs/${runId}`);
  const run = (await runResponse.json()) as Run;
  assert.equal(run.ref, "target-sha");
  assert.equal(run.executionStatus, "succeeded");
  assert.equal(run.results[0]?.nodeId, "goal");
  assert(run.finishedAt);

  const filtered = await apiFetch(app.baseUrl, `/runs?suiteId=${suite.id}`);
  assert.deepEqual(((await filtered.json()) as Run[]).map((value) => value.id), [runId]);
  const empty = await apiFetch(app.baseUrl, "/runs?suiteId=other");
  assert.deepEqual(await empty.json(), []);
});

test("nested screenshot ids are served as PNGs and traversal is rejected", async (t) => {
  const app = await startApp(t);
  const id = await app.artifacts.saveScreenshot({
    runId: "run/with/slashes",
    suiteId: "suite-1",
    nodeId: "goal",
    containerId: "dbx-1",
    contentType: "image/png",
    data: PNG,
  });
  assert(id.includes("/"));

  const screenshot = await apiFetch(app.baseUrl, `/screenshots/${id}`);
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()), PNG);

  const traversal = await apiFetch(app.baseUrl, "/screenshots/%2E%2E%2Fserver.json");
  assert.equal(traversal.status, 400);
  assert.equal((await traversal.json()).code, "invalid_screenshot_id");

  const missing = await apiFetch(app.baseUrl, "/screenshots/run/missing.png");
  assert.equal(missing.status, 404);
});

test("body limits and JSON content types fail with stable API errors", async (t) => {
  const app = await startApp(t, new ImmediateExecutor(), 64);
  const tooLarge = await apiFetch(app.baseUrl, "/runs", {
    method: "POST",
    body: JSON.stringify({ suiteId: "x".repeat(100) }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, "body_too_large");

  const wrongType = await fetch(`${app.baseUrl}/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "text/plain",
    },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).code, "unsupported_media_type");
});

test("readiness and run starts report an unconfigured engine without blocking suite APIs", async (t) => {
  const app = await startApp(t, {
    configured: false,
    async run() {
      throw new Error("must not run");
    },
  });
  assert.equal((await fetch(`${app.baseUrl}/readyz`)).status, 503);

  const suiteResponse = await apiFetch(app.baseUrl, "/suites", {
    method: "POST",
    body: JSON.stringify(makeSuite()),
  });
  assert.equal(suiteResponse.status, 201);
  const start = await apiFetch(app.baseUrl, "/runs", {
    method: "POST",
    body: JSON.stringify({ suiteId: "suite-1" }),
  });
  assert.equal(start.status, 503);
  assert.equal((await start.json()).code, "engine_not_configured");
});
