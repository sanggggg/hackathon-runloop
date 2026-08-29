import type { Node, NodeResult, Suite } from "@branchpoint/schema";

/** The Nimbus onboarding flow, matching the screenshots in the web app. */
export const SEED_SUITE: Suite = {
  id: "nimbus-onboarding",
  name: "nimbus-onboarding",
  treeVersion: 12,
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
    { id: "root", parentId: null, label: "Signed-in workspace", kind: "fixture", state: "verified",
      intent: "Start every branch from the verified account" },
    { id: "team", parentId: "root", label: "Team plan", kind: "step", state: "verified",
      intent: "Choose the team option", lastSeenLabel: "Team plan" },
    { id: "solo", parentId: "root", label: "Solo plan", kind: "step", state: "verified",
      intent: "Choose the solo option", lastSeenLabel: "Solo plan" },
    { id: "later", parentId: "root", label: "Decide later", kind: "step", state: "verified",
      intent: "Defer the choice for now", lastSeenLabel: "Decide later" },
    { id: "invite", parentId: "team", label: "Invite teammates", kind: "goal", state: "verified",
      intent: "Send invitations, then reach the finished screen", lastSeenLabel: "Invite teammates" },
    { id: "skipinv", parentId: "team", label: "Skip invites", kind: "goal", state: "verified",
      intent: "Skip inviting and still finish setup", lastSeenLabel: "Skip invites" },
    { id: "starter", parentId: "solo", label: "Starter template", kind: "goal", state: "verified",
      intent: "Pick the prepared template and finish", lastSeenLabel: "Use a starter" },
    { id: "blank", parentId: "solo", label: "Blank workspace", kind: "goal", state: "verified",
      intent: "Start from nothing and still finish", lastSeenLabel: "Blank workspace" },
    { id: "skipall", parentId: "later", label: "Skip onboarding", kind: "goal", state: "unresolved",
      intent: "Leave setup entirely without answering anything" },
  ],
};

/**
 * `elapsedMs` doubles as the moment a result lands, so a client polling the run
 * watches paths finish one by one instead of all at once.
 */
export function SEED_RESULTS(suite: Suite): NodeResult[] {
  const has = (id: string) => suite.tree.some((n) => n.id === id);
  const all: NodeResult[] = [
    { nodeId: "team", status: "pass", resolvedTo: '"Team plan" card', screenshotId: "team",
      devboxId: "dbx_34FiEurF", elapsedMs: 6400, log: [
        { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
        { t: 6400, text: "Reached step 2", level: "info" }] },
    { nodeId: "solo", status: "pass", resolvedTo: '"Solo plan" card', screenshotId: "solo",
      devboxId: "dbx_34FiEur9", elapsedMs: 6900, log: [
        { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
        { t: 6900, text: "Reached step 2", level: "info" }] },
    { nodeId: "later", status: "fail", failReason: "error-screen", resolvedTo: '"Decide later" card',
      screenshotId: "later", devboxId: "dbx_34FiEuqr", elapsedMs: 6500, log: [
        { t: 0, text: "Forked from the fixture, booted in 2.8s", level: "info" },
        { t: 6500, text: "Landed on an error screen. This path completed in run 41", level: "error" }] },
    { nodeId: "skipall", status: "fail", failReason: "unresolved", devboxId: "dbx_34FiKcW1",
      elapsedMs: 7200, log: [
        { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
        { t: 7200, text: "Nothing on the page skips the whole flow", level: "error" }] },
    { nodeId: "invite", status: "pass", resolvedTo: '"Invite teammates" card', screenshotId: "invite",
      devboxId: "dbx_34FiKcVG", elapsedMs: 10400, log: [
        { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
        { t: 10400, text: "Reached the finished screen", level: "info" }] },
    { nodeId: "skipinv", status: "pass", resolvedTo: '"Skip invites" card', screenshotId: "skipinv",
      devboxId: "dbx_34FiKcUy", elapsedMs: 9100, log: [
        { t: 0, text: "Forked from the fixture, booted in 2.6s", level: "info" },
        { t: 9100, text: "Reached the finished screen", level: "info" }] },
    { nodeId: "starter", status: "pass", note: "ui-changed", resolvedTo: '"Use a starter" card',
      screenshotId: "starter", devboxId: "dbx_34FiKcUr", elapsedMs: 12600, log: [
        { t: 0, text: "Forked from the fixture, booted in 2.7s", level: "info" },
        { t: 3400, text: "The card seen in run 41 is gone", level: "warn" },
        { t: 4100, text: 'Matched the intent to "Use a starter" instead', level: "warn" },
        { t: 12600, text: "Reached the finished screen. Path intact", level: "info" }] },
    { nodeId: "blank", status: "fail", failReason: "error-screen", resolvedTo: '"Blank workspace" card',
      screenshotId: "blank", devboxId: "dbx_34FivSUA", elapsedMs: 8100, log: [
        { t: 0, text: "Forked from the fixture, booted in 2.6s", level: "info" },
        { t: 8100, text: "Landed on an error screen, not the workspace", level: "error" }] },
  ];
  return all.filter((r) => has(r.nodeId));
}

/**
 * A suite created from the CLI. The description is echoed into a placeholder
 * step so the shape is right; the real engine drafts the tree from it.
 */
export function newSuiteFrom(repoUrl: string, describe?: string, name?: string): Suite {
  const slug = repoUrl.replace(/\/+$/, "").split("/").pop() ?? "suite";
  const id = name ?? `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  const tree: Node[] = [
    { id: "root", parentId: null, label: "Signed-in workspace", kind: "fixture", state: "verified",
      intent: "Start every branch from the verified account" },
  ];
  if (describe) {
    tree.push({
      id: "draft-1",
      parentId: "root",
      label: "Drafted from your description",
      kind: "goal",
      state: "unverified",
      intent: describe,
    });
  }

  return {
    id,
    name: id,
    treeVersion: 1,
    repo: { url: repoUrl, ref: "main", buildCmd: "npm install", startCmd: "npm run dev", port: 3000 },
    blueprintId: `bpt_${slug}`,
    fixture: {
      snapshotId: `snp_${Math.random().toString(36).slice(2, 10)}`,
      ref: "main",
      description: "signed in, first screen",
      screenshotId: "root",
    },
    tree,
  };
}
