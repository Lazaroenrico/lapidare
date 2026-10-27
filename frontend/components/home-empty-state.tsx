"use client";

import React, { useState } from "react";
import { homeEmptyText, homeEmptyView, roadmapStepsFor } from "@/lib/home-empty";
import { findActiveTrack } from "@/lib/tracks";
import type { RoadmapItem } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { SessionTrashDialog, useSessionTrash } from "./session-trash";
import { useTracks } from "./use-tracks";

/**
 * Home vazia: with 0 graph nodes, ONE quiet centred explanation over the canvas (no card,
 * no buttons). Only the small "Restaurar sessões (N)" link takes pointer events. It
 * disappears as soon as a snapshot brings the first node (the Home forwards the counts).
 */
export function HomeEmptyState({
  graphLoaded,
  nodeCount,
  roadmap,
}: {
  graphLoaded: boolean;
  nodeCount: number;
  roadmap: readonly RoadmapItem[];
}) {
  const { locale, t } = useLocale();
  const tx = homeEmptyText(locale);
  const trash = useSessionTrash();
  const { tracks } = useTracks();
  const [trashOpen, setTrashOpen] = useState(false);

  const activeTrackId = findActiveTrack(tracks)?.id ?? null;
  const view = homeEmptyView({
    graphLoaded,
    nodeCount,
    trashCount: trash.entries.length,
    activeTrackId,
    activeRoadmapSteps: roadmapStepsFor(roadmap, activeTrackId),
  });

  const dialog = <SessionTrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} trash={trash} />;
  if (!view.show) return dialog;

  return (
    <>
      <div className="absolute inset-x-0 top-24 bottom-64 z-[5] flex items-center justify-center px-6 pointer-events-none">
        <section
          aria-label={tx.regionLabel}
          data-home-empty="centered"
          className="max-w-lg text-center font-prose text-[14px] leading-relaxed text-muted-foreground"
        >
          <h2 className="font-title text-lg font-bold text-foreground mb-2">{t.homeEmptyTitle}</h2>
          <p>{t.homeEmptyLine1}</p>
          <p>{t.homeEmptyLine2}</p>
          {view.suggestRoadmap && <p className="mt-2 text-foreground">{t.homeEmptyTrack}</p>}
          {view.restoreCount > 0 && (
            <button
              type="button"
              onClick={() => setTrashOpen(true)}
              data-home-empty-action="restore"
              className="pointer-events-auto mt-3 font-ui text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-border hover:decoration-muted-foreground cursor-pointer transition-colors"
            >
              {tx.restore(view.restoreCount)}
            </button>
          )}
        </section>
      </div>
      {dialog}
    </>
  );
}
