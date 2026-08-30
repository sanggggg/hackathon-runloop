#!/usr/bin/env node
/**
 * Prepare a durable fixture snapshot for the Nimbus demo, and the Runloop
 * Secret the in-container resolver needs.
 *
 * `live-demo-e2e.mjs` builds the same fixture but deletes it on the way out,
 * because it is a self-contained test. The server needs one that survives, so
 * this does the same steps and keeps the result. The login script itself is
 * read out of the harness rather than copied, so the two cannot drift.
 *
 * Prints the snapshot id and the ready-to-register Suite JSON.
 *
 *   RUNLOOP_API_KEY=… OPENROUTER_API_KEY=… \
 *   BRANCHPOINT_DEMO_REPO_PATH=~/Desktop/hackathon-runloop-demo \
 *   node packages/engine/scripts/prepare-fixture.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RunloopClient } from "../dist/src/runloop-client.js";

const executeFile = promisify(execFile);
const engineRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const runloopKey = required("RUNLOOP_API_KEY");
const openrouterKey = required("OPENROUTER_API_KEY");
const demoPath = path.resolve(
  process.env.BRANCHPOINT_DEMO_REPO_PATH ?? path.join(engineRoot, "../../../hackathon-runloop-demo"),
);
const demoRef =
  process.env.BRANCHPOINT_DEMO_REF ?? "b36666c0351c94e5074e532f88cf8e70695549ea";
const demoRemote =
  process.env.BRANCHPOINT_DEMO_REMOTE ?? "https://github.com/sanggggg/hackathon-runloop-demo";
const secretName = process.env.BRANCHPOINT_OPENROUTER_SECRET ?? "BRANCHPOINT_OPENROUTER";
const model = process.env.BRANCHPOINT_OPENROUTER_MODEL ?? "google/gemini-3.1-flash-lite";
const suiteId = process.env.BRANCHPOINT_SUITE_ID ?? "nimbus-onboarding";

function required(name) {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is required\n`);
    process.exit(1);
  }
  return value;
}

const log = (message) => process.stderr.write(`  ${message}\n`);

/** The harness owns this script; read it rather than keeping a second copy. */
async function loginScript() {
  const harness = await readFile(path.join(engineRoot, "scripts", "live-demo-e2e.mjs"), "utf8");
  const open = harness.indexOf("const fixtureLoginSource = String.raw`");
  assert.notEqual(open, -1, "live-demo-e2e.mjs no longer defines fixtureLoginSource");
  const start = harness.indexOf("`", open) + 1;
  const end = harness.indexOf("\n`;", start);
  assert.ok(end > start, "could not find the end of fixtureLoginSource");
  return harness.slice(start, end + 1);
}

