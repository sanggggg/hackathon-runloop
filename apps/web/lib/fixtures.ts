/**
 * Hand-written sample data so both routes render before the engine exists.
 * Swap these for real API calls once `POST /runs` returns something.
 *
 * The shapes come from @branchpoint/schema — if the compiler complains here,
 * the contract changed and the engine team needs to know.
 */
import type { Node, NodeResult, Run, Suite } from "@branchpoint/schema";

export const suite: Suite = {
  id: "nimbus-onboarding",
  name: "nimbus-onboarding",
  repo: {
    url: "https://github.com/nimbus-labs/nimbus",
    ref: "def456",
    buildCmd: "npm install",
    startCmd: "npm run dev",
    port: 3000,
  },
  blueprintId: "bpt_nimbus_deps",
  fixture: {
    snapshotId: "snp_34Fj0JG",
    ref: "def456",
    description: "signed in, first screen",
    screenshotId: "root",
  },
  tree: [
    {
      id: "root",
      parentId: null,
      label: "Signed-in workspace",
      intent: "Start every branch from the verified account",
      kind: "fixture",
      state: "verified",
    },
    {
      id: "team",
      parentId: "root",
      label: "Team plan",
      intent: "Choose the team option",
      kind: "step",
      state: "verified",
      lastSeenLabel: "Team plan",
    },
    {
      id: "solo",
      parentId: "root",
      label: "Solo plan",
      intent: "Choose the solo option",
      kind: "step",
      state: "verified",
      lastSeenLabel: "Solo plan",
    },
    {
      id: "later",
      parentId: "root",
      label: "Decide later",
      intent: "Defer the choice for now",
      kind: "step",
      state: "verified",
      lastSeenLabel: "Decide later",
    },
    {
      id: "invite",
      parentId: "team",
      label: "Invite teammates",
      intent: "Send invitations, then reach the finished screen",
      kind: "goal",
      state: "verified",
      lastSeenLabel: "Invite teammates",
    },
    {
      id: "skipinv",
      parentId: "team",
      label: "Skip invites",
      intent: "Skip inviting and still finish setup",
      kind: "goal",
      state: "verified",
      lastSeenLabel: "Skip invites",
    },
    {
      id: "starter",
      parentId: "solo",
      label: "Starter template",
      intent: "Pick the prepared template and finish",
      kind: "goal",
      state: "verified",
      lastSeenLabel: "Use a starter",
    },
    {
      id: "blank",
      parentId: "solo",
      label: "Blank workspace",
      intent: "Start from nothing and still finish",
      kind: "goal",
      state: "verified",
      lastSeenLabel: "Blank workspace",
    },
    {
      id: "skipall",
      parentId: "later",
      label: "Skip onboarding",
      intent: "Leave setup entirely without answering anything",
      kind: "goal",
      // The interesting state: run 42 found nothing on the page matching these
      // words. A bug in the tree, not the app — fixed in Build, not in code.
      state: "unresolved",
    },
  ],
};

/** Discovered during run 42; offered in Build for a human to adopt. */
export const discovered: Node = {
  id: "import",
  parentId: "solo",
  label: "Import from CSV",
  intent: "Bring records in from a spreadsheet",
  kind: "goal",
  state: "unverified",
  lastSeenLabel: "Import from CSV",
};

