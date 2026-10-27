"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BackgroundJobStatus, SseEventType } from "@/lib/types";
import { getBackgroundJobs } from "@/lib/api";

export interface ServerEventFrame {
  type: SseEventType;
  data: unknown;
  timestamp: number;
}

type EventListener = (event: ServerEventFrame) => void;

type Subscribe = (
  eventTypes: SseEventType | SseEventType[],
  callback: EventListener
) => () => void;

interface ServerEventsContextValue {
  connected: boolean;
  activeJobs: BackgroundJobStatus[];
  subscribe: Subscribe;
  refreshJobs: () => Promise<void>;
}

const ServerEventsContext = createContext<ServerEventsContextValue | null>(null);
// `subscribe` never changes: subscribers read it from here, so a frame (or a jobs
// refresh) re-renders only the components whose own callbacks set state.
const SubscribeContext = createContext<Subscribe | null>(null);

const KNOWN_EVENT_TYPES: SseEventType[] = [
  "session:updated",
  "dock:opened",
  "dock:resolved",
  "plan:updated",
  "vault:changed",
  "graph:updated",
  "jobs:updated",
  "config:updated",
  "usage:updated",
];

export function ServerEventsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [connected, setConnected] = useState<boolean>(false);
  const [activeJobs, setActiveJobs] = useState<BackgroundJobStatus[]>([]);

  // Map of event listeners
  const listenersRef = useRef<Map<SseEventType, Set<EventListener>>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const backoffRef = useRef<number>(1000);
  const isMountedRef = useRef<boolean>(true);

  const fetchJobs = useCallback(async () => {
    try {
      const jobs = await getBackgroundJobs();
      if (isMountedRef.current) {
        setActiveJobs(jobs || []);
      }
    } catch {
      // In early boot or if backend is warming up, silently ignore
    }
  }, []);

  const dispatchEvent = useCallback(
    (type: SseEventType, data: unknown) => {
      const frame: ServerEventFrame = {
        type,
        data,
        timestamp: Date.now(),
      };

      if (type === "jobs:updated") {
        void fetchJobs();
      }

      const subs = listenersRef.current.get(type);
      if (subs) {
        subs.forEach((cb) => {
          try {
            cb(frame);
          } catch (err) {
            console.error(`[SSE] Error in event listener for ${type}:`, err);
          }
        });
      }
    },
    [fetchJobs]
  );

  const connect = useCallback(() => {
    if (typeof window === "undefined") return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    try {
      const es = new EventSource("/api/events");
      eventSourceRef.current = es;

      es.onopen = () => {
        if (!isMountedRef.current) return;
        setConnected(true);
        backoffRef.current = 1000; // Reset exponential backoff
        for (const type of KNOWN_EVENT_TYPES) dispatchEvent(type, { resync: true });
      };

      es.onerror = () => {
        if (!isMountedRef.current) return;
        setConnected(false);
        es.close();
        eventSourceRef.current = null;

        // Exponential backoff up to 16 seconds
        const delay = Math.min(backoffRef.current, 16000);
        backoffRef.current = delay * 1.5;

        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            connect();
          }
        }, delay);
      };

      // Listen to generic messages
      es.onmessage = (msgEvent) => {
        try {
          const parsed = JSON.parse(msgEvent.data);
          const type: SseEventType = parsed.type || parsed.event;
          const payload = parsed.payload !== undefined ? parsed.payload : parsed.data || parsed;
          if (type && KNOWN_EVENT_TYPES.includes(type)) {
            dispatchEvent(type, payload);
          }
        } catch {
          // Non-JSON message frame
        }
      };

      // Listen to specific named events
      KNOWN_EVENT_TYPES.forEach((type) => {
        es.addEventListener(type, (event: MessageEvent) => {
          try {
            const parsed = JSON.parse(event.data);
            const payload = parsed.payload !== undefined ? parsed.payload : parsed;
            dispatchEvent(type, payload);
          } catch {
            dispatchEvent(type, event.data);
          }
        });
      });
    } catch {
      // In case EventSource fails immediately (e.g. offline)
      const delay = Math.min(backoffRef.current, 16000);
      backoffRef.current = delay * 1.5;
      reconnectTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          connect();
        }
      }, delay);
    }
  }, [dispatchEvent]);

  useEffect(() => {
    isMountedRef.current = true;
    connect();
    const configChanged = () => dispatchEvent("config:updated", { resync: true });
    window.addEventListener("harness:config", configChanged);

    return () => {
      window.removeEventListener("harness:config", configChanged);
      isMountedRef.current = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect, dispatchEvent]);

  const subscribe = useCallback(
    (
      eventTypes: SseEventType | SseEventType[],
      callback: EventListener
    ): (() => void) => {
      const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];

      types.forEach((type) => {
        if (!listenersRef.current.has(type)) {
          listenersRef.current.set(type, new Set());
        }
        listenersRef.current.get(type)!.add(callback);
      });

      return () => {
        types.forEach((type) => {
          const set = listenersRef.current.get(type);
          if (set) {
            set.delete(callback);
            if (set.size === 0) {
              listenersRef.current.delete(type);
            }
          }
        });
      };
    },
    []
  );

  const value = useMemo(
    () => ({ connected, activeJobs, subscribe, refreshJobs: fetchJobs }),
    [connected, activeJobs, subscribe, fetchJobs]
  );

  return (
    <SubscribeContext.Provider value={subscribe}>
      <ServerEventsContext.Provider value={value}>{children}</ServerEventsContext.Provider>
    </SubscribeContext.Provider>
  );
}

export function useServerEvents(): ServerEventsContextValue {
  const ctx = useContext(ServerEventsContext);
  if (!ctx) {
    throw new Error(
      "useServerEvents must be used within a <ServerEventsProvider />"
    );
  }
  return ctx;
}

export function useEventSubscription(
  eventTypes: SseEventType | SseEventType[],
  callback: (event: ServerEventFrame) => void
): void {
  const subscribe = useContext(SubscribeContext);
  if (!subscribe) {
    throw new Error("useEventSubscription must be used within a <ServerEventsProvider />");
  }
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  // Keyed by content, so an inline array literal does not resubscribe on every render.
  const key = (Array.isArray(eventTypes) ? eventTypes : [eventTypes]).join(" ");

  useEffect(() => {
    const unsub = subscribe(key.split(" ") as SseEventType[], (frame) => {
      callbackRef.current(frame);
    });
    return unsub;
  }, [subscribe, key]);
}
