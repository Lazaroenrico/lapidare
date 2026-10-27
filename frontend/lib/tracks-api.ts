/** HTTP calls for várias trilhas (Fase 14). Errors are shown inline by callers: silent. */
import { fetchJson } from "./api";
import { decodeTrack, decodeTracks, type CreateTrackPayload, type TrackSummary } from "./tracks";

const silent = { silent: true };
const trackPath = (id: string, suffix = "") => `/api/tracks/${encodeURIComponent(id)}${suffix}`;

/** Mutations may answer with the track, `{track}` or nothing: the SSE refetch is the source of truth. */
const maybeTrack = (raw: unknown): TrackSummary | null => {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  return decodeTrack(r && r.track && typeof r.track === "object" ? r.track : raw);
};

export const listTracks = async (): Promise<TrackSummary[]> =>
  decodeTracks(await fetchJson<unknown>("/api/tracks", {}, silent));

export const createTrack = async (payload: CreateTrackPayload): Promise<TrackSummary | null> =>
  maybeTrack(await fetchJson<unknown>("/api/tracks", { method: "POST", body: JSON.stringify(payload) }, silent));

export const updateTrack = async (
  id: string,
  patch: { title?: string; archived?: boolean; goal_description?: string },
): Promise<TrackSummary | null> =>
  maybeTrack(await fetchJson<unknown>(trackPath(id), { method: "PUT", body: JSON.stringify(patch) }, silent));

export const activateTrack = async (id: string): Promise<TrackSummary | null> =>
  maybeTrack(await fetchJson<unknown>(trackPath(id, "/activate"), { method: "POST" }, silent));

export const regenerateTrack = async (id: string): Promise<TrackSummary | null> =>
  maybeTrack(await fetchJson<unknown>(trackPath(id, "/regenerate"), { method: "POST" }, silent));

/** Fase 15: opens (or reopens) the leveling TEACH session; returns its id. */
export const startLeveling = async (trackId: string): Promise<string> => {
  const raw = await fetchJson<{ id?: unknown }>(trackPath(trackId, "/leveling"), { method: "POST" }, silent);
  if (!raw || typeof raw.id !== "string" || !raw.id) throw new Error("Leveling session without id");
  return raw.id;
};

/** Fase 15: restores the flags from the leveling snapshot (409 once a leveled step changed). */
export const undoLeveling = async (trackId: string, sessionId: string): Promise<TrackSummary | null> =>
  maybeTrack(
    await fetchJson<unknown>(
      trackPath(trackId, `/leveling/${encodeURIComponent(sessionId)}/undo`),
      { method: "POST" },
      silent,
    ),
  );

export const deleteTrack = async (id: string): Promise<void> => {
  await fetchJson<unknown>(trackPath(id), { method: "DELETE" }, silent);
};
