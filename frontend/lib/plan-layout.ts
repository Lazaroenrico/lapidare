/**
 * Pure layered-DAG layout for the PlanWindow (no React, no DOM).
 * Edges come from `depends_on` (prerequisite → dependent). Layers use the
 * longest path from the roots; order within a layer is refined with a few
 * barycenter sweeps to reduce crossings. Unknown dependencies are ignored and
 * cycles (which the backend rejects) cannot hang the layout.
 */

export interface DagInput {
  id: string;
  depends_on: string[];
}

export interface DagLayers {
  /** Node ids per layer, already ordered for few crossings. */
  layers: string[][];
  layerOf: Record<string, number>;
  /** Valid edges [from (prerequisite), to (dependent)]. */
  edges: [string, string][];
}

/** Longest-path layering: roots at layer 0, every node below all its prerequisites. */
export function assignLayers(nodes: DagInput[]): Record<string, number> {
  const known = new Map(nodes.map((n) => [n.id, n]));
  const layer: Record<string, number> = {};
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (layer[id] !== undefined) return layer[id];
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let depth = 0;
    for (const dep of known.get(id)?.depends_on ?? []) {
      if (known.has(dep) && dep !== id) depth = Math.max(depth, visit(dep) + 1);
    }
    visiting.delete(id);
    layer[id] = depth;
    return depth;
  };
  nodes.forEach((n) => visit(n.id));
  return layer;
}

function validEdges(nodes: DagInput[]): [string, string][] {
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const edges: [string, string][] = [];
  for (const n of nodes) {
    for (const dep of n.depends_on ?? []) {
      const key = `${dep}->${n.id}`;
      if (!ids.has(dep) || dep === n.id || seen.has(key)) continue;
      seen.add(key);
      edges.push([dep, n.id]);
    }
  }
  return edges;
}

/** Counts pairwise crossings between edges joining adjacent layers. */
export function countCrossings(layers: string[][], edges: [string, string][]): number {
  const pos: Record<string, [number, number]> = {};
  layers.forEach((row, l) => row.forEach((id, i) => (pos[id] = [l, i])));
  const adjacent = edges
    .map(([a, b]) => [pos[a], pos[b]] as const)
    .filter(([pa, pb]) => pa && pb && pb[0] === pa[0] + 1);
  let crossings = 0;
  for (let i = 0; i < adjacent.length; i++) {
    for (let j = i + 1; j < adjacent.length; j++) {
      const [a1, b1] = adjacent[i];
      const [a2, b2] = adjacent[j];
      if (a1[0] !== a2[0]) continue;
      if ((a1[1] - a2[1]) * (b1[1] - b2[1]) < 0) crossings++;
    }
  }
  return crossings;
}