const results: NodeResult[] = [
  {
    nodeId: "team",
    status: "pass",
    resolvedTo: '"Team plan" card',
    screenshotId: "team",
    devboxId: "dbx_34FiEurF",
    elapsedMs: 6400,
    log: [
      { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
      { t: 3100, text: "Matched the intent on the first try", level: "info" },
      { t: 6400, text: "Reached step 2", level: "info" },
    ],
  },
  {
    nodeId: "solo",
    status: "pass",
    resolvedTo: '"Solo plan" card',
    screenshotId: "solo",
    devboxId: "dbx_34FiEur9",
    elapsedMs: 6900,
    log: [
      { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
      { t: 3000, text: "Matched the intent on the first try", level: "info" },
      { t: 6900, text: "Reached step 2", level: "info" },
    ],
  },
  {
    nodeId: "later",
    status: "fail",
    failReason: "error-screen",
    resolvedTo: '"Decide later" card',
    screenshotId: "later",
    devboxId: "dbx_34FiEuqr",
    elapsedMs: 6500,
    log: [
      { t: 0, text: "Forked from the fixture, booted in 2.8s", level: "info" },
      { t: 3300, text: "Chose Decide later, as in run 41", level: "info" },
      { t: 6500, text: "Landed on an error screen. This path completed in run 41", level: "error" },
    ],
  },
  {
    nodeId: "invite",
    status: "pass",
    resolvedTo: '"Invite teammates" card',
    screenshotId: "invite",
    devboxId: "dbx_34FiKcVG",
    elapsedMs: 10400,
    log: [
      { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
      { t: 6200, text: "Sent the invitations", level: "info" },
      { t: 10400, text: "Reached the finished screen", level: "info" },
    ],
  },
  {
    nodeId: "skipinv",
    status: "pass",
    resolvedTo: '"Skip invites" card',
    screenshotId: "skipinv",
    devboxId: "dbx_34FiKcUy",
    elapsedMs: 9100,
    log: [
      { t: 0, text: "Forked from the fixture, booted in 2.6s", level: "info" },
      { t: 9100, text: "Reached the finished screen", level: "info" },
    ],
  },
  {
    nodeId: "starter",
    status: "pass",
    note: "ui-changed",
    resolvedTo: '"Use a starter" card',
    screenshotId: "starter",
    devboxId: "dbx_34FiKcUr",
    elapsedMs: 12600,
    log: [
      { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
      { t: 2900, text: 'Looked for a control meaning "starter template"', level: "info" },
      { t: 3400, text: "The card seen in run 41 is gone", level: "warn" },
      { t: 4100, text: 'Matched the intent to "Use a starter" instead', level: "warn" },
      { t: 12600, text: "Reached the finished screen. Path intact", level: "info" },
    ],
  },
  {
    nodeId: "blank",
    status: "fail",
    failReason: "error-screen",
    resolvedTo: '"Blank workspace" card',
    screenshotId: "blank",
    devboxId: "dbx_34FivSUA",
    elapsedMs: 8100,
    log: [
      { t: 0, text: "Forked from the fixture, booted in 2.6s", level: "info" },
      { t: 3100, text: "Selected the blank workspace option", level: "info" },
      { t: 5800, text: "Landed on an error screen, not the workspace", level: "error" },
      { t: 8100, text: "Re-read after 3s. Still an error", level: "error" },
    ],
  },
  {
    nodeId: "import",
    status: "pass",
    note: "new-path",
    resolvedTo: '"Import from CSV" card',
    screenshotId: "import",
    devboxId: "dbx_34Fiz7ey",
    elapsedMs: 11800,
    log: [
      { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
      { t: 3000, text: "Found a third card the tree had never seen", level: "info" },
      { t: 3000, text: "Explored it rather than skipping past", level: "info" },
      { t: 11800, text: "Reached the finished screen. Added to the tree", level: "info" },
    ],
  },
];

export const run: Run = {
  id: "run-42",
  suiteId: suite.id,
  ref: "def456",
  startedAt: "2026-08-29T21:04:00Z",
  finishedAt: "2026-08-29T21:04:16Z",
  fixtureSnapshotId: suite.fixture.snapshotId,
  results,
  discovered: [discovered],
  costUsd: 0.14,
  wallClockMs: 15_600,
  sequentialEstimateMs: 210_000,
};

export const runHistory = [
  { id: "run-42", ref: "def456", when: "3 min ago", clean: "6 of 8", status: "warn" as const },
  { id: "run-41", ref: "abc123", when: "yesterday", clean: "7 of 7", status: "ok" as const },
  { id: "run-40", ref: "9f21ab", when: "2 days ago", clean: "7 of 7", status: "ok" as const },
  { id: "run-39", ref: "41c0de", when: "4 days ago", clean: "6 of 7", status: "warn" as const },
];

/** Screenshot pairs for the detail panel, keyed by node. */
export const diffs: Record<string, { before: string; beforeCaption: string; after: string; afterCaption: string; title: string; meta: string }> = {
  starter: {
    title: "Screenshot diff",
    meta: "passed, but the UI moved",
    before: "v1-step2solo",
    beforeCaption: 'run 41 · "Starter template"',
    after: "solo",
    afterCaption: 'run 42 · "Use a starter"',
  },
  blank: {
    title: "Screenshot diff",
    meta: "where it broke",
    before: "v1-blank",
    beforeCaption: "run 41 · completed",
    after: "blank",
    afterCaption: "run 42 · error screen",
  },
  later: {
    title: "Screenshot diff",
    meta: "where it broke",
    before: "v1-later",
    beforeCaption: "run 41 · completed",
    after: "later",
    afterCaption: "run 42 · error screen",
  },
  import: {
    title: "First capture",
    meta: "this path is new",
    before: "solo",
    beforeCaption: "the card that appeared",
    after: "import",
    afterCaption: "where it led",
  },
};
