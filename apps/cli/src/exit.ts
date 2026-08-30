import type { Run } from "@branchpoint/schema";

/**
 * Two kinds of red need two exit codes. A CI check that cannot tell "your app
 * broke" from "your test is stale" gets muted like every other flaky suite.
 */
export const EXIT = {
  OK: 0,
  APP_BROKE: 1,
  TREE_STALE: 2,
  COULD_NOT_START: 3,
} as const;

export function exitCodeFor(run: Run, opts: { strictUi: boolean }): number {
  const stale = run.results.some((r) => r.failReason === "unresolved");
  const broke = run.results.some((r) => r.status === "fail" && r.failReason !== "unresolved");

  if (broke) return EXIT.APP_BROKE;
  if (stale) return EXIT.TREE_STALE;

  // Following a renamed control is the product working, not a failure — unless
  // the team has decided they want to hear about every UI change.
  if (opts.strictUi && run.results.some((r) => r.note === "ui-changed")) return EXIT.APP_BROKE;

  return EXIT.OK;
}
