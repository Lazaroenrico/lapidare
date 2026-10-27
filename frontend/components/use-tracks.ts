"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SseEventType } from "@/lib/types";
import type { TrackSummary } from "@/lib/tracks";
import { listTracks } from "@/lib/tracks-api";
import { useEventSubscription } from "./server-events";

/** Track changes broadcast `config:updated`; generation progress comes as `jobs:updated`. */
const TRACK_EVENTS: SseEventType[] = ["config:updated", "jobs:updated"];

export interface TracksState {
  tracks: TrackSummary[];
  /** True after the first answer (success or failure). */
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** `GET /api/tracks`, refetched on SSE notifications (notify → fetch, no polling). */
export function useTracks(): TracksState {
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await listTracks();
      if (!mounted.current || mine !== seq.current) return;
      setTracks(next);
      setError(null);
    } catch (err) {
      if (!mounted.current || mine !== seq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current && mine === seq.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEventSubscription(TRACK_EVENTS, () => void refresh());

  return { tracks, loaded, error, refresh };
}
