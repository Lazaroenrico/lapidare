/**
 * Várias trilhas (Fase 14): pure decoding and view logic.
 *
 * Wire: `GET /api/tracks` → TrackSummary[] (also `config.tracks` in
 * `GET /api/setup/status`). Everything here is defensive: unknown or missing
 * fields fall back to safe defaults so a backend mid-migration never breaks
 * the chip, the Settings list, the sidebar filter or the ⇶ Roteiro legend.
 */
import type { PaletteTone } from "./palette";

export type TrackSource = "repo" | "github" | "goal" | "manual" | "legacy";

export interface TrackProgress {
  done: number;
  total: number;
}

export interface TrackSummary {
  id: string;
  title: string;
  source: TrackSource;
  mode: string;
  archived: boolean;
  active: boolean;
  created_at: string;
  progress: TrackProgress;
  next_item: { id: string; title: string } | null;
  generating: boolean;
  error: string | null;
}

type Wire = Record<string, unknown>;
const isObj = (v: unknown): v is Wire => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const count = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const SOURCES: readonly TrackSource[] = ["repo", "github", "goal", "manual", "legacy"];

export function decodeTrack(raw: unknown, activeId?: string | null): TrackSummary | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id).trim();
  if (!id) return null;
  const p = isObj(raw.progress) ? raw.progress : {};
  const total = count(p.total);
  const done = Math.min(count(p.done), total);
  const next = isObj(raw.next_item) && str(raw.next_item.id)
    ? { id: str(raw.next_item.id), title: str(raw.next_item.title) || str(raw.next_item.id) }
    : null;
  const source = SOURCES.includes(raw.source as TrackSource) ? (raw.source as TrackSource) : "goal";
  const error = typeof raw.error === "string" && raw.error.trim() ? raw.error : null;
  return {
    id,
    title: str(raw.title).trim() || id,
    source,
    mode: str(raw.mode, "free"),
    archived: raw.archived === true,
    active: activeId ? id === activeId : raw.active === true,
    created_at: str(raw.created_at),
    progress: { done, total },
    next_item: next,
    generating: raw.generating === true,
    error,
  };
}

/** Decodes a list (bare array or `{tracks: [...]}`); drops invalid entries and duplicate ids. */
export function decodeTracks(raw: unknown, activeId?: string | null): TrackSummary[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.tracks) ? raw.tracks : [];
  const out: TrackSummary[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const track = decodeTrack(item, activeId);
    if (track && !seen.has(track.id)) {
      seen.add(track.id);
      out.push(track);
    }
  }
  // At most one active track, even if the payload disagrees with itself.
  let activeSeen = false;
  return out.map((t) => {
    if (!t.active) return t;
    if (activeSeen) return { ...t, active: false };
    activeSeen = true;
    return t;
  });
}

// --- Progress ----------------------------------------------------------------

/** 0..1 share of finished items (0 when the queue is empty). */
export const progressRatio = (p: TrackProgress): number =>
  p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0;

export const progressLabel = (p: TrackProgress): string => `${p.done}/${p.total}`;

export const isTrackComplete = (p: TrackProgress): boolean => p.total > 0 && p.done >= p.total;

// --- Ordering ------------------------------------------------------------------

const byCreation = (a: TrackSummary, b: TrackSummary) =>
  a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at < b.created_at ? -1 : 1;

/** Active first, then the other non-archived tracks by creation, archived ones last. */
export function orderTracks(tracks: readonly TrackSummary[]): TrackSummary[] {
  const rank = (t: TrackSummary) => (t.active && !t.archived ? 0 : t.archived ? 2 : 1);
  return [...tracks].sort((a, b) => rank(a) - rank(b) || byCreation(a, b));
}

/** Tracks the switcher menu lists: not archived, active first. */
export const switchableTracks = (tracks: readonly TrackSummary[]): TrackSummary[] =>
  orderTracks(tracks.filter((t) => !t.archived));

export const findActiveTrack = (tracks: readonly TrackSummary[]): TrackSummary | null =>
  tracks.find((t) => t.active && !t.archived) ?? null;

// --- Colours -------------------------------------------------------------------

/** Per-track tones, drawn from the palette (never off-token colours). */
export const TRACK_TONES: readonly PaletteTone[] = [
  "success",
  "warning",
  "danger",
  ["success", "foreground", 0.5],
  ["warning", "danger", 0.5],
  ["success", "warning", 0.5],
  ["danger", "foreground", 0.45],
  "mutedForeground",
];

