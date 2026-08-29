"use client";

import type { ReactNode } from "react";
import type { Node } from "@branchpoint/schema";
import { edgePath, layoutTree } from "@/lib/tree-layout";

export type EdgeTone = "neutral" | "fail" | "new";

const EDGE_STROKE: Record<EdgeTone, string> = {
  neutral: "stroke-kumo-interact",
  fail: "stroke-kumo-danger",
  new: "stroke-kumo-info",
};

interface Props {
  nodes: Node[];
  cardWidth: number;
  cardHeight: number;
  /** Renders one card. The tree owns position; the caller owns everything inside. */
  renderNode: (node: Node) => ReactNode;
  /** Colour and dash the edge leading into `node`. */
  edgeTone?: (node: Node) => EdgeTone;
  gapX?: number;
  gapY?: number;
}

/**
 * The same tree renders in Build and in Run — only the cards differ. That is
 * the point: the plan and the suite are one object, not two that need syncing.
 */
export function TreeCanvas({
  nodes,
  cardWidth,
  cardHeight,
  renderNode,
  edgeTone = () => "neutral",
  gapX,
  gapY,
}: Props) {
  const { placed, edges, width, height } = layoutTree(nodes, {
    cardWidth,
    cardHeight,
    gapX,
    gapY,
  });

  return (
    <div className="flex h-full w-full items-start justify-center overflow-auto p-8">
      <div className="relative shrink-0" style={{ width, height }}>
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={width}
          height={height}
          aria-hidden="true"
        >
          {edges.map((e) => {
            const tone = edgeTone(e.to.node);
            return (
              <path
                key={e.id}
                d={edgePath(e.from, e.to, cardHeight)}
                fill="none"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeDasharray={tone === "new" ? "5 4" : undefined}
                className={EDGE_STROKE[tone]}
              />
            );
          })}
        </svg>

        {placed.map((p) => (
          <div
            key={p.node.id}
            className="absolute -translate-x-1/2"
            style={{ left: p.x, top: p.y, width: cardWidth }}
          >
            {renderNode(p.node)}
          </div>
        ))}
      </div>
    </div>
  );
}
