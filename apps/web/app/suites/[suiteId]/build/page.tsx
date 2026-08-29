"use client";

import { useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import type { Node } from "@branchpoint/schema";
import { TreeCanvas } from "@/components/tree/TreeCanvas";
import { IntentCard, INTENT_CARD } from "@/components/tree/Cards";
import { ChatPanel, type Message } from "@/components/build/ChatPanel";
import { discovered, suite } from "@/lib/fixtures";

const SEED_FEED: Message[] = [
  { from: "user", text: "Cover our signup and onboarding. Skip anything that charges a card." },
  {
    from: "agent",
    text: "Every branch starts from the signed-in fixture, so none of them re-register. Billing is excluded.",
  },
  {
    from: "agent",
    text: "Run 42 verified 8 of 9 steps. One intent matched nothing on the page — it is marked in the tree.",
  },
];

type ActionId = "adopt" | "reword" | "drop";

const ACTIONS: Record<ActionId, { label: string; user: string; agent: string }> = {
  adopt: {
    label: "Adopt the CSV import path run 42 discovered",
    user: "Yes, keep the CSV import path.",
    agent: "Added it under Solo plan. It stays unverified until the next run confirms it.",
  },
  reword: {
    label: "Reword the step that matched nothing",
    user: 'Reword it — I meant the "Decide later" shortcut.',
    agent: "Rewrote the intent. The next run will check the new wording.",
  },
  drop: {
    label: "Drop the step that matched nothing",
    user: "There is no skip-everything button. Drop it.",
    agent: "Removed. The tree no longer claims a flow the app does not have.",
  },
};

export default function BuildPage() {
  const [nodes, setNodes] = useState<Node[]>(suite.tree);
  const [feed, setFeed] = useState<Message[]>(SEED_FEED);
  const [used, setUsed] = useState<ActionId[]>([]);

  function act(id: ActionId) {
    if (used.includes(id)) return;
    const a = ACTIONS[id];

    setNodes((prev) => {
      if (id === "adopt") {
        return prev.some((n) => n.id === discovered.id) ? prev : [...prev, discovered];
      }
      if (id === "drop") return prev.filter((n) => n.id !== "skipall");
      return prev.map((n) =>
        n.id === "skipall"
          ? {
              ...n,
              state: "unverified",
              intent: 'Use the "Decide later" shortcut to leave setup',
            }
          : n,
      );
    });

    setUsed((prev) => [...prev, id]);
    setFeed((prev) => [...prev, { from: "user", text: a.user }, { from: "agent", text: a.agent }]);
  }

  const counts = {
    verified: nodes.filter((n) => n.state === "verified").length,
    unresolved: nodes.filter((n) => n.state === "unresolved").length,
    unverified: nodes.filter((n) => n.state === "unverified").length,
  };
  const clean = counts.unresolved === 0;
  const resolvedActionTaken = used.includes("drop") || used.includes("reword");

  return (
    <div className="flex h-full">
      <ChatPanel
        title="Describe the flows to cover"
        blurb="Nothing executes here. Each card stores an intent in plain words — runs are what turn those into verified paths."
        messages={feed}
        suggestionsLabel="Suggested from run 42"
        suggestions={[
          { id: "adopt", label: ACTIONS.adopt.label, done: used.includes("adopt") },
          { id: "reword", label: ACTIONS.reword.label, done: resolvedActionTaken },
          { id: "drop", label: ACTIONS.drop.label, done: resolvedActionTaken },
        ]}
        onSuggestion={(id) => act(id as ActionId)}
        status={clean ? "Ready to save and run" : "One intent still needs a decision"}
      />

      <section className="flex min-w-0 flex-1 flex-col bg-kumo-recessed">
        <div className="flex items-center gap-4 px-6 pt-4">
          <Badge variant="secondary">{counts.verified} verified</Badge>
          {counts.unresolved > 0 && <Badge variant="error">{counts.unresolved} unresolved</Badge>}
          {counts.unverified > 0 && <Badge variant="info">{counts.unverified} unverified</Badge>}
          <div className="flex-1" />
          <span className="text-xs text-kumo-placeholder">
            every card stores an intent, never a selector
          </span>
          <Button size="sm" variant="primary">
            Save &amp; run
          </Button>
        </div>

        <div className="min-h-0 flex-1">
          <TreeCanvas
            nodes={nodes}
            cardWidth={INTENT_CARD.width}
            cardHeight={INTENT_CARD.height}
            renderNode={(n) => <IntentCard node={n} />}
            edgeTone={(n) =>
              n.state === "unresolved" ? "fail" : n.state === "unverified" ? "new" : "neutral"
            }
          />
        </div>

        <p
          className={`mx-6 mb-5 rounded-lg border px-4 py-3 text-[13px] ${
            clean
              ? "border-kumo-hairline bg-kumo-base text-kumo-subtle"
              : "border-kumo-danger bg-kumo-danger-tint text-kumo-danger"
          }`}
        >
          {clean
            ? "Nothing unresolved left. Save and run — the next run verifies whatever is still dashed."
            : "A red card is a bug in the tree, not in the app: run 42 could not find anything on the page matching those words."}
        </p>
      </section>
    </div>
  );
}
