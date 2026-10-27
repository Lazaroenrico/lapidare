/**
 * 2D Canvas knowledge-graph engine — radial "flower" constellation.
 *
 * - radial layout (lib/radial-layout): each cluster owns an angular sector around
 *   an empty centre, derivation chains grow outward ring by ring (premises inside,
 *   conclusions outside) and unconnected propositions scatter on an outer band;
 *   the engine adds repulsion and link springs on top of those radial forces;
 * - tiny dot nodes joined by hairline straight threads (no arrowheads);
 * - chains with ≥ 2 premises meet at a virtual junction point before the
 *   conclusion (lib/graph-wire `buildConstellation`), which gives the branching,
 *   tree-like shape; junctions take part in the physics but are never drawn as
 *   nodes, labelled, picked or counted;
 * - one soft blurred nebula per cluster (birth session): its nodes and edges
 *   dilated, blurred, then tinted once (overlapping clusters blend);
 * - micro labels under every node (world-sized: tiny at overview, legible on zoom),
 *   full contrast from a zoom threshold (hovered/selected/focused always);
 * - hover brightens a node and its threads, the rest dims slightly;
 * - multi-selection ring (Shift/⌘-click toggles, plain click focuses);
 * - dragging pins a node and reports its position (persisted by the caller);
 * - optional ⇶ Roteiro region beside the graph: each track a constellation of
 *   modules (components/roadmap-canvas.ts), linked to the real nodes it produced.
 *
 * Colours come only from lib/palette (purple skin).
 */

import { palette, toneAlpha, withAlpha, type PaletteTone } from "@/lib/palette";
import type { Point } from "@/lib/roadmap-layout";
import { RoadmapLayer } from "./roadmap-canvas";
import { DEFAULT_GRAPH_SETTINGS, GRAPH_SETTING_KEYS, isLayoutSetting, type GraphSettings } from "@/lib/graph-settings";
import { buildConstellation, type ConstellationLink, type ConstellationWiring } from "@/lib/graph-wire";
import { applyRadialForces, planRadial, seedPosition, unitHash, type RadialArc, type RadialPlan } from "@/lib/radial-layout";
import type { ConceptNode, GraphCluster, GraphEdge, LogicalChain, RoadmapItem } from "@/lib/types";

/** Anything the simulation moves. */
interface Body {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  cluster?: string;
  /** Fixed by the user (dragged now or persisted earlier): physics leaves it alone. */
  fixed: boolean;
}

export interface CanvasNode extends Omit<ConceptNode, "x" | "y" | "cluster">, Body {
  cluster?: string;
}

/** Virtual implication point of a multi-premise chain. */
interface JunctionBody extends Body {
  premises: string[];
  conclusion: string;
}

interface CanvasLink {
  source: Body;
  target: Body;
  kind: ConstellationLink["kind"];
  /** Joins two different sessions: a weak spring and a faint line, so petals stay apart. */
  cross: boolean;
}

interface NodeLabel {
  node: CanvasNode;
  /** 0 active, 1 neighbour of the active node, 2 rest, 3 dimmed. */
  rank: number;
  hot: boolean;
  dimmed: boolean;
}

interface ClusterGroup {
  id: string;
  label: string;
  nodes: CanvasNode[];
  junctions: JunctionBody[];
  centroid: Point;
  /** Where the session name goes: the outer tip of the cluster's petal, on its sector bisector. */
  labelAt: Point;
  /** Unit direction of the sector bisector (the label is pushed outward along it). */
  labelDir: Point;
  tone: PaletteTone;
}

export interface GraphCanvasCallbacks {
  /** Plain click (additive=false) or Shift/⌘/Ctrl-click (additive=true) on a node. */
  onNodeClick?: (node: ConceptNode, additive: boolean) => void;
  onGhostClick?: (item: RoadmapItem) => void;
  /** Hovered roadmap step and its screen position (null when the pointer leaves it). */
  onRoadmapHover?: (item: RoadmapItem | null, screen: Point | null) => void;
  onCanvasClick?: () => void;
  /** Fired on drag end with the final position of the dragged node. */
  onNodeMoved?: (id: string, pos: Point) => void;
}

/** Nebula tones by sector order (neighbours differ), mixed from palette tokens only. */
const NEBULA_TONES: PaletteTone[] = [
  "mutedForeground",
  ["success", "mutedForeground", 0.55],
  ["warning", "success", 0.5],
  ["border", "foreground", 0.25],
  "warning",
  ["success", "border", 0.35],
  ["danger", "mutedForeground", 0.55],
  ["mutedForeground", "success", 0.3],
  ["warning", "danger", 0.4],
];
const UI_FONT = "'JetBrains Mono', monospace";
/** Minimum pick radius in screen px (dots are tiny). */
const MIN_HIT_PX = 8;
/** The nebula buffer is rendered at a fraction of the viewport (it is blurred anyway). */
const NEBULA_SCALE = 0.25;
/** Peak opacity of a region at full intensity (applied once, after the blur). */
const NEBULA_PEAK = 0.6;
/** Edge colour: a light grey-lavender hairline. */
const EDGE_TONE: PaletteTone = ["mutedForeground", "foreground", 0.4];
/** Links between sessions: spring factor and line opacity factor. */
const CROSS_SPRING = 0.08;
const CROSS_ALPHA = 0.3;
/** Extra world distance between the flower's right edge and the ⇶ Roteiro region (their nebulae must not touch). */
const ROADMAP_CLEARANCE = 120;
/** Roadmap labels are screen px; this maps the world-unit node label size onto them. */
const ROADMAP_LABEL_SCALE = 2.7;
/** Labels below this screen size are not drawn at all (unreadable dust). */
const MIN_LABEL_PX = 1.1;
/** Junctions repel less and sit closer, so premises visibly converge. */
const JUNCTION_REPULSION = 0.3;
const JUNCTION_LINK_FACTOR = 0.55;
const REPULSION_CUTOFF = 320;
/** Camera fit: screen band left free by the toolbar (top) and the composer (bottom). */
const FIT_TOP = 100;
const FIT_BOTTOM = 250;
const FIT_MAX_ZOOM = 1.4;

