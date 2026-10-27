/**
 * 2D Canvas knowledge-graph engine — "constellation" look.
 *
 * - tiny dot nodes joined by hairline straight threads (no arrowheads);
 * - chains with ≥ 2 premises meet at a virtual junction point before the
 *   conclusion (lib/graph-wire `buildConstellation`), which gives the branching,
 *   tree-like shape; junctions take part in the physics but are never drawn as
 *   nodes, labelled, picked or counted;
 * - one soft blurred nebula per cluster (birth session) behind its nodes;
 * - small unboxed labels from a zoom threshold (hovered/selected/focused always);
 * - hover brightens a node and its threads, the rest dims slightly;
 * - multi-selection ring (Shift/⌘-click toggles, plain click focuses);
 * - dragging pins a node and reports its position (persisted by the caller);
 * - optional roadmap ghost nodes (hollow, dashed) linked to real nodes.
 *
 * Colours come only from lib/palette (graphite skin).
 */

import { palette, toneAlpha, withAlpha, type PaletteTone } from "@/lib/palette";
import { layoutGhosts, type Point } from "@/lib/ghost-layout";
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from "@/lib/graph-settings";
import { buildConstellation, type ConstellationLink } from "@/lib/graph-wire";
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
}

interface ClusterGroup {
  id: string;
  label: string;
  nodes: CanvasNode[];
  junctions: JunctionBody[];
  centroid: Point;
  top: number;
  tone: PaletteTone;
}

export interface GraphCanvasCallbacks {
  /** Plain click (additive=false) or Shift/⌘/Ctrl-click (additive=true) on a node. */
  onNodeClick?: (node: ConceptNode, additive: boolean) => void;
  onGhostClick?: (item: RoadmapItem) => void;
  onCanvasClick?: () => void;
  /** Fired on drag end with the final position of the dragged node. */
  onNodeMoved?: (id: string, pos: Point) => void;
}

/** Nebula tones cycle through the palette (very low alpha), never off-token colours. */
const NEBULA_TONES: PaletteTone[] = [
  "success",
  "warning",
  "danger",
  "mutedForeground",
  ["success", "warning", 0.5],
  ["danger", "foreground", 0.45],
  ["warning", "danger", 0.5],
  ["success", "foreground", 0.5],
];
const UI_FONT = "'JetBrains Mono', monospace";
/** Minimum pick radius in screen px (dots are tiny). */
const MIN_HIT_PX = 8;
/** Nebula geometry in world units. */
const NEBULA_RADIUS = 26;
const NEBULA_CORE_RADIUS = 12;
const NEBULA_BLUR = 22;
/** The nebula buffer is rendered at a fraction of the viewport (it is blurred anyway). */
const NEBULA_SCALE = 0.25;
/** Junctions repel less and sit closer, so premises visibly converge. */
const JUNCTION_REPULSION = 0.3;
const JUNCTION_LINK_FACTOR = 0.55;
const REPULSION_CUTOFF = 320;
/** Camera fit: screen band left free by the toolbar (top) and the composer (bottom). */
const FIT_TOP = 100;
const FIT_BOTTOM = 250;
const FIT_MAX_ZOOM = 1.4;

