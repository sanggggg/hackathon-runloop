"use client";

import type { Run } from "@branchpoint/schema";

function human(ms: number) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${(ms / 1000).toFixed(1)}s`;
}

/** The argument for forking, kept on screen instead of in a view that vanishes. */
export function WallClock({ run }: { run: Run }) {
  if (!run.sequentialEstimateMs || !run.wallClockMs) return null;

  const rows = [
    {
      label: `${run.results.length} runs, one at a time`,
      ms: run.sequentialEstimateMs,
      pct: 100,
      fill: "bg-kumo-fill",
      text: "text-kumo-subtle",
    },
    {
      label: "Forked from one snapshot",
      ms: run.wallClockMs,
      pct: Math.max(1, (run.wallClockMs / run.sequentialEstimateMs) * 100),
      fill: "bg-kumo-brand",
      text: "text-kumo-strong",
    },
  ];

  return (
    <section className="rounded-lg border border-kumo-hairline bg-kumo-base px-4 py-3">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold text-kumo-strong">Wall clock</h3>
        <span className="text-xs text-kumo-placeholder">
          {run.results.length} paths
          {run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ""}
          {run.modelCalls ? ` · ${run.modelCalls} model calls` : ""}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3">
            <span className={`w-44 shrink-0 text-[12.5px] ${r.text}`}>{r.label}</span>
            <div className="h-[18px] flex-1 overflow-hidden rounded-md bg-kumo-recessed">
              <div className={`h-full rounded-md ${r.fill}`} style={{ width: `${r.pct}%` }} />
            </div>
            <span className={`w-16 shrink-0 text-right text-[13px] font-semibold tabular-nums ${r.text}`}>
              {human(r.ms)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
