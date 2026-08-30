"use client";

import type { Node, NodeResult } from "@branchpoint/schema";
import { shotUrl } from "@/lib/client";

/* ── Build: an intent in words. No run has touched it, so no screenshot. ── */

export const INTENT_CARD = { width: 168, height: 132 };

const RING: Record<Node["state"], string> = {
  verified: "border-kumo-hairline",
  unresolved: "border-kumo-danger bg-kumo-danger-tint",
  unverified: "border-kumo-info border-dashed",
};

const KICKER: Record<Node["state"], string> = {
  verified: "text-kumo-placeholder",
  unresolved: "text-kumo-danger",
  unverified: "text-kumo-info",
};

export function IntentCard({
  node,
  selected,
  onSelect,
}: {
  node: Node;
  selected: boolean;
  onSelect: () => void;
}) {
  const kicker = node.state === "verified" ? node.kind : node.state;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full flex-col rounded-lg border bg-kumo-base p-3 text-left shadow-sm
        transition hover:border-kumo-placeholder focus-visible:outline-2
        focus-visible:outline-offset-2 focus-visible:outline-kumo-focus
        ${RING[node.state]} ${selected ? "ring-3 ring-kumo-info-tint" : ""}`}
      style={{ height: INTENT_CARD.height }}
    >
      <span className={`text-[10.5px] font-semibold uppercase tracking-[0.05em] ${KICKER[node.state]}`}>
        {kicker}
      </span>
      <span className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-tight text-kumo-strong">
        {node.label}
      </span>
      <span
        className={`mt-1 line-clamp-3 text-xs leading-snug ${
          node.state === "unresolved" ? "text-kumo-danger" : "text-kumo-subtle"
        }`}
      >
        {node.intent}
      </span>
    </button>
  );
}

/* ── Run: the same node, decorated with what happened. ─────────────────── */

export const RESULT_CARD = { width: 152, height: 158 };

export function ResultCard({
  node,
  result,
  pending,
  selected,
  onSelect,
}: {
  node: Node;
  result?: NodeResult;
  pending: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const isFixture = node.kind === "fixture";
  const failed = result?.status === "fail";

  const stripe = isFixture
    ? "bg-kumo-placeholder"
    : pending
      ? "bg-kumo-info"
      : !result
        ? "bg-kumo-inactive"
        : failed
          ? "bg-kumo-danger"
          : "bg-kumo-success";

  const meta = isFixture
    ? "fixture"
    : pending
      ? "running…"
      : !result
        ? "not run"
        : failed
          ? result.failReason === "unresolved"
            ? "failed · matched nothing"
            : "failed · wrong screen"
          : result.note === "ui-changed"
            ? "passed · UI changed"
            : result.note === "new-path"
              ? "passed · new path"
              : "passed";

  const metaTone = isFixture
    ? "text-kumo-subtle"
    : pending
      ? "text-kumo-info"
      : !result
        ? "text-kumo-placeholder"
        : failed
          ? "text-kumo-danger"
          : "text-kumo-success";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full overflow-hidden rounded-lg border bg-kumo-base text-left shadow-sm transition
        hover:border-kumo-placeholder focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-kumo-focus
        ${selected ? (failed ? "border-kumo-danger ring-3 ring-kumo-danger-tint" : "border-kumo-success ring-3 ring-kumo-success-tint") : "border-kumo-hairline"}
        ${pending ? "animate-pulse" : ""}`}
      style={{ height: RESULT_CARD.height }}
    >
      <div className="relative h-[92px] overflow-hidden border-b border-kumo-hairline bg-kumo-recessed">
        <span className={`absolute inset-y-0 left-0 z-10 w-[3px] ${stripe}`} />
        {result?.screenshotId ? (
          // Not next/image: the id is opaque and the bytes come through our own
          // authenticated proxy, so there is nothing to optimise at build time.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shotUrl(result.screenshotId)}
            alt=""
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-[11px] text-kumo-placeholder">
            {pending ? "capturing…" : "no capture"}
          </span>
        )}
      </div>
      <div className="p-2.5">
        <span className="line-clamp-2 block text-[13px] font-medium leading-tight text-kumo-strong">
          {node.label}
        </span>
        <span className={`mt-1 block text-xs ${metaTone}`}>{meta}</span>
      </div>
    </button>
  );
}