/** Only the pinned commit's tree is uploaded — no history, no local files. */
async function sourceArchive(scratch) {
  const source = path.join(scratch, "source");
  const archive = path.join(scratch, "demo.tgz");

  const { stdout: resolved } = await executeFile("git", [
    "-C", demoPath, "rev-parse", "--verify", `${demoRef}^{commit}`,
  ]);
  assert.equal(resolved.trim(), demoRef, "BRANCHPOINT_DEMO_REF must be an exact commit");

  await executeFile("git", ["init", "--quiet", source]);
  await executeFile("git", ["-C", source, "fetch", "--no-tags", "--depth=1", demoPath, demoRef]);
  await executeFile("git", ["-C", source, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  await executeFile("git", ["-C", source, "remote", "add", "origin", demoRemote]);
  await Promise.all([
    rm(path.join(source, ".git", "FETCH_HEAD"), { force: true }),
    rm(path.join(source, ".git", "ORIG_HEAD"), { force: true }),
    rm(path.join(source, ".git", "logs"), { recursive: true, force: true }),
  ]);

  const { stdout: dirty } = await executeFile("git", ["-C", source, "status", "--porcelain"]);
  assert.equal(dirty, "", "the exported clone must be clean");

  await executeFile("tar", ["-czf", archive, "-C", source, "."]);
  return (await readFile(archive)).toString("base64");
}

const client = new RunloopClient({ apiKey: runloopKey, baseUrl: process.env.RUNLOOP_API_URL });

async function putSecret() {
  const base = (process.env.RUNLOOP_API_URL ?? "https://api.runloop.ai").replace(/\/+$/, "");
  const send = (pathname, body) =>
    fetch(`${base}${pathname}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runloopKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  let res = await send("/v1/secrets", { name: secretName, value: openrouterKey });
  if (res.status === 409 || res.status === 400) {
    // Already there from a previous preparation: replace the value in place.
    res = await send(`/v1/secrets/${encodeURIComponent(secretName)}`, { value: openrouterKey });
  }
  if (!res.ok) throw new Error(`storing the secret returned HTTP ${res.status}`);
}

const token = randomUUID().replace(/-/g, "").slice(0, 12);
let scratch;
let devbox;

try {
  log(`secret ${secretName}`);
  await putSecret();

  scratch = await mkdtemp(path.join(tmpdir(), "branchpoint-fixture-"));
  log(`packing ${demoRef.slice(0, 7)} from ${demoPath}`);
  const archiveBase64 = await sourceArchive(scratch);

  log("booting a devbox");
  devbox = await client.createDevbox({
    name: `branchpoint-fixture-${token.slice(0, 8)}`,
    metadata: { purpose: "fixture", ref: demoRef },
  });

  log("uploading the source");
  await client.writeFile(devbox.id, `.branchpoint-demo-${token}.tgz.b64`, archiveBase64, {
    timeoutMs: 180_000,
  });

  log("installing (npm ci, build, chromium — this is the slow part)");
  await client.execute(
    devbox.id,
    [
      "set -euo pipefail",
      "mkdir -p /home/user/workspace",
      `base64 --decode /home/user/.branchpoint-demo-${token}.tgz.b64 | tar -xzf - -C /home/user/workspace`,
      "cd /home/user/workspace",
      "npm ci",
      "npm run build",
      "sudo npx playwright install-deps chromium",
      "npx playwright install chromium",
      "mkdir -p /home/user/workspace/.branchpoint",
      "python3 -m venv /home/user/workspace/.branchpoint/venv",
      "/home/user/workspace/.branchpoint/venv/bin/pip install --disable-pip-version-check playwright==1.62.0",
      "/home/user/workspace/.branchpoint/venv/bin/python -m playwright install chromium",
    ].join("\n"),
    { timeoutMs: 900_000, lastN: 500 },
  );

  log("signing in");
  await client.writeFile(
    devbox.id,
    "workspace/.branchpoint/prepare-fixture.mjs",
    await loginScript(),
  );
  await client.start(
    devbox.id,
    "cd /home/user/workspace && QA_PROFILE=demo-head PORT=3000 npm start",
  );
  await client.execute(
    devbox.id,
    "for i in $(seq 1 120); do curl -fsS http://127.0.0.1:3000/__qa/health >/dev/null && exit 0; sleep 0.5; done; exit 1",
    { timeoutMs: 90_000, lastN: 100 },
  );
  await client.execute(devbox.id, "cd /home/user/workspace && node .branchpoint/prepare-fixture.mjs", {
    timeoutMs: 120_000,
    lastN: 100,
  });

  log("snapshotting");
  const snapshot = await client.snapshotDisk(devbox.id, {
    name: `branchpoint-demo-head-${token.slice(0, 8)}`,
    metadata: { purpose: "fixture", profile: "demo-head", ref: demoRef, durable: "true" },
    commit_message: "Signed-in Nimbus demo-head fixture",
  });

  const example = JSON.parse(
    await readFile(path.join(engineRoot, "examples", "nimbus-suite.json"), "utf8"),
  );
  const suite = {
    ...example,
    id: suiteId,
    name: suiteId,
    repo: { ...example.repo, ref: demoRef },
    fixture: { ...example.fixture, snapshotId: snapshot.id, ref: demoRef },
  };

  const out = path.join(engineRoot, "examples", "nimbus-suite.prepared.json");
  await writeFile(out, `${JSON.stringify(suite, null, 2)}\n`);

  log(`snapshot ${snapshot.id}`);
  log(`suite written to ${path.relative(process.cwd(), out)}`);
  log("");
  log("Set these on the server, then register the suite:");
  log(`  BRANCHPOINT_OPENROUTER_MODEL=${model}`);
  log(`  BRANCHPOINT_OPENROUTER_SECRET=${secretName}`);
  process.stdout.write(`${snapshot.id}\n`);
} finally {
  // The snapshot is the deliverable; the devbox that produced it is not.
  if (devbox) {
    log("shutting the devbox down");
    await client.shutdown(devbox.id).catch((err) => log(`shutdown failed: ${err.message}`));
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
