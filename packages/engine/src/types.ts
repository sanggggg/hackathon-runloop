import type {
  FailReason,
  LogLine,
  Node,
  Repo,
  ResultNote,
  Run,
  Suite,
} from "@branchpoint/schema";

export interface ContainerRef {
  id: string;
}

export interface SnapshotRef {
  id: string;
}

export interface RuntimeContext {
  runId: string;
  suiteId: string;
  ref: string;
  repo: Repo;
  /** Node ids already completed before this container was materialized. */
  branchPath: string[];
  sourceSnapshotId: string;
  kind: "root" | "fork";
  signal?: AbortSignal;
}

/**
 * JSON contract handed to the browser QA agent running inside a devbox.
 * The agent must restore its browser checkpoint, perform the node, persist the
 * next checkpoint, and then write an AgentNodeResult.
 */
export interface AgentNodeRequest {
  protocolVersion: 1;
  runId: string;
  suiteId: string;
  ref: string;
  node: Node;
  isGoal: boolean;
  expectedOutcome?: string;
  branchPath: string[];
}

export interface AgentNodeResult {
  status: "pass" | "fail";
  failReason?: FailReason;
  note?: ResultNote;
  resolvedTo?: string;
  /** Raw accessible name, used to infer `ui-changed`. */
  resolvedLabel?: string;
  screenshotId?: string;
  elapsedMs?: number;
  log?: LogLine[];
  discovered?: Node[];
  /** Successful structured-output model responses for this node. */
  modelCalls?: number;
  costUsd?: number;
  /** Proof that a resumable browser state was persisted before returning. */
  checkpoint?: {
    path: string;
    url: string;
  };
}

export interface ContainerRuntime {
  createFromSnapshot(snapshotId: string, context: RuntimeContext): Promise<ContainerRef>;
  /**
   * `root` materializes the requested git ref/build; `fork` only restarts the
   * app and restores the browser checkpoint inherited from the snapshot.
   */
  prepare(container: ContainerRef, context: RuntimeContext): Promise<void>;
  executeNode(
    container: ContainerRef,
    request: AgentNodeRequest,
    context: RuntimeContext,
  ): Promise<AgentNodeResult>;
  snapshot(container: ContainerRef, context: RuntimeContext): Promise<SnapshotRef>;
  deleteSnapshot(snapshot: SnapshotRef): Promise<void>;
  shutdown(container: ContainerRef): Promise<void>;
}

export interface EngineClock {
  now(): number;
}

export interface RunInput {
  suite: Suite;
  ref?: string;
  runId?: string;
  signal?: AbortSignal;
}

export interface EngineOptions {
  runtime: ContainerRuntime;
  maxConcurrency?: number;
  clock?: EngineClock;
  createId?: () => string;
}

export interface CompletedEngineRun {
  run: Run;
}
