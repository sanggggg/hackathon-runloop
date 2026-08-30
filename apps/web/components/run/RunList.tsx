"use client";

import type { Run, Suite } from "@branchpoint/schema";

const LIVE = new Set(["queued", "running", "cancelling"]);

function verdict(run: Run) {
  const status = run.executionStatus ?? "succeeded";
  if (LIVE.has(status)) return { text: status, tone: "text-kumo-info", dot: "bg-kumo-info" };
  if (status === "cancelled") return { text: "cancelled", tone: "text-kumo-subtle", dot: "bg-kumo-inactive" };
  if (status === "failed") return { text: "engine error", tone: "text-kumo-danger", dot: "bg-kumo-danger" };

  const failed = run.results.filter((r) => r.status === "fail").length;
  return failed
    ? { text: `${failed} failed`, tone: "text-kumo-danger", dot: "bg-kumo-danger" }
    : { text: "all passed", tone: "text-kumo-success", dot: "bg-kumo-success" };
}

export function RunList({
  runs,
  suite,
  activeId,
  onSelect,
}: {
  runs: Run[];
  suite: Suite;
  activeId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-kumo-hairline bg-kumo-base">
      <h2 className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
        Runs
      </h2>

      {runs.length === 0 ? (
        <p className="px-4 text-[13px] leading-normal text-kumo-subtle">
          Nothing has run yet. The first run is also what checks the tree itself.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5 overflow-y-auto px-2">
          {runs.map((r) => {
            const v = verdict(r);
            const active = r.id === activeId;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onSelect(r.id)}
                  aria-current={active ? "true" : undefined}
                  className={`w-full rounded-md px-2.5 py-2 text-left transition hover:bg-kumo-recessed
                    focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus
                    ${active ? "border border-kumo-hairline bg-kumo-recessed" : "border border-transparent"}`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${v.dot}`} />
                    <span className={`text-[13px] font-medium ${active ? "text-kumo-strong" : "text-kumo-subtle"}`}>
                      {r.id}
                    </span>
                  </span>
                  <span className="mt-0.5 block pl-3.5 text-xs text-kumo-placeholder">
                    <code className="font-mono">{r.ref.slice(0, 7)}</code> ·{" "}
                    <span className={v.tone}>{v.text}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex-1" />

      <div className="m-2.5 rounded-lg border border-kumo-hairline bg-kumo-recessed p-3">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
          Fixture
        </h3>
        <code className="block break-all font-mono text-[11px] text-kumo-subtle">
          {suite.fixture.snapshotId}
        </code>
        <p className="mt-2 border-t border-kumo-hairline pt-2 text-xs leading-normal text-kumo-subtle">
          {suite.fixture.description}
        </p>
        <p className="mt-2 text-xs leading-normal text-kumo-placeholder">
          Every branch forks from here instead of signing in again.
        </p>
      </div>
    </aside>
  );
}
