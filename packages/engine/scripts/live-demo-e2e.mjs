#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BranchpointEngine } from "../dist/src/engine.js";
import { LocalArtifactStore } from "../dist/src/artifact-store.js";
import { RunloopApiError, RunloopClient } from "../dist/src/runloop-client.js";
import { RunloopRuntime } from "../dist/src/runloop-runtime.js";

const executeFile = promisify(execFile);
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoPath = path.resolve(process.env.BRANCHPOINT_DEMO_REPO_PATH ?? "");
const demoRef = process.env.BRANCHPOINT_DEMO_REF;
const openrouterKey = process.env.OPENROUTER_API_KEY;
const openrouterModel =
  process.env.BRANCHPOINT_OPENROUTER_MODEL ?? "google/gemini-3.1-flash-lite";
const runloopBaseUrl = (process.env.RUNLOOP_API_URL ?? "https://api.runloop.ai").replace(
  /\/+$/,
  "",
);
const runloopKey = process.env.RUNLOOP_API_KEY;
const controller = new AbortController();
let terminationSignal;

function terminate(signal) {
  terminationSignal ??= signal;
  if (!controller.signal.aborted) {
    controller.abort(new Error(`received ${signal}`));
    process.stderr.write(`${signal} received; cleaning up live E2E resources...\n`);
  }
}

