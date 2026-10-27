"use client";

import React, { useEffect, useMemo, useState } from "react";
import { FolderInput, MessageSquarePlus, RotateCcw, Route } from "lucide-react";
import {
  ROADMAP_AUTO_KEY,
  buildConstellation,
  decodeAutoRoadmap,
  homeEmptyLayout,
  homeEmptyText,
  homeEmptyView,
  rememberAutoRoadmap,
  roadmapStepsFor,
  shouldAutoRoadmap,
  showRoadmapSuggestion,
} from "@/lib/home-empty";
import { findActiveTrack } from "@/lib/tracks";
import type { RoadmapItem } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { requestComposerFocus } from "./composer-focus";
import { requestRoadmapOn, useRoadmapDrawn } from "./roadmap-request";
import { NewTrackDialog } from "./new-track-dialog";
import { SessionTrashDialog, useSessionTrash } from "./session-trash";
import { useTracks } from "./use-tracks";

/** Same breakpoint as the graph's roadmap inset (`sm`). */
const WIDE_QUERY = "(min-width: 640px)";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the auto-on may repeat next time, which is harmless.
  }
}

/** Viewport width class, updated on `change` (an event, not polling). */
function useWideScreen(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(WIDE_QUERY);
    } catch {
      return;
    }
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

/** Faint decorative sky (tokens only): dust stars plus one small linked figure. */
function ConstellationSky({ className = "" }: { className?: string }) {
  const sky = useMemo(() => buildConstellation(), []);
  return (
    <svg viewBox={`0 0 ${sky.width} ${sky.height}`} className={className} aria-hidden="true" focusable="false">
      {sky.links.map(([a, b]) => (
        <line
          key={`${a}-${b}`}
          x1={sky.stars[a].x}
          y1={sky.stars[a].y}
          x2={sky.stars[b].x}
          y2={sky.stars[b].y}
          className="stroke-border"
          strokeWidth={0.8}
          strokeDasharray={a === 1 && b === 3 ? "2 3" : undefined}
        />
      ))}
      {sky.stars.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} className="fill-muted-foreground" opacity={s.alpha} />
      ))}
    </svg>
  );
}

const actionClass =
  "group flex items-start gap-2.5 w-full text-left bg-background/60 hover:bg-accent border border-border hover:border-muted-foreground rounded-lg transition-colors cursor-pointer";

/**
 * Fase 18 — Home vazia: with 0 graph nodes, a discreet constellation-style first-steps
 * card over the empty canvas. Disappears as soon as a snapshot brings the first node
 * (the graph refetches on SSE `graph:updated`; the Home forwards the counts here).
 */
