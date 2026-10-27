/**
 * 2D Canvas knowledge-graph engine (Fase 8B).
 *
 * - force-directed layout tuned by GraphSettings (⚙ panel);
 * - one region per cluster (birth session), labelled when it has ≥ 3 nodes;
 * - chain edges premise → conclusion;
 * - labels appear from a zoom threshold (selected/hovered/focused always);
 * - multi-selection highlight (Shift/⌘-click toggles, plain click focuses);
 * - dragging pins a node and reports its position (persisted by the caller);
 * - optional roadmap ghost nodes (hollow, dashed) linked to real nodes.
 *
 * Colours come only from lib/palette (graphite skin).
 */

import { palette, withAlpha, type PaletteToken } from "@/lib/palette";
import { layoutGhosts, type Point } from "@/lib/ghost-layout";
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from "@/lib/graph-settings";
import type { ConceptNode, GraphCluster, GraphEdge, RoadmapItem } from "@/lib/types";

export interface CanvasNode extends ConceptNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Fixed by the user (dragged now or persisted earlier): physics leaves it alone. */
  fixed: boolean;
}

interface CanvasEdge {
  source: CanvasNode;
  target: CanvasNode;
  kind: GraphEdge["kind"];
}

interface ClusterGroup {
  id: string;
  label: string;
  nodes: CanvasNode[];
  centroid: Point;
  hull: Point[];
  tone: PaletteToken;
}

export interface GraphCanvasCallbacks {
  /** Plain click (additive=false) or Shift/⌘/Ctrl-click (additive=true) on a node. */
  onNodeClick?: (node: ConceptNode, additive: boolean) => void;
  onGhostClick?: (item: RoadmapItem) => void;
  onCanvasClick?: () => void;
  /** Fired on drag end with the final position of the dragged node. */
  onNodeMoved?: (id: string, pos: Point) => void;
}

/** Region tones cycle through the palette (low alpha), never off-token colours. */
const REGION_TONES: PaletteToken[] = ["mutedForeground", "success", "warning", "foreground", "border"];
const UI_FONT = "'JetBrains Mono', monospace";

