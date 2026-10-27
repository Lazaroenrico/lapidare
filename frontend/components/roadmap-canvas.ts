/**
 * ⇶ Roteiro layer of the graph canvas: every track as a constellation.
 *
 * - each track is a galaxy (large faint serif title) beside the knowledge graph;
 * - its modules are sub-constellations along a curling arm (lib/roadmap-layout),
 *   each with a soft blurred nebula in the track tone and an uppercase label;
 *   submodules (repo lessons) are tighter sub-clusters with a tiny label on zoom;
 * - steps are star glyphs: completed = bright filled star with a glow,
 *   "nivelado" = muted success fill, active = ring with a gentle pulse,
 *   pending = hollow; kind livre/lab = diamond, base = square;
 * - threads: the module path and prerequisites (solid/brighter when both ends
 *   are done, dashed/dim otherwise), cross-module prerequisites as faint arcs,
 *   a faint spine between consecutive modules, and dotted lines to the real
 *   graph nodes born from each step.
 *
 * The engine owns the camera; this layer only draws in world space and answers
 * picking questions. Colours come only from lib/palette.
 */

import { palette, toneAlpha, withAlpha, type PaletteTone } from "@/lib/palette";
import {
  layoutRoadmap,
  offsetRoadmapLayout,
  roadmapEdges,
  roadmapOffset,
  type Point,
  type RoadmapEdge,
  type RoadmapLayout,
  type RoadmapModuleDisc,
  wrapLabel,
} from "@/lib/roadmap-layout";
import type { RoadmapItem } from "@/lib/types";

const UI_FONT = "'JetBrains Mono', monospace";
const TITLE_FONT = "'CMU Serif', 'Computer Modern Serif', Georgia, serif";
/** Muted success: the "nivelado" fill (known from the diagnosis, not studied here). */
const LEVELED_TONE: PaletteTone = ["success", "mutedForeground", 0.55];
const HAIR = String.fromCharCode(0x200a);

export interface RoadmapView {
  zoom: number;
  nodeSize: number;
  edgeWidth: number;
  labelSize: number;
  labelZoom: number;
  regionIntensity: number;
  hoveredId: string | null;
  pinnedId: string | null;
  /** 0..1 pulse phase of the active steps (constant when motion is reduced). */
  pulse: number;
  nodePos: (id: string) => Point | null;
}

