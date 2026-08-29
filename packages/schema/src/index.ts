/**
 * Branchpoint — pinned contracts.
 *
 * These are the interfaces the six workstreams agree on. Everything else can be
 * built in parallel behind them, so treat a change here as a change that stalls
 * other people: raise it before editing.
 *
 * See docs/build-spec.html for the reasoning behind each field.
 */

// ─────────────────────────────────────────────────────────────
// Suite — what the Build route produces
// ─────────────────────────────────────────────────────────────

export interface Repo {
  /** e.g. "https://github.com/sanggggg/nimbus" */
  url: string;
  /** Branch or commit sha. A run is always suite x ref. */
  ref: string;
  buildCmd: string;
  startCmd: string;
  port: number;
}

export interface Fixture {
  /** Runloop disk snapshot every branch forks from. */
  snapshotId: string;
  /** The ref the fixture was captured at. */
  ref: string;
  /** Human line for the UI, e.g. "signed in, first screen". */
  description: string;
  screenshotId?: string;
}

export type NodeKind =
  /** The snapshot root. Exactly one per tree, with parentId === null. */
  | "fixture"
  /** An intermediate choice that leads somewhere else. */
  | "step"
  /** A leaf. Reaching it in a good state is what "passing" means. */
  | "goal";

/**
 * Tree health, NOT run outcome.
 *
 * `unresolved` means the wording matched nothing on the page — a bug in the
 * tree, fixed by rewording or dropping the node. A node whose intent resolves
 * fine and then lands on an error screen is a bug in the APP, and shows up as
 * a failed NodeResult instead. Keeping these apart is why Build and Run are
 * separate routes.
 */
export type NodeState = "unverified" | "verified" | "unresolved";

export interface Node {
  id: string;
  /** null only for the fixture root. */
  parentId: string | null;
  /** Short name on the card, e.g. "Solo plan". */
  label: string;
  /**
   * The sentence the agent resolves against the live page, in plain words.
   * Never a selector — that is the whole point. "Choose the solo option",
   * not "#solo".
   */
  intent: string;
  kind: NodeKind;
  state: NodeState;
  /**
   * What the matched control read last time it resolved, e.g. "Use a starter".
   * Passed to the resolver as a hint to improve accuracy. It is NEVER used to
   * skip the resolver — that would optimise away the thing we are selling.
   */
  lastSeenLabel?: string;
}

export interface Suite {
  id: string;
  name: string;
  repo: Repo;
  /** Image with dependencies and the browser baked in. */
  blueprintId: string;
  fixture: Fixture;
  tree: Node[];
}

// ─────────────────────────────────────────────────────────────
// Run — what the engine produces and the Run route consumes
// ─────────────────────────────────────────────────────────────

/** The only two states the tree is coloured by. */
export type RunStatus = "pass" | "fail";

/**
 * Secondary detail shown as words on the node, never as a third colour.
 * `ui-changed` is the differentiator: a control was renamed and the agent
 * followed it instead of failing.
 */
export type ResultNote = "ui-changed" | "new-path";

export type FailReason =
  /** Nothing on the page matched the intent — fix the tree. */
  | "unresolved"
  /** The intent resolved, the click happened, the next screen was wrong. */
  | "error-screen"
  | "timeout";

export interface LogLine {
  /** Milliseconds since this branch started. */
  t: number;
  text: string;
  level: "info" | "warn" | "error";
}

export interface NodeResult {
  nodeId: string;
  status: RunStatus;
  note?: ResultNote;
  failReason?: FailReason;
  /** Human description of what it matched, e.g. `"Use a starter" card`. */
  resolvedTo?: string;
  screenshotId?: string;
  devboxId: string;
  /** Milliseconds this branch took, from fork to verdict. */
  elapsedMs: number;
  log: LogLine[];
}

export interface Run {
  id: string;
  suiteId: string;
  /** The commit this run targeted. */
  ref: string;
  startedAt: string;
  finishedAt?: string;
  fixtureSnapshotId: string;
  results: NodeResult[];
  /**
   * Options the agent found on a page that the tree did not contain. Surfaced
   * in Build so a human can adopt them into the plan.
   */
  discovered: Node[];
  costUsd: number;
  /** Actual: tracks tree depth. */
  wallClockMs: number;
  /** What running every path from a cold sign-in would have cost. */
  sequentialEstimateMs: number;
}

// ─────────────────────────────────────────────────────────────
// Agent calls
// ─────────────────────────────────────────────────────────────

/** One candidate element, lifted from the accessibility tree. */
export interface Candidate {
  ref: string;
  role: string;
  name: string;
  text?: string;
}

/**
 * Runs on every step, so it must stay cheap and near-deterministic: hand it
 * the candidates and make it pick one. Cheap model, temperature 0, structured
 * output. Open-ended judgement belongs in judgeScreen, not here.
 */
export interface ResolveIntentInput {
  candidates: Candidate[];
  intent: string;
  hint?: string;
}

export type ResolveIntentOutput =
  | { ref: string; confidence: number }
  | { ref: null; reason: string };

/** Runs only at leaves, so it can afford the capable model. */
export interface JudgeScreenInput {
  title: string;
  visibleText: string;
  url: string;
  /** The goal node's intent. */
  expected: string;
}

export interface JudgeScreenOutput {
  ok: boolean;
  reason: string;
}

// ─────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────

export interface PrepareRepoInput {
  url: string;
  ref: string;
  buildCmd: string;
  startCmd: string;
  port: number;
  testAccount?: { email: string; password: string };
}

export interface PrepareRepoOutput {
  blueprintId: string;
  fixture: Fixture;
}

// ─────────────────────────────────────────────────────────────
// HTTP surface (v1 — the UI polls; no socket layer yet)
// ─────────────────────────────────────────────────────────────

export interface Api {
  /** POST /suites */
  createSuite(body: { repo: Repo }): Promise<Suite>;
  /** PATCH /suites/:id */
  updateTree(id: string, body: { tree: Node[] }): Promise<Suite>;
  /** POST /runs */
  startRun(body: { suiteId: string; ref: string }): Promise<{ runId: string }>;
  /** GET /runs/:id */
  getRun(id: string): Promise<Run>;
  /** GET /runs?suiteId= — powers the left rail */
  listRuns(suiteId: string): Promise<Run[]>;
  /** GET /screenshots/:id → image/png */
  screenshotUrl(id: string): string;
}
