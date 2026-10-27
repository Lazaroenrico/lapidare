/**
 * Nivelamento de trilha (Fase 15): pure logic for the "Nivelar esta trilha"
 * button and the LevelingDoneCard.
 *
 * Wire:
 * - `POST /api/tracks/{id}/leveling` → the TEACH session (`context_kind: "leveling"`);
 * - `GET /api/chats/{id}` → `leveling: {track_id, known_items: [{id, title}],
 *   start_item: {id, title} | null, summary, created_at, undone_at}` once
 *   `leveling_done` ran (null before);
 * - `POST /api/tracks/{id}/leveling/{session_id}/undo` → `{ok, session_id, track}`
 *   (409 when a leveled step changed afterwards).
 */
import type { LevelingItemRef, LevelingResult } from "./types";

/** Below this many pending steps a diagnosis costs more than walking the steps (backend rule). */
export const MIN_PENDING_FOR_LEVELING = 4;

type Wire = Record<string, unknown>;
const isObj = (v: unknown): v is Wire => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function pendingSteps(track: { progress: { done: number; total: number } }): number {
  return Math.max(0, track.progress.total - track.progress.done);
}

/** The button shows for live tracks (not archived, not generating) with ≥ 4 pending steps. */
export function canLevelTrack(track: {
  archived: boolean;
  generating: boolean;
  progress: { done: number; total: number };
}): boolean {
  return !track.archived && !track.generating && pendingSteps(track) >= MIN_PENDING_FOR_LEVELING;
}

function decodeRef(raw: unknown): LevelingItemRef | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id).trim();
  return id ? { id, title: str(raw.title).trim() || id } : null;
}

/** Defensive decoding of `session.leveling`; null when absent or unusable. */
export function decodeLeveling(raw: unknown): LevelingResult | null {
  if (!isObj(raw)) return null;
  const trackId = str(raw.track_id).trim();
  if (!trackId) return null;
  const known = Array.isArray(raw.known_items)
    ? raw.known_items.map(decodeRef).filter((r): r is LevelingItemRef => r !== null)
    : [];
  const undone = str(raw.undone_at);
  return {
    track_id: trackId,
    known_items: known,
    start_item: decodeRef(raw.start_item),
    summary: str(raw.summary).trim(),
    created_at: str(raw.created_at),
    undone_at: undone || null,
  };
}

export const isLevelingSession = (session: { teach_context?: string | null; context_kind?: string | null }): boolean =>
  session.teach_context === "leveling" || session.context_kind === "leveling";
