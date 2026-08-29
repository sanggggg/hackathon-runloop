import assert from "node:assert/strict";
import type { Node } from "@branchpoint/schema";
import type {
  AgentNodeRequest,
  AgentNodeResult,
  ContainerRef,
  ContainerRuntime,
  RuntimeContext,
  SnapshotRef,
} from "../src/types.js";

export interface FakeBrowserState {
  url: string;
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  path: string[];
}

export interface FakeContainerState {
  id: string;
  sourceSnapshotId: string;
  browser: FakeBrowserState;
  appRunning: boolean;
  storageRestored: boolean;
  closed: boolean;
}

export interface FakeSnapshotRecord {
  id: string;
  containerId?: string;
  browser: FakeBrowserState;
  ephemeral: boolean;
  deleted: boolean;
}

export type FakeRuntimeEvent =
  | { seq: number; op: "create"; containerId: string; snapshotId: string; kind: RuntimeContext["kind"] }
  | { seq: number; op: "prepare"; containerId: string }
  | { seq: number; op: "execute:start" | "execute:finish"; containerId: string; nodeId: string }
  | { seq: number; op: "snapshot"; containerId: string; snapshotId: string }
  | { seq: number; op: "deleteSnapshot"; snapshotId: string }
  | { seq: number; op: "shutdown"; containerId: string };

type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;

interface Deferred {
  promise: Promise<void>;
  release(): void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    release: () => resolvePromise?.(),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Stateful Runloop substitute. A snapshot owns an immutable browser-state
 * value; every child gets a deep clone and must be prepared before use.
 */
export class FakeRuntime implements ContainerRuntime {
  readonly fixtureSnapshotId = "fixture-snapshot";
  readonly events: FakeRuntimeEvent[] = [];
  readonly containers = new Map<string, FakeContainerState>();
  readonly snapshotRecords = new Map<string, FakeSnapshotRecord>();
  readonly creations: Array<{
    containerId: string;
    sourceSnapshotId: string;
    context: RuntimeContext;
  }> = [];
  readonly executions: Array<{
    containerId: string;
    request: AgentNodeRequest;
  }> = [];
  readonly shutdowns: string[] = [];
  readonly shutdownAttempts: string[] = [];
  readonly deletedSnapshots: string[] = [];
  readonly liveContainers = new Set<string>();
  readonly liveEphemeralSnapshots = new Set<string>();
  maxLiveContainers = 0;

  #nextContainer = 1;
  #nextSnapshot = 1;
  #nextEvent = 1;
  #outcomes = new Map<string, AgentNodeResult>();
  #executeErrors = new Map<string, Error>();
  #gates = new Map<string, Deferred>();
  #shutdownFailures = new Map<string, number>();

  constructor() {
    this.snapshotRecords.set(this.fixtureSnapshotId, {
      id: this.fixtureSnapshotId,
      browser: {
        url: "http://fixture.test/onboarding",
        cookies: { session: "signed-in" },
        localStorage: { workspace: "fixture" },
        sessionStorage: { onboarding: "start" },
        path: [],
      },
      ephemeral: false,
      deleted: false,
    });
  }

  setOutcome(nodeId: string, result: AgentNodeResult): void {
    this.#outcomes.set(nodeId, clone(result));
  }

  throwWhileExecuting(nodeId: string, error = new Error(`execute ${nodeId} failed`)): void {
    this.#executeErrors.set(nodeId, error);
  }

  blockNode(nodeId: string): () => void {
    const gate = deferred();
    this.#gates.set(nodeId, gate);
    return gate.release;
  }

  failShutdown(containerId: string, attempts = 1): void {
    this.#shutdownFailures.set(containerId, attempts);
  }

  async createFromSnapshot(snapshotId: string, context: RuntimeContext): Promise<ContainerRef> {
    const source = this.snapshotRecords.get(snapshotId);
    assert(source, `unknown snapshot '${snapshotId}'`);
    assert.equal(source.deleted, false, `snapshot '${snapshotId}' was already deleted`);

    const id = `box-${this.#nextContainer++}`;
    const state: FakeContainerState = {
      id,
      sourceSnapshotId: snapshotId,
      browser: clone(source.browser),
      // Disk snapshots intentionally carry neither the app process nor an open
      // browser context. prepare() must reconstruct both.
      appRunning: false,
      storageRestored: false,
      closed: false,
    };
    this.containers.set(id, state);
    this.liveContainers.add(id);
    this.maxLiveContainers = Math.max(this.maxLiveContainers, this.liveContainers.size);
    this.creations.push({ containerId: id, sourceSnapshotId: snapshotId, context: clone(context) });
    this.#event({ op: "create", containerId: id, snapshotId, kind: context.kind });
    return { id };
  }

  async prepare(container: ContainerRef, _context: RuntimeContext): Promise<void> {
    const state = this.#openContainer(container);
    state.appRunning = true;
    state.storageRestored = true;
    this.#event({ op: "prepare", containerId: container.id });
  }

