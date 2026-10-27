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
  // Constellation look: tiny dots, hairline threads, small labels.
  nodeSize: { min: 1, max: 12, step: 0.5, default: 2.5, group: "display" },
  edgeWidth: { min: 0.25, max: 3, step: 0.05, default: 0.75, group: "display" },
  labelSize: { min: 7, max: 16, step: 0.5, default: 9.5, group: "display" },
  labelZoom: { min: 0.25, max: 4, step: 0.05, default: 1.6, group: "display" },
  regionIntensity: { min: 0, max: 1, step: 0.05, default: 0.6, group: "display" },
  repulsion: { min: 50, max: 4000, step: 25, default: 320, group: "physics" },
  attraction: { min: 0.005, max: 0.2, step: 0.005, default: 0.06, group: "physics" },
  linkDistance: { min: 15, max: 200, step: 1, default: 45, group: "physics" },
  centerGravity: { min: 0, max: 0.05, step: 0.001, default: 0.006, group: "physics" },
  clusterCohesion: { min: 0, max: 0.08, step: 0.002, default: 0.016, group: "physics" },
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
