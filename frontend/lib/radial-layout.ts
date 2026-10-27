/**
 * Radial "flower" layout of the knowledge graph (pure: no DOM, no randomness).
 *
 * - Every cluster (birth session) owns an angular sector around an empty centre,
 *   its width growing sub-linearly with the cluster size.
 * - Inside a sector, propositions sit on rings by inference depth: a node that is
 *   never a conclusion (a premise/foundation) is depth 0 on the inner ring, and
 *   each derivation step moves one ring outward, so chains grow into petals.
 *   Implication junctions sit halfway between their deepest premise and their
 *   conclusion. Cycles are tolerated (see `inferenceDepths`).
 * - Propositions with no chain at all are scattered on an outer band beyond the
 *   deepest ring, still inside their cluster's sector.
 *
 * The plan gives seed positions for new bodies and per-tick radial/sector forces;
 * the engine (components/graph-canvas.ts) adds repulsion and link springs.
 * Everything is a function of the graph, so the same graph lays out the same way.
 */

export interface RadialNodeInput {
  id: string;
  cluster?: string;
}

export interface RadialJunctionInput {
  id: string;
  premises: readonly string[];
  conclusion: string;
  cluster?: string;
}

/** A logical derivation step: `premise` supports `conclusion`. */
export interface RadialArc {
  premise: string;
  conclusion: string;
}

export interface RadialParams {
  /** Radius of the inner ring (depth 0), world units. */
  ringRadius: number;
  /** Distance between consecutive depth rings, world units. */
  depthSpacing: number;
  /** Extra distance between the deepest ring and the band of unconnected nodes. */
  peripheryGap?: number;
  /** Empty angle between neighbouring sectors (radians). */
  sectorGap?: number;
  /** Preferred cluster order (sectors run clockwise from the top in this order). */
  clusterOrder?: readonly string[];
}

export interface Sector {
  cluster: string;
  /** Start / end angle (radians, end > start); `mid` is the bisector. */
  start: number;
  end: number;
  mid: number;
  /** Position of the sector in the clockwise order (0 = first). */
  index: number;
}

export interface RadialPlan {
  /** Depth of every node and junction (junctions may be fractional). */
  depth: Map<string, number>;
  maxDepth: number;
  sectors: Map<string, Sector>;
  /** Cluster key of every body ("" = no cluster). */
  clusterOf: Map<string, string>;
  /** Nodes with no derivation at all (drawn on the outer band). */
  isolated: Set<string>;
  /** Seed angle of every body. */
  angle: Map<string, number>;
  /** Target radius of every body. */
  radius: Map<string, number>;
  /** Radius of the outer band (centre line). */
  peripheryRadius: number;
}

export interface RadialForceParams {
  /** Pull toward the target ring (per tick, × alpha). */
  depthStrength: number;
  /** Pull toward the planned angle inside the sector (per tick, × alpha). */
  clusterPull: number;
  /** Pull toward the centre for every free body (per tick, × alpha). */
  centerPull: number;
}

export interface RadialBody {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
}

const TAU = Math.PI * 2;
const DEFAULT_SECTOR_GAP = 0.14;
/** Sector containment is much stiffer than the cohesion pull. */
const SECTOR_WALL = 0.9;
/** Sector width ∝ size^SIZE_EXPONENT, so small sessions still get a readable slice. */
const SIZE_EXPONENT = 0.75;
/** Depth quantile of the connected nodes that the outer band sits just beyond. */
const BAND_QUANTILE = 0.9;

