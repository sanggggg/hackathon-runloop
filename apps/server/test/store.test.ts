import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StoreConflictError } from "../src/errors.js";
import { JsonFileStore } from "../src/store.js";
import { makeRun, makeSuite } from "./fixtures.js";

async function createStore(t: test.TestContext): Promise<{ store: JsonFileStore; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branchpoint-store-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileStore(path.join(directory, "server.json"));
  await store.initialize();
  return { store, directory };
}

test("JSON store persists suites and runs across instances without temp-file residue", async (t) => {
  const { store, directory } = await createStore(t);
  await store.insertSuite(makeSuite());
  await store.insertRun(makeRun("succeeded"));

  const reopened = new JsonFileStore(path.join(directory, "server.json"));
  await reopened.initialize();
  assert.deepEqual(await reopened.getSuite("suite-1"), makeSuite());
  assert.deepEqual(await reopened.getRun("run-1"), makeRun("succeeded"));
  assert.deepEqual(await readdir(directory), ["server.json"]);
});

test("failed mutations roll back in-memory state and preserve the committed file", async (t) => {
  const { store, directory } = await createStore(t);
  await store.insertSuite(makeSuite());
  await assert.rejects(store.insertSuite(makeSuite()), StoreConflictError);
  assert.equal((await store.listSuites()).length, 1);

  const reopened = new JsonFileStore(path.join(directory, "server.json"));
  await reopened.initialize();
  assert.equal((await reopened.listSuites()).length, 1);
});

test("startup recovery terminalizes every non-terminal persisted run", async (t) => {
  const { store } = await createStore(t);
  await store.insertRun(makeRun("queued", "queued"));
  await store.insertRun(makeRun("running", "running"));
  await store.insertRun(makeRun("cancelling", "cancelling"));
  await store.insertRun(makeRun("succeeded", "done"));

  const recovered = await store.recoverInterruptedRuns("2026-08-29T21:00:00.000Z");
  assert.deepEqual(recovered.map((run) => run.id), ["queued", "running", "cancelling"]);
  for (const id of ["queued", "running", "cancelling"]) {
    const run = await store.getRun(id);
    assert.equal(run?.executionStatus, "failed");
    assert.equal(run?.error?.code, "server_restarted");
    assert.equal(run?.finishedAt, "2026-08-29T21:00:00.000Z");
  }
  assert.equal((await store.getRun("done"))?.executionStatus, "succeeded");
});

test("run listing is newest-first and supports suite filtering", async (t) => {
  const { store } = await createStore(t);
  const older = makeRun("succeeded", "older");
  const newer = {
    ...makeRun("succeeded", "newer"),
    suiteId: "suite-2",
    createdAt: "2026-08-30T20:00:00.000Z",
  };
  await store.insertRun(older);
  await store.insertRun(newer);

  assert.deepEqual((await store.listRuns()).map((run) => run.id), ["newer", "older"]);
  assert.deepEqual((await store.listRuns("suite-1")).map((run) => run.id), ["older"]);
});
