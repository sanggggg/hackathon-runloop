/**
 * Tidy top-down layout for the scenario tree.
 *
 * Leaves are spread evenly left to right; every parent is centred over its
 * children. Deliberately simple — the trees are small and readable beats
 * clever here.
 */
import type { Node } from "@branchpoint/schema";

export interface Placed {
  node: Node;
  /** Centre of the card. */
  x: number;
  /** Top of the card. */
  y: number;
}

export interface Layout {
  placed: Placed[];
  edges: { id: string; from: Placed; to: Placed }[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  cardWidth: number;
  cardHeight: number;
  /** Horizontal gap between sibling cards. */
  gapX?: number;
  /** Vertical gap between depth levels. */
  gapY?: number;
}

export function layoutTree(nodes: Node[], opts: LayoutOptions): Layout {
  const { cardWidth, cardHeight, gapX = 24, gapY = 54 } = opts;
  const step = cardWidth + gapX;
  const rowHeight = cardHeight + gapY;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = (id: string | null) => nodes.filter((n) => n.parentId === id);
  const roots = childrenOf(null);

  const x = new Map<string, number>();
  const depth = new Map<string, number>();
  let cursor = 0;

  const assign = (node: Node, d: number) => {
    depth.set(node.id, d);
    const kids = childrenOf(node.id);
    if (kids.length === 0) {
      x.set(node.id, cursor * step);
      cursor += 1;
      return;
    }
    kids.forEach((k) => assign(k, d + 1));
    const first = x.get(kids[0].id)!;
    const last = x.get(kids[kids.length - 1].id)!;
    x.set(node.id, (first + last) / 2);
  };
  roots.forEach((r) => assign(r, 0));

  const placed: Placed[] = nodes
    .filter((n) => x.has(n.id))
    .map((n) => ({ node: n, x: x.get(n.id)! + cardWidth / 2, y: depth.get(n.id)! * rowHeight }));

  const byNodeId = new Map(placed.map((p) => [p.node.id, p]));
  const edges = placed
    .filter((p) => p.node.parentId && byNodeId.has(p.node.parentId))
    .map((p) => ({
      id: `${p.node.parentId}->${p.node.id}`,
      from: byNodeId.get(p.node.parentId!)!,
      to: p,
    }));

  const maxDepth = Math.max(0, ...placed.map((p) => depth.get(p.node.id)!));

  return {
    placed,
    edges,
    width: Math.max(step, cursor * step),
    height: maxDepth * rowHeight + cardHeight,
  };
}

/** Vertical S-curve from the bottom of the parent card to the top of the child. */
export function edgePath(from: Placed, to: Placed, cardHeight: number): string {
  const y1 = from.y + cardHeight;
  const mid = (y1 + to.y) / 2;
  return `M${from.x} ${y1} C${from.x} ${mid} ${to.x} ${mid} ${to.x} ${to.y}`;
}

export { type Node };