export function HomeEmptyState({
  graphLoaded,
  nodeCount,
  roadmap,
  onOpenImport,
}: {
  graphLoaded: boolean;
  nodeCount: number;
  roadmap: readonly RoadmapItem[];
  onOpenImport: () => void;
}) {
  const { locale } = useLocale();
  const tx = homeEmptyText(locale);
  const trash = useSessionTrash();
  const { tracks } = useTracks();
  const roadmapOn = useRoadmapDrawn();
  const wide = useWideScreen();
  const [trackOpen, setTrackOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  const activeTrackId = findActiveTrack(tracks)?.id ?? null;
  const view = homeEmptyView({
    graphLoaded,
    nodeCount,
    trashCount: trash.entries.length,
    activeTrackId,
    activeRoadmapSteps: roadmapStepsFor(roadmap, activeTrackId),
  });

  // Active track + empty graph: turn ⇶ Roteiro on once per track (remembered locally).
  useEffect(() => {
    const seen = decodeAutoRoadmap(readStorage(ROADMAP_AUTO_KEY));
    if (!activeTrackId || !shouldAutoRoadmap(view, activeTrackId, seen, wide)) return;
    writeStorage(ROADMAP_AUTO_KEY, rememberAutoRoadmap(seen, activeTrackId));
    requestRoadmapOn();
  }, [view.show, view.suggestRoadmap, activeTrackId, wide]); // eslint-disable-line react-hooks/exhaustive-deps

  const dialogs = (
    <>
      <NewTrackDialog open={trackOpen} onClose={() => setTrackOpen(false)} />
      <SessionTrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} trash={trash} />
    </>
  );
  if (!view.show) return dialogs;

  const beside = homeEmptyLayout(roadmapOn, wide) === "beside-roadmap";
  const suggest = showRoadmapSuggestion(view, roadmapOn);
  // The active-track chip sits above the composer: keep clear of it too.
  const bottom = activeTrackId ? "bottom-72" : "bottom-64 max-sm:bottom-60";
  // Beside the roadmap: the graph's reserved left column, under the ⇶ legend (w-72).
  const frame = beside
    ? `left-4 w-72 top-64 ${bottom} items-end`
    : `inset-x-0 ${activeTrackId ? "top-24 max-sm:top-40" : "top-24"} ${bottom} items-center justify-center px-4`;

  return (
    <>
      <div className={`absolute ${frame} z-[5] flex pointer-events-none`}>
        <section
          aria-label={tx.regionLabel}
          data-home-empty={beside ? "beside-roadmap" : "centered"}
          className={`pointer-events-auto w-full max-h-full overflow-y-auto bg-card/70 backdrop-blur border border-border font-ui shadow-lg ${
            beside ? "rounded-lg p-2.5" : "max-w-md sm:max-w-2xl rounded-xl px-5 py-4"
          }`}
        >
          {!beside && !suggest && <ConstellationSky className="w-full h-14 sm:h-16 mb-1" />}
          {!beside && <h2 className="font-title text-base font-bold text-foreground leading-tight">{tx.title}</h2>}
          <p className={beside ? "font-prose text-xs leading-snug text-muted-foreground mb-2" : "font-prose text-sm text-muted-foreground mt-1 mb-3"}>
            {tx.lead}
          </p>

          {suggest && (
            <button
              type="button"
              onClick={requestRoadmapOn}
              data-home-empty-action="roadmap"
              className="flex items-start gap-2 w-full text-left mb-3 bg-accent border border-muted-foreground rounded-lg px-3 py-2 hover:border-foreground transition-colors cursor-pointer"
            >
              <Route className="w-3.5 h-3.5 mt-0.5 text-success shrink-0" />
              <span className="min-w-0">
                <span className="block text-xs text-foreground">{tx.roadmapSuggest}</span>
                <span className="block text-[11px] text-muted-foreground">{tx.roadmapHint}</span>
              </span>
            </button>
          )}

          <div className={beside ? "flex flex-col gap-1" : "grid grid-cols-1 sm:grid-cols-3 gap-2"}>
            <EmptyAction
              compact={beside}
              phoneHint={!suggest}
              icon={<MessageSquarePlus className="w-3.5 h-3.5" />}
              label={tx.startTopic}
              hint={tx.startTopicHint}
              onClick={requestComposerFocus}
              action="topic"
            />
            <EmptyAction
              compact={beside}
              phoneHint={!suggest}
              icon={<FolderInput className="w-3.5 h-3.5" />}
              label={tx.importNotes}
              hint={tx.importNotesHint}
              onClick={onOpenImport}
              action="import"
            />
            <EmptyAction
              compact={beside}
              phoneHint={!suggest}
              icon={<Route className="w-3.5 h-3.5" />}
              label={tx.createTrack}
              hint={tx.createTrackHint}
              onClick={() => setTrackOpen(true)}
              action="track"
            />
          </div>

          {view.restoreCount > 0 && (
            <button
              type="button"
              onClick={() => setTrashOpen(true)}
              data-home-empty-action="restore"
              className={`${beside ? "mt-2" : "mt-3"} inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-border hover:decoration-muted-foreground cursor-pointer transition-colors`}
            >
              <RotateCcw className="w-3 h-3" />
              {tx.restore(view.restoreCount)}
            </button>
          )}
        </section>
      </div>
      {dialogs}
    </>
  );
}

function EmptyAction({
  icon,
  label,
  hint,
  onClick,
  action,
  compact,
  phoneHint,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  action: string;
  compact: boolean;
  /** False: the hint hides on phones (room for the ⇶ suggestion). */
  phoneHint: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-home-empty-action={action}
      title={compact ? hint : undefined}
      className={`${actionClass} ${compact ? "px-2 py-1" : "px-3 py-2"}`}
    >
      <span className="text-muted-foreground group-hover:text-foreground shrink-0 mt-0.5">{icon}</span>
      <span className="min-w-0">
        <span className={`block text-foreground ${compact ? "text-[11px] whitespace-nowrap" : "text-xs"}`}>{label}</span>
        {!compact && <span className={`block text-[11px] text-muted-foreground ${phoneHint ? "" : "max-sm:hidden"}`}>{hint}</span>}
      </span>
    </button>
  );
}
