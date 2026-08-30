#!/usr/bin/env node
/**
 * Branchpoint CLI — a thin client.
 *
 * It runs no tests. Every command is an HTTP call: the service clones the
 * commit, forks a devbox per branch and decides the verdict. That is why CI
 * needs a token and nothing else — no browser, no runner dependencies, no
 * flake from the CI machine.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import * as api from "./api.ts";
import type { Client } from "./api.ts";
import { renderTerminal } from "./render/terminal.ts";
import { renderMarkdown } from "./render/markdown.ts";
import { renderRunList, renderSuiteList, renderTree } from "./render/tables.ts";
import { bold, cyan, dim, green } from "./render/color.ts";
import { EXIT, exitCodeFor } from "./exit.ts";

const USAGE = `
${bold("branchpoint")} — agent-driven QA, evaluated on the service

${bold("Suites")}   a suite is a repo, a fixture snapshot, and the tree of flows to check
  suite list
  suite show <suiteId>
  suite register <suite.json>     upload a prepared Suite document

${bold("Runs")}     a run is one suite evaluated against one commit
  run --suite <id> [--ref <sha>] [--wait]
  runs [--suite <id>] [--watch]
  show <runId>
  cancel <runId>

${bold("Options")}
  --wait            block until the run finishes, then exit non-zero on failure
  --watch           keep refreshing the list while anything is running
  --format <fmt>    human | markdown | json          (default: human)
  --strict-ui       also fail when the agent had to follow a UI change
  --timeout <sec>   give up waiting                  (default: 900)

${bold("Exit codes")}
  0  every path passed
  1  a path failed — the app broke
  2  a step matched nothing — the tree is stale, not the app
  3  the command could not run

${bold("Environment")}
  BRANCHPOINT_API_URL     service base url
  BRANCHPOINT_API_TOKEN   shared bearer token
  BRANCHPOINT_SUITE       default --suite
`;

function fail(message: string, hint?: string): never {
  process.stderr.write(`\n  ${message}\n${hint ? `  ${dim(hint)}\n` : ""}\n`);
  process.exit(EXIT.COULD_NOT_START);
}

const write = (s: string) => process.stdout.write(`${s}\n`);

async function main() {
  const [group = "help", ...rest] = process.argv.slice(2);

  if (group === "help" || group === "--help" || group === "-h") {
    write(USAGE);
    return;
  }

  const sub = group === "suite" ? (rest.shift() ?? "list") : undefined;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      suite: { type: "string" },
      ref: { type: "string" },
      wait: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      format: { type: "string", default: "human" },
      "strict-ui": { type: "boolean", default: false },
      timeout: { type: "string", default: "900" },
    },
  });

  const client: Client = {
    baseUrl: (process.env.BRANCHPOINT_API_URL ?? "http://localhost:4000").replace(/\/+$/, ""),
    token: process.env.BRANCHPOINT_API_TOKEN ?? "",
  };
  if (!client.token) {
    fail("BRANCHPOINT_API_TOKEN is not set.", "Every suite and run endpoint needs it.");
  }

  const format = String(values.format);
  const suiteId = values.suite ?? process.env.BRANCHPOINT_SUITE;
  const timeoutMs = Number(values.timeout) * 1000;

  /* ── suites ─────────────────────────────────────────────────────── */

  if (group === "suite") {
    if (sub === "list") {
      const suites = await api.listSuites(client);
      if (format === "json") return write(JSON.stringify(suites, null, 2));
      const runs = await api.listRuns(client);
      const bySuite = new Map<string, typeof runs>();
      for (const r of runs) bySuite.set(r.suiteId, [...(bySuite.get(r.suiteId) ?? []), r]);
      return write(renderSuiteList(suites, bySuite));
    }

    if (sub === "show") {
      const id = positionals[0] ?? suiteId;
      if (!id) fail("no suite.", "branchpoint suite show <suiteId>");
      const suite = await api.getSuite(client, id);
      if (format === "json") return write(JSON.stringify(suite, null, 2));
      return write(renderTree(suite));
    }

    if (sub === "register") {
      const file = positionals[0];
      if (!file) {
        fail(
          "no suite document.",
          "branchpoint suite register packages/engine/examples/nimbus-suite.prepared.json",
        );
      }
      const document = JSON.parse(await readFile(file, "utf8")) as { fixture?: { snapshotId?: string } };
      if (document.fixture?.snapshotId?.startsWith("REPLACE_")) {
        fail(
          "that suite still has a placeholder fixture snapshot.",
          "Build a real one first: node packages/engine/scripts/prepare-fixture.mjs",
        );
      }
      const suite = await api.registerSuite(client, document);
      if (format === "json") return write(JSON.stringify(suite, null, 2));
      write(`\n  ${green("Registered")} ${bold(suite.id)}  ${dim(`${suite.tree.length} steps`)}`);
      write(`  ${dim(`fixture ${suite.fixture.snapshotId}`)}`);
      write(`\n  ${dim("Next:")}  branchpoint run --suite ${suite.id} --wait\n`);
      return;
    }

    fail(`unknown command "suite ${sub}".`, "Try: branchpoint help");
  }

  /* ── runs ───────────────────────────────────────────────────────── */

  if (group === "runs") {
    const suites = new Map((await api.listSuites(client)).map((s) => [s.id, s]));

    if (!values.watch) {
      const runs = await api.listRuns(client, suiteId);
      if (format === "json") return write(JSON.stringify(runs, null, 2));
      return write(renderRunList(runs, suites));
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const runs = await api.listRuns(client, suiteId);
      process.stdout.write("\x1b[2J\x1b[H");
      write(renderRunList(runs, suites));
      if (!runs.some(api.isLive)) return;
      if (Date.now() > deadline) fail("stopped watching: timed out.");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (group === "run") {
    if (!suiteId) fail("no suite.", "Pass --suite or set BRANCHPOINT_SUITE.");
    const { runId } = await api.startRun(client, { suiteId, ref: values.ref });

    if (!values.wait) {
      write(`\n  ${green("Started")} ${bold(runId)}  ${dim(`suite ${suiteId}`)}`);
      write(`  ${dim("Follow:")}  branchpoint runs --watch\n`);
      return;
    }

    const tty = process.stderr.isTTY;
    const run = await api.waitForRun(client, runId, timeoutMs, (r) => {
      if (!tty) return;
      const done = r.results.length;
      process.stderr.write(`\r  ${cyan(r.executionStatus ?? "running")} ${dim(`${done} paths`)}   `);
    });
    if (tty) process.stderr.write("\x1b[2K\r");

    const suite = await api.getSuite(client, run.suiteId);
    report(run, suite, format, client.baseUrl);
    process.exit(exitCodeFor(run, { strictUi: Boolean(values["strict-ui"]) }));
  }

  if (group === "show") {
    const runId = positionals[0];
    if (!runId) fail("no run.", "branchpoint show <runId>");
    const run = await api.getRun(client, runId);
    const suite = await api.getSuite(client, run.suiteId);
    report(run, suite, format, client.baseUrl);
    process.exit(exitCodeFor(run, { strictUi: Boolean(values["strict-ui"]) }));
  }

  if (group === "cancel") {
    const runId = positionals[0];
    if (!runId) fail("no run.", "branchpoint cancel <runId>");
    const run = await api.cancelRun(client, runId);
    write(`\n  ${bold(run.id)} is now ${cyan(run.executionStatus ?? "cancelled")}\n`);
    return;
  }

  fail(`unknown command "${group}".`, "Try: branchpoint help");
}

function report(
  run: Parameters<typeof renderTerminal>[0],
  suite: Parameters<typeof renderTerminal>[1],
  format: string,
  appUrl: string,
) {
  if (format === "json") write(JSON.stringify(run, null, 2));
  else if (format === "markdown") write(renderMarkdown(run, suite, appUrl));
  else write(renderTerminal(run, suite));
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
