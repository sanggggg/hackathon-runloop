"use client";

import type { Node, NodeResult } from "@branchpoint/schema";
import { Badge } from "@cloudflare/kumo/components/badge";
import { shotUrl } from "@/lib/client";

const LEVEL = {
  info: "text-kumo-subtle",
  warn: "text-kumo-warning",
  error: "text-kumo-danger",
} as const;

const FAIL_REASON = {
  unresolved: "Nothing on the page matched this step's wording. That is a stale tree, not a broken app.",
  "error-screen": "The control resolved, but the screen it led to was not the expected one.",
  timeout: "The branch ran out of time before reaching a verdict.",
} as const;

export function DetailPanel({
  node,
  result,
  previousShotId,
}: {
  node: Node;
  result?: NodeResult;
  /** Same node's capture from the run before, when there is one. */
  previousShotId?: string;
}) {
  const failed = result?.status === "fail";

  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-kumo-hairline bg-kumo-base">
      <div className="border-b border-kumo-hairline p-4">
        {result ? (
          failed ? <Badge variant="error">Failed</Badge> : <Badge variant="success">Passed</Badge>
        ) : (
          <Badge variant="secondary">Not run</Badge>
        )}
        <h2 className="mt-2.5 text-xl font-semibold tracking-tight text-kumo-strong">
          {node.label}
        </h2>
        {result && (
          <code className="mt-1 block font-mono text-[11px] text-kumo-placeholder">
            {result.devboxId} · {(result.elapsedMs / 1000).toFixed(1)}s
            {result.modelCalls ? ` · ${result.modelCalls} model calls` : ""}
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
        {node.expectedOutcome && (
          <p className="mt-2 text-xs leading-normal text-kumo-placeholder">
            Expected outcome: <span className="text-kumo-subtle">{node.expectedOutcome}</span>
          </p>
        )}
        {result?.resolvedTo && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-kumo-placeholder">
            resolved to
            <span
              className={`rounded px-2 py-0.5 ${
                failed ? "bg-kumo-danger-tint text-kumo-danger" : "bg-kumo-success-tint text-kumo-success"
              }`}
            >
              {result.resolvedTo}
            </span>
          </p>
        )}
      </div>

      {result?.failReason && (
        <div className="border-b border-kumo-hairline p-4">
          <p className="rounded-md border border-kumo-danger bg-kumo-danger-tint px-3 py-2.5 text-[13px] leading-normal text-kumo-danger">
            {FAIL_REASON[result.failReason]}
          </p>
        </div>
      )}

      {result?.screenshotId && (
        <div className="border-b border-kumo-hairline p-4">
          <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
            {previousShotId ? "This run, and the one before" : "Capture"}
          </h3>
          <div className="flex gap-2.5">
            {previousShotId && (
              <figure className="min-w-0 flex-1">
                <div className="overflow-hidden rounded-md border border-kumo-hairline">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={shotUrl(previousShotId)} alt="previous run" className="w-full" />
                </div>
                <figcaption className="mt-1.5 text-xs text-kumo-placeholder">previous run</figcaption>
              </figure>
            )}
            <figure className="min-w-0 flex-1">
              <div
                className={`overflow-hidden rounded-md border ${
                  failed
                    ? "border-kumo-danger ring-3 ring-kumo-danger-tint"
                    : result.note === "ui-changed"
                      ? "border-kumo-warning ring-3 ring-kumo-warning-tint"
                      : "border-kumo-hairline"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={shotUrl(result.screenshotId)} alt="this run" className="w-full" />
              </div>
              <figcaption
                className={`mt-1.5 text-xs ${
                  failed
                    ? "text-kumo-danger"
                    : result.note === "ui-changed"
                      ? "text-kumo-warning"
                      : "text-kumo-placeholder"
                }`}
              >
                {result.note === "ui-changed" ? "this run · UI changed" : "this run"}
              </figcaption>
            </figure>
          </div>
        </div>
      )}

      <div className="flex-1 p-4">
        <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
          Agent log
        </h3>
        {result?.log?.length ? (
          <ol className="flex flex-col gap-2">
            {result.log.map((l, i) => (
              <li key={i} className="flex gap-2.5">
                <code className="w-10 shrink-0 pt-px font-mono text-[11px] text-kumo-inactive">
                  +{(l.t / 1000).toFixed(1)}s
                </code>
                <span className={`text-[13px] leading-snug ${LEVEL[l.level]}`}>{l.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[13px] text-kumo-placeholder">No log for this step yet.</p>
        )}
      </div>
    </aside>
  );
}
