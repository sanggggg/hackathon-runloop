#!/usr/bin/env node
/**
 * A stand-in for the engine, so the CLI and the web app can be finished against
 * the real HTTP surface instead of against imports.
 *
 * It keeps everything in memory and fakes the one thing that matters for the
 * client: runs take time. A run created now reports partial results as the
 * clock advances and finishes around the sixteen seconds a real one takes, so
 * `--wait` and `runs --watch` exercise the code paths they will use for real.
 *
 * Delete this package once the engine answers on the same routes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Node, Run, Suite } from "@branchpoint/schema";
import { SEED_RESULTS, SEED_SUITE, newSuiteFrom } from "./seed.ts";

const PORT = Number(process.env.PORT ?? 4000);

const suites = new Map<string, Suite>([[SEED_SUITE.id, SEED_SUITE]]);
interface StoredRun extends Run {
  /** Wall-clock ms since epoch when the run began; drives simulated progress. */
  _startedMs: number;
}
const runs = new Map<string, StoredRun>();
let runSeq = 42;

/** Fill in results as time passes so clients see a run actually progress. */
function project(stored: StoredRun): Run {
  const elapsed = Date.now() - stored._startedMs;
  const landed = stored.results.filter((r) => elapsed >= r.elapsedMs);
  const done = elapsed >= stored.wallClockMs;

  const { _startedMs, ...run } = stored;
  return {
    ...run,
    results: landed,
    finishedAt: done ? new Date(stored._startedMs + stored.wallClockMs).toISOString() : undefined,
    wallClockMs: done ? stored.wallClockMs : elapsed,
  };
}

function startRun(suiteId: string, ref?: string): Run {
  const suite = suites.get(suiteId);
  if (!suite) throw Object.assign(new Error(`no suite "${suiteId}"`), { status: 404 });

  runSeq += 1;
  const id = `run-${runSeq}`;
  const results = SEED_RESULTS(suite);
  const stored: StoredRun = {
    id,
    suiteId,
    ref: ref ?? suite.repo.ref,
    treeVersion: suite.treeVersion,
    startedAt: new Date().toISOString(),
    fixtureSnapshotId: suite.fixture.snapshotId,
    results,
    discovered: [],
    costUsd: 0.14,
    wallClockMs: Math.max(...results.map((r) => r.elapsedMs)) + 600,
    sequentialEstimateMs: results.reduce((a, r) => a + r.elapsedMs, 0) + results.length * 12_000,
    _startedMs: Date.now(),
  };
  runs.set(id, stored);
  return project(stored);
}

/* ── routing ──────────────────────────────────────────────────────── */

type Handler = (ctx: {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}) => unknown;

const ROUTES: [string, string, Handler][] = [
  ["GET", "/suites", () => [...suites.values()]],

  [
    "POST",
    "/suites",
    ({ body }) => {
      const b = (body ?? {}) as { repo?: { url?: string }; describe?: string; name?: string };
      if (!b.repo?.url) throw Object.assign(new Error("repo.url is required"), { status: 400 });
      const suite = newSuiteFrom(b.repo.url, b.describe, b.name);
      suites.set(suite.id, suite);
      return suite;
    },
  ],

  [
    "GET",
    "/suites/:id",
    ({ params }) => {
      const s = suites.get(params.id);
      if (!s) throw Object.assign(new Error(`no suite "${params.id}"`), { status: 404 });
      return s;
    },
  ],

  [
    "PATCH",
    "/suites/:id",
    ({ params, body }) => {
      const s = suites.get(params.id);
      if (!s) throw Object.assign(new Error(`no suite "${params.id}"`), { status: 404 });
      const tree = (body as { tree?: Node[] })?.tree;
      if (tree) suites.set(s.id, { ...s, tree, treeVersion: s.treeVersion + 1 });
      return suites.get(s.id);
    },
  ],

  [
    "GET",
    "/runs",
    ({ query }) => {
      const suiteId = query.get("suiteId");
      return [...runs.values()]
        .filter((r) => !suiteId || r.suiteId === suiteId)
        .sort((a, b) => b._startedMs - a._startedMs)
        .map(project);
    },
  ],

  [
    "POST",
    "/runs",
    ({ body }) => {
      const b = (body ?? {}) as { suiteId?: string; ref?: string };
      if (!b.suiteId) throw Object.assign(new Error("suiteId is required"), { status: 400 });
      const run = startRun(b.suiteId, b.ref);
      return { runId: run.id };
    },
  ],

  [
    "GET",
    "/runs/:id",
    ({ params }) => {
      const r = runs.get(params.id);
      if (!r) throw Object.assign(new Error(`no run "${params.id}"`), { status: 404 });
      return project(r);
    },
  ],
];

function match(method: string, path: string) {
  for (const [m, pattern, handler] of ROUTES) {
    if (m !== method) continue;
    const pa = pattern.split("/");
    const ac = path.split("/");
    if (pa.length !== ac.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pa.length; i += 1) {
      if (pa[i].startsWith(":")) params[pa[i].slice(1)] = decodeURIComponent(ac[i]);
      else if (pa[i] !== ac[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw Object.assign(new Error("body is not valid JSON"), { status: 400 });
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const hit = match(req.method ?? "GET", url.pathname);

  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (!hit) {
    res.writeHead(404).end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }));
    return;
  }

  try {
    const body = await readBody(req);
    const out = hit.handler({ params: hit.params, query: url.searchParams, body });
    res.writeHead(200).end(JSON.stringify(out));
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.writeHead(status).end(JSON.stringify({ error: (err as Error).message }));
  }
});

server.listen(PORT, () => {
  process.stdout.write(
    `branchpoint mock engine on http://localhost:${PORT}\n` +
      `  seeded suite: ${SEED_SUITE.id}\n` +
      `  runs take ~16s, same as the real thing\n`,
  );
});
