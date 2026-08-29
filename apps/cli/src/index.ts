#!/usr/bin/env node
/**
 * Branchpoint CLI — a thin client.
 *
 * It runs no tests. Every command is an HTTP call: the service clones the
 * commit, forks a devbox per branch and decides the verdict. That is why CI
 * needs a token and nothing else — no browser, no runner dependencies, no
 * flake from the CI machine.
 */
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

${bold("Suites")}   a suite is a repo plus the tree of flows to check
  suite create --repo <url> [--describe "..."] [--name <id>]
  suite list
  suite show <suiteId>

${bold("Runs")}     a run is one suite evaluated against one commit
  run --suite <id> [--ref <sha>] [--wait]
  runs [--suite <id>] [--watch]
  show <runId>

${bold("Options")}
  --wait            block until the run finishes, then exit non-zero on failure
  --watch           keep refreshing the list while anything is running
  --format <fmt>    human | markdown | json          (default: human)
  --strict-ui       also fail when the agent had to follow a UI change
  --timeout <sec>   give up waiting                  (default: 300)

${bold("Exit codes")}
  0  every path passed
  1  a path failed — the app broke
  2  a step matched nothing — the tree is stale, not the app
  3  the command could not run

${bold("Environment")}
  BRANCHPOINT_TOKEN   required against a real service
  BRANCHPOINT_API     base url (default http://localhost:4000)
  BRANCHPOINT_SUITE   default --suite
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

  // `suite create` style commands take a second word.
  const sub = group === "suite" ? (rest.shift() ?? "list") : undefined;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      suite: { type: "string" },
      repo: { type: "string" },
      describe: { type: "string" },
      name: { type: "string" },
      ref: { type: "string" },
      wait: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      format: { type: "string", default: "human" },
      "strict-ui": { type: "boolean", default: false },
      timeout: { type: "string", default: "300" },
    },
  });

  const client: Client = {
    baseUrl: (process.env.BRANCHPOINT_API ?? "http://localhost:4000").replace(/\/+$/, ""),
    token: process.env.BRANCHPOINT_TOKEN ?? "",
  };
  const format = String(values.format);
  const suiteId = values.suite ?? process.env.BRANCHPOINT_SUITE;

  /* ── suites ─────────────────────────────────────────────────────── */

  if (group === "suite") {
    if (sub === "create") {
      if (!values.repo) fail("no repository.", 'branchpoint suite create --repo https://github.com/you/app');
      const suite = await api.createSuite(client, {
        repo: { url: values.repo },
        describe: values.describe,
        name: values.name,
      });
      if (format === "json") return write(JSON.stringify(suite, null, 2));
      write(`\n  ${green("Created")} ${bold(suite.id)}  ${dim(`tree v${suite.treeVersion}`)}`);
      write(`  ${dim(`fixture ${suite.fixture.snapshotId} · ${suite.fixture.description}`)}`);
      write(`\n  ${dim("Next:")}  branchpoint run --suite ${suite.id} --wait\n`);
      return;
    }

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

    fail(`unknown command "suite ${sub}".`, "Try: branchpoint help");
  }

  /* ── runs ───────────────────────────────────────────────────────── */

  if (group === "runs") {
    const suites = new Map((await api.listSuites(client)).map((s) => [s.id, s]));

    const once = async () => {
      const runs = await api.listRuns(client, suiteId);
      return { runs, anyRunning: runs.some((r) => !r.finishedAt) };
    };

    if (!values.watch) {
      const { runs } = await once();
      if (format === "json") return write(JSON.stringify(runs, null, 2));
      return write(renderRunList(runs, suites));
    }

    const deadline = Date.now() + Number(values.timeout) * 1000;
    for (;;) {
      const { runs, anyRunning } = await once();
      process.stdout.write("\x1b[2J\x1b[H");
      write(renderRunList(runs, suites));
      if (!anyRunning) return;
      if (Date.now() > deadline) fail("stopped watching: timed out.");
      await new Promise((r) => setTimeout(r, 1000));
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

    if (process.stdout.isTTY) process.stderr.write(`  ${cyan("running")} ${dim(runId)}\r`);
    const run = await api.waitForRun(client, runId, Number(values.timeout) * 1000);
    if (process.stdout.isTTY) process.stderr.write("\x1b[2K");

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
