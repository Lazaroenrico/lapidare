/**
 * Pure layout of the ⇶ Roteiro constellation (no DOM, no canvas).
 *
 * Each track is a galaxy; its modules are sub-constellations placed in order
 * along a gently curling arm; inside a module the steps follow a short curved
 * path (a spiral when the module is long) in queue order; steps that share a
 * submodule (repo tracks: the lesson directory) form a tight sunflower cluster
 * on that path. Galaxies are stacked in a column.
 *
 * Coordinates are local to the roadmap region (top-left galaxy label at about
 * (0, 0)); the canvas translates the result beside the knowledge graph with
 * `offsetRoadmapLayout`. Positions depend only on track / module / submodule
 * grouping and queue order (never on status), so a refetch after a step is
 * completed keeps every star where it was.
 */

export interface RoadmapLayoutItem {
  id: string;
  track_id?: string | null;
  track_title?: string | null;
  order: number;
  module: { id: string; title: string; order: number };
  submodule: { id: string; title: string } | null;
}

export interface Point {
  x: number;
  y: number;
}

export interface RoadmapModuleDisc {
  /** `<track key>\u0000<module id>`: unique across tracks. */
  key: string;
  trackKey: string;
  id: string;
  title: string;
  order: number;
  x: number;
  y: number;
  r: number;
  /** Arm direction at this module (radians). */
  angle: number;
  /** Label under the disc (every other module, so neighbours on the arm never collide). */
  labelBelow: boolean;
  /** Item ids in queue order. */
  itemIds: string[];
}

export interface RoadmapSubmoduleDisc {
  key: string;
  moduleKey: string;
  id: string;
  title: string;
  x: number;
  y: number;
  r: number;
  itemIds: string[];
}

export interface RoadmapGalaxy {
  /** track id, or "" for steps without a track (legacy). */
  trackKey: string;
  title: string;
  /** Module keys in order (the spine). */
  moduleKeys: string[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Anchor of the galaxy title (left, baseline). */
  labelX: number;
  labelY: number;
}

export interface RoadmapLayout {
  items: Map<string, Point>;
  /** Item id → module key / submodule key (null when not in a sub-cluster). */
  moduleOf: Map<string, string>;
  submoduleOf: Map<string, string | null>;
  modules: RoadmapModuleDisc[];
  submodules: RoadmapSubmoduleDisc[];
  galaxies: RoadmapGalaxy[];
  /** Bounds of everything (labels included). Empty layout → all zeros. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

export interface RoadmapLayoutOptions {
  /** Galaxy order (e.g. the active track first); unknown tracks follow in first-appearance order. */
  trackOrder?: readonly string[];
}

/** Distance between consecutive units on a module path. */
const STEP = 24;
/** Sunflower spacing inside a submodule cluster. */
const SUB_SPACING = 7.5;
/** Empty margin inside a module disc around its outermost star. */
const MODULE_PAD = 16;
const MODULE_MIN_R = 28;
/** Gap between consecutive module discs along the arm. */
const MODULE_GAP = 46;
/** Path length from which a module curls into a spiral instead of an arc. */
const ARC_MAX = 170;
/** Total bend of a short module path (radians). */
const ARC_BEND = 1.7;
/** Arm: total bend of a short track and the largest turn between two modules (radians). */
const ARM_BEND = 1.1;
const ARM_MAX_TURN = 0.3;
const GALAXY_GAP = 100;
/** Half the width a two-line module label needs at overview zoom (kept inside the bounds). */
const LABEL_HALF_WIDTH = 70;
/** Room above a galaxy for its title. */
const GALAXY_LABEL_SPACE = 46;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const keyOf = (a: string, b: string) => `${a}\u0000${b}`;

interface Unit {
  /** Submodule id, or null for a lone step. */
  sub: { id: string; title: string } | null;
  itemIds: string[];
  r: number;
}

interface LocalModule {
  /** Item positions relative to the module centre, path along +x. */
  items: Map<string, Point>;
  subs: { id: string; title: string; x: number; y: number; r: number; itemIds: string[] }[];
  r: number;
}

/** Points at the given arc lengths along a curve sampled by `at(t)`. */
function placeAlong(lengths: number[], sample: (s: number) => Point): Point[] {
  return lengths.map((s) => sample(s));
}

/** Gentle circular arc of length `total`, chord centred on the origin along +x, bulging to -y (`sign`). */
function arcSampler(total: number, sign: number): (s: number) => Point {
  if (total <= 1e-6) return () => ({ x: 0, y: 0 });
  const R = total / ARC_BEND;
  // Arc centre sits below the chord for an upward bulge; s=0 at the left end.
  const sagitta = R * (1 - Math.cos(ARC_BEND / 2));
  return (s) => {
    const a = -ARC_BEND / 2 + (s / total) * ARC_BEND;
    return { x: R * Math.sin(a), y: sign * (-(R * Math.cos(a)) + R - sagitta / 2) };
  };
}

/** Archimedean spiral from the centre, parametrised by arc length (numerically). */
function spiralSampler(pitch: number): (s: number) => Point {
  const b = pitch / (2 * Math.PI);
  const phi0 = 1.6;
  const table: { s: number; phi: number }[] = [{ s: 0, phi: phi0 }];
  let phi = phi0;
  let acc = 0;
  return (s) => {
    while (acc < s) {
      const dphi = 0.02;
      const r = b * phi;
      acc += Math.sqrt(r * r + b * b) * dphi;
      phi += dphi;
      table.push({ s: acc, phi });
    }
    let lo = 0;
    let hi = table.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (table[mid].s < s) lo = mid + 1;
      else hi = mid;
    }
    const p = table[lo].phi;
    return { x: b * p * Math.cos(p), y: b * p * Math.sin(p) };
  };
}

