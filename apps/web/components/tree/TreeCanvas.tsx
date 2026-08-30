"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { Node } from "@branchpoint/schema";
import { edgePath, layoutTree } from "@/lib/tree-layout";

export type EdgeTone = "neutral" | "fail" | "new";

const EDGE_STROKE: Record<EdgeTone, string> = {
  neutral: "stroke-kumo-interact",
  fail: "stroke-kumo-danger",
  new: "stroke-kumo-info",
};

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
/** Past this much movement a pointer gesture is a pan, not a click on a card. */
const DRAG_SLOP = 4;
const PAD = 48;

interface View {
  x: number;
  y: number;
  z: number;
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

interface Props {
  nodes: Node[];
  cardWidth: number;
  cardHeight: number;
  renderNode: (node: Node) => ReactNode;
  edgeTone?: (node: Node) => EdgeTone;
  gapX?: number;
  gapY?: number;
}

/**
 * The same tree renders in Build and in Run — only the cards differ. The canvas
 * owns position and navigation; the caller owns everything inside a card.
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

  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ ox: number; oy: number; vx: number; vy: number; moved: number } | null>(
    null,
  );
  const swallowClick = useRef(false);

  /** Zoom around a point in container coordinates, so the cursor stays put. */
  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      const z = clampZoom(v.z * factor);
      const k = z / v.z;
      return { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  const zoomCentre = useCallback(
    (factor: number) => {
      const el = wrap.current;
      if (!el) return;
      zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
    },
    [zoomAt],
  );

  /** Centre the tree, shrinking it only if it does not already fit. */
  const fit = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const w = el.clientWidth - PAD * 2;
    const h = el.clientHeight - PAD * 2;
    if (w <= 0 || h <= 0) return;

    const z = Math.min(1, clampZoom(Math.min(w / width, h / height)));
    setView({
      x: (el.clientWidth - width * z) / 2,
      y: Math.max(PAD, (el.clientHeight - height * z) / 2),
      z,
    });
  }, [width, height]);

  useLayoutEffect(fit, [fit]);

  /** The container is often 0×0 on first layout, so fit again once it is real. */
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let seen = false;
    const ro = new ResizeObserver(() => {
      if (!seen && el.clientWidth > 0) {
        seen = true;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  /**
   * React attaches wheel passively, so `preventDefault` there is ignored and a
   * pinch would zoom the whole page. This listener has to be a native one.
   */
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // A trackpad pinch arrives as ctrl+wheel; plain wheel pans, as in Figma.
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY / 260));
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    // Deliberately no pointer capture yet: capturing here would retarget the
    // click to this container, and cards would stop being clickable.
    drag.current = { ox: e.clientX, oy: e.clientY, vx: view.x, vy: view.y, moved: 0 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.ox;
    const dy = e.clientY - d.oy;
    d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy));

    // Only once this is unambiguously a pan do we take the pointer, so the
    // gesture keeps working when it leaves the container.
    if (d.moved <= DRAG_SLOP) return;
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setPanning(true);
    }
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // A drag that began on a card must not also select it.
    if (d.moved > DRAG_SLOP) swallowClick.current = true;
    drag.current = null;
    setPanning(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrap.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.altKey || e.shiftKey ? 1 / 1.6 : 1.6);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 160 : 48;
    const pans: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    if (pans[e.key]) {
      e.preventDefault();
      const [dx, dy] = pans[e.key];
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomCentre(1.25);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomCentre(1 / 1.25);
    } else if (e.key === "0") {
      e.preventDefault();
      fit();
    }
  };

  return (
    <div
      ref={wrap}
      role="application"
      aria-label="Scenario tree. Drag to pan, arrow keys to move, plus and minus to zoom, 0 to fit."
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={onClickCapture}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className={`relative h-full w-full touch-none overflow-hidden outline-none
        focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus
        ${panning ? "cursor-grabbing" : "cursor-grab"}`}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width,
          height,
          transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.z})`,
        }}
      >
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

      <div className="pointer-events-none absolute bottom-4 right-4 flex items-center gap-2">
        <span className="hidden rounded-md bg-kumo-base/85 px-2 py-1 text-[11px] text-kumo-placeholder backdrop-blur sm:block">
          drag to pan · pinch to zoom · double-click to zoom in
        </span>
        <div className="pointer-events-auto flex overflow-hidden rounded-md border border-kumo-hairline bg-kumo-base shadow-sm">
          <CanvasButton label="Zoom out" onClick={() => zoomCentre(1 / 1.25)}>
            −
          </CanvasButton>
          <span className="w-12 border-x border-kumo-hairline py-1 text-center text-[11px] tabular-nums text-kumo-subtle">
            {Math.round(view.z * 100)}%
          </span>
          <CanvasButton label="Zoom in" onClick={() => zoomCentre(1.25)}>
            +
          </CanvasButton>
          <CanvasButton label="Fit to view" onClick={fit}>
            <span className="text-[11px]">Fit</span>
          </CanvasButton>
        </div>
      </div>
    </div>
  );
}

function CanvasButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={onClick}
      className="min-w-8 px-2 py-1 text-[13px] leading-5 text-kumo-subtle transition hover:bg-kumo-recessed hover:text-kumo-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-focus"
    >
      {children}
    </button>
  );
}