export class GraphCanvasEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private callbacks: GraphCanvasCallbacks;
  private settings: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS };

  private nodes: CanvasNode[] = [];
  private edges: CanvasEdge[] = [];
  private nodeMap = new Map<string, CanvasNode>();
  private clusterLabels = new Map<string, string>();
  private clusters: ClusterGroup[] = [];
  private ghosts: RoadmapItem[] = [];
  private ghostPos = new Map<string, Point>();

  private selection = new Set<string>();
  private focusedId: string | null = null;
  private hoveredId: string | null = null;

  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private readonly minZoom = 0.15;
  private readonly maxZoom = 3;

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

  public setData(rawNodes: ConceptNode[], rawEdges: GraphEdge[], clusters: GraphCluster[]) {
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    this.nodeMap.clear();
    this.nodes = rawNodes.map((n, idx) => {
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
        // Spiral seed (jitter keeps the simulation from locking symmetric states).
        const angle = idx * 0.75;
        const radius = 60 + Math.sqrt(idx) * 55;
        x = Math.cos(angle) * radius + (Math.random() - 0.5) * 20;
        y = Math.sin(angle) * radius + (Math.random() - 0.5) * 20;
      }
      const node: CanvasNode = { ...n, x, y, vx: 0, vy: 0, fixed: persisted || (old?.fixed ?? false) };
      this.nodeMap.set(n.id, node);
      return node;
    });

    this.edges = [];
    for (const e of rawEdges) {
      const s = this.nodeMap.get(e.source);
      const t = this.nodeMap.get(e.target);
      if (s && t && s !== t) this.edges.push({ source: s, target: t, kind: e.kind ?? "dependency" });
    }
    // Legacy notes: depends_on by name/id when the server sent no edge.
    for (const node of this.nodes) {
      for (const dep of node.depends_on) {
        const target = this.nodeMap.get(dep) ?? this.nodes.find((n) => n.name.toLowerCase() === dep.toLowerCase());
        if (!target || target === node) continue;
        if (this.edges.some((e) => e.source === target && e.target === node)) continue;
        this.edges.push({ source: target, target: node, kind: "dependency" });
      }
    }

    this.clusterLabels = new Map(clusters.map((c) => [c.id, c.label]));
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

  /** Centres the camera on a node. */
  public focusNode(id: string) {
    const node = this.nodeMap.get(id);
    if (!node) return;
    this.focusedId = id;
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

  public resetView() {
    const { width, height } = this.viewport();
    const points: Point[] = [...this.nodes, ...this.ghostPos.values()];
    if (points.length === 0) {
      this.zoom = 1;
      this.panX = width / 2;
      this.panY = height / 2;
      this.requestRender();
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
    const w = Math.max(maxX - minX + 200, 240);
    const h = Math.max(maxY - minY + 260, 240);
    this.zoom = Math.max(this.minZoom, Math.min(1.4, Math.min(width / w, height / h)));
    this.panX = width / 2 - ((minX + maxX) / 2) * this.zoom;
    // The composer dock covers the bottom: bias the graph upwards a little.
    this.panY = height / 2 - 40 - ((minY + maxY) / 2) * this.zoom;
    this.requestRender();
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
    const damping = 0.84;
    const n = this.nodes.length;

    for (let i = 0; i < n; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 1;
        if (d2 > 500 * 500) continue;
        const d = Math.sqrt(d2);
        const f = kRepel / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const e of this.edges) {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - s.linkDistance) * s.attraction;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      e.source.vx += fx;
      e.source.vy += fy;
      e.target.vx -= fx;
      e.target.vy -= fy;
    }

    for (const c of this.clusters) {
      if (c.nodes.length < 2) continue;
      for (const node of c.nodes) {
        node.vx += (c.centroid.x - node.x) * kCluster;
        node.vy += (c.centroid.y - node.y) * kCluster;
      }
    }

    for (const node of this.nodes) {
      if (node.fixed || node === this.draggedNode) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx = (node.vx - node.x * kCenter) * damping;
      node.vy = (node.vy - node.y * kCenter) * damping;
      node.x += node.vx;
      node.y += node.vy;
    }
    this.updateClusters();
  }

  private updateClusters() {
    const groups = new Map<string, CanvasNode[]>();
    for (const node of this.nodes) {
      const id = node.cluster || "";
      if (!id) continue;
      const list = groups.get(id);
      if (list) list.push(node);
      else groups.set(id, [node]);
    }
    const clusters: ClusterGroup[] = [];
    let i = 0;
    for (const [id, members] of groups) {
      const cx = members.reduce((s, m) => s + m.x, 0) / members.length;
      const cy = members.reduce((s, m) => s + m.y, 0) / members.length;
      clusters.push({
        id,
        label: this.clusterLabels.get(id) ?? id,
        nodes: members,
        centroid: { x: cx, y: cy },
        hull: this.hull(members, this.settings.nodeSize + 26),
        tone: REGION_TONES[i++ % REGION_TONES.length],
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
      offset: this.settings.nodeSize * 2 + 60,
      columnGap: 180,
      rowGap: this.settings.nodeSize * 2 + 48,
    });
  }

  private hull(nodes: CanvasNode[], pad: number): Point[] {
    const pts: Point[] = [];
    for (const n of nodes) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        pts.push({ x: n.x + Math.cos(a) * pad, y: n.y + Math.sin(a) * pad });
      }
    }
    if (pts.length < 3) return pts;
    pts.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: Point[] = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper: Point[] = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  // --- Rendering -------------------------------------------------------------

  public requestRender() {
    if (!this.running) this.render();
  }

  private render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(dpr, dpr);
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    this.renderGrid(ctx);
    this.renderRegions(ctx);
    this.renderGhostEdges(ctx);
    this.renderEdges(ctx);
    this.renderGhosts(ctx);
    this.renderNodes(ctx);
  }

  private renderGrid(ctx: CanvasRenderingContext2D) {
    const { width, height } = this.viewport();
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(width, height);
    const step = this.zoom < 0.4 ? 96 : 48;
    ctx.fillStyle = withAlpha("border", 0.22);
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
        ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
      }
    }
  }

  private smoothPath(ctx: CanvasRenderingContext2D, pts: Point[]) {
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.moveTo((last.x + pts[0].x) / 2, (last.y + pts[0].y) / 2);
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
    }
    ctx.closePath();
  }

  private renderRegions(ctx: CanvasRenderingContext2D) {
    const intensity = this.settings.regionIntensity;
    if (intensity <= 0) return;
    for (const c of this.clusters) {
      if (c.hull.length < 3) continue;
      ctx.save();
      this.smoothPath(ctx, c.hull);
      ctx.fillStyle = withAlpha(c.tone, 0.1 * intensity);
      ctx.fill();
      ctx.strokeStyle = withAlpha(c.tone, 0.45 * intensity);
      ctx.lineWidth = 1 / Math.max(this.zoom, 0.5);
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.restore();

      if (c.nodes.length >= 3 && c.label) {
        let minY = Infinity;
        for (const p of c.hull) minY = Math.min(minY, p.y);
        ctx.save();
        ctx.font = `600 ${Math.max(10, this.settings.labelSize - 1) / Math.max(this.zoom, 0.6)}px ${UI_FONT}`;
        ctx.fillStyle = withAlpha("mutedForeground", 0.55 + 0.4 * intensity);
        ctx.textAlign = "center";
        const label = c.label.length > 48 ? `${c.label.slice(0, 47)}…` : c.label;
        ctx.fillText(label.toUpperCase(), c.centroid.x, minY - 8);
        ctx.restore();
      }
    }
  }

  private isActive(id: string) {
    return id === this.focusedId || id === this.hoveredId || this.selection.has(id);
  }

  private renderEdges(ctx: CanvasRenderingContext2D) {
    const w = this.settings.edgeWidth;
    const r = this.settings.nodeSize;
    for (const e of this.edges) {
      const hot = this.isActive(e.source.id) || this.isActive(e.target.id);
      ctx.save();
      ctx.strokeStyle = hot ? palette.foreground : withAlpha("border", 0.75);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = hot ? w * 1.6 : w;
      if (e.kind === "dependency") ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const d = Math.hypot(dx, dy);
      if (d > r * 2 + 8) {
        const ux = dx / d;
        const uy = dy / d;
        const ax = e.target.x - ux * (r + 4);
        const ay = e.target.y - uy * (r + 4);
        const ang = Math.atan2(uy, ux);
        const len = 5 + w * 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - len * Math.cos(ang - Math.PI / 6), ay - len * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(ax - len * Math.cos(ang + Math.PI / 6), ay - len * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private renderGhostEdges(ctx: CanvasRenderingContext2D) {
    if (this.ghosts.length === 0) return;
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = Math.max(0.75, this.settings.edgeWidth * 0.9);
    ctx.strokeStyle = withAlpha("mutedForeground", 0.6);
    for (const g of this.ghosts) {
      const gp = this.ghostPos.get(g.id);
      if (!gp) continue;
      const targets: Point[] = [
        ...g.linked_node_ids.map((id) => this.nodeMap.get(id)).filter((p): p is CanvasNode => !!p),
        ...g.depends_on.map((id) => this.ghostPos.get(id)).filter((p): p is Point => !!p),
      ];
      for (const t of targets) {
        ctx.beginPath();
        ctx.moveTo(gp.x, gp.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private renderGhosts(ctx: CanvasRenderingContext2D) {
    const r = this.settings.nodeSize;
    for (const g of this.ghosts) {
      const p = this.ghostPos.get(g.id);
      if (!p) continue;
      const hot = this.hoveredId === g.id;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha("background", 0.85);
      ctx.fill();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = hot ? 2 : 1.4;
      ctx.strokeStyle = hot ? palette.foreground : palette.mutedForeground;
      ctx.stroke();
      ctx.restore();
      this.drawLabel(ctx, g.title, p.x, p.y + r + 12, hot, true);
    }
  }

  private renderNodes(ctx: CanvasRenderingContext2D) {
    const r = this.settings.nodeSize;
    const showAll = this.zoom >= this.settings.labelZoom;
    for (const node of this.nodes) {
      const focused = node.id === this.focusedId;
      const hovered = node.id === this.hoveredId;
      const selected = this.selection.has(node.id);
      ctx.save();
      if (selected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = palette.success;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (focused) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 9, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha("foreground", 0.1);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = focused || selected ? palette.accent : palette.card;
      ctx.fill();
      ctx.strokeStyle = focused ? palette.foreground : hovered ? palette.mutedForeground : palette.border;
      ctx.lineWidth = focused ? 2.2 : hovered ? 1.8 : 1.2;
      ctx.stroke();

      const dot =
        node.status === "aprendendo"
          ? palette.warning
          : node.status === "revisar"
            ? palette.danger
            : node.status === "sólido"
              ? palette.success
              : selected
                ? palette.success
                : palette.mutedForeground;
      ctx.beginPath();
      ctx.arc(node.x, node.y, Math.max(2, r * 0.25), 0, Math.PI * 2);
      ctx.fillStyle = dot;
      ctx.fill();
      ctx.restore();

      if (showAll || focused || hovered || selected) {
        this.drawLabel(ctx, node.name, node.x, node.y + r + 12, focused || hovered, false);
      }
    }
  }

  private drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, hot: boolean, ghost: boolean) {
    const size = this.settings.labelSize / Math.max(this.zoom, 0.75);
    const label = text.length > 42 ? `${text.slice(0, 41)}…` : text;
    ctx.save();
    ctx.font = `500 ${size}px ${UI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(label).width;
    const padX = size * 0.5;
    const h = size * 1.5;
    ctx.beginPath();
    ctx.roundRect(x - w / 2 - padX, y - h / 2, w + padX * 2, h, 4);
    ctx.fillStyle = withAlpha("background", 0.88);
    ctx.fill();
    ctx.strokeStyle = hot ? withAlpha("foreground", 0.4) : withAlpha("border", 0.35);
    ctx.lineWidth = 1 / Math.max(this.zoom, 0.75);
    if (ghost) ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.fillStyle = hot ? palette.foreground : ghost ? palette.mutedForeground : withAlpha("foreground", 0.85);
    ctx.fillText(label, x, y);
    ctx.restore();
  }

  // --- Coordinates & picking -------------------------------------------------

  public screenToWorld(sx: number, sy: number): Point {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  private pickNode(sx: number, sy: number): CanvasNode | null {
    const w = this.screenToWorld(sx, sy);
    const hit = this.settings.nodeSize + 6 / this.zoom;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if ((w.x - n.x) ** 2 + (w.y - n.y) ** 2 <= hit * hit) return n;
    }
    return null;
  }

  private pickGhost(sx: number, sy: number): RoadmapItem | null {
    const w = this.screenToWorld(sx, sy);
    const hit = this.settings.nodeSize + 6 / this.zoom;
    for (const g of this.ghosts) {
      const p = this.ghostPos.get(g.id);
      if (p && (w.x - p.x) ** 2 + (w.y - p.y) ** 2 <= hit * hit) return g;
    }
    return null;
  }

  private applyZoom(factor: number, ox: number, oy: number) {
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    if (z === this.zoom) return;
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
      this.updateClusters();
      this.reheat(0.25);
      this.start();
      this.requestRender();
      return;
    }
    if (this.panning) {
      this.movedDistance += Math.abs(dx) + Math.abs(dy);
      this.panX += dx;
      this.panY += dy;
      this.requestRender();
      return;
    }
    if (e.target !== this.canvas) return;
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