/** Stable [0, 1) hash of a string (FNV-1a), used instead of randomness. */
export function unitHash(text: string, salt = 0): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Angle difference folded into (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/**
 * Longest derivation path ending at each id: depth 0 for ids no arc concludes,
 * otherwise 1 + the deepest premise. Computed by peeling ids whose premises are
 * all settled; when only cycles remain, the smallest pending id is released
 * using the premises settled so far, which keeps the result finite and
 * deterministic for any input.
 */
export function inferenceDepths(ids: readonly string[], arcs: readonly RadialArc[]): Map<string, number> {
  const known = new Set(ids);
  const premisesOf = new Map<string, Set<string>>();
  const conclusionsOf = new Map<string, Set<string>>();
  for (const { premise, conclusion } of arcs) {
    if (premise === conclusion || !known.has(premise) || !known.has(conclusion)) continue;
    if (!premisesOf.has(conclusion)) premisesOf.set(conclusion, new Set());
    if (!conclusionsOf.has(premise)) conclusionsOf.set(premise, new Set());
    premisesOf.get(conclusion)!.add(premise);
    conclusionsOf.get(premise)!.add(conclusion);
  }
  const waiting = new Map<string, number>();
  for (const id of known) waiting.set(id, premisesOf.get(id)?.size ?? 0);
  const depth = new Map<string, number>();
  const pending = new Set(known);
  const ready: string[] = [...known].filter((id) => waiting.get(id) === 0).sort();

  const settle = (id: string) => {
    let d = 0;
    for (const p of premisesOf.get(id) ?? []) {
      const pd = depth.get(p);
      if (pd !== undefined) d = Math.max(d, pd + 1);
    }
    depth.set(id, d);
    pending.delete(id);
    for (const c of [...(conclusionsOf.get(id) ?? [])].sort()) {
      if (!pending.has(c)) continue;
      const left = (waiting.get(c) ?? 0) - 1;
      waiting.set(c, left);
      if (left === 0) ready.push(c);
    }
  };

  while (pending.size > 0) {
    if (ready.length === 0) {
      // Only cycles left: release the smallest pending id.
      let pick: string | null = null;
      for (const id of pending) if (pick === null || id < pick) pick = id;
      ready.push(pick as string);
    }
    const id = ready.shift() as string;
    if (pending.has(id)) settle(id);
  }
  return depth;
}

/**
 * Splits the circle into one sector per cluster, clockwise from the top, in the
 * given order (unknown clusters after, by key). Widths ∝ size^0.75.
 */
export function allocateSectors(
  sizes: ReadonlyMap<string, number>,
  order: readonly string[] = [],
  gap = DEFAULT_SECTOR_GAP,
): Map<string, Sector> {
  const rank = new Map(order.map((k, i) => [k, i]));
  const keys = [...sizes.keys()].filter((k) => (sizes.get(k) ?? 0) > 0);
  keys.sort((a, b) => {
    const ra = rank.get(a) ?? Infinity;
    const rb = rank.get(b) ?? Infinity;
    return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
  });
  const out = new Map<string, Sector>();
  if (keys.length === 0) return out;
  const weights = keys.map((k) => Math.pow(sizes.get(k) as number, SIZE_EXPONENT));
  const total = weights.reduce((s, w) => s + w, 0);
  const usable = keys.length > 1 ? TAU - gap * keys.length : TAU;
  let cursor = -Math.PI / 2 + (keys.length > 1 ? gap / 2 : 0);
  keys.forEach((k, index) => {
    const width = (usable * weights[index]) / total;
    out.set(k, { cluster: k, start: cursor, end: cursor + width, mid: cursor + width / 2, index });
    cursor += width + (keys.length > 1 ? gap : 0);
  });
  return out;
}

/** Builds the radial plan for the given bodies and derivation arcs. */
export function planRadial(
  nodes: readonly RadialNodeInput[],
  junctions: readonly RadialJunctionInput[],
  arcs: readonly RadialArc[],
  params: RadialParams,
): RadialPlan {
  const ids = nodes.map((n) => n.id);
  const nodeIds = new Set(ids);
  const usable = arcs.filter((a) => a.premise !== a.conclusion && nodeIds.has(a.premise) && nodeIds.has(a.conclusion));
  const depth = inferenceDepths(ids, usable);

  const linked = new Set<string>();
  for (const a of usable) {
    linked.add(a.premise);
    linked.add(a.conclusion);
  }
  const isolated = new Set(ids.filter((id) => !linked.has(id)));

  let maxDepth = 0;
  for (const id of linked) maxDepth = Math.max(maxDepth, depth.get(id) ?? 0);
  for (const j of junctions) {
    const c = depth.get(j.conclusion);
    const ps = j.premises.map((p) => depth.get(p)).filter((d): d is number => d !== undefined);
    if (c === undefined || ps.length === 0) continue;
    depth.set(j.id, (Math.max(...ps) + c) / 2);
  }

  const clusterOf = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const n of nodes) {
    const key = n.cluster ?? "";
    clusterOf.set(n.id, key);
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  for (const j of junctions) clusterOf.set(j.id, j.cluster ?? clusterOf.get(j.conclusion) ?? "");
  const sectors = allocateSectors(sizes, params.clusterOrder ?? [], params.sectorGap ?? DEFAULT_SECTOR_GAP);

  // The outer band hugs the bulk of the petals: a few very deep chains reach
  // into it instead of pushing it far out.
  const linkedDepths = [...linked].map((id) => depth.get(id) ?? 0).sort((x, y) => x - y);
  const bandDepth = linkedDepths.length ? linkedDepths[Math.floor((linkedDepths.length - 1) * BAND_QUANTILE)] : 0;
  const peripheryRadius = params.ringRadius + (bandDepth + 1) * params.depthSpacing + (params.peripheryGap ?? params.depthSpacing * 0.6);
  const angle = new Map<string, number>();
  const radius = new Map<string, number>();

  // Angular order inside each sector: walk back from the outermost conclusions
  // through their premises, so every derivation tree occupies a contiguous arc.
  const premisesOf = new Map<string, string[]>();
  const supports = new Map<string, string[]>();
  for (const a of usable) {
    if (!premisesOf.has(a.conclusion)) premisesOf.set(a.conclusion, []);
    premisesOf.get(a.conclusion)!.push(a.premise);
    if (!supports.has(a.premise)) supports.set(a.premise, []);
    supports.get(a.premise)!.push(a.conclusion);
  }
  for (const list of premisesOf.values()) list.sort();
  const members = new Map<string, string[]>();
  for (const id of ids) {
    const key = clusterOf.get(id) as string;
    if (!members.has(key)) members.set(key, []);
    members.get(key)!.push(id);
  }
  for (const [key, list] of members) {
    const sector = sectors.get(key) as Sector;
    const width = sector.end - sector.start;
    const inSector = new Set(list);
    const structured = list.filter((id) => !isolated.has(id));
    const tips = structured
      .filter((id) => !(supports.get(id) ?? []).some((c) => inSector.has(c)))
      .sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0) || (a < b ? -1 : 1));
    const order: string[] = [];
    const seen = new Set<string>();
    const walk = (root: string) => {
      const stack: [string, number][] = [[root, 0]];
      seen.add(root);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const children = (premisesOf.get(top[0]) ?? []).filter((p) => inSector.has(p));
        if (top[1] < children.length) {
          const next = children[top[1]++];
          if (!seen.has(next)) {
            seen.add(next);
            stack.push([next, 0]);
          }
        } else {
          stack.pop();
          order.push(top[0]);
        }
      }
    };
    for (const tip of tips) if (!seen.has(tip)) walk(tip);
    for (const id of [...structured].sort()) if (!seen.has(id)) walk(id);
    // Seeds use the middle of the sector: petals start narrow, with dark gaps between them.
    const margin = width * 0.12;
    order.forEach((id, i) => {
      angle.set(id, sector.start + margin + ((i + 0.5) / order.length) * (width - 2 * margin));
      radius.set(id, params.ringRadius + (depth.get(id) ?? 0) * params.depthSpacing);
    });
    const loose = list.filter((id) => isolated.has(id)).sort();
    loose.forEach((id, i) => {
      angle.set(id, sector.start + margin + ((i + 0.5) / loose.length) * (width - 2 * margin));
      // Scattered band: a stable per-node offset around the periphery radius.
      radius.set(id, peripheryRadius + (unitHash(id, 7) - 0.3) * params.depthSpacing * 1.4);
    });
  }
  for (const j of junctions) {
    const ends = [...j.premises, j.conclusion].filter((id) => angle.has(id));
    if (ends.length === 0) continue;
    let sx = 0;
    let sy = 0;
    for (const id of ends) {
      sx += Math.cos(angle.get(id) as number);
      sy += Math.sin(angle.get(id) as number);
    }
    angle.set(j.id, Math.atan2(sy, sx));
    radius.set(j.id, params.ringRadius + (depth.get(j.id) ?? 0) * params.depthSpacing);
  }
  return { depth, maxDepth, sectors, clusterOf, isolated, angle, radius, peripheryRadius };
}