const onSigint = () => terminate("SIGINT");
const onSigterm = () => terminate("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

if (!process.env.BRANCHPOINT_DEMO_REPO_PATH) {
  throw new Error("BRANCHPOINT_DEMO_REPO_PATH is required");
}
if (!/^[0-9a-f]{40}$/i.test(demoRef ?? "")) {
  throw new Error("BRANCHPOINT_DEMO_REF must be a pinned 40-character commit SHA");
}
if (!runloopKey) throw new Error("RUNLOOP_API_KEY is required");
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY is required for model-backed E2E");

const client = new RunloopClient({ apiKey: runloopKey, baseUrl: runloopBaseUrl });
const token = randomUUID().replaceAll("-", "");
const secretName = `BRANCHPOINT_E2E_${token.toUpperCase()}`;
const artifactDirectory = path.resolve(
  process.env.BRANCHPOINT_ARTIFACT_DIR ??
    path.join(".branchpoint-artifacts", `live-${token.slice(0, 12)}`),
);
const liveDevboxes = new Set();
const snapshots = new Set();
let secretCreated = false;
let hostTempDirectory;
let primaryError;

async function runloopSecret(pathname, body, { ignoreNotFound = false, signal } = {}) {
  const response = await fetch(`${runloopBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runloopKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  if (ignoreNotFound && response.status === 404) return;
  if (!response.ok) {
    throw new Error(`Runloop secret operation returned HTTP ${response.status}`);
  }
  await response.text();
}

async function shutdown(id) {
  try {
    await client.shutdown(id, { force: true });
    liveDevboxes.delete(id);
  } catch (error) {
    if (error instanceof RunloopApiError && error.status === 404) {
      liveDevboxes.delete(id);
      return;
    }
    throw error;
  }
}

async function deleteSnapshot(id) {
  try {
    await client.deleteSnapshot(id);
    snapshots.delete(id);
  } catch (error) {
    if (error instanceof RunloopApiError && error.status === 404) {
      snapshots.delete(id);
      return;
    }
    throw error;
  }
}

async function cleanupSet(resources, cleanupResource) {
  let errors = [];
  for (let attempt = 0; attempt < 2 && resources.size > 0; attempt += 1) {
    const cleanup = await Promise.allSettled([...resources].map(cleanupResource));
    errors = cleanup.flatMap((entry) =>
      entry.status === "rejected" ? [entry.reason] : [],
    );
  }
  return errors;
}

function node(id, parentId, kind, label, intent, expectedOutcome, state = "verified") {
  return {
    id,
    parentId,
    kind,
    state,
    label,
    intent,
    ...(expectedOutcome ? { expectedOutcome } : {}),
    ...(id === "starter" ? { lastSeenLabel: "Starter template" } : {}),
  };
}

function demoSuite(fixtureSnapshotId) {
  return {
    id: "nimbus-live-e2e",
    name: "Nimbus demo-head live E2E",
    repo: {
      url: "https://github.com/sanggggg/hackathon-runloop-demo",
      ref: demoRef,
      buildCmd: "npm ci && npm run build",
      startCmd: "QA_PROFILE=demo-head npm start",
      port: 3000,
    },
    blueprintId: "runloop-default-with-playwright-fixture",
    fixture: {
      snapshotId: fixtureSnapshotId,
      ref: demoRef,
      description: "demo-head, signed in at /onboarding/use-case",
    },
    tree: [
      node("root", null, "fixture", "Signed-in use-case screen", "Start from the signed-in fixture"),
      node("team", "root", "step", "Team plan", "Choose the Team plan"),
      node("invite", "team", "step", "Invite teammates", "Invite teammates"),
      node("send", "invite", "goal", "Send invitations", "Send invitations", "Invitations sent"),
      node("skip", "team", "goal", "Skip invites", "Skip invites", "Team workspace ready"),
      node("solo", "root", "step", "Solo plan", "Choose the Solo plan"),
      node(
        "starter",
        "solo",
        "goal",
        "Starter template",
        "Create the workspace from a starter template",
        "Starter project created",
      ),
      node(
        "blank",
        "solo",
        "goal",
        "Blank workspace",
        "Create a blank workspace",
        "Empty workspace ready",
      ),
      node(
        "import",
        "solo",
        "goal",
        "Import from CSV",
        "Import the workspace from CSV",
        "Records imported",
        "unverified",
      ),
      node(
        "later",
        "root",
        "goal",
        "Decide later",
        "Decide about setup later",
        "Progress saved for later",
      ),
    ],
  };
}

const fixtureLoginSource = String.raw`
import { chromium } from "@playwright/test";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root = "/home/user/workspace/.branchpoint";
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:3000", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email address", { exact: true }).fill("demo@example.com");
  await page.getByLabel("Password", { exact: true }).fill("branchpoint");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/onboarding/use-case");
  const storagePath = path.join(root, "browser-checkpoint.storage-state.json");
  await context.storageState({ path: storagePath, indexedDB: true });
  const sessionStorage = await page.evaluate(() => {
    const values = {};
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key !== null) values[key] = sessionStorage.getItem(key) ?? "";
    }
    return { origin: location.origin, values };
  });
  const checkpoint = {
    protocolVersion: 1,
    storage_state: storagePath,
    url: page.url(),
    sessionStorage,
  };
  const temporary = path.join(root, "browser-checkpoint.json.tmp");
  const destination = path.join(root, "browser-checkpoint.json");
  await writeFile(temporary, JSON.stringify(checkpoint) + "\n", "utf8");
  await rename(temporary, destination);
  process.stdout.write(JSON.stringify({ url: page.url(), fixtureReady: true }) + "\n");
} finally {
  await browser.close();
}
`;

try {
  // Set before the request: a successful allocation followed by a response
  // timeout must still be deleted in finally.
  secretCreated = true;
  await runloopSecret(
    "/v1/secrets",
    { name: secretName, value: openrouterKey },
    { signal: controller.signal },
  );

  hostTempDirectory = await mkdtemp(path.join(tmpdir(), "branchpoint-demo-e2e-"));
  const artifactStore = new LocalArtifactStore(artifactDirectory);
  const archivePath = path.join(hostTempDirectory, "demo.tgz");
  await executeFile(
    "tar",
    [
      "--exclude=./node_modules",
      "--exclude=./dist",
      "--exclude=./playwright-report",
      "--exclude=./test-results",
      "-czf",
      archivePath,
      "-C",
      demoPath,
      ".",
    ],
    { signal: controller.signal },
  );
  const archiveBase64 = (await readFile(archivePath)).toString("base64");

  const fixtureBox = await client.createDevbox({
    name: `branchpoint-fixture-${token.slice(0, 8)}`,
    metadata: { branchpoint_live_e2e: token, purpose: "fixture" },
  }, { signal: controller.signal });
  liveDevboxes.add(fixtureBox.id);
  await client.writeFile(fixtureBox.id, `.branchpoint-demo-${token}.tgz.b64`, archiveBase64, {
    timeoutMs: 180_000,
    signal: controller.signal,
  });
  await client.execute(
    fixtureBox.id,
    [
      "set -euo pipefail",
      "mkdir -p /home/user/workspace",
      `base64 --decode /home/user/.branchpoint-demo-${token}.tgz.b64 | tar -xzf - -C /home/user/workspace`,
      "cd /home/user/workspace",
      `test \"$(git rev-parse HEAD)\" = \"${demoRef}\"`,
      "npm ci",
      "npm run build",
      "sudo npx playwright install-deps chromium",
      "npx playwright install chromium",
      "mkdir -p /home/user/workspace/.branchpoint",
      "python3 -m venv /home/user/workspace/.branchpoint/venv",
      "/home/user/workspace/.branchpoint/venv/bin/pip install --disable-pip-version-check playwright==1.62.0",
      "/home/user/workspace/.branchpoint/venv/bin/python -m playwright install chromium",
    ].join("\n"),
    { timeoutMs: 900_000, lastN: 500, signal: controller.signal },
  );
  await client.writeFile(
    fixtureBox.id,
    "workspace/.branchpoint/prepare-fixture.mjs",
    fixtureLoginSource,
    { signal: controller.signal },
  );
  await client.start(
    fixtureBox.id,
    "cd /home/user/workspace && QA_PROFILE=demo-head PORT=3000 npm start",
    { signal: controller.signal },
  );
  await client.execute(
    fixtureBox.id,
    "for i in $(seq 1 120); do curl -fsS http://127.0.0.1:3000/__qa/health >/dev/null && exit 0; sleep 0.5; done; exit 1",
    { timeoutMs: 90_000, lastN: 100, signal: controller.signal },
  );
  await client.execute(
    fixtureBox.id,
    "cd /home/user/workspace && node .branchpoint/prepare-fixture.mjs",
    { timeoutMs: 120_000, lastN: 100, signal: controller.signal },
  );
  const fixtureSnapshot = await client.snapshotDisk(fixtureBox.id, {
    name: `branchpoint-demo-head-${token.slice(0, 8)}`,
    metadata: { branchpoint_live_e2e: token, profile: "demo-head", ref: demoRef },
    commit_message: "Signed-in Nimbus demo-head fixture",
  }, { signal: controller.signal });
  snapshots.add(fixtureSnapshot.id);
  await shutdown(fixtureBox.id);

  const runnerSource = await readFile(path.join(engineRoot, "runner", "browser-agent.py"), "utf8");
  const runtime = new RunloopRuntime({
    client,
    artifactStore,
    workDir: "/home/user/workspace",
    agentCommand: ".branchpoint/venv/bin/python .branchpoint/browser-agent.py",
    healthPath: "/__qa/health",
    bootstrapFiles: { ".branchpoint/browser-agent.py": runnerSource },
    environmentVariables: { BRANCHPOINT_OPENROUTER_MODEL: openrouterModel },
    secrets: { OPENROUTER_API_KEY: secretName },
    signal: controller.signal,
    timeouts: { agentMs: 240_000 },
  });
  const run = await new BranchpointEngine({ runtime, maxConcurrency: 4 }).run({
    suite: demoSuite(fixtureSnapshot.id),
    ref: demoRef,
    signal: controller.signal,
  });

  const byId = new Map(run.results.map((result) => [result.nodeId, result]));
  for (const id of ["team", "invite", "send", "skip", "solo", "starter", "import"]) {
    assert.equal(byId.get(id)?.status, "pass", `${id} should pass`);
  }
  for (const id of ["blank", "later"]) {
    assert.equal(byId.get(id)?.status, "fail", `${id} should fail`);
    assert.equal(byId.get(id)?.failReason, "error-screen", `${id} should be an app regression`);
  }
  assert.equal(byId.get("starter")?.note, "ui-changed");
  await Promise.all(
    run.results.map(async (result) => {
      assert(result.screenshotId, `${result.nodeId} must have a persisted screenshot id`);
      await access(artifactStore.resolveScreenshot(result.screenshotId));
    }),
  );
  assert((run.modelCalls ?? 0) > 0, "structured-output calls must prove model-backed execution");
  const fallbackLogs = run.results.flatMap((result) => result.log).filter((line) =>
    /Model (resolver|judge) unavailable/i.test(line.text),
  );
  assert.deepEqual(fallbackLogs, [], "no resolver/judge call may fall back during model E2E");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        ref: run.ref,
        model: openrouterModel,
        artifactDirectory,
        results: run.results,
        modelCalls: run.modelCalls,
        costUsd: run.costUsd,
        wallClockMs: run.wallClockMs,
        sequentialEstimateMs: run.sequentialEstimateMs,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [
    ...await cleanupSet(liveDevboxes, shutdown),
    ...await cleanupSet(snapshots, deleteSnapshot),
  ];
  if (secretCreated) {
    let secretError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await runloopSecret(
          `/v1/secrets/${encodeURIComponent(secretName)}/delete`,
          {},
          { ignoreNotFound: true },
        );
        secretError = undefined;
        break;
      } catch (error) {
        secretError = error;
      }
    }
    if (secretError) cleanupErrors.push(secretError);
  }
  if (hostTempDirectory) {
    try {
      await rm(hostTempDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "live demo E2E and cleanup failed");
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "live demo E2E cleanup failed");
  }
}

if (terminationSignal) {
  process.exitCode = terminationSignal === "SIGINT" ? 130 : 143;
}
