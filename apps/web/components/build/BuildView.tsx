"use client";

import { useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import type { Node, Suite } from "@branchpoint/schema";
import { TreeCanvas } from "@/components/tree/TreeCanvas";
import { IntentCard, INTENT_CARD } from "@/components/tree/Cards";
import { saveTree } from "@/lib/client";

/**
 * The suite's tree, editable in the one way the engine supports: PATCH replaces
 * the whole tree. So edits are made locally and saved as a set.
 */
export function BuildView({ suite }: { suite: Suite }) {
  const [tree, setTree] = useState<Node[]>(suite.tree);
  const [selectedId, setSelectedId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const dirty = JSON.stringify(tree) !== JSON.stringify(suite.tree);
  const selected = tree.find((n) => n.id === selectedId);

  const patch = (id: string, fields: Partial<Node>) => {
    setTree((prev) => prev.map((n) => (n.id === id ? { ...n, ...fields } : n)));
    setSaved(false);
  };

  /** Removing a step takes everything under it — there is nowhere else to hang. */
  const dropSubtree = (id: string) => {
    setTree((prev) => {
      const doomed = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of prev) {
          if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
            doomed.add(n.id);
            grew = true;
          }
        }
      }
      return prev.filter((n) => !doomed.has(n.id));
    });
    setSelectedId(undefined);
    setSaved(false);
  };

  const onSave = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const next = await saveTree(suite.id, tree);
      setTree(next.tree);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const counts = {
    verified: tree.filter((n) => n.state === "verified").length,
    unresolved: tree.filter((n) => n.state === "unresolved").length,
    unverified: tree.filter((n) => n.state === "unverified").length,
  };

  const descendants = selected
    ? tree.filter((n) => {
        let cur: Node | undefined = n;
        while (cur?.parentId) {
          if (cur.parentId === selected.id) return true;
          cur = tree.find((x) => x.id === cur!.parentId);
        }
        return false;
      }).length
    : 0;

  return (
    <div className="flex h-full">
      <section className="flex min-w-0 flex-1 flex-col bg-kumo-recessed">
        <div className="flex items-center gap-3 px-6 pt-4">
          <Badge variant="secondary">{counts.verified} verified</Badge>
          {counts.unresolved > 0 && <Badge variant="error">{counts.unresolved} unresolved</Badge>}
          {counts.unverified > 0 && <Badge variant="info">{counts.unverified} unverified</Badge>}

          <span className="ml-1 text-xs text-kumo-placeholder">
            every step stores an intent, never a selector
          </span>

          <div className="flex-1" />

          {saved && !dirty && <span className="text-xs text-kumo-success">Saved</span>}
          <Button size="sm" variant="primary" onClick={onSave} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save tree"}
          </Button>
        </div>

        {error && (
          <p className="mx-6 mt-3 rounded-lg border border-kumo-danger bg-kumo-danger-tint px-4 py-2.5 text-[13px] text-kumo-danger">
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1">
          <TreeCanvas
            nodes={tree}
            cardWidth={INTENT_CARD.width}
            cardHeight={INTENT_CARD.height}
            renderNode={(n) => (
              <IntentCard
                node={n}
                selected={selectedId === n.id}
                onSelect={() => setSelectedId(n.id)}
              />
            )}
            edgeTone={(n) =>
              n.state === "unresolved" ? "fail" : n.state === "unverified" ? "new" : "neutral"
            }
          />
        </div>

        {counts.unresolved > 0 && (
          <p className="mx-6 mb-5 rounded-lg border border-kumo-danger bg-kumo-danger-tint px-4 py-3 text-[13px] text-kumo-danger">
            A red step is a bug in the tree, not in the app: the last run found nothing on the page
            matching its wording. Reword it or drop it.
          </p>
        )}
      </section>

      <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-kumo-hairline bg-kumo-base">
        {!selected ? (
          <div className="p-5">
            <h2 className="text-sm font-semibold text-kumo-strong">Pick a step</h2>
            <p className="mt-1.5 text-[13px] leading-normal text-kumo-subtle">
              Nothing executes on this side. Each step stores a sentence the agent resolves against
              the live page at run time — which is why there is no selector to keep in sync.
            </p>
          </div>
        ) : (
          <>
            <div className="border-b border-kumo-hairline p-4">
              <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
                {selected.kind}
              </span>
              <input
                value={selected.label}
                onChange={(e) => patch(selected.id, { label: e.target.value })}
                className="mt-1.5 w-full rounded-md border border-kumo-hairline bg-kumo-base px-2.5 py-1.5 text-[15px] font-medium text-kumo-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-kumo-focus"
              />
            </div>

            <div className="border-b border-kumo-hairline p-4">
              <label
                htmlFor="intent"
                className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder"
              >
                Intent
              </label>
              <textarea
                id="intent"
                rows={3}
                value={selected.intent}
                onChange={(e) => patch(selected.id, { intent: e.target.value })}
                className="w-full resize-y rounded-md border border-kumo-hairline bg-kumo-recessed px-3 py-2.5 text-[13px] leading-normal text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-kumo-focus"
              />

              {selected.kind === "goal" && (
                <>
                  <label
                    htmlFor="expected"
                    className="mb-2 mt-4 block text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder"
                  >
                    Expected outcome
                  </label>
                  <input
                    id="expected"
                    value={selected.expectedOutcome ?? ""}
                    onChange={(e) => patch(selected.id, { expectedOutcome: e.target.value })}
                    className="w-full rounded-md border border-kumo-hairline bg-kumo-recessed px-3 py-2 text-[13px] text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-kumo-focus"
                  />
                </>
              )}

              {selected.lastSeenLabel && (
                <p className="mt-3 text-xs leading-normal text-kumo-placeholder">
                  Last resolved to{" "}
                  <span className="text-kumo-subtle">&ldquo;{selected.lastSeenLabel}&rdquo;</span>.
                  Kept as a hint for the agent, never used to skip it.
                </p>
              )}
            </div>

            {selected.parentId && (
              <div className="p-4">
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={() => dropSubtree(selected.id)}
                >
                  {descendants > 0 ? `Drop this and ${descendants} below` : "Drop this step"}
                </Button>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