/** Layering + barycenter ordering. Deterministic for a given input order. */
export function layerDag(nodes: DagInput[], sweeps = 4): DagLayers {
  const layerOf = assignLayers(nodes);
  const edges = validEdges(nodes);
  const depth = nodes.reduce((m, n) => Math.max(m, layerOf[n.id] ?? 0), -1) + 1;
  let layers: string[][] = Array.from({ length: depth }, () => []);
  nodes.forEach((n) => layers[layerOf[n.id]].push(n.id));

  const parents: Record<string, string[]> = {};
  const children: Record<string, string[]> = {};
  for (const [a, b] of edges) {
    (children[a] ??= []).push(b);
    (parents[b] ??= []).push(a);
  }

  // Relative position (0..1) of each node in its layer — lets long edges vote too.
  const relPos = (ls: string[][]) => {
    const p: Record<string, number> = {};
    ls.forEach((row) => row.forEach((id, i) => (p[id] = row.length > 1 ? i / (row.length - 1) : 0.5)));
    return p;
  };
  const reorder = (row: string[], neighbours: Record<string, string[]>, p: Record<string, number>) => {
    const keyed = row.map((id, i) => {
      const ns = (neighbours[id] ?? []).filter((n) => p[n] !== undefined);
      const current = row.length > 1 ? i / (row.length - 1) : 0.5;
      const bary = ns.length ? ns.reduce((s, n) => s + p[n], 0) / ns.length : current;
      return { id, bary, i };
    });
    keyed.sort((x, y) => x.bary - y.bary || x.i - y.i);
    return keyed.map((k) => k.id);
  };

  let best = layers.map((r) => [...r]);
  let bestCrossings = countCrossings(best, edges);
  for (let s = 0; s < sweeps && bestCrossings > 0; s++) {
    const down = s % 2 === 0;
    const range = down
      ? Array.from({ length: depth - 1 }, (_, k) => k + 1)
      : Array.from({ length: depth - 1 }, (_, k) => depth - 2 - k);
    for (const l of range) {
      const next = layers.map((r) => [...r]);
      next[l] = reorder(layers[l], down ? parents : children, relPos(layers));
      layers = next;
    }
    const c = countCrossings(layers, edges);
    if (c < bestCrossings) {
      best = layers.map((r) => [...r]);
      bestCrossings = c;
    }
  }
  const finalLayerOf: Record<string, number> = {};
  best.forEach((row, l) => row.forEach((id) => (finalLayerOf[id] = l)));
  return { layers: best, layerOf: finalLayerOf, edges };
}

// --- Geometry ------------------------------------------------------------------

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  gapX: number;
  gapY: number;
  padding: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { nodeWidth: 128, nodeHeight: 44, gapX: 16, gapY: 32, padding: 12 };

export interface PositionedEdge {
  from: string;
  to: string;
  /** SVG path `d` (cubic curve from the bottom of `from` to the top of `to`). */
  d: string;
}

export interface DagLayout {
  layers: string[][];
  positions: Record<string, { x: number; y: number }>;
  edges: PositionedEdge[];
  width: number;
  height: number;
}

/** Top-down layout: each layer is a centered row; returns node top-left corners. */
export function layoutDag(nodes: DagInput[], opts: LayoutOptions = DEFAULT_LAYOUT): DagLayout {
  const { layers, edges } = layerDag(nodes);
  const { nodeWidth: w, nodeHeight: h, gapX, gapY, padding } = opts;
  const widest = layers.reduce((m, row) => Math.max(m, row.length), 0);
  const width = padding * 2 + Math.max(0, widest * w + (widest - 1) * gapX);
  const height = padding * 2 + Math.max(0, layers.length * h + (layers.length - 1) * gapY);
  const positions: Record<string, { x: number; y: number }> = {};
  layers.forEach((row, l) => {
    const rowWidth = row.length * w + (row.length - 1) * gapX;
    const x0 = (width - rowWidth) / 2;
    row.forEach((id, i) => (positions[id] = { x: x0 + i * (w + gapX), y: padding + l * (h + gapY) }));
  });
  const positioned = edges.map(([from, to]) => {
    const a = positions[from];
    const b = positions[to];
    const x1 = a.x + w / 2;
    const y1 = a.y + h;
    const x2 = b.x + w / 2;
    const y2 = b.y;
    const mid = (y2 - y1) / 2;
    return { from, to, d: `M${x1},${y1} C${x1},${y1 + mid} ${x2},${y2 - mid} ${x2},${y2}` };
  });
  return { layers, positions, edges: positioned, width, height };
}

/** Greedy word wrap for SVG labels; the last line gets an ellipsis when truncated. */
export function wrapLabel(label: string, maxChars: number, maxLines: number): string[] {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let i = 0;
  for (; i < words.length; i++) {
    const word = words[i].length > maxChars ? `${words[i].slice(0, maxChars - 1)}…` : words[i];
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) {
    lines.push(line);
    line = "";
    i = words.length;
  }
  if (i < words.length || line) {
    const last = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
  }
  return lines;
}