export interface RoadmapLabelHit {
  kind: "module" | "galaxy";
  key: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const spaced = (text: string) => text.toUpperCase().split("").join(HAIR);
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class RoadmapLayer {
  private items: RoadmapItem[] = [];
  private byId = new Map<string, RoadmapItem>();
  private tone: (item: RoadmapItem) => PaletteTone = () => "mutedForeground";
  private trackTone = new Map<string, PaletteTone>();
  private local: RoadmapLayout | null = null;
  private world: RoadmapLayout | null = null;
  private edges: RoadmapEdge[] = [];
  private offset: Point | null = null;
  private defaultModuleTitle = "";
  private moduleStats = new Map<string, { done: number; total: number }>();
  /** Label boxes from the last draw (world units), for clicks on module / galaxy titles. */
  private labelHits: RoadmapLabelHit[] = [];

  get enabled() {
    return this.items.length > 0;
  }

  get layout() {
    return this.world;
  }

  setItems(
    items: readonly RoadmapItem[] | null,
    tone: (item: RoadmapItem) => PaletteTone | null,
    opts: { trackOrder?: readonly string[]; defaultModuleTitle?: string } = {},
  ) {
    this.items = items ? [...items] : [];
    this.byId = new Map(this.items.map((i) => [i.id, i]));
    this.tone = (item) => tone(item) ?? "mutedForeground";
    this.trackTone = new Map(this.items.map((i) => [i.track_id ?? "", this.tone(i)]));
    this.defaultModuleTitle = opts.defaultModuleTitle ?? "";
    this.local = this.items.length ? layoutRoadmap(this.items, { trackOrder: opts.trackOrder }) : null;
    this.edges = this.local ? roadmapEdges(this.items, this.local) : [];
    this.moduleStats = new Map();
    if (this.local) {
      for (const m of this.local.modules) {
        const done = m.itemIds.filter((id) => this.byId.get(id)?.status === "completed").length;
        this.moduleStats.set(m.key, { done, total: m.itemIds.length });
      }
    }
    this.offset = null;
    this.world = null;
  }

  /** Places the region beside the graph bbox; true when it moved. */
  place(graph: { x0: number; y0: number; x1: number; y1: number } | null): boolean {
    if (!this.local) {
      this.world = null;
      return false;
    }
    const off = roadmapOffset(graph, this.local);
    if (this.world && this.offset && off.x === this.offset.x && off.y === this.offset.y) return false;
    this.offset = off;
    this.world = offsetRoadmapLayout(this.local, off.x, off.y);
    return true;
  }

  hasActive() {
    return this.items.some((i) => i.status === "active");
  }

  item(id: string) {
    return this.byId.get(id) ?? null;
  }

  position(id: string): Point | null {
    return this.world?.items.get(id) ?? null;
  }

  module(key: string): RoadmapModuleDisc | null {
    return this.world?.modules.find((m) => m.key === key) ?? null;
  }

  galaxyBounds(trackKey: string) {
    return this.world?.galaxies.find((g) => g.trackKey === trackKey) ?? null;
  }

  // --- Picking ---------------------------------------------------------------

  pickItem(w: Point, hit: number): RoadmapItem | null {
    if (!this.world) return null;
    let best: RoadmapItem | null = null;
    let bestD = hit * hit;
    for (const [id, p] of this.world.items) {
      const d = (w.x - p.x) ** 2 + (w.y - p.y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = this.byId.get(id) ?? null;
      }
    }
    return best;
  }

  pickLabel(w: Point): RoadmapLabelHit | null {
    for (let i = this.labelHits.length - 1; i >= 0; i--) {
      const h = this.labelHits[i];
      if (w.x >= h.x0 && w.x <= h.x1 && w.y >= h.y0 && w.y <= h.y1) return h;
    }
    return null;
  }

  // --- Drawing -----------------------------------------------------------------

  /** Module / submodule clouds into the (already transformed) low-res nebula buffer. */
  drawNebulae(o: CanvasRenderingContext2D, intensity: number, blurPx: number, supportsFilter: boolean) {
    const world = this.world;
    if (!world || intensity <= 0) return;
    const blob = (centres: { x: number; y: number; r: number }[], tone: PaletteTone, alpha: number) => {
      if (supportsFilter) {
        o.filter = `blur(${blurPx}px)`;
        o.beginPath();
        for (const c of centres) {
          o.moveTo(c.x + c.r, c.y);
          o.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        }
        o.fillStyle = toneAlpha(tone, alpha * intensity);
        o.fill();
        return;
      }
      for (const c of centres) {
        const r = c.r * 2;
        const g = o.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
        g.addColorStop(0, toneAlpha(tone, (alpha * intensity) / 2));
        g.addColorStop(1, toneAlpha(tone, 0));
        o.fillStyle = g;
        o.fillRect(c.x - r, c.y - r, r * 2, r * 2);
      }
    };
    for (const m of world.modules) {
      const tone = this.trackTone.get(m.trackKey) ?? "mutedForeground";
      const stars = m.itemIds.map((id) => world.items.get(id)).filter((p): p is Point => !!p);
      blob([{ x: m.x, y: m.y, r: m.r * 0.75 }, ...stars.map((p) => ({ ...p, r: 22 }))], tone, 0.26);
    }
    for (const s of world.submodules) {
      const m = world.modules.find((mm) => mm.key === s.moduleKey);
      const tone = (m && this.trackTone.get(m.trackKey)) ?? "mutedForeground";
      const stars = s.itemIds.map((id) => world.items.get(id)).filter((p): p is Point => !!p);
      blob(stars.map((p) => ({ ...p, r: 9 })), tone, 0.3);
    }
  }

  draw(ctx: CanvasRenderingContext2D, v: RoadmapView) {
    const world = this.world;
    this.labelHits = [];
    if (!world) return;
    const z = v.zoom;
    const lw = (scale = 1) => (v.edgeWidth * scale * Math.pow(z, 0.25)) / z;
    const hot = v.hoveredId && this.byId.has(v.hoveredId) ? v.hoveredId : v.pinnedId;

    this.drawGalaxyTitles(ctx, v);
    this.drawSpines(ctx, v, lw);
    this.drawLinkedLines(ctx, v, lw, hot);
    this.drawEdges(ctx, v, lw, hot);
    const r = (v.nodeSize * 1.25) / Math.sqrt(z);
    for (const it of this.items) {
      const p = world.items.get(it.id);
      if (p) this.drawGlyph(ctx, it, p, r, v, it.id === hot);
    }
    this.drawLabels(ctx, v, r, hot);
  }

  private drawGalaxyTitles(ctx: CanvasRenderingContext2D, v: RoadmapView) {
    const world = this.world!;
    const z = v.zoom;
    const px = Math.min(34, Math.max(15, 22 * Math.pow(z, 0.45)));
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (const g of world.galaxies) {
      const tone = this.trackTone.get(g.trackKey) ?? "mutedForeground";
      const size = px / z;
      ctx.font = `700 ${size}px ${TITLE_FONT}`;
      const text = cut(g.title, 48);
      ctx.fillStyle = toneAlpha(tone, 0.42);
      ctx.fillText(text, g.labelX, g.labelY);
      const w = ctx.measureText(text).width;
      // Thin rule under the title, fading into the galaxy.
      ctx.strokeStyle = toneAlpha(tone, 0.18);
      ctx.lineWidth = 1 / z;
      ctx.beginPath();
      ctx.moveTo(g.labelX, g.labelY + 6 / z);
      ctx.lineTo(g.labelX + Math.max(w, 60 / z), g.labelY + 6 / z);
      ctx.stroke();
      this.labelHits.push({ kind: "galaxy", key: g.trackKey, x0: g.labelX, y0: g.labelY - size, x1: g.labelX + w, y1: g.labelY + 6 / z });
    }
    ctx.restore();
  }

  private drawSpines(ctx: CanvasRenderingContext2D, v: RoadmapView, lw: (s?: number) => number) {
    const world = this.world!;
    const byKey = new Map(world.modules.map((m) => [m.key, m]));
    ctx.save();
    ctx.lineCap = "round";
    for (const g of world.galaxies) {
      const tone = this.trackTone.get(g.trackKey) ?? "mutedForeground";
      ctx.strokeStyle = toneAlpha(tone, 0.16);
      ctx.lineWidth = lw(1.6);
      ctx.beginPath();
      for (let i = 1; i < g.moduleKeys.length; i++) {
        const a = byKey.get(g.moduleKeys[i - 1]);
        const b = byKey.get(g.moduleKeys[i]);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d;
        const uy = dy / d;
        const sx = a.x + ux * a.r * 0.8;
        const sy = a.y + uy * a.r * 0.8;
        const ex = b.x - ux * b.r * 0.8;
        const ey = b.y - uy * b.r * 0.8;
        const bend = 0.12 * d;
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo((sx + ex) / 2 - uy * bend, (sy + ey) / 2 + ux * bend, ex, ey);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawLinkedLines(ctx: CanvasRenderingContext2D, v: RoadmapView, lw: (s?: number) => number, hot: string | null) {
    const world = this.world!;
    ctx.save();
    ctx.setLineDash([1.5 / v.zoom, 4 / v.zoom]);
    ctx.lineCap = "round";
    for (const it of this.items) {
      if (it.linked_node_ids.length === 0) continue;
      const p = world.items.get(it.id);
      if (!p) continue;
      const isHot = it.id === hot;
      ctx.strokeStyle = isHot ? withAlpha("foreground", 0.7) : toneAlpha(this.tone(it), 0.2);
      ctx.lineWidth = lw(isHot ? 1.1 : 0.8);
      ctx.beginPath();
      for (const nid of it.linked_node_ids) {
        const q = v.nodePos(nid);
        if (!q) continue;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawEdges(ctx: CanvasRenderingContext2D, v: RoadmapView, lw: (s?: number) => number, hot: string | null) {
    const world = this.world!;
    const z = v.zoom;
    ctx.save();
    ctx.lineCap = "round";
    for (const e of this.edges) {
      const a = world.items.get(e.source);
      const b = world.items.get(e.target);
      const ia = this.byId.get(e.source);
      const ib = this.byId.get(e.target);
      if (!a || !b || !ia || !ib) continue;
      const done = ia.status === "completed" && ib.status === "completed";
      const tone = this.tone(ib);
      const isHot = hot !== null && (e.source === hot || e.target === hot);
      const cross = e.kind === "cross";
      if (done) {
        ctx.setLineDash([]);
        ctx.strokeStyle = isHot ? withAlpha("foreground", 0.9) : toneAlpha(tone, cross ? 0.3 : 0.62);
        ctx.lineWidth = lw(cross ? 0.9 : 1.15);
      } else {
        ctx.setLineDash(cross ? [1.5 / z, 4 / z] : [2.5 / z, 3 / z]);
        ctx.strokeStyle = isHot ? withAlpha("foreground", 0.75) : toneAlpha(tone, cross ? 0.16 : 0.3);
        ctx.lineWidth = lw(0.9);
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      if (cross) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const bend = 0.22;
        ctx.quadraticCurveTo((a.x + b.x) / 2 - dy * bend, (a.y + b.y) / 2 + dx * bend, b.x, b.y);
      } else {
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private shapePath(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, r: number) {
    ctx.beginPath();
    if (kind === "livre" || kind === "lab") {
      const d = r * 1.3;
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      ctx.closePath();
    } else if (kind === "base") {
      const s = r * 0.95;
      ctx.rect(x - s, y - s, s * 2, s * 2);
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  private drawGlyph(ctx: CanvasRenderingContext2D, it: RoadmapItem, p: Point, r: number, v: RoadmapView, hot: boolean) {
    const z = v.zoom;
    const tone = this.tone(it);
    const leveled = it.status === "completed" && it.status_detail === "nivelado";
    ctx.save();
    if (hot) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha("foreground", 0.08);
      ctx.fill();
    }
    if (it.status === "completed" && !leveled) {
      // Bright star: glow, four short rays, filled core.
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4.2);
      glow.addColorStop(0, toneAlpha(tone, 0.5));
      glow.addColorStop(1, toneAlpha(tone, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(p.x - r * 4.2, p.y - r * 4.2, r * 8.4, r * 8.4);
      ctx.strokeStyle = toneAlpha(tone, 0.55);
      ctx.lineWidth = 0.8 / z;
      ctx.beginPath();
      const ray = r * 2.6;
      ctx.moveTo(p.x - ray, p.y);
      ctx.lineTo(p.x + ray, p.y);
      ctx.moveTo(p.x, p.y - ray);
      ctx.lineTo(p.x, p.y + ray);
      ctx.stroke();
      this.shapePath(ctx, it.kind, p.x, p.y, r * 1.1);
      ctx.fillStyle = toneAlpha(tone, 1);
      ctx.fill();
      this.shapePath(ctx, it.kind, p.x, p.y, r * 0.5);
      ctx.fillStyle = palette.foreground;
      ctx.fill();
    } else if (leveled) {
      this.shapePath(ctx, it.kind, p.x, p.y, r);
      ctx.fillStyle = toneAlpha(LEVELED_TONE, 0.95);
      ctx.fill();
      ctx.strokeStyle = toneAlpha(LEVELED_TONE, 0.45);
      ctx.lineWidth = 1 / z;
      this.shapePath(ctx, it.kind, p.x, p.y, r * 1.9);
      ctx.stroke();
    } else if (it.status === "active") {
      // Pulse: an expanding, fading halo around a steady ring.
      const t = v.pulse;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * (2.4 + 2.4 * t), 0, Math.PI * 2);
      ctx.strokeStyle = toneAlpha(tone, 0.55 * (1 - t));
      ctx.lineWidth = 1.2 / z;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha("foreground", 0.95);
      ctx.lineWidth = 1.3 / z;
      ctx.stroke();
      this.shapePath(ctx, it.kind, p.x, p.y, r * 0.9);
      ctx.fillStyle = toneAlpha(tone, 1);
      ctx.fill();
    } else {
      this.shapePath(ctx, it.kind, p.x, p.y, r);
      ctx.fillStyle = palette.background;
      ctx.fill();
      ctx.strokeStyle = hot ? palette.foreground : toneAlpha(tone, 0.8);
      ctx.lineWidth = 1.1 / z;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawLabels(ctx: CanvasRenderingContext2D, v: RoadmapView, r: number, hot: string | null) {
    const world = this.world!;
    const z = v.zoom;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const collides = (b: { x0: number; y0: number; x1: number; y1: number }) =>
      placed.some((p) => p.x0 < b.x1 && b.x0 < p.x1 && p.y0 < b.y1 && b.y0 < p.y1);
    ctx.save();

    // Module labels: always readable (constant screen size), above or below the disc.
    const modulePx = 10 * Math.min(1.35, Math.max(1, Math.pow(z, 0.2)));
    for (const m of world.modules) {
      const tone = this.trackTone.get(m.trackKey) ?? "mutedForeground";
      const stats = this.moduleStats.get(m.key);
      const lines = wrapLabel(m.title || this.defaultModuleTitle).map(spaced);
      const count = stats ? `  ${stats.done}/${stats.total}` : "";
      const size = modulePx / z;
      const lineH = size * 1.2;
      // The block hugs the module's stars from above or below (room for step titles below).
      let top = m.y;
      let bottom = m.y;
      for (const id of m.itemIds) {
        const p = world.items.get(id);
        if (!p) continue;
        top = Math.min(top, p.y);
        bottom = Math.max(bottom, p.y);
      }
      const stepTitles = z >= v.labelZoom * 0.85 ? (v.labelSize * 1.3) / z : 0;
      // Baseline (bottom) of the first line.
      const firstY = m.labelBelow
        ? bottom + r * 3 + stepTitles + 6 / z + lineH
        : top - r * 3 - 8 / z - (lines.length - 1) * lineH;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      let x0 = Infinity;
      let x1 = -Infinity;
      lines.forEach((line, i) => {
        const last = i === lines.length - 1;
        ctx.font = `600 ${size}px ${UI_FONT}`;
        const wMain = ctx.measureText(line).width;
        ctx.font = `400 ${size * 0.9}px ${UI_FONT}`;
        const wCount = last ? ctx.measureText(count).width : 0;
        const x = m.x - (wMain + wCount) / 2;
        const y = firstY + i * lineH;
        ctx.font = `600 ${size}px ${UI_FONT}`;
        ctx.fillStyle = toneAlpha(tone, 0.95);
        ctx.fillText(line, x, y);
        if (last && count) {
          ctx.font = `400 ${size * 0.9}px ${UI_FONT}`;
          ctx.fillStyle = withAlpha("mutedForeground", 0.75);
          ctx.fillText(count, x + wMain, y);
        }
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x + wMain + wCount);
      });
      const box = { x0: x0 - 3 / z, y0: firstY - lineH, x1: x1 + 3 / z, y1: firstY + (lines.length - 1) * lineH + 2 / z };
      placed.push(box);
      this.labelHits.push({ kind: "module", key: m.key, ...box });
    }

    // Submodule labels once their cluster is big enough on screen.
    const subPx = 8.5;
    ctx.font = `500 ${subPx / z}px ${UI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const s of world.submodules) {
      if (s.r * z < 16) continue;
      const m = world.modules.find((mm) => mm.key === s.moduleKey);
      const tone = (m && this.trackTone.get(m.trackKey)) ?? "mutedForeground";
      const text = cut(s.title, 30);
      const w = ctx.measureText(text).width;
      const y = s.y - s.r - 2 / z;
      const box = { x0: s.x - w / 2 - 2 / z, y0: y - (subPx * 1.2) / z, x1: s.x + w / 2 + 2 / z, y1: y };
      if (collides(box)) continue;
      placed.push(box);
      ctx.fillStyle = toneAlpha(tone, 0.7);
      ctx.fillText(text, s.x, y);
    }

    // Step titles: hovered / pinned / active always; all of them from the label zoom.
    const showAll = z >= v.labelZoom * 0.85;
    const size = v.labelSize / z;
    const ranked = this.items
      .map((it) => ({ it, rank: it.id === hot ? 0 : it.status === "active" ? 1 : showAll ? 2 : 9 }))
      .filter((l) => l.rank < 9)
      .sort((a, b) => a.rank - b.rank);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const { it, rank } of ranked) {
      const p = world.items.get(it.id);
      if (!p) continue;
      ctx.font = `${rank === 0 ? 500 : 400} ${size}px ${UI_FONT}`;
      const text = cut(it.title, 36);
      const w = ctx.measureText(text).width;
      const y = p.y + r * 2.4 + 2 / z;
      const box = { x0: p.x - w / 2 - 2 / z, y0: y - 2 / z, x1: p.x + w / 2 + 2 / z, y1: y + size * 1.15 };
      if (rank > 0 && collides(box)) continue;
      placed.push(box);
      ctx.fillStyle =
        rank === 0 ? palette.foreground : it.status === "completed" ? withAlpha("foreground", 0.78) : withAlpha("mutedForeground", 0.8);
      ctx.fillText(text, p.x, y);
    }
    ctx.restore();
  }
}
