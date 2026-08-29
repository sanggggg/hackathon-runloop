"use client";

import Image from "next/image";
import { Badge } from "@cloudflare/kumo/components/badge";
import type { Node, NodeResult } from "@branchpoint/schema";

/* ── Build route: an intent, in words, with no screenshot ───────────── */

export const INTENT_CARD = { width: 164, height: 132 };

const STATE_RING: Record<Node["state"], string> = {
  verified: "border-kumo-hairline",
  unresolved: "border-kumo-danger bg-kumo-danger-tint",
  unverified: "border-kumo-info border-dashed",
};

const STATE_KICKER: Record<Node["state"], string> = {
  verified: "text-kumo-placeholder",
  unresolved: "text-kumo-danger",
  unverified: "text-kumo-info",
};

export function IntentCard({ node }: { node: Node }) {
  const kicker =
    node.state === "unresolved"
      ? "unresolved"
      : node.state === "unverified"
        ? "unverified"
        : node.kind;

  return (
    <div
      className={`flex flex-col rounded-lg border bg-kumo-base p-3 shadow-sm ${STATE_RING[node.state]}`}
      style={{ height: INTENT_CARD.height }}
    >
      <span
        className={`text-[10.5px] font-semibold uppercase tracking-[0.05em] ${STATE_KICKER[node.state]}`}
      >
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
    </div>
  );
}

/* ── Run route: the same node, decorated with what happened ─────────── */

export const RESULT_CARD = { width: 148, height: 158 };

export function ResultCard({
  node,
  result,
  selected,
  onSelect,
}: {
  node: Node;
  result?: NodeResult;
  selected: boolean;
  onSelect: () => void;
}) {
  const failed = result?.status === "fail";
  const isFixture = node.kind === "fixture";

  const stripe = isFixture
    ? "bg-kumo-placeholder"
    : failed
      ? "bg-kumo-danger"
      : "bg-kumo-success";

  const meta = isFixture
    ? "fixture snapshot"
    : !result
      ? "not run"
      : failed
        ? "failed · dead end"
        : result.note === "ui-changed"
          ? "passed · UI changed"
          : result.note === "new-path"
            ? "passed · new path"
            : "passed";

  const shot = isFixture ? "root" : result?.screenshotId;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full overflow-hidden rounded-lg border bg-kumo-base text-left shadow-sm transition
        hover:border-kumo-placeholder focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-kumo-focus
        ${selected ? (failed ? "border-kumo-danger ring-3 ring-kumo-danger-tint" : "border-kumo-success ring-3 ring-kumo-success-tint") : "border-kumo-hairline"}`}
      style={{ height: RESULT_CARD.height }}
    >
      <div className="relative h-[92px] overflow-hidden border-b border-kumo-hairline bg-kumo-recessed">
        <span className={`absolute inset-y-0 left-0 z-10 w-[3px] ${stripe}`} />
        {shot ? (
          <Image
            src={`/shots/${shot}.png`}
            alt=""
            width={264}
            height={165}
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-[11px] text-kumo-placeholder">
            not captured
          </span>
        )}
      </div>
      <div className="p-2.5">
        <span className="line-clamp-2 block text-[13px] font-medium leading-tight text-kumo-strong">
          {node.label}
        </span>
        <span
          className={`mt-1 block text-xs ${
            isFixture ? "text-kumo-subtle" : failed ? "text-kumo-danger" : "text-kumo-success"
          }`}
        >
          {meta}
        </span>
      </div>
    </button>
  );
}

/* ── shared ─────────────────────────────────────────────────────────── */

export function StatusBadge({ result }: { result?: NodeResult }) {
  if (!result) return <Badge variant="neutral">Fixture</Badge>;
  return result.status === "fail" ? (
    <Badge variant="error">Failed</Badge>
  ) : (
    <Badge variant="success">Passed</Badge>
  );
}
