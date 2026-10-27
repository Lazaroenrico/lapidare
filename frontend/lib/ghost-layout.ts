/**
 * Pure layout for roadmap ghost nodes (⇶ Roteiro).
 *
 * - A ghost linked to real nodes sits just outside the centroid of those nodes,
 *   pushed away from the graph centre so it does not cover them.
 * - A ghost with no linked node yet is queued in a column to the right of the
 *   graph, in dependency order (depends_on first), so the "next" items read
 *   top-to-bottom.
 */

export interface GhostInput {
  id: string;
  linked_node_ids: readonly string[];
  depends_on: readonly string[];
}

export interface Point {
  x: number;
  y: number;
}

export interface GhostLayoutOptions {
  /** Distance from the linked centroid (world units). */
  offset?: number;
  /** Horizontal gap between the graph bbox and the queue column. */
  columnGap?: number;
  /** Vertical spacing of queued ghosts. */
  rowGap?: number;
}

/** Stable topological order by depends_on (cycles and unknown deps keep input order). */
export function dependencyOrder<T extends Pick<GhostInput, "id" | "depends_on">>(items: readonly T[]): T[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: T[] = [];
  const visit = (it: T) => {
    if (done.has(it.id) || visiting.has(it.id)) return;
    visiting.add(it.id);
    for (const dep of it.depends_on) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    visiting.delete(it.id);
    done.add(it.id);
    out.push(it);
  };
  items.forEach(visit);
  return out;
}

export function layoutGhosts(
  ghosts: readonly GhostInput[],
  positions: ReadonlyMap<string, Point>,
  opts: GhostLayoutOptions = {},
): Map<string, Point> {
  const offset = opts.offset ?? 90;
  const columnGap = opts.columnGap ?? 160;
  const rowGap = opts.rowGap ?? 72;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let sumX = 0;
  let sumY = 0;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    sumX += p.x;
    sumY += p.y;
  }
  const hasGraph = positions.size > 0;
  const center: Point = hasGraph ? { x: sumX / positions.size, y: sumY / positions.size } : { x: 0, y: 0 };

  const out = new Map<string, Point>();
  const queued: GhostInput[] = [];
  const usedAnchors = new Map<string, number>();

  for (const g of dependencyOrder(ghosts)) {
    const linked = g.linked_node_ids.map((id) => positions.get(id)).filter((p): p is Point => !!p);
    if (linked.length === 0) {
      queued.push(g);
      continue;
    }
    const cx = linked.reduce((s, p) => s + p.x, 0) / linked.length;
    const cy = linked.reduce((s, p) => s + p.y, 0) / linked.length;
    let dx = cx - center.x;
    let dy = cy - center.y;
    let len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = 0;
      dy = -1;
      len = 1;
    }
    // Ghosts sharing the same anchor fan out instead of stacking.
    const key = `${Math.round(cx)}:${Math.round(cy)}`;
    const k = usedAnchors.get(key) ?? 0;
    usedAnchors.set(key, k + 1);
    const angle = Math.atan2(dy, dx) + k * 0.6;
    out.set(g.id, { x: cx + Math.cos(angle) * offset, y: cy + Math.sin(angle) * offset });
  }

  const colX = hasGraph ? maxX + columnGap : 0;
  const startY = hasGraph ? minY : -((queued.length - 1) * rowGap) / 2;
  queued.forEach((g, i) => out.set(g.id, { x: colX, y: startY + i * rowGap }));
  return out;
}
