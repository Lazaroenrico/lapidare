/**
 * 2D Canvas Knowledge Graph Physics & Rendering Engine.
 * Single unified 2D graph with soft nebulous cluster hulls,
 * force-directed layout, smooth pan/zoom, and graphite skin styling (#141414).
 */

import type { ConceptNode, GraphEdge } from "@/lib/types";

export interface CanvasNode extends ConceptNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pinned?: boolean;
}

export interface CanvasEdge {
  source: CanvasNode;
  target: CanvasNode;
  kind?: "dependency" | "implication" | "reinforces";
}

export interface ClusterGroup {
  name: string;
  nodes: CanvasNode[];
  centroid: { x: number; y: number };
  hullPoints: { x: number; y: number }[];
}

export interface GraphCanvasCallbacks {
  onSelectNode?: (node: ConceptNode | null) => void;
  onHoverNode?: (node: ConceptNode | null) => void;
  onCanvasClick?: () => void;
}

export class GraphCanvasEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private callbacks: GraphCanvasCallbacks;

  // Graph state
  private nodes: CanvasNode[] = [];
  private edges: CanvasEdge[] = [];
  private nodeMap: Map<string, CanvasNode> = new Map();
  private clusters: ClusterGroup[] = [];

  // Viewport / Camera state
  private panX: number = 0;
  private panY: number = 0;
  private zoom: number = 1.0;
  private minZoom: number = 0.25;
  private maxZoom: number = 2.8;

  // Interaction state
  private hoveredNode: CanvasNode | null = null;
  private selectedNode: CanvasNode | null = null;
  private isDragging: boolean = false;
  private draggedNode: CanvasNode | null = null;
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;
  private hasPannedDistance: number = 0;

  // Simulation physics
  private animationFrameId: number | null = null;
  private alpha: number = 1.0;
  private alphaDecay: number = 0.015;
  private alphaMin: number = 0.001;
  private isRunning: boolean = false;

  constructor(
    canvas: HTMLCanvasElement,
    callbacks: GraphCanvasCallbacks = {}
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Unable to obtain 2D canvas context");
    }
    this.ctx = ctx;
    this.callbacks = callbacks;

    this.bindEvents();
    this.resize();
  }

  // --- Public Configuration & Data Setters ---

  public setData(rawNodes: ConceptNode[], rawEdges: GraphEdge[]) {
    // Save existing positions if re-indexing
    const prevPositions = new Map<string, { x: number; y: number }>();
    this.nodes.forEach((n) => {
      prevPositions.set(n.id, { x: n.x, y: n.y });
    });

    const centerX = 0;
    const centerY = 0;

    this.nodeMap.clear();

    // Map & initialize nodes
    this.nodes = rawNodes.map((n, idx) => {
      const prev = prevPositions.get(n.id);
      let initX = prev ? prev.x : n.x;
      let initY = prev ? prev.y : n.y;

      if (initX === undefined || initY === undefined) {
        // Arrange in a natural clustered spiral
        const angle = idx * 0.75;
        const radius = 60 + Math.sqrt(idx) * 55;
        initX = centerX + Math.cos(angle) * radius + (Math.random() - 0.5) * 20;
        initY = centerY + Math.sin(angle) * radius + (Math.random() - 0.5) * 20;
      }

      const canvasNode: CanvasNode = {
        ...n,
        x: initX,
        y: initY,
        vx: 0,
        vy: 0,
        radius: 18,
      };

      this.nodeMap.set(n.id, canvasNode);
      return canvasNode;
    });

    // Map edges
    this.edges = [];
    rawEdges.forEach((e) => {
      const src = this.nodeMap.get(e.source);
      const tgt = this.nodeMap.get(e.target);
      if (src && tgt) {
        this.edges.push({
          source: src,
          target: tgt,
          kind: e.kind || "dependency",
        });
      }
    });

    // Also link nodes through depends_on if edges were sparse
    this.nodes.forEach((node) => {
      if (Array.isArray(node.depends_on)) {
        node.depends_on.forEach((depName) => {
          const target = this.nodes.find(
            (n) => n.name.toLowerCase() === depName.toLowerCase() || n.id === depName
          );
          if (target && target.id !== node.id) {
            const exists = this.edges.some(
              (edge) =>
                (edge.source.id === node.id && edge.target.id === target.id) ||
                (edge.source.id === target.id && edge.target.id === node.id)
            );
            if (!exists) {
              this.edges.push({
                source: target,
                target: node,
                kind: "dependency",
              });
            }
          }
        });
      }
    });

    // Compute cluster hulls
    this.updateClusters();

    // Reheat simulation
    this.reheat(1.0);
    this.startSimulation();
  }

  public setSelectedNode(nodeOrId: ConceptNode | string | null) {
    if (!nodeOrId) {
      this.selectedNode = null;
    } else if (typeof nodeOrId === "string") {
      this.selectedNode = this.nodeMap.get(nodeOrId) || null;
    } else {
      this.selectedNode = this.nodeMap.get(nodeOrId.id) || null;
    }
    this.requestRender();
  }

  public getSelectedNode(): ConceptNode | null {
    return this.selectedNode;
  }

  public focusNode(nodeId: string) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;

    this.selectedNode = node;
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);

    // Smoothly pan camera to center node
    this.panX = width / 2 - node.x * this.zoom;
    this.panY = height / 2 - node.y * this.zoom;

    this.requestRender();
    if (this.callbacks.onSelectNode) {
      this.callbacks.onSelectNode(node);
    }
  }

  public zoomIn() {
    this.applyZoom(1.25, this.canvas.width / 2, this.canvas.height / 2);
  }

  public zoomOut() {
    this.applyZoom(0.8, this.canvas.width / 2, this.canvas.height / 2);
  }

  public resetView() {
    if (this.nodes.length === 0) {
      this.panX = this.canvas.width / 2;
      this.panY = this.canvas.height / 2;
      this.zoom = 1.0;
      this.requestRender();
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    this.nodes.forEach((n) => {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    });

    const graphW = Math.max(maxX - minX + 160, 200);
    const graphH = Math.max(maxY - minY + 160, 200);
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const scaleX = width / graphW;
    const scaleY = height / graphH;
    const newZoom = Math.max(
      this.minZoom,
      Math.min(1.4, Math.min(scaleX, scaleY))
    );

    this.zoom = newZoom;
    this.panX = width / 2 - midX * newZoom;
    this.panY = height / 2 - midY * newZoom;

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

    // Center camera on initial layout
    if (this.panX === 0 && this.panY === 0) {
      this.panX = rect.width / 2;
      this.panY = rect.height / 2;
    }

    this.requestRender();
  }

  public destroy() {
    this.stopSimulation();
    this.unbindEvents();
  }

  // --- Physics & Layout Simulation ---

  private reheat(amount = 0.5) {
    this.alpha = Math.max(this.alpha, amount);
  }

  private startSimulation() {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = () => {
      if (!this.isRunning) return;

      if (this.alpha > this.alphaMin) {
        this.stepSimulation();
        this.alpha *= 1 - this.alphaDecay;
      }

      this.render();
      this.animationFrameId = requestAnimationFrame(loop);
    };

    this.animationFrameId = requestAnimationFrame(loop);
  }

  private stopSimulation() {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private stepSimulation() {
    const kRepel = 2400 * this.alpha;
    const kSpring = 0.045;
    const restLength = 110;
    const kCenter = 0.008 * this.alpha;
    const damping = 0.84;

    const nodeCount = this.nodes.length;

    // 1. Node-node repulsion
    for (let i = 0; i < nodeCount; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < nodeCount; j++) {
        const b = this.nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy + 1;
        const dist = Math.sqrt(distSq);

        if (dist < 450) {
          const force = kRepel / distSq;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          if (!a.pinned) {
            a.vx -= fx;
            a.vy -= fy;
          }
          if (!b.pinned) {
            b.vx += fx;
            b.vy += fy;
          }
        }
      }
    }

    // 2. Edge spring attraction
    this.edges.forEach((edge) => {
      const a = edge.source;
      const b = edge.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const displacement = dist - restLength;
      const force = displacement * kSpring;

      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (!a.pinned) {
        a.vx += fx;
        a.vy += fy;
      }
      if (!b.pinned) {
        b.vx -= fx;
        b.vy -= fy;
      }
    });

    // 3. Cluster cohesion force (pulling cluster nodes toward cluster centroid)
    this.clusters.forEach((cluster) => {
      if (cluster.nodes.length <= 1) return;
      const cx = cluster.centroid.x;
      const cy = cluster.centroid.y;
      const kCluster = 0.018 * this.alpha;

      cluster.nodes.forEach((n) => {
        if (!n.pinned) {
          n.vx += (cx - n.x) * kCluster;
          n.vy += (cy - n.y) * kCluster;
        }
      });
    });

    // 4. Centering gravity & integration
    for (let i = 0; i < nodeCount; i++) {
      const n = this.nodes[i];
      if (n.pinned) continue;

      // Gentle gravitational pull to origin
      n.vx -= n.x * kCenter;
      n.vy -= n.y * kCenter;

      n.vx *= damping;
      n.vy *= damping;

      n.x += n.vx;
      n.y += n.vy;
    }

    // Refresh cluster geometry after positions update
    this.updateClusters();
  }

  // --- Cluster Hull Geometry ---

  private updateClusters() {
    const clusterMap = new Map<string, CanvasNode[]>();

    this.nodes.forEach((n) => {
      const cName = n.cluster || "Core";
      if (!clusterMap.has(cName)) {
        clusterMap.set(cName, []);
      }
      clusterMap.get(cName)!.push(n);
    });

    this.clusters = [];
    clusterMap.forEach((members, name) => {
      let sumX = 0;
      let sumY = 0;
      members.forEach((m) => {
        sumX += m.x;
        sumY += m.y;
      });
      const centroid = {
        x: sumX / members.length,
        y: sumY / members.length,
      };

      const hullPoints = this.calculateConvexHull(members, 36);

      this.clusters.push({
        name,
        nodes: members,
        centroid,
        hullPoints,
      });
    });
  }

  private calculateConvexHull(
    nodes: CanvasNode[],
    padding = 32
  ): { x: number; y: number }[] {
    if (nodes.length === 0) return [];

    if (nodes.length === 1) {
      const n = nodes[0];
      const pts: { x: number; y: number }[] = [];
      const segments = 8;
      for (let i = 0; i < segments; i++) {
        const rad = (i / segments) * Math.PI * 2;
        pts.push({
          x: n.x + Math.cos(rad) * (n.radius + padding),
          y: n.y + Math.sin(rad) * (n.radius + padding),
        });
      }
      return pts;
    }

    // Expand each node into circle approximation points
    const points: { x: number; y: number }[] = [];
    nodes.forEach((n) => {
      const r = n.radius + padding;
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        const rad = (i / steps) * Math.PI * 2;
        points.push({
          x: n.x + Math.cos(rad) * r,
          y: n.y + Math.sin(rad) * r,
        });
      }
    });

    // Monotone chain 2D convex hull
    points.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

    const cross = (
      o: { x: number; y: number },
      a: { x: number; y: number },
      b: { x: number; y: number }
    ) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

    const lower: { x: number; y: number }[] = [];
    for (const p of points) {
      while (
        lower.length >= 2 &&
        cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
      ) {
        lower.pop();
      }
      lower.push(p);
    }

    const upper: { x: number; y: number }[] = [];
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      while (
        upper.length >= 2 &&
        cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
      ) {
        upper.pop();
      }
      upper.push(p);
    }

    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  // --- Rendering Pipeline ---

  public requestRender() {
    if (!this.isRunning) {
      this.render();
    }
  }

  private render() {
    const ctx = this.ctx;
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;

    // Reset transform & clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Canvas background
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Apply high-DPI scaling and camera pan/zoom
    ctx.scale(dpr, dpr);
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // Draw background subtle grid dots
    this.renderGrid(ctx);

    // Draw soft nebulous cluster hulls
    this.renderClusterHulls(ctx);

    // Draw graph edges
    this.renderEdges(ctx);

    // Draw nodes
    this.renderNodes(ctx);
  }

  private renderGrid(ctx: CanvasRenderingContext2D) {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;

    const screenTopLeft = this.screenToWorld(0, 0);
    const screenBottomRight = this.screenToWorld(width, height);

    const step = 48;
    const startX = Math.floor(screenTopLeft.x / step) * step;
    const endX = Math.ceil(screenBottomRight.x / step) * step;
    const startY = Math.floor(screenTopLeft.y / step) * step;
    const endY = Math.ceil(screenBottomRight.y / step) * step;

    ctx.fillStyle = "rgba(67, 67, 67, 0.22)";

    for (let x = startX; x <= endX; x += step) {
      for (let y = startY; y <= endY; y += step) {
        ctx.beginPath();
        ctx.arc(x, y, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private renderClusterHulls(ctx: CanvasRenderingContext2D) {
    this.clusters.forEach((cluster) => {
      const pts = cluster.hullPoints;
      if (pts.length < 3) return;

      // Draw rounded smooth hull path
      ctx.save();
      ctx.beginPath();

      const p0 = pts[0];
      const pLast = pts[pts.length - 1];
      const midStart = { x: (pLast.x + p0.x) / 2, y: (pLast.y + p0.y) / 2 };
      ctx.moveTo(midStart.x, midStart.y);

      for (let i = 0; i < pts.length; i++) {
        const current = pts[i];
        const next = pts[(i + 1) % pts.length];
        const midNext = { x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 };
        ctx.quadraticCurveTo(current.x, current.y, midNext.x, midNext.y);
      }
      ctx.closePath();

      // Soft nebulous fill
      const grad = ctx.createRadialGradient(
        cluster.centroid.x,
        cluster.centroid.y,
        10,
        cluster.centroid.x,
        cluster.centroid.y,
        180
      );
      grad.addColorStop(0, "rgba(42, 42, 42, 0.32)");
      grad.addColorStop(0.7, "rgba(28, 28, 28, 0.18)");
      grad.addColorStop(1, "rgba(20, 20, 20, 0.02)");

      ctx.fillStyle = grad;
      ctx.fill();

      // Delicate dashed border
      ctx.strokeStyle = "rgba(67, 67, 67, 0.4)";
      ctx.lineWidth = 1.0;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.restore();

      // Cluster label
      if (cluster.name && cluster.name !== "Core" && cluster.nodes.length >= 2) {
        ctx.save();
        ctx.font = "600 9.5px 'JetBrains Mono', monospace";
        ctx.fillStyle = "rgba(141, 141, 141, 0.65)";
        ctx.textAlign = "center";
        ctx.letterSpacing = "0.08em";

        let minY = Infinity;
        pts.forEach((p) => {
          if (p.y < minY) minY = p.y;
        });

        ctx.fillText(cluster.name.toUpperCase(), cluster.centroid.x, minY - 10);
        ctx.restore();
      }
    });
  }

  private renderEdges(ctx: CanvasRenderingContext2D) {
    this.edges.forEach((edge) => {
      const src = edge.source;
      const tgt = edge.target;

      const isConnectedToSelected =
        this.selectedNode &&
        (src.id === this.selectedNode.id || tgt.id === this.selectedNode.id);
      const isConnectedToHovered =
        this.hoveredNode &&
        (src.id === this.hoveredNode.id || tgt.id === this.hoveredNode.id);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);

      if (isConnectedToSelected) {
        ctx.strokeStyle = "#e6e6e6";
        ctx.lineWidth = 1.8;
      } else if (isConnectedToHovered) {
        ctx.strokeStyle = "#8d8d8d";
        ctx.lineWidth = 1.4;
      } else {
        ctx.strokeStyle = "rgba(67, 67, 67, 0.65)";
        ctx.lineWidth = 1.0;
      }

      ctx.stroke();

      // Subtle directional arrow tip towards target
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 30) {
        const nx = dx / dist;
        const ny = dy / dist;
        const arrowX = tgt.x - nx * (tgt.radius + 6);
        const arrowY = tgt.y - ny * (tgt.radius + 6);

        const arrowLen = 7;
        const arrowAngle = Math.atan2(ny, nx);

        ctx.beginPath();
        ctx.moveTo(arrowX, arrowY);
        ctx.lineTo(
          arrowX - arrowLen * Math.cos(arrowAngle - Math.PI / 6),
          arrowY - arrowLen * Math.sin(arrowAngle - Math.PI / 6)
        );
        ctx.lineTo(
          arrowX - arrowLen * Math.cos(arrowAngle + Math.PI / 6),
          arrowY - arrowLen * Math.sin(arrowAngle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fillStyle = isConnectedToSelected
          ? "#e6e6e6"
          : isConnectedToHovered
          ? "#8d8d8d"
          : "rgba(67, 67, 67, 0.75)";
        ctx.fill();
      }

      ctx.restore();
    });
  }

  private renderNodes(ctx: CanvasRenderingContext2D) {
    this.nodes.forEach((node) => {
      const isSelected = this.selectedNode?.id === node.id;
      const isHovered = this.hoveredNode?.id === node.id;

      ctx.save();

      // Node shadow / outer halo when active
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(230, 230, 230, 0.12)";
        ctx.fill();
      }

      // Base circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "#2a2a2a" : "#1c1c1c";
      ctx.fill();

      // Border stroke
      if (isSelected) {
        ctx.strokeStyle = "#e6e6e6";
        ctx.lineWidth = 2.2;
      } else if (isHovered) {
        ctx.strokeStyle = "#8d8d8d";
        ctx.lineWidth = 1.8;
      } else {
        ctx.strokeStyle = "#434343";
        ctx.lineWidth = 1.2;
      }
      ctx.stroke();

      // Status indicator dot
      let statusColor = "#34d399"; // default sólido
      if (node.status === "aprendendo") {
        statusColor = "#fbbf24";
      } else if (node.status === "revisar") {
        statusColor = "#f87171";
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = statusColor;
      ctx.fill();

      // Label with background badge for contrast
      const labelText = node.name;
      ctx.font = "500 11px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const textWidth = ctx.measureText(labelText).width;
      const labelY = node.y + node.radius + 14;
      const padX = 6;
      const padY = 3;

      // Label background pill
      ctx.fillStyle = "rgba(20, 20, 20, 0.88)";
      ctx.strokeStyle = isSelected
        ? "rgba(230, 230, 230, 0.4)"
        : isHovered
        ? "rgba(141, 141, 141, 0.4)"
        : "rgba(67, 67, 67, 0.35)";
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.roundRect(
        node.x - textWidth / 2 - padX,
        labelY - 7 - padY,
        textWidth + padX * 2,
        14 + padY * 2,
        4
      );
      ctx.fill();
      ctx.stroke();

      // Text
      ctx.fillStyle = isSelected ? "#ffffff" : isHovered ? "#e6e6e6" : "#cccccc";
      ctx.fillText(labelText, node.x, labelY);

      ctx.restore();
    });
  }

  // --- Coordinate Transformations ---

  public screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.panX) / this.zoom,
      y: (screenY - this.panY) / this.zoom,
    };
  }

  public worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: worldX * this.zoom + this.panX,
      y: worldY * this.zoom + this.panY,
    };
  }

  // --- Hit Testing & Node Picking ---

  private getNodeAt(screenX: number, screenY: number): CanvasNode | null {
    const world = this.screenToWorld(screenX, screenY);
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      const dx = world.x - node.x;
      const dy = world.y - node.y;
      const hitRadius = node.radius + 6;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        return node;
      }
    }
    return null;
  }

  // --- Zoom & Pan Mechanics ---

  private applyZoom(factor: number, originX: number, originY: number) {
    const newZoom = Math.min(
      this.maxZoom,
      Math.max(this.minZoom, this.zoom * factor)
    );
    if (newZoom === this.zoom) return;

    this.panX = originX - (originX - this.panX) * (newZoom / this.zoom);
    this.panY = originY - (originY - this.panY) * (newZoom / this.zoom);
    this.zoom = newZoom;

    this.requestRender();
  }

  // --- Event Handling ---

  private handleMouseDown = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    this.lastMouseX = mouseX;
    this.lastMouseY = mouseY;
    this.dragStartX = mouseX;
    this.dragStartY = mouseY;
    this.hasPannedDistance = 0;

    const hit = this.getNodeAt(mouseX, mouseY);
    if (hit) {
      this.draggedNode = hit;
      hit.pinned = true;
      this.canvas.style.cursor = "grabbing";
      this.reheat(0.4);
    } else {
      this.isDragging = true;
      this.canvas.style.cursor = "grabbing";
    }
  };

  private handleMouseMove = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const dx = mouseX - this.lastMouseX;
    const dy = mouseY - this.lastMouseY;
    this.lastMouseX = mouseX;
    this.lastMouseY = mouseY;

    this.hasPannedDistance += Math.abs(dx) + Math.abs(dy);

    if (this.draggedNode) {
      const worldDeltaX = dx / this.zoom;
      const worldDeltaY = dy / this.zoom;
      this.draggedNode.x += worldDeltaX;
      this.draggedNode.y += worldDeltaY;
      this.draggedNode.vx = 0;
      this.draggedNode.vy = 0;
      this.reheat(0.2);
      this.requestRender();
      return;
    }

    if (this.isDragging) {
      this.panX += dx;
      this.panY += dy;
      this.requestRender();
      return;
    }

    const hit = this.getNodeAt(mouseX, mouseY);
    if (hit !== this.hoveredNode) {
      this.hoveredNode = hit;
      this.canvas.style.cursor = hit ? "pointer" : "default";
      if (this.callbacks.onHoverNode) {
        this.callbacks.onHoverNode(hit);
      }
      this.requestRender();
    }
  };

  private handleMouseUp = (e: MouseEvent) => {
    const wasDraggingNode = !!this.draggedNode;
    if (this.draggedNode) {
      this.draggedNode.pinned = false;
      this.draggedNode = null;
    }

    this.isDragging = false;
    this.canvas.style.cursor = this.hoveredNode ? "pointer" : "default";

    if (this.hasPannedDistance < 6) {
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const hit = this.getNodeAt(mouseX, mouseY);

      if (hit) {
        this.selectedNode = hit;
        if (this.callbacks.onSelectNode) {
          this.callbacks.onSelectNode(hit);
        }
      } else if (!wasDraggingNode) {
        this.selectedNode = null;
        if (this.callbacks.onSelectNode) {
          this.callbacks.onSelectNode(null);
        }
        if (this.callbacks.onCanvasClick) {
          this.callbacks.onCanvasClick();
        }
      }
      this.requestRender();
    }
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    this.applyZoom(zoomFactor, mouseX, mouseY);
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
