import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BranchpointEngine,
  createRunloopEngine,
  LocalArtifactStore,
  resolveBrowserAgentPath,
  RunloopClient,
  RunloopRuntime,
} from "../src/index.js";

function packageRoot(): string {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(path.dirname(testDirectory)) === "dist"
    ? path.resolve(testDirectory, "../..")
    : path.resolve(testDirectory, "..");
}

test("browser agent resolution supports source and compiled module layouts", async () => {
  const root = packageRoot();
  const expected = path.join(root, "runner", "browser-agent.py");
  const sourceModule = pathToFileURL(path.join(root, "src", "runloop-engine-factory.ts"));
  const compiledModule = pathToFileURL(
    path.join(root, "dist", "src", "runloop-engine-factory.js"),
  );

  assert.equal(await resolveBrowserAgentPath(sourceModule), expected);
  assert.equal(await resolveBrowserAgentPath(compiledModule), expected);
  assert.equal(await resolveBrowserAgentPath(), expected);
  const source = await readFile(expected, "utf8");
  assert.match(source, /^#!\/usr\/bin\/env python3/);
  assert.match(source, /PROTOCOL_VERSION = 1/);
});

test("createRunloopEngine assembles the shared production bundle", async () => {
  const artifactDir = path.join(os.tmpdir(), "branchpoint-factory-test-artifacts");
  const bundle = await createRunloopEngine({
    runloopApiKey: "test-runloop-key",
    maxConcurrency: 3,
    artifactDir,
  });

  assert(bundle.engine instanceof BranchpointEngine);
  assert(bundle.client instanceof RunloopClient);
  assert(bundle.runtime instanceof RunloopRuntime);
  assert(bundle.artifactStore instanceof LocalArtifactStore);
  assert.equal(bundle.artifactStore.rootDirectory, path.resolve(artifactDir));
});

test("createRunloopEngine requires OpenRouter model and secret name together", async () => {
  await assert.rejects(
    createRunloopEngine({
      runloopApiKey: "test-runloop-key",
      openrouterModel: "test/model",
    }),
    /openrouterModel and openrouterSecret must be configured together/,
  );
  await assert.rejects(
    createRunloopEngine({
      runloopApiKey: "test-runloop-key",
      openrouterSecret: "RUNLOOP_SECRET_NAME",
    }),
    /openrouterModel and openrouterSecret must be configured together/,
  );
});
