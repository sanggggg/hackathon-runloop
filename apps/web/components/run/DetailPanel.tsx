"use client";

import Image from "next/image";
import { Button } from "@cloudflare/kumo/components/button";
import type { Node, NodeResult } from "@branchpoint/schema";
import { StatusBadge } from "@/components/tree/Cards";
import { diffs } from "@/lib/fixtures";

const LEVEL_TEXT = {
  info: "text-kumo-subtle",
  warn: "text-kumo-warning",
  error: "text-kumo-danger",
} as const;

function Shot({
  id,
  caption,
  tone,
}: {
  id: string;
  caption: string;
  tone: "neutral" | "warn" | "bad" | "info";
}) {
  const ring = {
    neutral: "border-kumo-hairline",
    warn: "border-kumo-warning ring-3 ring-kumo-warning-tint",
    bad: "border-kumo-danger ring-3 ring-kumo-danger-tint",
    info: "border-kumo-info ring-3 ring-kumo-info-tint",
  }[tone];
  const label = {
    neutral: "text-kumo-placeholder",
    warn: "text-kumo-warning",
    bad: "text-kumo-danger",
    info: "text-kumo-info",
  }[tone];

  return (
    <figure className="min-w-0 flex-1">
      <div className={`h-[106px] overflow-hidden rounded-md border ${ring}`}>
        <Image
          src={`/shots/${id}.png`}
          alt={caption}
          width={264}
          height={165}
          className="h-full w-full object-cover object-top"
        />
      </div>
      <figcaption className={`mt-1.5 text-xs ${label}`}>{caption}</figcaption>
    </figure>
  );
}

export function DetailPanel({ node, result }: { node: Node; result?: NodeResult }) {
  const diff = diffs[node.id];
  const needsVerdict = Boolean(diff);
  const acceptLabel = result?.note === "new-path" ? "Keep in suite" : "Accept as baseline";

  return (
    <aside className="flex w-[384px] shrink-0 flex-col overflow-y-auto border-l border-kumo-hairline bg-kumo-base">
      <div className="border-b border-kumo-hairline p-4">
        <StatusBadge result={result} />
        <h2 className="mt-2.5 text-xl font-semibold tracking-tight text-kumo-strong">
          {node.label}
        </h2>
        {result?.devboxId && (
          <code className="mt-1 block font-mono text-[11px] text-kumo-placeholder">
            {result.devboxId} · {(result.elapsedMs / 1000).toFixed(1)}s
          </code>
        )}
      </div>

      <div className="border-b border-kumo-hairline p-4">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
          Stored intent
        </h3>
        <p className="rounded-md border border-kumo-hairline bg-kumo-recessed px-3 py-2.5 text-[13px] leading-normal text-kumo-default">
          {node.intent}
        </p>
        {result?.resolvedTo && (
          <p className="mt-2 flex items-center gap-2 text-xs text-kumo-placeholder">
            resolved to
            <span
              className={`rounded px-2 py-0.5 ${
                result.status === "fail"
                  ? "bg-kumo-danger-tint text-kumo-danger"
                  : "bg-kumo-success-tint text-kumo-success"
              }`}
            >
              {result.resolvedTo}
            </span>
          </p>
        )}
      </div>

      <div className="border-b border-kumo-hairline p-4">
        <div className="mb-2.5 flex items-baseline justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
            {diff ? diff.title : "Screenshot"}
          </h3>
          <span className="text-xs text-kumo-placeholder">{diff ? diff.meta : "unchanged"}</span>
        </div>

        {diff ? (
          <div className="flex gap-2.5">
            <Shot id={diff.before} caption={diff.beforeCaption} tone={node.id === "import" ? "info" : "neutral"} />
            <Shot
              id={diff.after}
              caption={diff.afterCaption}
              tone={
                result?.status === "fail" ? "bad" : result?.note === "ui-changed" ? "warn" : "neutral"
              }
            />
          </div>
        ) : (
          <p className="rounded-md border border-kumo-hairline bg-kumo-recessed px-3.5 py-3.5 text-[13px] leading-normal text-kumo-subtle">
            Pixel-identical to run 41. Nothing to review here.
          </p>
        )}
      </div>

      <div className="flex-1 p-4">
        <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
          Agent log
        </h3>
        <ol className="flex flex-col gap-2">
          {(result?.log ?? []).map((l, i) => (
            <li key={i} className="flex gap-2.5">
              <code className="w-9 shrink-0 pt-px font-mono text-[11px] text-kumo-inactive">
                +{(l.t / 1000).toFixed(1)}s
              </code>
              <span className={`text-[13px] leading-snug ${LEVEL_TEXT[l.level]}`}>{l.text}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex gap-2 border-t border-kumo-hairline p-3">
        {needsVerdict ? (
          <>
            <Button className="flex-1" variant="primary">
              {acceptLabel}
            </Button>
            <Button className="flex-1" variant="secondary">
              Report as bug
            </Button>
          </>
        ) : (
          <>
            <Button className="flex-1" variant="secondary">
              Fork from here
            </Button>
            <Button className="flex-1" variant="secondary">
              Prune branch
            </Button>
          </>
        )}
      </div>
    </aside>
  );
}