function layoutModule(itemIds: string[], subOf: Map<string, { id: string; title: string } | null>, sign: number): LocalModule {
  // Units in first-appearance order: a submodule gathers all its steps.
  const units: Unit[] = [];
  const unitBySub = new Map<string, Unit>();
  for (const id of itemIds) {
    const sub = subOf.get(id) ?? null;
    if (sub) {
      const existing = unitBySub.get(sub.id);
      if (existing) {
        existing.itemIds.push(id);
        continue;
      }
      const unit: Unit = { sub, itemIds: [id], r: 0 };
      unitBySub.set(sub.id, unit);
      units.push(unit);
    } else {
      units.push({ sub: null, itemIds: [id], r: 0 });
    }
  }
  // A one-step submodule is just a star on the path (no cluster).
  for (const u of units) u.r = u.itemIds.length > 1 ? SUB_SPACING * Math.sqrt(u.itemIds.length) + 4 : 0;

  const lengths: number[] = [];
  let s = 0;
  units.forEach((u, i) => {
    if (i > 0) s += units[i - 1].r + u.r + STEP;
    lengths.push(s);
  });
  const total = s;
  const maxR = Math.max(0, ...units.map((u) => u.r));
  let centres: Point[];
  if (total <= ARC_MAX) {
    centres = placeAlong(lengths, arcSampler(total, sign));
  } else {
    const sample = spiralSampler(Math.max(STEP * 1.6, 2 * maxR + STEP));
    centres = placeAlong(lengths, sample);
    // Centre the spiral's bounding box on the origin.
    const xs = centres.map((p) => p.x);
    const ys = centres.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    centres = centres.map((p) => ({ x: p.x - cx, y: p.y - cy }));
  }

  const items = new Map<string, Point>();
  const subs: LocalModule["subs"] = [];
  units.forEach((u, i) => {
    const c = centres[i];
    if (u.itemIds.length === 1) {
      items.set(u.itemIds[0], { x: c.x, y: c.y });
      return;
    }
    let far = 0;
    u.itemIds.forEach((id, k) => {
      const rr = SUB_SPACING * Math.sqrt(k + 0.5);
      const a = k * GOLDEN - Math.PI / 2;
      const p = { x: c.x + Math.cos(a) * rr, y: c.y + Math.sin(a) * rr };
      far = Math.max(far, rr);
      items.set(id, p);
    });
    if (u.sub) subs.push({ id: u.sub.id, title: u.sub.title, x: c.x, y: c.y, r: far + 6, itemIds: [...u.itemIds] });
  });

  // Re-centre on the bounding box so the disc is as tight as possible.
  const pts = [...items.values()];
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const ox = (minX + maxX) / 2;
  const oy = (minY + maxY) / 2;
  for (const [id, p] of items) items.set(id, { x: p.x - ox, y: p.y - oy });
  for (const sd of subs) {
    sd.x -= ox;
    sd.y -= oy;
  }
  let r = MODULE_MIN_R;
  for (const p of items.values()) r = Math.max(r, Math.hypot(p.x, p.y) + MODULE_PAD);
  for (const sd of subs) r = Math.max(r, Math.hypot(sd.x, sd.y) + sd.r + MODULE_PAD / 2);
  return { items, subs, r };
}

const rotate = (p: Point, a: number): Point => ({
  x: p.x * Math.cos(a) - p.y * Math.sin(a),
  y: p.x * Math.sin(a) + p.y * Math.cos(a),
});