const shortLabel = (text: string) => (text.length > 36 ? `${text.slice(0, 35)}…` : text);

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
  private ghosts: RoadmapItem[] = [];
  private ghostPos = new Map<string, Point>();

  private nebula: HTMLCanvasElement | null = null;

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

    // Seed new nodes around one anchor per cluster so sessions start apart.
    const clusterIds = [...new Set(rawNodes.map((n) => n.cluster ?? ""))];
    const anchorRadius = 70 * Math.sqrt(Math.max(1, clusterIds.length));
    const anchors = new Map<string, Point>(
      clusterIds.map((id, i) => {
        const a = (i / Math.max(1, clusterIds.length)) * Math.PI * 2;
        return [id, clusterIds.length > 1 ? { x: Math.cos(a) * anchorRadius, y: Math.sin(a) * anchorRadius } : { x: 0, y: 0 }];
      }),
    );
    const seeded = new Map<string, number>();

    this.nodeMap.clear();
    this.nodes = rawNodes.map((n) => {
      const old = prev.get(n.id);
      const persisted = typeof n.x === "number" && typeof n.y === "number";
      let x: number;
      let y: number;
      if (old) {
        x = old.x;
        y = old.y;
      } else if (persisted) {
        x = n.x as number;
        y = n.y as number;
      } else {
        // Sunflower spiral around the cluster anchor (jitter breaks symmetric states).
        const anchor = anchors.get(n.cluster ?? "") ?? { x: 0, y: 0 };
        const k = seeded.get(n.cluster ?? "") ?? 0;
        seeded.set(n.cluster ?? "", k + 1);
        const angle = k * 2.399;
        const radius = 12 * Math.sqrt(k + 1);
        x = anchor.x + Math.cos(angle) * radius + (Math.random() - 0.5) * 6;
        y = anchor.y + Math.sin(angle) * radius + (Math.random() - 0.5) * 6;
      }
      const node: CanvasNode = { ...n, x, y, vx: 0, vy: 0, fixed: persisted || (old?.fixed ?? false) };
      this.nodeMap.set(n.id, node);
      return node;
    });

    const wiring = buildConstellation(rawNodes, rawEdges, chains);
    this.junctions = wiring.junctions.map((j) => {
      const old = prevJunctions.get(j.id);
      const ends = [...j.premises, j.conclusion].map((id) => this.nodeMap.get(id)).filter((p): p is CanvasNode => !!p);
      const cx = ends.reduce((s, p) => s + p.x, 0) / Math.max(1, ends.length);
      const cy = ends.reduce((s, p) => s + p.y, 0) / Math.max(1, ends.length);
      return {
        id: j.id,
        premises: j.premises,
        conclusion: j.conclusion,
        cluster: j.cluster,
        x: old?.x ?? cx + (Math.random() - 0.5) * 4,
        y: old?.y ?? cy + (Math.random() - 0.5) * 4,
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
      if (s && t && s !== t) this.links.push({ source: s, target: t, kind: l.kind });
    }

    this.clusterLabels = new Map(clusters.map((c) => [c.id, c.label]));
    this.clusterOrder = clusters.map((c) => c.id);
    this.updateClusters();
    for (const id of [...this.selection]) if (!this.nodeMap.has(id)) this.selection.delete(id);
    if (this.focusedId && !this.nodeMap.has(this.focusedId)) this.focusedId = null;
    this.reheat(prev.size === 0 ? 1 : 0.5);
    this.start();
  }

  public setGhosts(items: RoadmapItem[] | null) {
    this.ghosts = items ?? [];
    this.updateGhostLayout();
    this.requestRender();
  }

  public setSettings(settings: GraphSettings) {
    this.settings = settings;
    this.reheat(0.6);
    this.start();
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
    const points: Point[] = [...this.nodes, ...this.ghostPos.values()];
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
    this.zoom = Math.max(this.minZoom, Math.min(cap, Math.min(width / w, availH / h)));
    this.panX = width / 2 - ((minX + maxX) / 2) * this.zoom;
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
    const kCenter = s.centerGravity * this.alpha;
    const kCluster = s.clusterCohesion * this.alpha;
    const damping = 0.82;
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
      const f = (d - rest) * s.attraction;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      e.source.vx += fx;
      e.source.vy += fy;
      e.target.vx -= fx;
      e.target.vy -= fy;
    }

    for (const c of this.clusters) {
      if (c.nodes.length < 2) continue;
      for (const body of [...c.nodes, ...c.junctions]) {
        body.vx += (c.centroid.x - body.x) * kCluster;
        body.vy += (c.centroid.y - body.y) * kCluster;
      }
    }

    for (const body of bodies) {
      if (body.fixed || body === this.draggedNode) {
        body.vx = 0;
        body.vy = 0;
        continue;
      }
      body.vx = (body.vx - body.x * kCenter) * damping;
      body.vy = (body.vy - body.y * kCenter) * damping;
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
      let cx = 0;
      let cy = 0;
      let top = Infinity;
      for (const m of nodes) {
        cx += m.x;
        cy += m.y;
        top = Math.min(top, m.y);
      }
      const order = this.clusterOrder.indexOf(id);
      clusters.push({
        id,
        label: this.clusterLabels.get(id) ?? id,
        nodes,
        junctions: members.junctions,
        centroid: { x: cx / nodes.length, y: cy / nodes.length },
        top,
        tone: NEBULA_TONES[(order >= 0 ? order : fallback++) % NEBULA_TONES.length],
      });
    }
    this.clusters = clusters;
    this.updateGhostLayout();
  }

  private updateGhostLayout() {
    if (this.ghosts.length === 0) {
      this.ghostPos = new Map();
      return;
    }
    this.ghostPos = layoutGhosts(this.ghosts, this.nodeMap, {
      offset: 60,
      columnGap: 120,
      rowGap: 36,
    });
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
    this.renderGhostEdges(ctx);
    this.renderLinks(ctx, hot);
    this.renderGhosts(ctx);
    this.renderNodes(ctx, hot);
  }

  /** Soft blurred colour cloud per cluster, drawn in screen space from a low-res buffer. */
  private renderNebulae(ctx: CanvasRenderingContext2D) {
    const intensity = this.settings.regionIntensity;
    if (intensity <= 0 || this.clusters.length === 0) return;
    const { width, height } = this.viewport();
    const bw = Math.max(1, Math.ceil(width * NEBULA_SCALE));
    const bh = Math.max(1, Math.ceil(height * NEBULA_SCALE));
    if (!this.nebula) this.nebula = document.createElement("canvas");
    const buf = this.nebula;
    if (buf.width !== bw || buf.height !== bh) {
      buf.width = bw;
      buf.height = bh;
    }
    const o = buf.getContext("2d");
    if (!o) return;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.filter = "none";
    o.clearRect(0, 0, bw, bh);
    const k = NEBULA_SCALE * this.zoom;
    o.setTransform(k, 0, 0, k, this.panX * NEBULA_SCALE, this.panY * NEBULA_SCALE);
    const supportsFilter = typeof o.filter === "string";
    const blurPx = Math.max(1.5, NEBULA_BLUR * k);

    const layers: [number, number][] = [
      [NEBULA_RADIUS, 0.2],
      [NEBULA_CORE_RADIUS, 0.12],
    ];
    for (const c of this.clusters) {
      for (const [radius, alpha] of layers) {
        if (supportsFilter) {
          // One union path per cluster: no alpha build-up inside a cluster; the blur makes it a cloud.
          o.filter = `blur(${blurPx}px)`;
          o.beginPath();
          for (const p of c.nodes) {
            o.moveTo(p.x + radius, p.y);
            o.arc(p.x, p.y, radius, 0, Math.PI * 2);
          }
          o.fillStyle = toneAlpha(c.tone, alpha * intensity);
          o.fill();
        } else {
          // Fallback without canvas filters: layered radial gradients.
          for (const p of c.nodes) {
            const r = radius * 2;
            const g = o.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
            g.addColorStop(0, toneAlpha(c.tone, (alpha * intensity) / 2));
            g.addColorStop(1, toneAlpha(c.tone, 0));
            o.fillStyle = g;
            o.fillRect(p.x - r, p.y - r, r * 2, r * 2);
          }
        }
      }
    }
    o.filter = "none";
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buf, 0, 0, bw, bh, 0, 0, bw / NEBULA_SCALE, bh / NEBULA_SCALE);
    ctx.restore();
  }

  private renderClusterLabels(ctx: CanvasRenderingContext2D) {
    if (this.settings.regionIntensity <= 0 || this.zoom < 0.3) return;
    const size = 9 / this.zoom;
    ctx.save();
    ctx.font = `500 ${size}px ${UI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = withAlpha("mutedForeground", 0.3 + 0.25 * this.settings.regionIntensity);
    for (const c of this.clusters) {
      if (c.nodes.length < 3 || !c.label) continue;
      const label = c.label.length > 40 ? `${c.label.slice(0, 39)}…` : c.label;
      const text = label.toUpperCase().split("").join(String.fromCharCode(0x200a));
      ctx.fillText(text, c.centroid.x, c.top - 14 / this.zoom);
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
    const base = withAlpha("mutedForeground", hot.dim ? 0.22 : 0.4);
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = base;
    ctx.lineWidth = this.lineWidth();
    ctx.beginPath();
    for (const l of this.links) {
      if (hot.links.has(l)) continue;
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
    }
    ctx.stroke();
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

  private renderGhostEdges(ctx: CanvasRenderingContext2D) {
    if (this.ghosts.length === 0) return;
    ctx.save();
    ctx.setLineDash([3 / this.zoom, 3 / this.zoom]);
    ctx.lineWidth = this.lineWidth(0.9);
    ctx.strokeStyle = withAlpha("mutedForeground", 0.45);
    ctx.beginPath();
    for (const g of this.ghosts) {
      const gp = this.ghostPos.get(g.id);
      if (!gp) continue;
      const targets: Point[] = [
        ...g.linked_node_ids.map((id) => this.nodeMap.get(id)).filter((p): p is CanvasNode => !!p),
        ...g.depends_on.map((id) => this.ghostPos.get(id)).filter((p): p is Point => !!p),
      ];
      for (const t of targets) {
        ctx.moveTo(gp.x, gp.y);
        ctx.lineTo(t.x, t.y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  private renderGhosts(ctx: CanvasRenderingContext2D) {
    const r = this.dotRadius() * 1.8;
    for (const g of this.ghosts) {
      const p = this.ghostPos.get(g.id);
      if (!p) continue;
      const hovered = this.hoveredId === g.id;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = palette.background;
      ctx.fill();
      ctx.setLineDash([2 / this.zoom, 2 / this.zoom]);
      ctx.lineWidth = 1 / this.zoom;
      ctx.strokeStyle = hovered ? palette.foreground : withAlpha("mutedForeground", 0.8);
      ctx.stroke();
      ctx.restore();
      this.drawLabel(ctx, g.title, p.x, p.y + r, hovered, true);
    }
  }

  private renderNodes(ctx: CanvasRenderingContext2D, hot: ReturnType<GraphCanvasEngine["hotState"]>) {
    const r = this.dotRadius();
    const px = 1 / this.zoom;
    const showAll = this.zoom >= this.settings.labelZoom;
    const labels: { node: CanvasNode; rank: number; hot: boolean; dimmed: boolean }[] = [];
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
      ctx.fillStyle = active || near ? palette.foreground : withAlpha("foreground", dimmed ? 0.4 : 0.85);
      ctx.fill();

      if (active) labels.push({ node, rank: 0, hot: true, dimmed: false });
      else if (showAll) labels.push({ node, rank: near ? 1 : dimmed ? 3 : 2, hot: false, dimmed });
    }
    this.renderNodeLabels(ctx, labels, r);
  }

  /** Labels in priority order (active, neighbours, rest); one that would overlap a placed label is skipped. */
  private renderNodeLabels(
    ctx: CanvasRenderingContext2D,
    labels: { node: CanvasNode; rank: number; hot: boolean; dimmed: boolean }[],
    r: number,
  ) {
    if (labels.length === 0) return;
    labels.sort((a, b) => a.rank - b.rank);
    const size = this.settings.labelSize / this.zoom;
    const gap = 2 / this.zoom;
    ctx.save();
    ctx.font = `400 ${size}px ${UI_FONT}`;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const l of labels) {
      const text = shortLabel(l.node.name);
      const w = ctx.measureText(text).width;
      const y = l.node.y + r + 4 / this.zoom;
      const box = { x0: l.node.x - w / 2 - gap, y0: y - gap, x1: l.node.x + w / 2 + gap, y1: y + size * 1.15 + gap };
      if (!l.hot && placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1 && p.y0 < box.y1 && box.y0 < p.y1)) continue;
      placed.push(box);
      this.drawLabel(ctx, l.node.name, l.node.x, l.node.y + r, l.hot, false, l.dimmed);
    }
    ctx.restore();
  }

  /** Small unboxed label centred under a dot whose bottom edge is at `y`. */
  private drawLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    hot: boolean,
    ghost: boolean,
    dimmed = false,
  ) {
    const size = this.settings.labelSize / this.zoom;
    const label = shortLabel(text);
    ctx.save();
    ctx.font = `${hot ? 500 : 400} ${size}px ${UI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = hot
      ? palette.foreground
      : withAlpha("mutedForeground", ghost ? 0.75 : dimmed ? 0.35 : 0.8);
    ctx.fillText(label, x, y + 4 / this.zoom);
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
    const w = this.screenToWorld(sx, sy);
    const hit = this.hitRadius(1.8);
    for (const g of this.ghosts) {
      const p = this.ghostPos.get(g.id);
      if (p && (w.x - p.x) ** 2 + (w.y - p.y) ** 2 <= hit * hit) return g;
    }
    return null;
  }

  private applyZoom(factor: number, ox: number, oy: number) {
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    if (z === this.zoom) return;
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
      this.following = false;
      this.panX += dx;
      this.panY += dy;
      this.requestRender();
      return;
    }
    if (e.target !== this.canvas) {
      if (this.hoveredId !== null) {
        this.hoveredId = null;
        this.requestRender();
      }
      return;
    }
    const node = this.pickNode(x, y);
    const hovered = node?.id ?? this.pickGhost(x, y)?.id ?? null;
    if (hovered !== this.hoveredId) {
      this.hoveredId = hovered;
      this.canvas.style.cursor = hovered ? "pointer" : "default";
      this.requestRender();
    }
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
