#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RunloopClient } from "../dist/src/runloop-client.js";

const client = new RunloopClient();
const token = randomUUID();
const statePath = `.branchpoint-canary/${token}.json`;
const expected = JSON.stringify({ token, stage: "before-fork" });
const liveDevboxes = new Set();
const snapshots = new Set();
const startedAt = Date.now();
let primaryError;

async function shutdown(id) {
  try {
    await client.shutdown(id, { force: true });
  } finally {
    liveDevboxes.delete(id);
  }
}

try {
  const parent = await client.createDevbox({
    name: `branchpoint-canary-parent-${token.slice(0, 8)}`,
    metadata: { branchpoint_canary: token },
  });
  liveDevboxes.add(parent.id);
  await client.writeFile(parent.id, statePath, expected);

  const snapshot = await client.snapshotDisk(parent.id, {
    name: `branchpoint-canary-${token.slice(0, 8)}`,
    metadata: { branchpoint_canary: token },
    commit_message: "Branchpoint client fork canary",
  });
  snapshots.add(snapshot.id);
  await shutdown(parent.id);

  const children = await Promise.all(
    ["a", "b"].map(async (branch) => {
      const child = await client.createFromSnapshot(snapshot.id, {
        name: `branchpoint-canary-${branch}-${token.slice(0, 8)}`,
        metadata: { branchpoint_canary: token, branch },
      });
      liveDevboxes.add(child.id);
      return child;
    }),
  );
  const inherited = await Promise.all(
    children.map((child) => client.readFile(child.id, statePath)),
  );
  assert.deepEqual(inherited, [expected, expected]);
  await Promise.all(children.map((child) => shutdown(child.id)));

  process.stdout.write(
    `${JSON.stringify({ ok: true, forks: children.length, elapsedMs: Date.now() - startedAt })}\n`,
  );
} catch (error) {
  primaryError = error;
} finally {
  const cleanup = await Promise.allSettled([
    ...[...liveDevboxes].map((id) => shutdown(id)),
    ...[...snapshots].map(async (id) => {
      await client.deleteSnapshot(id);
      snapshots.delete(id);
    }),
  ]);
  const cleanupErrors = cleanup.flatMap((entry) =>
    entry.status === "rejected" ? [entry.reason] : [],
  );
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "canary and cleanup failed");
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "canary cleanup failed");
  }
}