export function layoutRoadmap(items: readonly RoadmapLayoutItem[], opts: RoadmapLayoutOptions = {}): RoadmapLayout {
  const out: RoadmapLayout = {
    items: new Map(),
    moduleOf: new Map(),
    submoduleOf: new Map(),
    modules: [],
    submodules: [],
    galaxies: [],
    bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
  };
  if (items.length === 0) return out;

  // Track → modules (by module order, then first appearance) → item ids (queue order).
  const tracks = new Map<string, { title: string; modules: Map<string, { id: string; title: string; order: number; first: number; itemIds: string[] }> }>();
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const subOf = new Map<string, { id: string; title: string } | null>();
  const seen = new Set<string>();
  items.forEach((it) => {
    const key = it.track_id ?? "";
    if (!tracks.has(key)) tracks.set(key, { title: it.track_title?.trim() || key, modules: new Map() });
  });
  sorted.forEach((it, idx) => {
    if (seen.has(it.id)) return;
    seen.add(it.id);
    const track = tracks.get(it.track_id ?? "")!;
    let mod = track.modules.get(it.module.id);
    if (!mod) {
      mod = { id: it.module.id, title: it.module.title, order: it.module.order, first: idx, itemIds: [] };
      track.modules.set(it.module.id, mod);
    }
    mod.itemIds.push(it.id);
    subOf.set(it.id, it.submodule);
  });

  const order = opts.trackOrder ?? [];
  const trackKeys = [...tracks.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
  });

  let cursorY = 0;
  for (const trackKey of trackKeys) {
    const track = tracks.get(trackKey)!;
    const mods = [...track.modules.values()].sort((a, b) => a.order - b.order || a.first - b.first);
    const placed: { key: string; x: number; y: number; r: number; angle: number; local: LocalModule; mod: (typeof mods)[number] }[] = [];
    // A gentle arc left → right (symmetric bend) that curls into a spiral for long tracks.
    const steps = mods.length - 1;
    const turn = steps > 0 ? Math.min(ARM_MAX_TURN, ARM_BEND / steps) : 0;
    const start = steps > 0 ? -turn * Math.min(steps - 1, ARM_BEND / turn) / 2 : 0;
    let angle = start;
    mods.forEach((mod, k) => {
      const local = layoutModule(mod.itemIds, subOf, k % 2 === 0 ? 1 : -1);
      let x = 0;
      let y = 0;
      if (k > 0) {
        angle = start + (k - 1) * turn;
        const prev = placed[k - 1];
        let d = prev.r + local.r + MODULE_GAP;
        x = prev.x + Math.cos(angle) * d;
        y = prev.y + Math.sin(angle) * d;
        // Push further along the arm until clear of every earlier disc.
        for (let guard = 0; guard < 400 && placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + local.r + MODULE_GAP * 0.75); guard++) {
          d += 8;
          x = prev.x + Math.cos(angle) * d;
          y = prev.y + Math.sin(angle) * d;
        }
      }
      placed.push({ key: keyOf(trackKey, mod.id), x, y, r: local.r, angle, local, mod });
    });

    // Galaxy bounds (discs + module labels above them).
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of placed) {
      x0 = Math.min(x0, p.x - Math.max(p.r, LABEL_HALF_WIDTH));
      x1 = Math.max(x1, p.x + Math.max(p.r, LABEL_HALF_WIDTH));
      y0 = Math.min(y0, p.y - p.r - 30);
      y1 = Math.max(y1, p.y + p.r + 30);
    }
    const dx = -x0;
    const dy = cursorY + GALAXY_LABEL_SPACE - y0;
    const moduleKeys: string[] = [];
    for (const p of placed) {
      const cx = p.x + dx;
      const cy = p.y + dy;
      moduleKeys.push(p.key);
      out.modules.push({
        key: p.key,
        trackKey,
        id: p.mod.id,
        title: p.mod.title,
        order: p.mod.order,
        x: cx,
        y: cy,
        r: p.r,
        angle: p.angle,
        labelBelow: placed.indexOf(p) % 2 === 1,
        itemIds: [...p.mod.itemIds],
      });
      for (const [id, lp] of p.local.items) {
        const w = rotate(lp, p.angle);
        out.items.set(id, { x: cx + w.x, y: cy + w.y });
        out.moduleOf.set(id, p.key);
        out.submoduleOf.set(id, null);
      }
      for (const sd of p.local.subs) {
        const w = rotate(sd, p.angle);
        const key = keyOf(p.key, sd.id);
        out.submodules.push({ key, moduleKey: p.key, id: sd.id, title: sd.title, x: cx + w.x, y: cy + w.y, r: sd.r, itemIds: sd.itemIds });
        for (const id of sd.itemIds) out.submoduleOf.set(id, key);
      }
    }
    const gx0 = x0 + dx;
    const gy0 = cursorY;
    const gx1 = x1 + dx;
    const gy1 = y1 + dy;
    out.galaxies.push({
      trackKey,
      title: track.title,
      moduleKeys,
      x0: gx0,
      y0: gy0,
      x1: gx1,
      y1: gy1,
      labelX: gx0,
      labelY: gy0 + 18,
    });
    cursorY = gy1 + GALAXY_GAP;
  }

  const g = out.galaxies;
  out.bounds = {
    x0: Math.min(...g.map((v) => v.x0)),
    y0: Math.min(...g.map((v) => v.y0)),
    x1: Math.max(...g.map((v) => v.x1)),
    y1: Math.max(...g.map((v) => v.y1)),
  };
  return out;
}