  async executeNode(
    container: ContainerRef,
    request: AgentNodeRequest,
    _context: RuntimeContext,
  ): Promise<AgentNodeResult> {
    const state = this.#openContainer(container);
    assert.equal(state.appRunning, true, `app is not running in '${container.id}'`);
    assert.equal(state.storageRestored, true, `browser state is not restored in '${container.id}'`);
    assert.deepEqual(
      state.browser.path,
      request.branchPath,
      `branch '${container.id}' did not inherit the expected browser prefix`,
    );

    this.executions.push({ containerId: container.id, request: clone(request) });
    this.#event({ op: "execute:start", containerId: container.id, nodeId: request.node.id });
    const gate = this.#gates.get(request.node.id);
    if (gate) await gate.promise;

    const infrastructureError = this.#executeErrors.get(request.node.id);
    if (infrastructureError) throw infrastructureError;

    state.browser.path.push(request.node.id);
    state.browser.url = `http://fixture.test/${request.node.id}`;
    this.#event({ op: "execute:finish", containerId: container.id, nodeId: request.node.id });
    return clone(
      this.#outcomes.get(request.node.id) ?? {
        status: "pass",
        resolvedTo: `"${request.node.label}" control`,
        resolvedLabel: request.node.label,
        elapsedMs: 1,
      },
    );
  }

  async snapshot(container: ContainerRef, context: RuntimeContext): Promise<SnapshotRef> {
    const state = this.#openContainer(container);
    assert.equal(state.appRunning, true, `cannot snapshot unprepared '${container.id}'`);
    assert.equal(state.storageRestored, true, `cannot snapshot unrestored '${container.id}'`);
    assert.deepEqual(state.browser.path, context.branchPath, "snapshot path must equal the completed prefix");

    const id = `snapshot-${this.#nextSnapshot++}`;
    this.snapshotRecords.set(id, {
      id,
      containerId: container.id,
      browser: clone(state.browser),
      ephemeral: true,
      deleted: false,
    });
    this.liveEphemeralSnapshots.add(id);
    this.#event({ op: "snapshot", containerId: container.id, snapshotId: id });
    return { id };
  }

  async deleteSnapshot(snapshot: SnapshotRef): Promise<void> {
    const record = this.snapshotRecords.get(snapshot.id);
    assert(record, `unknown snapshot '${snapshot.id}'`);
    assert.equal(record.ephemeral, true, "fixture snapshots must never be deleted");
    assert.equal(record.deleted, false, `snapshot '${snapshot.id}' deleted twice`);
    record.deleted = true;
    this.liveEphemeralSnapshots.delete(snapshot.id);
    this.deletedSnapshots.push(snapshot.id);
    this.#event({ op: "deleteSnapshot", snapshotId: snapshot.id });
  }

  async shutdown(container: ContainerRef): Promise<void> {
    const state = this.containers.get(container.id);
    assert(state, `unknown container '${container.id}'`);
    assert.equal(state.closed, false, `container '${container.id}' shut down twice`);
    this.shutdownAttempts.push(container.id);
    const failuresRemaining = this.#shutdownFailures.get(container.id) ?? 0;
    if (failuresRemaining > 0) {
      this.#shutdownFailures.set(container.id, failuresRemaining - 1);
      throw new Error(`shutdown '${container.id}' failed`);
    }
    state.closed = true;
    state.appRunning = false;
    state.storageRestored = false;
    this.liveContainers.delete(container.id);
    this.shutdowns.push(container.id);
    this.#event({ op: "shutdown", containerId: container.id });
  }

  executionFor(nodeId: string): { containerId: string; request: AgentNodeRequest } | undefined {
    return this.executions.find((entry) => entry.request.node.id === nodeId);
  }

  startedNodeIds(): string[] {
    return this.events.flatMap((event) =>
      event.op === "execute:start" ? [event.nodeId] : [],
    );
  }

  finishedNodeIds(): string[] {
    return this.events.flatMap((event) =>
      event.op === "execute:finish" ? [event.nodeId] : [],
    );
  }

  assertFullyCleaned(): void {
    assert.deepEqual([...this.liveContainers], [], "containers leaked");
    assert.deepEqual([...this.liveEphemeralSnapshots], [], "ephemeral snapshots leaked");
    assert.equal(new Set(this.shutdowns).size, this.creations.length, "not every created container was shut down");
    assert.equal(this.snapshotRecords.get(this.fixtureSnapshotId)?.deleted, false);
  }

  #openContainer(container: ContainerRef): FakeContainerState {
    const state = this.containers.get(container.id);
    assert(state, `unknown container '${container.id}'`);
    assert.equal(state.closed, false, `container '${container.id}' is closed`);
    return state;
  }

  #event(event: WithoutSeq<FakeRuntimeEvent>): void {
    this.events.push({ seq: this.#nextEvent++, ...event } as FakeRuntimeEvent);
  }
}

export function node(
  id: string,
  parentId: string | null,
  kind: Node["kind"],
  state: Node["state"] = "verified",
): Node {
  return {
    id,
    parentId,
    label: id,
    intent: `perform ${id}`,
    ...(kind === "goal" ? { expectedOutcome: `completed ${id}` } : {}),
    kind,
    state,
  };
}