/** Seed position of a body (deterministic small jitter so rings do not start perfectly aligned). */
export function seedPosition(plan: RadialPlan, id: string): { x: number; y: number } | null {
  const a = plan.angle.get(id);
  const r = plan.radius.get(id);
  if (a === undefined || r === undefined) return null;
  const jr = (unitHash(id, 1) - 0.5) * 6;
  const ja = (unitHash(id, 2) - 0.5) * 0.01;
  return { x: Math.cos(a + ja) * (r + jr), y: Math.sin(a + ja) * (r + jr) };
}

/**
 * One tick of the radial forces (adds to vx/vy; fixed bodies are skipped):
 * spring toward the target ring, a stiff wall at the sector edges, a weak pull
 * toward the body's planned angle (which keeps each derivation tree on its own
 * arc, so chains read as radial petals) and an optional pull toward the centre.
 */
export function applyRadialForces(
  bodies: readonly RadialBody[],
  plan: RadialPlan,
  force: RadialForceParams,
  alpha: number,
): void {
  for (const b of bodies) {
    if (b.fixed) continue;
    const target = plan.radius.get(b.id);
    const sector = plan.sectors.get(plan.clusterOf.get(b.id) ?? "");
    const r = Math.hypot(b.x, b.y);
    const ux = r > 1e-6 ? b.x / r : 1;
    const uy = r > 1e-6 ? b.y / r : 0;
    if (target !== undefined) {
      const k = (target - r) * force.depthStrength * alpha;
      b.vx += ux * k;
      b.vy += uy * k;
    }
    if (sector && r > 1e-6) {
      const theta = Math.atan2(b.y, b.x);
      const off = angleDelta(theta, sector.mid);
      const half = (sector.end - sector.start) / 2;
      let turn = -angleDelta(theta, plan.angle.get(b.id) ?? sector.mid) * force.clusterPull;
      if (Math.abs(off) > half) turn -= Math.sign(off) * (Math.abs(off) - half) * SECTOR_WALL;
      // Tangential direction (counter-clockwise unit) scaled by arc length.
      const t = turn * r * alpha;
      b.vx += -uy * t;
      b.vy += ux * t;
    }
    if (force.centerPull > 0) {
      b.vx -= b.x * force.centerPull * alpha;
      b.vy -= b.y * force.centerPull * alpha;
    }
  }
}