/** The same layout translated by (dx, dy). */
export function offsetRoadmapLayout(layout: RoadmapLayout, dx: number, dy: number): RoadmapLayout {
  const move = <T extends { x: number; y: number }>(p: T): T => ({ ...p, x: p.x + dx, y: p.y + dy });
  return {
    items: new Map([...layout.items].map(([id, p]) => [id, move(p)])),
    moduleOf: layout.moduleOf,
    submoduleOf: layout.submoduleOf,
    modules: layout.modules.map(move),
    submodules: layout.submodules.map(move),
    galaxies: layout.galaxies.map((v) => ({
      ...v,
      x0: v.x0 + dx,
      x1: v.x1 + dx,
      y0: v.y0 + dy,
      y1: v.y1 + dy,
      labelX: v.labelX + dx,
      labelY: v.labelY + dy,
    })),
    bounds: { x0: layout.bounds.x0 + dx, x1: layout.bounds.x1 + dx, y0: layout.bounds.y0 + dy, y1: layout.bounds.y1 + dy },
  };
}

/**
 * Where the roadmap region goes: to the right of the graph's bounding box,
 * vertically centred on it (rounded so the settling graph does not make it shiver).
 */
export function roadmapOffset(
  graph: { x0: number; y0: number; x1: number; y1: number } | null,
  layout: RoadmapLayout,
  gap = 160,
): Point {
  const h = layout.bounds.y1 - layout.bounds.y0;
  if (!graph) return { x: -layout.bounds.x0 - (layout.bounds.x1 - layout.bounds.x0) / 2, y: -layout.bounds.y0 - h / 2 };
  const snap = (v: number) => Math.round(v / 24) * 24;
  const cy = (graph.y0 + graph.y1) / 2;
  return { x: snap(graph.x1 + gap - layout.bounds.x0), y: snap(cy - h / 2 - layout.bounds.y0) };
}

/**
 * Module label in at most two lines of about `max` characters (words are kept
 * whole when possible; an over-long remainder ends in "…").
 */
export function wrapLabel(text: string, max = 16): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (!current) current = w;
    else if (current.length + 1 + w.length <= max || lines.length === 1) current += ` ${w}`;
    else {
      lines.push(current);
      current = w;
    }
  }
  lines.push(current);
  const cutLine = (l: string) => (l.length > max + 4 ? `${l.slice(0, max + 3)}…` : l);
  return lines.slice(0, 2).map(cutLine);
}

export type RoadmapEdgeKind = "path" | "prereq" | "cross";

export interface RoadmapEdge {
  source: string;
  target: string;
  kind: RoadmapEdgeKind;
}

/**
 * Drawn threads: the curved path between consecutive steps of a module (queue
 * order), prerequisite lines inside a module (unless already a path thread)
 * and prerequisite arcs between modules. Unknown ids are ignored.
 */
export function roadmapEdges(
  items: readonly { id: string; depends_on: readonly string[] }[],
  layout: Pick<RoadmapLayout, "modules" | "moduleOf">,
): RoadmapEdge[] {
  const out: RoadmapEdge[] = [];
  const seen = new Set<string>();
  const add = (a: string, b: string, kind: RoadmapEdgeKind) => {
    const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    if (a === b || seen.has(k)) return;
    seen.add(k);
    out.push({ source: a, target: b, kind });
  };
  for (const m of layout.modules) for (let i = 1; i < m.itemIds.length; i++) add(m.itemIds[i - 1], m.itemIds[i], "path");
  for (const it of items) {
    const mod = layout.moduleOf.get(it.id);
    if (!mod) continue;
    for (const dep of it.depends_on) {
      const depMod = layout.moduleOf.get(dep);
      if (!depMod) continue;
      add(dep, it.id, depMod === mod ? "prereq" : "cross");
    }
  }
  return out;
}
