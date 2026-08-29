import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalArtifactStore } from "../src/artifact-store.js";

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test("LocalArtifactStore persists a content-addressed PNG below its root", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "branchpoint-artifacts-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new LocalArtifactStore(directory);
  const artifact = {
    runId: "run / 42",
    suiteId: "suite",
    nodeId: "team choice",
    containerId: "box-1",
    contentType: "image/png" as const,
    data: PNG,
  };

  const first = await store.saveScreenshot(artifact);
  const second = await store.saveScreenshot(artifact);

  assert.equal(first, second, "the stable id should be content-addressed");
  assert(!first.startsWith("/"));
  assert.deepEqual(new Uint8Array(await readFile(store.resolveScreenshot(first))), PNG);
  assert.throws(() => store.resolveScreenshot("../escape.png"), /must not escape/);
  await assert.rejects(
    store.saveScreenshot({ ...artifact, data: Uint8Array.from([1, 2, 3]) }),
    /not a PNG/,
  );
});