/**
 * Stable tone per track id: assigned by creation order over every known track
 * (archived included), so a track keeps its colour when others are archived.
 */
export function trackTones(tracks: readonly TrackSummary[]): Map<string, PaletteTone> {
  const out = new Map<string, PaletteTone>();
  [...tracks].sort(byCreation).forEach((t, i) => out.set(t.id, TRACK_TONES[i % TRACK_TONES.length]));
  return out;
}

/** Tone for a track id, also for ids only known from roadmap items (hash fallback). */
export function toneForTrack(trackId: string | null | undefined, tones: Map<string, PaletteTone>): PaletteTone {
  if (!trackId) return "mutedForeground";
  const known = tones.get(trackId);
  if (known) return known;
  let h = 0;
  for (let i = 0; i < trackId.length; i++) h = (h * 31 + trackId.charCodeAt(i)) >>> 0;
  return TRACK_TONES[h % TRACK_TONES.length];
}

// --- Labels --------------------------------------------------------------------

/** Short tag for session rows: the title cut at a word boundary, max `max` chars. */
export function shortTrackTag(title: string, max = 14): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  if (clean.charAt(max - 1) === " ") return `${cut.trimEnd()}…`;
  const space = cut.lastIndexOf(" ");
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type TrackRef = { kind: "track"; track: TrackSummary } | { kind: "removed" } | { kind: "none" };

/** What a session's `track_id` points to; orphan ids read as "trilha removida". */
export function resolveTrackRef(trackId: string | null | undefined, tracks: readonly TrackSummary[]): TrackRef {
  if (!trackId) return { kind: "none" };
  const track = tracks.find((t) => t.id === trackId);
  return track ? { kind: "track", track } : { kind: "removed" };
}

// --- Sidebar filter ------------------------------------------------------------

export const TRACK_FILTER_ALL = "all";
export const TRACK_FILTER_NONE = "none";
/** `all`, `none` or `track:<id>`. */
export type TrackFilter = string;

export const trackFilterFor = (trackId: string): TrackFilter => `track:${trackId}`;

export function filterByTrack<T extends { track_id?: string | null }>(items: readonly T[], filter: TrackFilter): T[] {
  if (filter === TRACK_FILTER_ALL) return [...items];
  if (filter === TRACK_FILTER_NONE) return items.filter((s) => !s.track_id);
  const id = filter.startsWith("track:") ? filter.slice("track:".length) : filter;
  return items.filter((s) => s.track_id === id);
}

/** A filter pointing at a track that no longer exists falls back to `all`. */
export function sanitizeTrackFilter(filter: TrackFilter, tracks: readonly TrackSummary[]): TrackFilter {
  if (filter === TRACK_FILTER_ALL || filter === TRACK_FILTER_NONE) return filter;
  const id = filter.startsWith("track:") ? filter.slice("track:".length) : filter;
  return tracks.some((t) => t.id === id) ? filter : TRACK_FILTER_ALL;
}

export function parseTrackFilter(raw: string | null | undefined): TrackFilter {
  if (!raw) return TRACK_FILTER_ALL;
  if (raw === TRACK_FILTER_ALL || raw === TRACK_FILTER_NONE || /^track:.+/.test(raw)) return raw;
  return TRACK_FILTER_ALL;
}

// --- Roadmap (⇶ Roteiro) -------------------------------------------------------

export interface RoadmapRef {
  trackId: string | null;
  itemId: string;
}

/**
 * Splits a roadmap id: `track:<track_id>:<item_id>` (Fase 14) or the legacy
 * `track:<item_id>`. `trackId` (from the item's `track_id`) disambiguates ids
 * that contain colons.
 */
export function parseRoadmapId(id: string, trackId?: string | null): RoadmapRef {
  const rest = id.replace(/^track:/, "");
  if (trackId) {
    const prefix = `${trackId}:`;
    return { trackId, itemId: rest.startsWith(prefix) ? rest.slice(prefix.length) : rest };
  }
  const colon = rest.indexOf(":");
  if (colon > 0) return { trackId: rest.slice(0, colon), itemId: rest.slice(colon + 1) };
  return { trackId: null, itemId: rest };
}

export type RoadmapScope = "focus" | "all";

/** "Só a trilha em foco" keeps the active track's items (and legacy items without a track). */
export function filterRoadmap<T extends { track_id?: string | null }>(
  items: readonly T[],
  scope: RoadmapScope,
  activeTrackId: string | null | undefined,
): T[] {
  if (scope === "all" || !activeTrackId) return [...items];
  return items.filter((i) => !i.track_id || i.track_id === activeTrackId);
}