/** Node label wrapped in up to three short lines (whole words when possible). */
function labelLines(text: string, width = 18): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 3) {
    lines.length = 3;
    lines[2] = lines[2].length > width - 1 ? `${lines[2].slice(0, width - 1)}…` : `${lines[2]}…`;
  }
  return lines.map((l) => (l.length > width + 6 ? `${l.slice(0, width + 5)}…` : l));
}

export class GraphCanvasEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private callbacks: GraphCanvasCallbacks;
  private settings: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS };

  private nodes: CanvasNode[] = [];
  private junctions: JunctionBody[] = [];
  private bodies: Body[] = [];
  private links: CanvasLink[] = [];
  private nodeMap = new Map<string, CanvasNode>();
  private clusterLabels = new Map<string, string>();
  private clusterOrder: string[] = [];
  private clusters: ClusterGroup[] = [];
  /** ⇶ Roteiro constellations (empty = off). */
  private roadmap = new RoadmapLayer();
  private pinnedRoadmapId: string | null = null;
  private insetLeft = 0;
  private pulseFrame: number | null = null;
  private pulseLast = 0;
  private pulsePhase = 0.35;

  private nebula: HTMLCanvasElement | null = null;
  /** Per-cluster scratch buffer: the region is drawn opaque here, then blurred + tinted once. */
  private scratch: HTMLCanvasElement | null = null;
  /** Radial plan (sectors, depth rings, outer band) of the current data. */
  private plan: RadialPlan | null = null;
  private wiring: ConstellationWiring = { junctions: [], links: [] };
  private labelCache = new Map<string, string[]>();
  private labelWidth = new Map<string, number>();

  private selection = new Set<string>();
  private focusedId: string | null = null;
  private hoveredId: string | null = null;

  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private readonly minZoom = 0.15;
  private readonly maxZoom = 6;

  /** Camera follows the settling layout after resetView(), until the user pans/zooms/focuses. */
  private following = false;
  private panning = false;
  private draggedNode: CanvasNode | null = null;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private movedDistance = 0;

  private frame: number | null = null;
  private alpha = 1;
  private readonly alphaDecay = 0.015;
  private readonly alphaMin = 0.002;
  private running = false;

  constructor(canvas: HTMLCanvasElement, callbacks: GraphCanvasCallbacks = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Unable to obtain 2D canvas context");
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.bindEvents();
    this.resize();
  }

  // --- Data ------------------------------------------------------------------

  public setData(rawNodes: ConceptNode[], rawEdges: GraphEdge[], clusters: GraphCluster[], chains: LogicalChain[] = []) {
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    const prevJunctions = new Map(this.junctions.map((j) => [j.id, j]));

    const wiring = buildConstellation(rawNodes, rawEdges, chains);
    this.clusterOrder = clusters.map((c) => c.id);
    this.wiring = wiring;
    this.plan = this.buildPlan(rawNodes);
    const plan = this.plan;

    // Existing bodies keep their place (no jumps); persisted (dragged) ones are
    // fixed; new ones start on their ring inside their cluster's sector.
    this.nodeMap.clear();
    this.nodes = rawNodes.map((n) => {
      const old = prev.get(n.id);
      const persisted = typeof n.x === "number" && typeof n.y === "number";
      const seed = old ?? (persisted ? { x: n.x as number, y: n.y as number } : seedPosition(plan, n.id) ?? { x: 0, y: 0 });
      const node: CanvasNode = { ...n, x: seed.x, y: seed.y, vx: 0, vy: 0, fixed: persisted || (old?.fixed ?? false) };
      this.nodeMap.set(n.id, node);
      return node;
    });
    this.labelCache.clear();
    this.labelWidth.clear();

    this.junctions = wiring.junctions.map((j) => {
      const old = prevJunctions.get(j.id);
      const ends = [...j.premises, j.conclusion].map((id) => this.nodeMap.get(id)).filter((p): p is CanvasNode => !!p);
      const cx = ends.reduce((s, p) => s + p.x, 0) / Math.max(1, ends.length);
      const cy = ends.reduce((s, p) => s + p.y, 0) / Math.max(1, ends.length);
      const jitter = (k: number) => (unitHash(j.id, k) - 0.5) * 4;
      return {
        id: j.id,
        premises: j.premises,
        conclusion: j.conclusion,
        cluster: j.cluster,
        x: old?.x ?? cx + jitter(3),
        y: old?.y ?? cy + jitter(4),
        vx: 0,
        vy: 0,
        fixed: false,
      };
    });
    const bodyMap = new Map<string, Body>([...this.nodeMap, ...this.junctions.map((j) => [j.id, j] as const)]);
    this.bodies = [...this.nodes, ...this.junctions];
    this.links = [];
    for (const l of wiring.links) {
      const s = bodyMap.get(l.source);
      const t = bodyMap.get(l.target);
      if (s && t && s !== t) this.links.push({ source: s, target: t, kind: l.kind, cross: (s.cluster ?? "") !== (t.cluster ?? "") });
    }

    this.clusterLabels = new Map(clusters.map((c) => [c.id, c.label]));
    this.updateClusters();
    for (const id of [...this.selection]) if (!this.nodeMap.has(id)) this.selection.delete(id);
    if (this.focusedId && !this.nodeMap.has(this.focusedId)) this.focusedId = null;
    this.reheat(prev.size === 0 ? 1 : 0.5);
    this.start();
  }

  /** Radial plan of the current graph: derivation arcs = direct links + junction premise→conclusion pairs. */
  private buildPlan(nodes: readonly { id: string; cluster?: string }[]): RadialPlan {
    const arcs: RadialArc[] = [];
    for (const l of this.wiring.links) if (l.kind === "direct") arcs.push({ premise: l.source, conclusion: l.target });
    for (const j of this.wiring.junctions) for (const p of j.premises) arcs.push({ premise: p, conclusion: j.conclusion });
    const s = this.settings;
    return planRadial(nodes, this.wiring.junctions, arcs, {
      ringRadius: s.ringRadius,
      depthSpacing: s.depthSpacing,
      clusterOrder: this.clusterOrder,
    });
  }

  /** ⇶ Roteiro: the steps to draw (null/empty = off), their track tone and the galaxy order. */
  public setRoadmap(
    items: RoadmapItem[] | null,
    tone?: (item: RoadmapItem) => PaletteTone | null,
    opts: { trackOrder?: readonly string[]; defaultModuleTitle?: string } = {},
  ) {
    this.roadmap.setItems(items, tone ?? (() => null), opts);
    if (this.hoveredId && !this.nodeMap.has(this.hoveredId) && !this.roadmap.item(this.hoveredId)) this.hoveredId = null;
    this.updateRoadmapPlacement();
    this.syncPulse();
    this.requestRender();
  }

  /** Step whose card is pinned (drawn highlighted). */
  public setPinnedRoadmap(id: string | null) {
    this.pinnedRoadmapId = id;
    this.requestRender();
  }

  /** Frames the whole ⇶ Roteiro region. */
  public frameRoadmap() {
    const b = this.roadmap.layout?.bounds;
    if (!b) return;
    this.frameBox(b.x0, b.y0, b.x1, b.y1, 1.4);
  }

  /** Zooms into one module (labels of its steps become visible). */
  public frameModule(key: string) {
    const m = this.roadmap.module(key);
    if (!m) return;
    this.frameBox(m.x - m.r, m.y - m.r - 24, m.x + m.r, m.y + m.r + 24, Math.max(this.settings.labelZoom * 1.2, 2.4));
  }

  public frameTrack(trackId: string) {
    const g = this.roadmap.galaxyBounds(trackId);
    if (!g) return;
    this.frameBox(g.x0, g.y0, g.x1, g.y1, 2);
  }

  /** Screen px on the left covered by an overlay (the ⇶ Roteiro legend): fits avoid it. */
  public setInsetLeft(px: number) {
    this.insetLeft = Math.max(0, px);
  }

  private availW(width: number) {
    return Math.max(160, width - this.insetLeft);
  }

  private frameBox(x0: number, y0: number, x1: number, y1: number, maxZoom: number) {
    const { width, height } = this.viewport();
    const top = Math.min(FIT_TOP, height * 0.15);
    const bottom = Math.min(FIT_BOTTOM, height * 0.3);
    const availH = Math.max(120, height - top - bottom);
    const w = Math.max(x1 - x0 + 60, 120);
    const h = Math.max(y1 - y0 + 40, 100);
    this.following = false;
    this.zoom = Math.max(this.minZoom, Math.min(maxZoom, this.maxZoom, Math.min(this.availW(width) / w, availH / h)));
    this.panX = this.insetLeft + this.availW(width) / 2 - ((x0 + x1) / 2) * this.zoom;
    this.panY = top + availH / 2 - ((y0 + y1) / 2) * this.zoom;
    this.requestRender();
  }

  /** Screen position of a roadmap step (for the hover card). */
  public roadmapScreenPoint(id: string): Point | null {
    const p = this.roadmap.position(id);
    return p ? { x: p.x * this.zoom + this.panX, y: p.y * this.zoom + this.panY } : null;
  }

  private reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  /** Gentle pulse of the active steps: a throttled animation frame loop only while one is drawn. */
  private syncPulse() {
    const want = this.roadmap.enabled && this.roadmap.hasActive() && !this.reducedMotion();
    if (!want) {
      if (this.pulseFrame !== null) cancelAnimationFrame(this.pulseFrame);
      this.pulseFrame = null;
      this.pulsePhase = 0.35;
      return;
    }
    if (this.pulseFrame !== null) return;
    const tick = (now: number) => {
      this.pulseFrame = requestAnimationFrame(tick);
      if (now - this.pulseLast < 45) return;
      this.pulseLast = now;
      this.pulsePhase = (now % 2400) / 2400;
      if (!this.running) this.render();
    };
    this.pulseFrame = requestAnimationFrame(tick);
  }

  public setSettings(settings: GraphSettings) {
    const prev = this.settings;
    this.settings = settings;
    if (prev.ringRadius !== settings.ringRadius || prev.depthSpacing !== settings.depthSpacing) {
      this.plan = this.buildPlan(this.nodes);
    }
    const physics = GRAPH_SETTING_KEYS.some((k) => isLayoutSetting(k) && prev[k] !== settings[k]);
    if (physics) {
      this.reheat(0.6);
      this.start();
    } else {
      this.requestRender();
    }
  }

  public setSelection(ids: readonly string[]) {
    this.selection = new Set(ids);
    this.requestRender();
  }

  public setFocused(id: string | null) {
    this.focusedId = id;
    this.requestRender();
  }

  /** Centres the camera on a node (zooming in enough for its label and neighbours' labels). */
  public focusNode(id: string) {
    const node = this.nodeMap.get(id);
    if (!node) return;
    this.focusedId = id;
    this.following = false;
    this.zoom = Math.min(this.maxZoom, Math.max(this.zoom, this.settings.labelZoom));
    const { width, height } = this.viewport();
    this.panX = width / 2 - node.x * this.zoom;
    this.panY = height / 2 - node.y * this.zoom;
    this.requestRender();
  }

  public zoomIn() {
    const { width, height } = this.viewport();
    this.applyZoom(1.25, width / 2, height / 2);
  }

  public zoomOut() {
    const { width, height } = this.viewport();
    this.applyZoom(0.8, width / 2, height / 2);
  }

  /** Fits the whole graph and keeps it fitted while the layout settles (until the user moves the camera). */
  public resetView() {
    this.following = true;
    this.fitCamera();
    this.requestRender();
  }

  private fitCamera() {
    const { width, height } = this.viewport();
    const rb = this.roadmap.layout?.bounds;
    const points: Point[] = [
      ...this.nodes,
      ...(rb ? [{ x: rb.x0, y: rb.y0 }, { x: rb.x1, y: rb.y1 }] : []),
    ];
    if (points.length === 0) {
      this.zoom = 1;
      this.panX = width / 2;
      this.panY = height / 2;
      return;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // The toolbar covers the top and the composer dock the bottom: fit into the band between.
    const top = Math.min(FIT_TOP, height * 0.15);
    const bottom = Math.min(FIT_BOTTOM, height * 0.3);
    const availH = Math.max(120, height - top - bottom);
    const w = Math.max(maxX - minX + 80, 160);
    const h = Math.max(maxY - minY + 60, 120);
    // Capped below the label zoom: the overview reads as a star map, labels come on zoom/hover.
    const cap = Math.min(FIT_MAX_ZOOM, this.settings.labelZoom * 0.9);
    // Session names hang off the petal tips (screen-sized): keep room for them at the sides.
    const pad = this.settings.clusterLabels >= 1 ? Math.min(150, this.availW(width) * 0.12) : 0;
    this.zoom = Math.max(this.minZoom, Math.min(cap, Math.min((this.availW(width) - 2 * pad) / w, availH / h)));
    this.panX = this.insetLeft + this.availW(width) / 2 - ((minX + maxX) / 2) * this.zoom;
    this.panY = top + availH / 2 - ((minY + maxY) / 2) * this.zoom;
  }

  public resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    if (this.panX === 0 && this.panY === 0) {
      this.panX = rect.width / 2;
      this.panY = rect.height / 2;
    }
    this.requestRender();
  }

  public destroy() {
    this.stop();
    if (this.pulseFrame !== null) cancelAnimationFrame(this.pulseFrame);
    this.pulseFrame = null;
    this.unbindEvents();
  }

  // --- Simulation ------------------------------------------------------------

  private viewport() {
    const dpr = window.devicePixelRatio || 1;
    return { width: this.canvas.width / dpr, height: this.canvas.height / dpr };
  }

  private reheat(amount: number) {
    this.alpha = Math.max(this.alpha, amount);
  }

  private start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      if (this.alpha > this.alphaMin) {
        this.step();
        this.alpha *= 1 - this.alphaDecay;
        if (this.following) this.fitCamera();
        this.render();
        this.frame = requestAnimationFrame(loop);
      } else {
        // Cooled down: stop the loop; interactions render on demand.
        this.running = false;
        this.frame = null;
        this.render();
      }
    };
    this.frame = requestAnimationFrame(loop);
  }

  private stop() {
    this.running = false;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private step() {
    const s = this.settings;
    const kRepel = s.repulsion * this.alpha;
    const damping = 1 - s.friction;
    const bodies = this.bodies;
    const n = bodies.length;
    const realCount = this.nodes.length;
    const cutoff2 = REPULSION_CUTOFF * REPULSION_CUTOFF;

    for (let i = 0; i < n; i++) {
      const a = bodies[i];
      const wa = i < realCount ? 1 : JUNCTION_REPULSION;
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 1;
        if (d2 > cutoff2) continue;
        const d = Math.sqrt(d2);
        const f = (kRepel * wa * (j < realCount ? 1 : JUNCTION_REPULSION)) / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const e of this.links) {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = e.kind === "direct" ? s.linkDistance : s.linkDistance * JUNCTION_LINK_FACTOR;
      // Springs cool with alpha like every other force, so the radial rings win at rest.
      const f = (d - rest) * s.attraction * this.alpha * (e.cross ? CROSS_SPRING : 1);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      e.source.vx += fx;
      e.source.vy += fy;
      e.target.vx -= fx;
      e.target.vy -= fy;
    }

    if (this.plan) {
      applyRadialForces(
        bodies,
        this.plan,
        { depthStrength: s.depthStrength, clusterPull: s.clusterCohesion, centerPull: s.centerGravity },
        this.alpha,
      );
    }

    for (const body of bodies) {
      if (body.fixed || body === this.draggedNode) {
        body.vx = 0;
        body.vy = 0;
        continue;
      }
      body.vx *= damping;
      body.vy *= damping;
      body.x += body.vx;
      body.y += body.vy;
    }
    this.updateClusters();
  }

  private updateClusters() {
    const groups = new Map<string, { nodes: CanvasNode[]; junctions: JunctionBody[] }>();
    const group = (id: string) => {
      let g = groups.get(id);
      if (!g) {
        g = { nodes: [], junctions: [] };
        groups.set(id, g);
      }
      return g;
    };
    for (const node of this.nodes) if (node.cluster) group(node.cluster).nodes.push(node);
    for (const j of this.junctions) if (j.cluster && groups.has(j.cluster)) group(j.cluster).junctions.push(j);
    const clusters: ClusterGroup[] = [];
    let fallback = this.clusterOrder.length;
    for (const [id, members] of groups) {
      const { nodes } = members;
      if (nodes.length === 0) continue;
      // The label sits on the petal (connected nodes), not pulled out by the outer band.
      const core = nodes.filter((m) => !this.plan?.isolated.has(m.id));
      const pts = core.length > 0 ? core : nodes;
      let cx = 0;
      let cy = 0;
      for (const m of pts) {
        cx += m.x;
        cy += m.y;
      }
      const sector = this.plan?.sectors.get(id);
      const index = sector?.index ?? fallback++;
      const centroid = { x: cx / pts.length, y: cy / pts.length };
      let labelAt = centroid;
      let labelDir = { x: 0, y: -1 };
      if (sector) {
        const radii = pts.map((m) => Math.hypot(m.x, m.y)).sort((a, b) => a - b);
        const rim = radii[Math.floor((radii.length - 1) * 0.85)] ?? 0;
        labelDir = { x: Math.cos(sector.mid), y: Math.sin(sector.mid) };
        labelAt = { x: labelDir.x * rim, y: labelDir.y * rim };
      }
      clusters.push({
        id,
        label: this.clusterLabels.get(id) ?? id,
        nodes,
        junctions: members.junctions,
        centroid,
        labelAt,
        labelDir,
        tone: NEBULA_TONES[index % NEBULA_TONES.length],
      });
    }
    this.clusters = clusters;
    this.updateRoadmapPlacement();
  }

  /** Keeps the roadmap region beside the (settling) graph. */
  private updateRoadmapPlacement() {
    if (!this.roadmap.enabled) return;
    if (this.nodes.length === 0) {
      this.roadmap.place(null);
      return;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x);
      y1 = Math.max(y1, n.y);
    }
    this.roadmap.place({ x0, y0, x1: x1 + ROADMAP_CLEARANCE, y1 });
  }

  // --- Rendering -------------------------------------------------------------

  public requestRender() {
    if (!this.running) this.render();
  }

  /** Dot radius in world units: grows gently (√zoom) on screen when zooming in. */
  private dotRadius() {
    return this.settings.nodeSize / Math.sqrt(this.zoom);
  }

  /** Hairline width in world units (≈ constant on screen, slightly thicker when zoomed in). */
  private lineWidth(scale = 1) {
    return (this.settings.edgeWidth * scale * Math.pow(this.zoom, 0.25)) / this.zoom;
  }

  private render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.renderNebulae(ctx);

    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
    const hot = this.hotState();
    this.renderClusterLabels(ctx);
    if (this.roadmap.enabled) {
      const s = this.settings;
      this.roadmap.draw(ctx, {
        zoom: this.zoom,
        nodeSize: s.nodeSize,
        edgeWidth: s.edgeWidth,
        labelSize: s.labelSize * ROADMAP_LABEL_SCALE,
        labelZoom: s.labelZoom,
        regionIntensity: s.regionIntensity,
        hoveredId: this.hoveredId,
        pinnedId: this.pinnedRoadmapId,
        pulse: this.pulsePhase,
        nodePos: (id) => this.nodeMap.get(id) ?? null,
      });
    }
    this.renderLinks(ctx, hot);
    this.renderNodes(ctx, hot);
  }

  /**
   * Soft colour cloud per cluster, drawn in screen space from a low-res buffer:
   * the cluster's nodes and edges are dilated into an opaque silhouette on a
   * scratch buffer, which is then blurred and tinted ONCE onto the nebula buffer
   * (no alpha build-up inside a cluster; overlapping clusters blend).
   */
  private renderNebulae(ctx: CanvasRenderingContext2D) {
    const intensity = this.settings.regionIntensity;
    if (intensity <= 0 || (this.clusters.length === 0 && !this.roadmap.enabled)) return;
    const { width, height } = this.viewport();
    const bw = Math.max(1, Math.ceil(width * NEBULA_SCALE));
    const bh = Math.max(1, Math.ceil(height * NEBULA_SCALE));
    const fit = (c: HTMLCanvasElement | null) => {
      const buf = c ?? document.createElement("canvas");
      if (buf.width !== bw || buf.height !== bh) {
        buf.width = bw;
        buf.height = bh;
      }
      return buf;
    };
    this.nebula = fit(this.nebula);
    this.scratch = fit(this.scratch);
    const o = this.nebula.getContext("2d");
    const sc = this.scratch.getContext("2d");
    if (!o || !sc) return;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.filter = "none";
    o.globalAlpha = 1;
    o.clearRect(0, 0, bw, bh);
    const k = NEBULA_SCALE * this.zoom;
    const supportsFilter = typeof o.filter === "string";
    const blurPx = Math.max(1.5, this.settings.regionBlur * k);
    const dilation = this.settings.regionDilation;

    const byCluster = new Map<string, CanvasLink[]>();
    for (const l of this.links) {
      const c = l.target.cluster ?? l.source.cluster;
      if (!c || (l.source.cluster && l.source.cluster !== c)) continue;
      if (!byCluster.has(c)) byCluster.set(c, []);
      byCluster.get(c)!.push(l);
    }
    for (const c of this.clusters) {
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.clearRect(0, 0, bw, bh);
      sc.setTransform(k, 0, 0, k, this.panX * NEBULA_SCALE, this.panY * NEBULA_SCALE);
      const colour = toneAlpha(c.tone, 1);
      sc.strokeStyle = colour;
      sc.fillStyle = colour;
      sc.lineCap = "round";
      sc.lineWidth = dilation * 1.6;
      sc.beginPath();
      for (const l of byCluster.get(c.id) ?? []) {
        sc.moveTo(l.source.x, l.source.y);
        sc.lineTo(l.target.x, l.target.y);
      }
      sc.stroke();
      sc.beginPath();
      for (const p of c.nodes) {
        const r = this.plan?.isolated.has(p.id) ? dilation * 0.45 : dilation;
        sc.moveTo(p.x + r, p.y);
        sc.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      sc.fill();
      o.globalAlpha = Math.min(1, intensity * NEBULA_PEAK);
      if (supportsFilter) o.filter = `blur(${blurPx}px)`;
      o.drawImage(this.scratch, 0, 0);
      o.filter = "none";
    }
    o.globalAlpha = 1;
    o.setTransform(k, 0, 0, k, this.panX * NEBULA_SCALE, this.panY * NEBULA_SCALE);
    this.roadmap.drawNebulae(o, intensity, blurPx, supportsFilter);
    o.filter = "none";
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.nebula, 0, 0, bw, bh, 0, 0, bw / NEBULA_SCALE, bh / NEBULA_SCALE);
    ctx.restore();
  }

  /** Session names at the outer tip of their petals: screen-sized, fading out as node labels become legible. */
  private renderClusterLabels(ctx: CanvasRenderingContext2D) {
    const s = this.settings;
    if (s.clusterLabels < 1) return;
    const fade = Math.max(0, Math.min(1, 1.6 - this.zoom / (s.labelZoom * 0.5)));
    if (fade <= 0.02) return;
    const size = s.clusterLabelSize / this.zoom;
    ctx.save();
    ctx.font = `500 ${size}px ${UI_FONT}`;
    ctx.fillStyle = withAlpha("foreground", 0.55 * fade);
    const push = 14 / this.zoom;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    // Largest sessions first; a name that would overlap one already drawn is skipped.
    for (const c of [...this.clusters].sort((a, b) => b.nodes.length - a.nodes.length)) {
      if (c.nodes.length < 3 || !c.label) continue;
      const label = c.label.length > 34 ? `${c.label.slice(0, 33)}…` : c.label;
      const text = label.toUpperCase().split("").join(String.fromCharCode(0x200a));
      const { x: dx, y: dy } = c.labelDir;
      // The text starts at the petal tip and grows outward; on the right side it
      // grows inward while ⇶ Roteiro occupies that side.
      const inward = dx > 0.35 && this.roadmap.enabled;
      ctx.textAlign = dx > 0.35 ? (inward ? "right" : "left") : dx < -0.35 ? "right" : "center";
      ctx.textBaseline = dy > 0.35 ? "top" : dy < -0.35 ? "bottom" : "middle";
      const k = inward ? -push : push;
      const x = c.labelAt.x + dx * k;
      const y = c.labelAt.y + dy * k;
      const w = ctx.measureText(text).width;
      const x0 = ctx.textAlign === "left" ? x : ctx.textAlign === "right" ? x - w : x - w / 2;
      const y0 = ctx.textBaseline === "top" ? y : ctx.textBaseline === "bottom" ? y - size : y - size / 2;
      const box = { x0, y0, x1: x0 + w, y1: y0 + size };
      if (placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1 && p.y0 < box.y1 && box.y0 < p.y1)) continue;
      placed.push(box);
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }

  private isActive(id: string) {
    return id === this.focusedId || id === this.hoveredId || this.selection.has(id);
  }

  /** Links touching an active node (through junctions too) and the nodes they reach. */
  private hotState() {
    const links = new Set<CanvasLink>();
    const nodes = new Set<string>();
    const anyActive = this.hoveredId !== null || this.focusedId !== null || this.selection.size > 0;
    if (!anyActive) return { links, nodes, dim: false };
    const hotJunctions = new Set<string>();
    for (const j of this.junctions) {
      if (this.isActive(j.conclusion) || j.premises.some((p) => this.isActive(p))) hotJunctions.add(j.id);
    }
    for (const l of this.links) {
      if (this.isActive(l.source.id) || this.isActive(l.target.id) || hotJunctions.has(l.source.id) || hotJunctions.has(l.target.id)) {
        links.add(l);
        nodes.add(l.source.id);
        nodes.add(l.target.id);
      }
    }
    // Hover/focus dims the rest; a multi-selection alone keeps the map readable.
    const spot = (id: string | null) => id !== null && this.nodeMap.has(id);
    return { links, nodes, dim: spot(this.hoveredId) || spot(this.focusedId) };
  }

  private renderLinks(ctx: CanvasRenderingContext2D, hot: ReturnType<GraphCanvasEngine["hotState"]>) {
    const alpha = this.settings.edgeAlpha * (hot.dim ? 0.55 : 1);
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = toneAlpha(EDGE_TONE, alpha);
    ctx.lineWidth = this.lineWidth();
    for (const cross of [false, true]) {
      if (cross) ctx.strokeStyle = toneAlpha(EDGE_TONE, alpha * CROSS_ALPHA);
      ctx.beginPath();
      for (const l of this.links) {
        if (l.cross !== cross || hot.links.has(l)) continue;
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
      }
      ctx.stroke();
    }
    if (hot.links.size > 0) {
      ctx.strokeStyle = withAlpha("foreground", 0.85);
      ctx.lineWidth = this.lineWidth(1.4);
      ctx.beginPath();
      for (const l of hot.links) {
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderNodes(ctx: CanvasRenderingContext2D, hot: ReturnType<GraphCanvasEngine["hotState"]>) {
    const r = this.dotRadius();
    const px = 1 / this.zoom;
    const labels: NodeLabel[] = [];
    for (const node of this.nodes) {
      const focused = node.id === this.focusedId;
      const hovered = node.id === this.hoveredId;
      const selected = this.selection.has(node.id);
      const active = focused || hovered || selected;
      const near = hot.nodes.has(node.id);
      const dimmed = hot.dim && !active && !near;

      if (focused) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 6 * px, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha("foreground", 0.08);
        ctx.fill();
      }
      if (selected || focused) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 3 * px, 0, Math.PI * 2);
        ctx.strokeStyle = selected ? palette.success : withAlpha("foreground", 0.7);
        ctx.lineWidth = px;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, active ? r * 1.25 : r, 0, Math.PI * 2);
      ctx.fillStyle = active || near ? palette.foreground : withAlpha("foreground", dimmed ? 0.4 : 0.9);
      ctx.fill();

      labels.push({ node, rank: active ? 0 : near ? 1 : dimmed ? 3 : 2, hot: active, dimmed });
    }
    this.renderNodeLabels(ctx, labels, r);
  }

  /** Wrapped label lines and their widest line at a 10px reference font (cached per node). */
  private measuredLabel(ctx: CanvasRenderingContext2D, node: CanvasNode) {
    let lines = this.labelCache.get(node.id);
    if (!lines) {
      lines = labelLines(node.name);
      this.labelCache.set(node.id, lines);
    }
    let width = this.labelWidth.get(node.id);
    if (width === undefined) {
      ctx.save();
      ctx.font = `400 10px ${UI_FONT}`;
      width = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
      ctx.restore();
      this.labelWidth.set(node.id, width);
    }
    return { lines, width };
  }

  /**
   * Labels under the dots, in priority order (active, neighbours, rest). Every
   * node gets one: world-sized micro text at overview (dropped below ~1px), full
   * contrast from the label zoom; active labels keep a legible minimum size. A
   * label that would overlap an already placed one is skipped.
   */
  private renderNodeLabels(ctx: CanvasRenderingContext2D, labels: NodeLabel[], r: number) {
    if (labels.length === 0) return;
    labels.sort((a, b) => a.rank - b.rank);
    const s = this.settings;
    const microPx = s.labelSize * this.zoom;
    const crisp = Math.max(0, Math.min(1, (this.zoom - s.labelZoom * 0.4) / (s.labelZoom * 0.6)));
    const gap = 1.5 / this.zoom;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const l of labels) {
      if (!l.hot && microPx < MIN_LABEL_PX) continue;
      const size = l.hot ? Math.max(s.labelSize, 11 / this.zoom) : s.labelSize;
      const { lines, width } = this.measuredLabel(ctx, l.node);
      const w = (width * size) / 10;
      const top = l.node.y + r + size * 0.35;
      const lineH = size * 1.15;
      const box = { x0: l.node.x - w / 2 - gap, y0: top - gap, x1: l.node.x + w / 2 + gap, y1: top + lines.length * lineH + gap };
      if (!l.hot && placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1 && p.y0 < box.y1 && box.y0 < p.y1)) continue;
      placed.push(box);
      ctx.font = `${l.hot ? 500 : 400} ${size}px ${UI_FONT}`;
      ctx.fillStyle = l.hot
        ? palette.foreground
        : withAlpha("mutedForeground", (l.dimmed ? 0.35 : 0.45 + 0.4 * crisp) * (l.rank === 1 ? 1.15 : 1));
      lines.forEach((line, i) => ctx.fillText(line, l.node.x, top + i * lineH));
    }
    ctx.restore();
  }

  // --- Coordinates & picking -------------------------------------------------

  public screenToWorld(sx: number, sy: number): Point {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  private hitRadius(scale = 1) {
    return Math.max(this.dotRadius() * scale + 2 / this.zoom, MIN_HIT_PX / this.zoom);
  }

  /** Nearest real node within the hit radius (junctions are never pickable). */
  private pickNode(sx: number, sy: number): CanvasNode | null {
    const w = this.screenToWorld(sx, sy);
    const hit = this.hitRadius();
    let best: CanvasNode | null = null;
    let bestD = hit * hit;
    for (const n of this.nodes) {
      const d = (w.x - n.x) ** 2 + (w.y - n.y) ** 2;
      if (d <= bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private pickGhost(sx: number, sy: number): RoadmapItem | null {
    if (!this.roadmap.enabled) return null;
    return this.roadmap.pickItem(this.screenToWorld(sx, sy), this.hitRadius(2.2));
  }

  /** Hover state changed: tell the caller which roadmap step (if any) is under the pointer. */
  private emitRoadmapHover() {
    const item = this.hoveredId ? this.roadmap.item(this.hoveredId) : null;
    this.callbacks.onRoadmapHover?.(item, item ? this.roadmapScreenPoint(item.id) : null);
  }

  private applyZoom(factor: number, ox: number, oy: number) {
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    if (z === this.zoom) return;
    if (this.hoveredId && this.roadmap.item(this.hoveredId)) {
      this.hoveredId = null;
      this.emitRoadmapHover();
    }
    this.following = false;
    this.panX = ox - (ox - this.panX) * (z / this.zoom);
    this.panY = oy - (oy - this.panY) * (z / this.zoom);
    this.zoom = z;
    this.requestRender();
  }

  // --- Events ----------------------------------------------------------------

  private local(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    this.lastMouseX = x;
    this.lastMouseY = y;
    this.movedDistance = 0;
    const hit = this.pickNode(x, y);
    if (hit) {
      this.draggedNode = hit;
    } else {
      this.panning = true;
    }
    this.canvas.style.cursor = "grabbing";
  };

  private handleMouseMove = (e: MouseEvent) => {
    const { x, y } = this.local(e);
    const dx = x - this.lastMouseX;
    const dy = y - this.lastMouseY;
    this.lastMouseX = x;
    this.lastMouseY = y;

    if (this.draggedNode) {
      this.movedDistance += Math.abs(dx) + Math.abs(dy);
      if (this.movedDistance < 4) return;
      this.draggedNode.x += dx / this.zoom;
      this.draggedNode.y += dy / this.zoom;
      this.draggedNode.fixed = true;
      this.following = false;
      this.updateClusters();
      this.reheat(0.25);
      this.start();
      this.requestRender();
      return;
    }
    if (this.panning) {
      this.movedDistance += Math.abs(dx) + Math.abs(dy);
      if (this.movedDistance < 4) return;
      this.following = false;
      this.panX += dx;
      this.panY += dy;
      if (this.hoveredId !== null) {
        this.hoveredId = null;
        this.emitRoadmapHover();
      }
      this.requestRender();
      return;
    }
    if (e.target !== this.canvas) {
      if (this.hoveredId !== null) {
        this.hoveredId = null;
        this.emitRoadmapHover();
        this.requestRender();
      }
      return;
    }
    const node = this.pickNode(x, y);
    const hovered = node?.id ?? this.pickGhost(x, y)?.id ?? null;
    const overLabel = !hovered && this.roadmap.enabled && this.roadmap.pickLabel(this.screenToWorld(x, y)) !== null;
    if (hovered !== this.hoveredId) {
      this.hoveredId = hovered;
      this.emitRoadmapHover();
      this.requestRender();
    }
    this.canvas.style.cursor = hovered || overLabel ? "pointer" : "default";
  };

  private handleMouseUp = (e: MouseEvent) => {
    const dragged = this.draggedNode;
    const wasPanning = this.panning;
    this.draggedNode = null;
    this.panning = false;
    if (!dragged && !wasPanning) return;
    this.canvas.style.cursor = this.hoveredId ? "pointer" : "default";

    if (this.movedDistance >= 4) {
      if (dragged) this.callbacks.onNodeMoved?.(dragged.id, { x: dragged.x, y: dragged.y });
      return;
    }
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (dragged) {
      if (!additive) this.focusedId = dragged.id;
      this.callbacks.onNodeClick?.(dragged, additive);
      this.requestRender();
      return;
    }
    const { x, y } = this.local(e);
    const ghost = this.pickGhost(x, y);
    if (ghost) {
      this.callbacks.onGhostClick?.(ghost);
      return;
    }
    const label = this.roadmap.enabled ? this.roadmap.pickLabel(this.screenToWorld(x, y)) : null;
    if (label) {
      if (label.kind === "module") this.frameModule(label.key);
      else this.frameTrack(label.key);
      return;
    }
    this.focusedId = null;
    this.callbacks.onCanvasClick?.();
    this.requestRender();
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { x, y } = this.local(e);
    this.applyZoom(e.deltaY < 0 ? 1.1 : 0.9, x, y);
  };

  private bindEvents() {
    this.canvas.addEventListener("mousedown", this.handleMouseDown);
    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("mouseup", this.handleMouseUp);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  private unbindEvents() {
    this.canvas.removeEventListener("mousedown", this.handleMouseDown);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);
    this.canvas.removeEventListener("wheel", this.handleWheel);
  }
}
