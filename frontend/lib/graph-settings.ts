/**
 * Graph view settings (⚙ panel): display + physics, with defaults, ranges and
 * clamping. Persisted per browser under `learnharness:graph-settings`; callers
 * do the storage access (inside try/catch) and pass the raw string here.
 */

export const GRAPH_SETTINGS_KEY = "learnharness:graph-settings";

export interface GraphSettings {
  // Display
  nodeSize: number;
  edgeWidth: number;
  labelSize: number;
  /** Zoom level from which every label is drawn (selected/hovered always are). */
  labelZoom: number;
  /** Opacity multiplier of the cluster regions. */
  regionIntensity: number;
  // Physics
  repulsion: number;
  attraction: number;
  linkDistance: number;
  centerGravity: number;
  clusterCohesion: number;
}

export type GraphSettingKey = keyof GraphSettings;

export interface SettingRange {
  min: number;
  max: number;
  step: number;
  default: number;
  group: "display" | "physics";
}

export const GRAPH_SETTING_RANGES: Record<GraphSettingKey, SettingRange> = {
  nodeSize: { min: 6, max: 36, step: 1, default: 14, group: "display" },
  edgeWidth: { min: 0.5, max: 4, step: 0.25, default: 1, group: "display" },
  labelSize: { min: 8, max: 18, step: 0.5, default: 11, group: "display" },
  labelZoom: { min: 0.25, max: 2.5, step: 0.05, default: 0.7, group: "display" },
  regionIntensity: { min: 0, max: 1, step: 0.05, default: 0.5, group: "display" },
  repulsion: { min: 200, max: 8000, step: 100, default: 2400, group: "physics" },
  attraction: { min: 0.005, max: 0.2, step: 0.005, default: 0.045, group: "physics" },
  linkDistance: { min: 30, max: 300, step: 5, default: 110, group: "physics" },
  centerGravity: { min: 0, max: 0.05, step: 0.001, default: 0.008, group: "physics" },
  clusterCohesion: { min: 0, max: 0.08, step: 0.002, default: 0.018, group: "physics" },
};

export const GRAPH_SETTING_KEYS = Object.keys(GRAPH_SETTING_RANGES) as GraphSettingKey[];

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = Object.fromEntries(
  GRAPH_SETTING_KEYS.map((k) => [k, GRAPH_SETTING_RANGES[k].default]),
) as unknown as GraphSettings;

export function clampSetting(key: GraphSettingKey, value: unknown): number {
  const r = GRAPH_SETTING_RANGES[key];
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return r.default;
  return Math.min(r.max, Math.max(r.min, n));
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
