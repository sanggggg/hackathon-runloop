"use client";

import { useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import type { Node } from "@branchpoint/schema";
import { TreeCanvas } from "@/components/tree/TreeCanvas";
import { ResultCard, RESULT_CARD } from "@/components/tree/Cards";
import { DetailPanel } from "@/components/run/DetailPanel";
import { RunList } from "@/components/run/RunList";
import { WallClock } from "@/components/run/WallClock";
import { discovered, run, suite } from "@/lib/fixtures";

/** The tree a run covers: the plan, minus unresolved steps, plus what it found. */
function runTree(): Node[] {
  const planned = suite.tree.filter((n) => n.state !== "unresolved");
  return [...planned, discovered];
}

export default function RunPage() {
  const nodes = useMemo(runTree, []);
  const [selected, setSelected] = useState("starter");

  const resultFor = (id: string) => run.results.find((r) => r.nodeId === id);
  const passed = run.results.filter((r) => r.status === "pass").length;
  const failed = run.results.filter((r) => r.status === "fail").length;

  const selectedNode = nodes.find((n) => n.id === selected) ?? nodes[0];

  return (
    <div className="flex h-full">
      <RunList activeId={run.id} />

      <section className="flex min-w-0 flex-1 flex-col bg-kumo-recessed">
        <div className="flex items-center gap-3 px-6 pt-4">
          <Badge variant="success">{passed} passed</Badge>
          <Badge variant="error">{failed} failed</Badge>
          <span className="ml-2 text-xs text-kumo-placeholder">
            green means the path still works, red means it failed
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="secondary">
            Re-run suite
          </Button>
        </div>

        <div className="min-h-0 flex-1">
          <TreeCanvas
            nodes={nodes}
            cardWidth={RESULT_CARD.width}
            cardHeight={RESULT_CARD.height}
            renderNode={(n) => (
              <ResultCard
                node={n}
                result={resultFor(n.id)}
                selected={selected === n.id}
                onSelect={() => setSelected(n.id)}
              />
            )}
            edgeTone={(n) => (resultFor(n.id)?.status === "fail" ? "fail" : "neutral")}
          />
        </div>

        <div className="mx-6 mb-5">
          <WallClock run={run} />
        </div>
      </section>

      <DetailPanel node={selectedNode} result={resultFor(selectedNode.id)} />
    </div>
  );
}
