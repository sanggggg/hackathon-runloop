import { randomUUID } from "node:crypto";
import type { LogLine, Node, NodeResult, Run } from "@branchpoint/schema";
import { EngineRunError } from "./errors.js";
import { Semaphore } from "./semaphore.js";
import { TreeIndex } from "./tree.js";
import { validateRunInput } from "./validation.js";
import type {
  AgentNodeRequest,
  AgentNodeResult,
  ContainerRef,
  EngineOptions,
  RunInput,
  RuntimeContext,
  SnapshotRef,
} from "./types.js";

interface ManagedContainer {
  ref: ContainerRef;
  releasePermit: () => void;
  permitReleased: boolean;
  startedAt: number;
  context: RuntimeContext;
}

const systemClock = { now: () => Date.now() };

function normalizeLabel(value: string): string {
  return value
    .replace(/["'`]/g, "")
    .replace(/\b(button|link|card|option|menu item)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function resultLogs(log: readonly LogLine[] | undefined, offsetMs: number): LogLine[] {
  const sorted = [...(log ?? [])].sort((a, b) => a.t - b.t);
  return sorted.map((line) => ({ ...line, t: Math.max(0, offsetMs + line.t) }));
}

export class BranchpointEngine {
  readonly #runtime: EngineOptions["runtime"];
  readonly #maxConcurrency: number;
  readonly #clock: NonNullable<EngineOptions["clock"]>;
  readonly #createId: () => string;

  constructor(options: EngineOptions) {
    this.#runtime = options.runtime;
    this.#maxConcurrency = options.maxConcurrency ?? 8;
    if (!Number.isInteger(this.#maxConcurrency) || this.#maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    this.#clock = options.clock ?? systemClock;
    this.#createId = options.createId ?? randomUUID;
  }

  async run(input: RunInput): Promise<Run> {
    validateRunInput(input);
    const tree = new TreeIndex(input.suite.tree);
    const runId = input.runId ?? this.#createId();
    const ref = input.ref ?? input.suite.repo.ref;
    const startedAtMs = this.#clock.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const semaphore = new Semaphore(this.#maxConcurrency);
    const active = new Map<string, ManagedContainer>();
    const ephemeralSnapshots = new Map<string, SnapshotRef>();
    const results = new Map<string, NodeResult>();
    const discovered = new Map<string, Node>();
    let costUsd = 0;
    let modelCalls = 0;
    let progressTail = Promise.resolve();

    const makeRun = (finished: boolean): Run => {
      const ordered = tree.nodes.flatMap((node) => {
        const result = results.get(node.id);
        return result ? [result] : [];
      });
      const terminal = ordered.filter((result) => {
        const node = tree.byId.get(result.nodeId);
        return result.status === "fail" || (node ? tree.activeChildrenOf(node.id).length === 0 : false);
      });
      const sequentialEstimateMs = terminal.reduce((total, terminalResult) => {
        const segments = new Map<string, number>();
        let node = tree.byId.get(terminalResult.nodeId);
        while (node && node !== tree.root) {
          const result = results.get(node.id);
          if (result) {
            segments.set(
              result.devboxId,
              Math.max(segments.get(result.devboxId) ?? 0, result.elapsedMs),
            );
          }
          node = node.parentId ? tree.byId.get(node.parentId) : undefined;
        }
        return total + [...segments.values()].reduce((sum, elapsedMs) => sum + elapsedMs, 0);
      }, 0);
      return {
        id: runId,
        suiteId: input.suite.id,
        ref,
        startedAt,
        ...(finished ? { finishedAt: new Date(this.#clock.now()).toISOString() } : {}),
        fixtureSnapshotId: input.suite.fixture.snapshotId,
        results: ordered,
        discovered: [...discovered.values()],
        ...(modelCalls > 0 ? { modelCalls } : {}),
        costUsd,
        wallClockMs: Math.max(0, this.#clock.now() - startedAtMs),
        sequentialEstimateMs,
      };
    };

    const notifyProgress = async (): Promise<void> => {
      const onProgress = input.onProgress;
      if (!onProgress) return;

      // Branches can finish nodes concurrently. Capture the snapshot at commit
      // time, then serialize delivery so a slower, older persistence write
      // cannot land after a newer one. Keep the queue usable after rejection;
      // the branch awaiting `notification` still promotes that rejection to the
      // normal EngineRunError + cleanup path.
      // The callback owns its snapshot and cannot mutate NodeResult/Node values
      // retained by the engine for later notifications or the final Run.
      const partialRun = structuredClone(makeRun(false));
      const notification = progressTail.then(() => onProgress(partialRun));
      progressTail = notification.then(
        () => undefined,
        () => undefined,
      );
      await notification;
    };

    const throwIfAborted = (): void => {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("run aborted");
    };

    const releaseContainer = async (container: ContainerRef): Promise<void> => {
      const managed = active.get(container.id);
      if (!managed) return;
      try {
        await this.#runtime.shutdown(container);
        active.delete(container.id);
      } finally {
        if (!managed.permitReleased) {
          managed.permitReleased = true;
          managed.releasePermit();
        }
      }
    };

    const takeSnapshot = async (
      container: ContainerRef,
      context: RuntimeContext,
    ): Promise<SnapshotRef> => {
      const snapshot = await this.#runtime.snapshot(container, context);
      ephemeralSnapshots.set(snapshot.id, snapshot);
      return snapshot;
    };

    const createContainer = async (
      snapshotId: string,
      context: RuntimeContext,
    ): Promise<ManagedContainer> => {
      throwIfAborted();
      const releasePermit = await semaphore.acquire(input.signal);
      let created: ContainerRef | undefined;
      try {
        const refValue = await this.#runtime.createFromSnapshot(snapshotId, context);
        created = refValue;
        const managed = {
          ref: refValue,
          releasePermit,
          permitReleased: false,
          startedAt: this.#clock.now(),
          context,
        };
        active.set(refValue.id, managed);
        await this.#runtime.prepare(refValue, context);
        return managed;
      } catch (error) {
        let cleanupError: unknown;
        if (created) {
          try {
            await releaseContainer(created);
          } catch (shutdownError) {
            cleanupError = shutdownError;
          }
        } else {
          releasePermit();
        }
        if (cleanupError) {
          throw new AggregateError([error, cleanupError], "container preparation and cleanup failed");
        }
        throw error;
      }
    };

    const recordResult = async (
      node: Node,
      managed: ManagedContainer,
      agent: AgentNodeResult,
      nodeStartedAt: number,
    ): Promise<void> => {
      if (agent.status === "fail" && !agent.failReason) {
        throw new Error(`agent failed node '${node.id}' without failReason`);
      }
      if (agent.status === "pass" && agent.failReason) {
        throw new Error(`agent passed node '${node.id}' with failReason '${agent.failReason}'`);
      }
      if (agent.status === "fail" && agent.note) {
        throw new Error(`agent failed node '${node.id}' with note '${agent.note}'`);
      }
      if (agent.elapsedMs !== undefined && (!Number.isFinite(agent.elapsedMs) || agent.elapsedMs < 0)) {
        throw new Error(`agent returned invalid elapsedMs for node '${node.id}'`);
      }
      if (agent.costUsd !== undefined && (!Number.isFinite(agent.costUsd) || agent.costUsd < 0)) {
        throw new Error(`agent returned invalid costUsd for node '${node.id}'`);
      }
      if (
        agent.modelCalls !== undefined &&
        (!Number.isInteger(agent.modelCalls) || agent.modelCalls < 0)
      ) {
        throw new Error(`agent returned invalid modelCalls for node '${node.id}'`);
      }
      for (const line of agent.log ?? []) {
        if (
          !Number.isFinite(line.t) ||
          line.t < 0 ||
          typeof line.text !== "string" ||
          !["info", "warn", "error"].includes(line.level)
        ) {
          throw new Error(`agent returned an invalid log line for node '${node.id}'`);
        }
      }

      const inferredChange =
        agent.status === "pass" &&
        node.lastSeenLabel &&
        agent.resolvedLabel &&
        normalizeLabel(node.lastSeenLabel) !== normalizeLabel(agent.resolvedLabel);

      const nodeOffsetMs = Math.max(0, nodeStartedAt - managed.startedAt);
      const elapsedMs = Math.max(
        0,
        this.#clock.now() - managed.startedAt,
        nodeOffsetMs + (agent.elapsedMs ?? 0),
      );
      results.set(node.id, {
        nodeId: node.id,
        status: agent.status,
        ...(agent.note || inferredChange ? { note: agent.note ?? "ui-changed" } : {}),
        ...(agent.failReason ? { failReason: agent.failReason } : {}),
        ...(agent.resolvedTo ? { resolvedTo: agent.resolvedTo } : {}),
        ...(agent.screenshotId ? { screenshotId: agent.screenshotId } : {}),
        ...(agent.modelCalls ? { modelCalls: agent.modelCalls } : {}),
        devboxId: managed.ref.id,
        elapsedMs,
        log: resultLogs(agent.log, nodeOffsetMs),
      });
      for (const nodeValue of agent.discovered ?? []) discovered.set(nodeValue.id, nodeValue);
      costUsd += agent.costUsd ?? 0;
      modelCalls += agent.modelCalls ?? 0;
      await notifyProgress();
    };

    const settleAll = async (tasks: Array<Promise<void>>): Promise<void> => {
      const settled = await Promise.allSettled(tasks);
      const errors = settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : []));
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "multiple QA branches failed");
    };

    const walk = async (
      node: Node,
      managed: ManagedContainer,
      branchPath: string[],
    ): Promise<void> => {
      throwIfAborted();
      const request: AgentNodeRequest = {
        protocolVersion: 1,
        runId,
        suiteId: input.suite.id,
        ref,
        node,
        isGoal: node.kind === "goal",
        ...(node.kind === "goal"
          ? { expectedOutcome: node.expectedOutcome ?? node.intent }
          : {}),
        branchPath,
      };
      const nodeStartedAt = this.#clock.now();
      const agentResult = await this.#runtime.executeNode(managed.ref, request, managed.context);
      await recordResult(node, managed, agentResult, nodeStartedAt);
      if (agentResult.status === "fail") return;

      const children = tree.activeChildrenOf(node.id);
      if (children.length === 0) return;

      const nextPath = [...branchPath, node.id];
      if (children.length === 1) {
        await walk(children[0], managed, nextPath);
        return;
      }

      const snapshot = await takeSnapshot(managed.ref, {
        ...managed.context,
        branchPath: nextPath,
      });
      await releaseContainer(managed.ref);

      await settleAll(
        children.map((child) =>
          runFromSnapshot(child, snapshot.id, nextPath, "fork"),
        ),
      );
    };

    const runFromSnapshot = async (
      node: Node,
      snapshotId: string,
      branchPath: string[],
      kind: RuntimeContext["kind"],
    ): Promise<void> => {
      const context: RuntimeContext = {
        runId,
        suiteId: input.suite.id,
        ref,
        repo: input.suite.repo,
        branchPath,
        sourceSnapshotId: snapshotId,
        kind,
        signal: input.signal,
      };
      let managed: ManagedContainer | undefined;
      let primaryError: unknown;
      try {
        managed = await createContainer(snapshotId, context);
        await walk(node, managed, branchPath);
      } catch (error) {
        primaryError = error;
      }

      let cleanupError: unknown;
      if (managed) {
        try {
          await releaseContainer(managed.ref);
        } catch (error) {
          cleanupError = error;
        }
      }
      if (primaryError && cleanupError) {
        throw new AggregateError([primaryError, cleanupError], `branch '${node.id}' and cleanup failed`);
      }
      if (primaryError) throw primaryError;
      if (cleanupError) throw cleanupError;
    };

    let primaryError: unknown;
    try {
      const rootContext: RuntimeContext = {
        runId,
        suiteId: input.suite.id,
        ref,
        repo: input.suite.repo,
        branchPath: [],
        sourceSnapshotId: input.suite.fixture.snapshotId,
        kind: "root",
        signal: input.signal,
      };
      const root = await createContainer(input.suite.fixture.snapshotId, rootContext);
      const children = tree.activeChildrenOf(tree.root.id);

      if (children.length === 0) {
        await releaseContainer(root.ref);
      } else if (children.length === 1) {
        await walk(children[0], root, []);
        await releaseContainer(root.ref);
      } else {
        const snapshot = await takeSnapshot(root.ref, rootContext);
        await releaseContainer(root.ref);
        await settleAll(children.map((child) => runFromSnapshot(child, snapshot.id, [], "fork")));
      }
    } catch (error) {
      primaryError = error;
    }

    const cleanup = await Promise.allSettled([...active.values()].map((entry) => releaseContainer(entry.ref)));
    const cleanupErrors = cleanup.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : []));
    const snapshotCleanup = await Promise.allSettled(
      [...ephemeralSnapshots.values()].map((snapshot) => this.#runtime.deleteSnapshot(snapshot)),
    );
    const snapshotCleanupErrors = snapshotCleanup.flatMap((entry) =>
      entry.status === "rejected" ? [entry.reason] : [],
    );
    const allCleanupErrors = [...cleanupErrors, ...snapshotCleanupErrors];
    if (primaryError || allCleanupErrors.length > 0) {
      const cause =
        primaryError && allCleanupErrors.length > 0
          ? new AggregateError([primaryError, ...allCleanupErrors], "run and cleanup failed")
          : primaryError ?? new AggregateError(allCleanupErrors, "run cleanup failed");
      throw new EngineRunError(runId, makeRun(false), cause);
    }

    return makeRun(true);
  }
}
