import type { Node } from "@branchpoint/schema";

export class TreeValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid QA tree:\n- ${issues.join("\n- ")}`);
    this.name = "TreeValidationError";
    this.issues = issues;
  }
}

export class TreeIndex {
  readonly root: Node;
  readonly nodes: readonly Node[];
  readonly byId: ReadonlyMap<string, Node>;
  readonly childrenById: ReadonlyMap<string, readonly Node[]>;
  readonly activeChildrenById: ReadonlyMap<string, readonly Node[]>;

  constructor(nodes: readonly Node[]) {
    const issues: string[] = [];
    if (nodes.length === 0) issues.push("tree must not be empty");
    const byId = new Map<string, Node>();

    for (const node of nodes) {
      if (byId.has(node.id)) issues.push(`duplicate node id '${node.id}'`);
      else byId.set(node.id, node);
      if (!node.label.trim()) issues.push(`node '${node.id}' has an empty label`);
      if (!node.intent.trim()) issues.push(`node '${node.id}' has an empty intent`);
    }

    const roots = nodes.filter((node) => node.parentId === null);
    if (roots.length !== 1) issues.push(`expected exactly one root, found ${roots.length}`);

    const root = roots[0];
    if (root && root.kind !== "fixture") issues.push(`root '${root.id}' must have kind 'fixture'`);
    if (root && root.state !== "verified") issues.push(`root '${root.id}' must be verified`);

    const children = new Map<string, Node[]>();
    for (const node of nodes) children.set(node.id, []);

    for (const node of nodes) {
      if (node === root) continue;
      if (node.parentId === null) continue;
      if (node.parentId === node.id) issues.push(`node '${node.id}' cannot parent itself`);
      const parent = byId.get(node.parentId);
      if (!parent) {
        issues.push(`node '${node.id}' has missing parent '${node.parentId}'`);
        continue;
      }
      children.get(parent.id)?.push(node);
      if (node.kind === "fixture") issues.push(`only the root may have kind 'fixture' ('${node.id}')`);
    }

    for (const node of nodes) {
      const childCount = children.get(node.id)?.length ?? 0;
      if (node.kind === "goal" && childCount > 0) {
        issues.push(`goal '${node.id}' must be a leaf`);
      }
      if (node !== root && childCount === 0 && node.kind !== "goal") {
        issues.push(`leaf '${node.id}' must have kind 'goal'`);
      }
    }

    const reachable = new Set<string>();
    const markReachable = (node: Node): void => {
      if (reachable.has(node.id)) return;
      reachable.add(node.id);
      for (const child of children.get(node.id) ?? []) markReachable(child);
    };
    if (root) markReachable(root);
    for (const node of nodes) {
      if (!reachable.has(node.id)) issues.push(`node '${node.id}' is disconnected from the root`);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const detectCycle = (node: Node): void => {
      if (visiting.has(node.id)) {
        issues.push(`cycle detected at '${node.id}'`);
        return;
      }
      if (visited.has(node.id)) return;
      visiting.add(node.id);
      for (const child of children.get(node.id) ?? []) detectCycle(child);
      visiting.delete(node.id);
      visited.add(node.id);
    };
    for (const node of nodes) detectCycle(node);

    if (!nodes.some((node) => node.kind === "goal")) issues.push("tree must contain at least one goal");

    if (issues.length > 0 || !root) throw new TreeValidationError([...new Set(issues)]);

    this.root = root;
    this.nodes = [...nodes];
    this.byId = byId;
    this.childrenById = children;

    const active = new Set<string>();
    const markRunnable = (node: Node): boolean => {
      if (node !== root && node.state === "unresolved") return false;
      if (node.kind === "goal") {
        active.add(node.id);
        return true;
      }

      let hasRunnableGoal = false;
      for (const child of children.get(node.id) ?? []) {
        if (markRunnable(child)) hasRunnableGoal = true;
      }
      if (hasRunnableGoal) active.add(node.id);
      return hasRunnableGoal;
    };
    markRunnable(root);
    const activeChildren = new Map<string, Node[]>();
    for (const node of nodes) {
      activeChildren.set(
        node.id,
        (children.get(node.id) ?? []).filter((child) => active.has(child.id)),
      );
    }
    if (!active.has(root.id)) {
      throw new TreeValidationError(["tree has no runnable goal after unresolved nodes are pruned"]);
    }
    this.activeChildrenById = activeChildren;
  }

  childrenOf(nodeId: string): readonly Node[] {
    return this.childrenById.get(nodeId) ?? [];
  }

  activeChildrenOf(nodeId: string): readonly Node[] {
    return this.activeChildrenById.get(nodeId) ?? [];
  }
}
