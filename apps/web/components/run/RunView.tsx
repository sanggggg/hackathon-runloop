"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import type { Node, Run, Suite } from "@branchpoint/schema";
import { TreeCanvas } from "@/components/tree/TreeCanvas";
import { ResultCard, RESULT_CARD } from "@/components/tree/Cards";
import { DetailPanel } from "@/components/run/DetailPanel";
import { RunList } from "@/components/run/RunList";
import { WallClock } from "@/components/run/WallClock";
import { cancelRun, fetchRun, fetchRuns, startRun } from "@/lib/client";

const IN_FLIGHT = new Set(["queued", "running", "cancelling"]);
const isLive = (r?: Run) => Boolean(r && IN_FLIGHT.has(r.executionStatus ?? "succeeded"));

export function RunView({ suite, initialRuns }: { suite: Suite; initialRuns: Run[] }) {
  const [runs, setRuns] = useState(initialRuns);
  const [activeId, setActiveId] = useState(initialRuns[0]?.id);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const active = runs.find((r) => r.id === activeId);
  const live = isLive(active);

  /* Poll only while something is actually in flight. */
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!live || !activeId) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const fresh = await fetchRun(activeId);
        if (cancelled) return;
        setRuns((prev) => prev.map((r) => (r.id === fresh.id ? fresh : r)));
        if (isLive(fresh)) timer.current = setTimeout(tick, 1200);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Polling failed");
      }
    };

    timer.current = setTimeout(tick, 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [live, activeId]);

  const onRun = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { runId } = await startRun(suite.id);
      // The engine answers 202 with an id only, so read the run itself before
      // showing it; polling takes over from there.
      const run = await fetchRun(runId);
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      setActiveId(runId);
      setSelected(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the run");
    } finally {
      setBusy(false);
    }
  }, [suite.id]);

  const onCancel = useCallback(async () => {
    if (!activeId) return;
    setBusy(true);
    try {
      const run = await cancelRun(activeId);
      setRuns((prev) => prev.map((r) => (r.id === run.id ? run : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel");
    } finally {
      setBusy(false);
    }
  }, [activeId]);

  /* When a run finishes, refresh the list so the rail's summary is right. */
  useEffect(() => {
    if (live) return;
    fetchRuns(suite.id).then(setRuns).catch(() => {});
  }, [live, suite.id]);

  /* The plan, plus whatever the run found that the plan did not have. */
  const nodes = useMemo<Node[]>(() => {
    const planned = suite.tree.filter((n) => n.state !== "unresolved");
    const extra = (active?.discovered ?? []).filter((d) => !planned.some((n) => n.id === d.id));
    return [...planned, ...extra];
  }, [suite.tree, active]);

  const resultFor = (id: string) => active?.results.find((r) => r.nodeId === id);

  /* The same node's capture from the run before this one, when there is one.
     The engine stores a screenshot per result, so a before/after is just two
     runs read side by side rather than anything it has to compute. */
  const previousShotFor = (nodeId: string) => {
    const idx = runs.findIndex((r) => r.id === activeId);
    for (const older of runs.slice(idx + 1)) {
      const hit = older.results.find((r) => r.nodeId === nodeId && r.screenshotId);
      if (hit) return hit.screenshotId;
    }
    return undefined;
  };
  const passed = active?.results.filter((r) => r.status === "pass").length ?? 0;
  const failed = active?.results.filter((r) => r.status === "fail").length ?? 0;
  const selectedNode = nodes.find((n) => n.id === selected);

  return (
    <div className="flex h-full">
      <RunList runs={runs} suite={suite} activeId={activeId} onSelect={setActiveId} />

      <section className="flex min-w-0 flex-1 flex-col bg-kumo-recessed">
        <div className="flex items-center gap-3 px-6 pt-4">
          {active ? (
            <>
              <Badge variant="success">{passed} passed</Badge>
              <Badge variant="error">{failed} failed</Badge>
              {live && (
                <Badge variant="info">
                  {active.executionStatus} · {active.results.length}/{nodes.length - 1}
                </Badge>
              )}
            </>
          ) : (
            <Badge variant="secondary">never run</Badge>
          )}

          <div className="flex-1" />

          {live ? (
            <Button size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={onRun} disabled={busy}>
              {busy ? "Starting…" : active ? "Re-run suite" : "Run now"}
            </Button>
          )}
        </div>

        {error && (
          <p className="mx-6 mt-3 rounded-lg border border-kumo-danger bg-kumo-danger-tint px-4 py-2.5 text-[13px] text-kumo-danger">
            {error}
          </p>
        )}
        {active?.error && (
          <p className="mx-6 mt-3 rounded-lg border border-kumo-danger bg-kumo-danger-tint px-4 py-2.5 text-[13px] text-kumo-danger">
            <b>{active.error.code}</b> — {active.error.message}
          </p>
        )}

        <div className="min-h-0 flex-1">
          <TreeCanvas
            nodes={nodes}
            cardWidth={RESULT_CARD.width}
            cardHeight={RESULT_CARD.height}
            renderNode={(n) => (
              <ResultCard
                node={n}
                result={resultFor(n.id)}
                pending={live && !resultFor(n.id) && n.kind !== "fixture"}
                selected={selected === n.id}
                onSelect={() => setSelected(n.id)}
              />
            )}
            edgeTone={(n) => (resultFor(n.id)?.status === "fail" ? "fail" : "neutral")}
          />
        </div>

        {active && !live && (
          <div className="mx-6 mb-5">
            <WallClock run={active} />
          </div>
        )}
      </section>

      {selectedNode && (
        <DetailPanel
          node={selectedNode}
          result={resultFor(selectedNode.id)}
          previousShotId={previousShotFor(selectedNode.id)}
        />
      )}
    </div>
  );
}