export interface RoadmapLegendEntry {
  trackId: string;
  title: string;
  tone: PaletteTone;
  count: number;
}

export function roadmapLegend(
  items: readonly { track_id?: string | null; track_title?: string | null }[],
  tones: Map<string, PaletteTone>,
): RoadmapLegendEntry[] {
  const out = new Map<string, RoadmapLegendEntry>();
  for (const i of items) {
    if (!i.track_id) continue;
    const entry = out.get(i.track_id);
    if (entry) entry.count += 1;
    else out.set(i.track_id, {
      trackId: i.track_id,
      title: i.track_title?.trim() || i.track_id,
      tone: toneForTrack(i.track_id, tones),
      count: 1,
    });
  }
  return [...out.values()];
}

// --- Creation ------------------------------------------------------------------

export type NewTrackTab = "goal" | "manual" | "repo" | "github";

export interface NewTrackDraft {
  tab: NewTrackTab;
  title: string;
  goal: string;
  topics: string;
  repoPath: string;
  githubUrl: string;
  activate: boolean;
}

export const GOAL_MAX = 20000;
export const TITLE_MAX_TRACK = 200;

export interface CreateTrackPayload {
  title: string;
  source: "goal" | "manual" | "repo" | "github";
  goal_description?: string;
  items?: string[];
  repo_path?: string;
  github_url?: string;
  activate: boolean;
}

/** One topic per line; bullets, numbering and checkboxes are stripped, blanks and repeats dropped. */
export function parseTopicList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const topic = line
      .replace(/^\s*(?:[-*+•]\s+)?(?:\[[ xX]\]\s+)?(?:\d+[.)]\s+)?/, "")
      .replace(/\s+/g, " ")
      .trim();
    const key = topic.toLowerCase();
    if (topic && !seen.has(key)) {
      seen.add(key);
      out.push(topic);
    }
  }
  return out;
}

/** Last path segment (`~/cursos/ml-101/` → `ml-101`). */
export const repoName = (path: string): string =>
  path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

/** `https://github.com/owner/repo(.git)(/tree/...)` → `owner/repo`. */
export function githubSlug(url: string): string {
  const m = url.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/i, "")}` : "";
}

export type DraftError = "title" | "goal" | "goalTooLong" | "topics" | "repo" | "github";

/** Builds the POST /api/tracks body, or the first problem with the draft. */
export function buildCreateTrack(
  draft: NewTrackDraft,
  isGithubUrl: (url: string) => boolean,
): { ok: true; payload: CreateTrackPayload } | { ok: false; error: DraftError } {
  const title = draft.title.replace(/\s+/g, " ").trim();
  switch (draft.tab) {
    case "goal": {
      const goal = draft.goal.trim();
      if (!goal) return { ok: false, error: "goal" };
      if (goal.length > GOAL_MAX) return { ok: false, error: "goalTooLong" };
      if (!title) return { ok: false, error: "title" };
      return { ok: true, payload: { title, source: "goal", goal_description: goal, activate: draft.activate } };
    }
    case "manual": {
      const items = parseTopicList(draft.topics);
      if (items.length === 0) return { ok: false, error: "topics" };
      if (!title) return { ok: false, error: "title" };
      return { ok: true, payload: { title, source: "manual", items, activate: draft.activate } };
    }
    case "repo": {
      const repo = draft.repoPath.trim();
      if (!repo) return { ok: false, error: "repo" };
      const name = title || repoName(repo);
      if (!name) return { ok: false, error: "title" };
      return { ok: true, payload: { title: name, source: "repo", repo_path: repo, activate: draft.activate } };
    }
    case "github": {
      const url = draft.githubUrl.trim();
      if (!url || !isGithubUrl(url)) return { ok: false, error: "github" };
      const name = title || githubSlug(url);
      if (!name) return { ok: false, error: "title" };
      return { ok: true, payload: { title: name, source: "github", github_url: url, activate: draft.activate } };
    }
  }
}

export const emptyTrackDraft = (tab: NewTrackTab = "goal"): NewTrackDraft => ({
  tab,
  title: "",
  goal: "",
  topics: "",
  repoPath: "",
  githubUrl: "",
  activate: true,
});

/** Sources whose queue can be rebuilt by POST /regenerate. */
export const canRegenerate = (t: TrackSummary): boolean =>
  t.source === "repo" || t.source === "github" || t.source === "goal";
