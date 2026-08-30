/**
 * One place decides what a result *means*, so the terminal, the PR comment and
 * the exit code can never disagree with each other.
 */
import type { Node, NodeResult, Run, Suite } from "@branchpoint/schema";

export type Outcome = "passed" | "healed" | "discovered" | "failed";

export interface Line {
  nodeId: string;
  /** "Solo → Starter template" */
  path: string;
  outcome: Outcome;
  /** Short reason, shown next to the path. */
  summary: string;
  /** Longer explanation, only rendered for failures. */
  detail?: string;
  elapsedMs: number;
}

const FAIL_SUMMARY: Record<NonNullable<NodeResult["failReason"]>, string> = {
  unresolved: "nothing on the page matched",
  "error-screen": "landed on an error screen",
  timeout: "timed out",
};

function pathOf(node: Node, byId: Map<string, Node>): string {
  const parts: string[] = [];
  let cur: Node | undefined = node;
  while (cur && cur.parentId) {
    parts.unshift(cur.label);
    cur = byId.get(cur.parentId);
  }
  return parts.join(" → ") || node.label;
}

export function toLines(run: Run, suite: Suite): Line[] {
  const nodes = [...suite.tree, ...run.discovered];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return run.results.map((r) => {
    const node = byId.get(r.nodeId);
    const path = node ? pathOf(node, byId) : r.nodeId;

    if (r.status === "fail") {
      const reason = r.failReason ?? "error-screen";
      return {
        nodeId: r.nodeId,
        path,
        outcome: "failed" as const,
        summary: FAIL_SUMMARY[reason],
        detail:
          reason === "unresolved"
            ? `The stored intent "${node?.intent ?? ""}" matched nothing on the page. This is a stale step, not a broken app — reword or drop it in Build.`
            : `${r.resolvedTo ?? "The control"} resolved, but the next screen was not the expected one.`,
        elapsedMs: r.elapsedMs,
      };
    }

    if (r.note === "ui-changed") {
      return {
        nodeId: r.nodeId,
        path,
        outcome: "healed" as const,
        summary: "UI changed, followed anyway",
        detail: r.resolvedTo
          ? `The control this step used was renamed. The agent matched the intent to ${r.resolvedTo} instead of failing.`
          : undefined,
        elapsedMs: r.elapsedMs,
      };
    }

    if (r.note === "new-path") {
      return {
        nodeId: r.nodeId,
        path,
        outcome: "discovered" as const,
        summary: "new path, not in the tree",
        elapsedMs: r.elapsedMs,
      };
    }

    return {
      nodeId: r.nodeId,
      path,
      outcome: "passed" as const,
      summary: "passed",
      elapsedMs: r.elapsedMs,
    };
  });
}

export interface Tally {
  passed: number;
  failed: number;
  healed: number;
  discovered: number;
  /** Steps whose wording matched nothing — a stale tree, not a broken app. */
  unresolved: number;
}

export function tally(lines: Line[], run: Run): Tally {
  const unresolved = run.results.filter((r) => r.failReason === "unresolved").length;
  return {
    passed: lines.filter((l) => l.outcome !== "failed").length,
    failed: lines.filter((l) => l.outcome === "failed").length,
    healed: lines.filter((l) => l.outcome === "healed").length,
    discovered: lines.filter((l) => l.outcome === "discovered").length,
    unresolved,
  };
}

export function humanMs(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
