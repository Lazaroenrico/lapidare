/**
 * Graph view settings (⚙ panel): display, regions, radial layout and physics,
 * with defaults, ranges and clamping. Persisted per browser under
 * `GRAPH_SETTINGS_KEY`; callers do the storage access (inside try/catch) and
 * pass the raw string here.
 *
 * Units: sizes and distances are world units (they scale with the camera), except
 * `clusterLabelSize`, which is screen px. Toggles are stored as 0/1.
 */

/** v2: the radial layout changed the meaning of label size and physics values. */
export const GRAPH_SETTINGS_KEY = "learnharness:graph-settings:v2";

export interface GraphSettings {
  // Display
  nodeSize: number;
  edgeWidth: number;
  /** Opacity of the edges. */
  edgeAlpha: number;
  /** Node label font size (world units: micro at overview, legible when zoomed in). */
  labelSize: number;
  /** Zoom from which labels are drawn at full contrast (selected/hovered always are). */
  labelZoom: number;
  /** 1 = show the cluster (session) names. */
  clusterLabels: number;
  /** Cluster name size, screen px. */
  clusterLabelSize: number;
  // Regions (blurred colour nebulae per cluster)
  /** Opacity of the cluster regions. */
  regionIntensity: number;
  /** How far a region spreads around its nodes and edges. */
  regionDilation: number;
  /** Softness of the region edges. */
  regionBlur: number;
  // Radial layout
  /** Radius of the empty centre (inner ring = foundations). */
  ringRadius: number;
  /** Distance between inference-depth rings. */
  depthSpacing: number;
  /** How strongly nodes are held on their depth ring. */
  depthStrength: number;
  // Physics
  repulsion: number;
  attraction: number;
  linkDistance: number;
  centerGravity: number;
  clusterCohesion: number;
  friction: number;
}

export type GraphSettingKey = keyof GraphSettings;

export type GraphSettingGroup = "display" | "regions" | "layout" | "physics";

export const GRAPH_SETTING_GROUPS: readonly GraphSettingGroup[] = ["display", "regions", "layout", "physics"];

export interface SettingRange {
  min: number;
  max: number;
  step: number;
  default: number;
  group: GraphSettingGroup;
  /** Rendered as a checkbox (0 = off, 1 = on). */
  toggle?: boolean;
}

export const GRAPH_SETTING_RANGES: Record<GraphSettingKey, SettingRange> = {
  // Constellation look: tiny dots, hairline threads, micro labels.
  nodeSize: { min: 0.5, max: 8, step: 0.25, default: 2, group: "display" },
  edgeWidth: { min: 0.25, max: 3, step: 0.05, default: 0.6, group: "display" },
  edgeAlpha: { min: 0.05, max: 1, step: 0.05, default: 0.5, group: "display" },
  labelSize: { min: 1, max: 12, step: 0.25, default: 3.5, group: "display" },
  labelZoom: { min: 0.5, max: 6, step: 0.1, default: 2.5, group: "display" },
  clusterLabels: { min: 0, max: 1, step: 1, default: 1, group: "display", toggle: true },
  clusterLabelSize: { min: 7, max: 24, step: 1, default: 10, group: "display" },
  regionIntensity: { min: 0, max: 1, step: 0.05, default: 0.5, group: "regions" },
  regionDilation: { min: 4, max: 80, step: 1, default: 30, group: "regions" },
  regionBlur: { min: 5, max: 120, step: 1, default: 45, group: "regions" },
  ringRadius: { min: 40, max: 600, step: 5, default: 130, group: "layout" },
  depthSpacing: { min: 15, max: 240, step: 5, default: 75, group: "layout" },
  depthStrength: { min: 0, max: 0.3, step: 0.005, default: 0.08, group: "layout" },
  repulsion: { min: 50, max: 4000, step: 25, default: 260, group: "physics" },
  attraction: { min: 0.005, max: 0.2, step: 0.005, default: 0.04, group: "physics" },
  linkDistance: { min: 15, max: 200, step: 1, default: 50, group: "physics" },
  centerGravity: { min: 0, max: 0.05, step: 0.001, default: 0, group: "physics" },
  clusterCohesion: { min: 0, max: 0.08, step: 0.002, default: 0.02, group: "physics" },
  friction: { min: 0.05, max: 0.6, step: 0.01, default: 0.2, group: "physics" },
};

export const GRAPH_SETTING_KEYS = Object.keys(GRAPH_SETTING_RANGES) as GraphSettingKey[];

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = Object.fromEntries(
  GRAPH_SETTING_KEYS.map((k) => [k, GRAPH_SETTING_RANGES[k].default]),
) as unknown as GraphSettings;

export function clampSetting(key: GraphSettingKey, value: unknown): number {
  const r = GRAPH_SETTING_RANGES[key];
  const raw = typeof value === "boolean" ? Number(value) : value;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return r.default;
  const clamped = Math.min(r.max, Math.max(r.min, n));
  return r.toggle ? (clamped >= 0.5 ? 1 : 0) : clamped;
}

/** Full settings from any partial/garbage input: unknown keys dropped, values clamped, gaps defaulted. */
export function clampSettings(input: unknown): GraphSettings {
  const src = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const out = {} as GraphSettings;
  for (const k of GRAPH_SETTING_KEYS) out[k] = k in src ? clampSetting(k, src[k]) : GRAPH_SETTING_RANGES[k].default;
  return out;
}

/** Parses the stored JSON (null/corrupt → defaults). */
export function parseGraphSettings(raw: string | null | undefined): GraphSettings {
  if (!raw) return { ...DEFAULT_GRAPH_SETTINGS };
  try {
    return clampSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_GRAPH_SETTINGS };
  }
}

export const serializeGraphSettings = (s: GraphSettings) => JSON.stringify(clampSettings(s));

export const withSetting = (s: GraphSettings, key: GraphSettingKey, value: unknown): GraphSettings => ({
  ...s,
  [key]: clampSetting(key, value),
});

export const isDefaultSettings = (s: GraphSettings) =>
  GRAPH_SETTING_KEYS.every((k) => s[k] === DEFAULT_GRAPH_SETTINGS[k]);

/** Physics-only keys: changing them reheats the simulation; display keys only redraw. */
export const isLayoutSetting = (key: GraphSettingKey) =>
  GRAPH_SETTING_RANGES[key].group === "layout" || GRAPH_SETTING_RANGES[key].group === "physics";
