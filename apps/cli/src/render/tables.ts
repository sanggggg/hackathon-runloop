import type { Node, Run, Suite } from "@branchpoint/schema";
import { humanMs, tally, toLines } from "./lines.ts";
import { bold, blue, cyan, dim, green, pad, red, yellow } from "./color.ts";

const repoOf = (s: Suite) => s.repo.url.replace(/^https?:\/\/github\.com\//, "");
/** Refs are full SHAs on the wire; columns only have room for the short form. */
const shortRef = (ref: string) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref);

function header(cols: [string, number][]): string {
  return `  ${dim(cols.map(([label, w]) => pad(label, w)).join(""))}`;
}

/* ── branchpoint suite list ─────────────────────────────────────────── */

export function renderSuiteList(suites: Suite[], runsBySuite: Map<string, Run[]>): string {
  if (!suites.length) {
    return [
      "",
      `  ${dim("No suites yet.")}`,
      `  ${dim("Create one:")}  branchpoint suite create --repo https://github.com/you/app`,
      "",
    ].join("\n");
  }

  const idW = Math.max(6, ...suites.map((s) => s.id.length)) + 3;
  const repoW = Math.max(5, ...suites.map((s) => repoOf(s).length)) + 3;

  const out = [
    "",
    header([
      ["SUITE", idW],
      ["REPO", repoW],
      ["STEPS", 8],
      ["LATEST RUN", 0],
    ]),
  ];

  for (const s of suites) {
    const latest = (runsBySuite.get(s.id) ?? [])[0];
    let cell = dim("never run");
    if (latest) {
      const t = tally(toLines(latest, s), latest);
      const verdict = !latest.finishedAt
        ? cyan("running")
        : t.failed
          ? red(`${t.failed} failed`)
          : green("all passed");
      cell = `${verdict} ${dim(`· ${shortRef(latest.ref)} · ${latest.results.length} paths`)}`;
    }
    out.push(
      `  ${pad(bold(s.id), idW)}${pad(dim(repoOf(s)), repoW)}${pad(dim(String(s.tree.length)), 8)}${cell}`,
    );
  }

  out.push("");
  return out.join("\n");
}

/* ── branchpoint suite show ─────────────────────────────────────────── */

export function renderTree(suite: Suite): string {
  const kids = (id: string | null) => suite.tree.filter((n) => n.parentId === id);

  const out = [
    "",
    `  ${bold(suite.id)}  ${dim(repoOf(suite))}  ${dim(`${suite.tree.length} steps`)}`,
    `  ${dim(`fixture ${suite.fixture.snapshotId} · ${suite.fixture.description}`)}`,
    "",
  ];

  const paint = (n: Node) =>
    n.state === "unresolved" ? red(n.label) : n.state === "unverified" ? blue(n.label) : n.label;

  const badge = (n: Node) =>
    n.state === "unresolved"
      ? `  ${red("unresolved")}`
      : n.state === "unverified"
        ? `  ${blue("unverified")}`
        : "";

  const walk = (node: Node, indent: string, isLast: boolean, isRoot: boolean) => {
    const stem = isRoot ? "" : `${indent}${isLast ? "└─ " : "├─ "}`;
    const under = isRoot ? "" : `${indent}${isLast ? "   " : "│  "}`;

    out.push(`  ${dim(stem)}${paint(node)}${badge(node)}`);
    out.push(`  ${dim(under)}${dim(node.intent)}`);

    const children = kids(node.id);
    children.forEach((c, i) => walk(c, under, i === children.length - 1, false));
  };

  kids(null).forEach((r) => walk(r, "", true, true));

  const unresolved = suite.tree.filter((n) => n.state === "unresolved").length;
  out.push("");
  if (unresolved) {
    out.push(
      `  ${red(`${unresolved} step${unresolved > 1 ? "s" : ""} matched nothing on the page.`)} ${dim("Reword or drop them in Build.")}`,
    );
    out.push("");
  }
  return out.join("\n");
}

/* ── branchpoint runs ───────────────────────────────────────────────── */

export function renderRunList(runs: Run[], suites: Map<string, Suite>): string {
  if (!runs.length) {
    return [
      "",
      `  ${dim("No runs yet.")}`,
      `  ${dim("Start one:")}  branchpoint run --suite <id> --wait`,
      "",
    ].join("\n");
  }

  const shortId = (id: string) => (id.length > 12 ? id.slice(0, 8) : id);
  const idW = Math.max(3, ...runs.map((r) => shortId(r.id).length)) + 3;
  const suiteW = Math.max(5, ...runs.map((r) => r.suiteId.length)) + 3;

  const out = [
    "",
    header([
      ["RUN", idW],
      ["SUITE", suiteW],
      ["REF", 10],
      ["STATUS", 15],
      ["PATHS", 8],
      ["WALL", 0],
    ]),
  ];

  for (const r of runs) {
    const suite = suites.get(r.suiteId);
    const t = suite ? tally(toLines(r, suite), r) : undefined;
    const exec = r.executionStatus ?? "succeeded";
    const status = exec === "queued" || exec === "running" || exec === "cancelling"
      ? cyan(exec)
      : exec === "cancelled"
        ? dim("cancelled")
        : exec === "failed"
          ? red("engine error")
          : t?.failed
        ? red(`${t.failed} failed`)
        : t?.unresolved
          ? yellow("tree stale")
          : green("passed");

    out.push(
      `  ${pad(bold(shortId(r.id)), idW)}${pad(dim(r.suiteId), suiteW)}${pad(dim(shortRef(r.ref)), 10)}${pad(status, 15)}${pad(dim(String(r.results.length)), 8)}${dim(humanMs(r.wallClockMs))}`,
    );
  }

  const running = runs.filter((r) => !r.finishedAt).length;
  out.push("");
  if (running) {
    out.push(`  ${cyan(`${running} still running`)}  ${dim("· branchpoint runs --watch")}`);
    out.push("");
  }
  return out.join("\n");
}
