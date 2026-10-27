"use client";

/**
 * Home track chip (Fase 14): `⇶ <trilha> · Próximo: <item> [Continuar ↵] ▾`.
 * The ▾ opens the switcher: non-archived tracks with progress, the one in
 * focus, "gerando…"/error, "＋ Nova trilha" and "Gerenciar trilhas".
 * Hidden when there are no tracks (only TEACH/PRACTICE live in the composer).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ListChecks, Route } from "lucide-react";
import {
  findActiveTrack,
  isTrackComplete,
  switchableTracks,
  toneForTrack,
  trackTones,
  type TrackSummary,
} from "@/lib/tracks";
import { activateTrack } from "@/lib/tracks-api";
import { canLevelTrack, pendingSteps } from "@/lib/leveling";
import { tracksText } from "@/lib/tracks-i18n";
import { useLocale } from "./locale-provider";
import { NewTrackDialog } from "./new-track-dialog";
import { TrackDot, TrackJobState, TrackProgressBar } from "./tracks-ui";
import { errMsg } from "./import-ui";
import { useStartLeveling } from "./leveling-ui";

export interface TrackStep {
  id: string;
  title: string;
  /** null only for the pre-Fase 14 fallback (backend without /api/tracks). */
  trackId: string | null;
  sourcePath?: string;
}

export function TrackChip({
  tracks,
  nextStep,
  legacyStep,
  busy,
  onContinue,
}: {
  tracks: TrackSummary[];
  nextStep: TrackStep | null;
  /** Set when GET /api/tracks is unavailable: the old single-track chip. */
  legacyStep: TrackStep | null;
  busy: boolean;
  onContinue: () => void;
}) {
  const { locale, t } = useLocale();
  const tt = tracksText(locale);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const switchable = useMemo(() => switchableTracks(tracks), [tracks]);
  const tones = useMemo(() => trackTones(tracks), [tracks]);
  const active = findActiveTrack(tracks);
  const leveling = useStartLeveling();

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const choose = async (track: TrackSummary) => {
    setError(null);
    if (track.active) {
      setMenuOpen(false);
      return;
    }
    setActivating(track.id);
    try {
      await activateTrack(track.id);
      // `config:updated` refreshes the list (notify → fetch).
      setMenuOpen(false);
    } catch (err) {
      setError(errMsg(err, tt.activateFailed));
    } finally {
      setActivating(null);
    }
  };

  // Old single-track chip while the backend has no /api/tracks.
  if (legacyStep) {
    return (
      <div className="w-full flex justify-center">
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className="group flex items-center gap-2 bg-card/95 hover:bg-accent backdrop-blur border border-border hover:border-muted-foreground rounded-full px-3.5 py-1.5 shadow-lg transition-all cursor-pointer text-xs font-ui text-muted-foreground hover:text-foreground"
          title={tt.chipContinueTitle(legacyStep.title)}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          <Route className="w-3.5 h-3.5 text-success" />
          <span>{t.composerTrackActive}</span>
          <span className="text-foreground font-medium max-w-xs truncate">{legacyStep.title}</span>
          <span className="flex items-center gap-1 bg-accent group-hover:bg-border px-2 py-0.5 rounded-full text-[11px] text-foreground border border-border">
            {t.composerContinue}
          </span>
        </button>
      </div>
    );
  }

  if (switchable.length === 0) return null;

  const status = !active
    ? null
    : active.generating
      ? tt.menuGenerating
      : active.error
        ? tt.menuError
        : isTrackComplete(active.progress)
          ? tt.chipDone
          : active.progress.total === 0
            ? tt.chipEmpty
            : null;

  return (
    <div className="w-full flex justify-center">
      <div ref={rootRef} className="relative flex items-stretch max-w-full">
        <div className="flex items-stretch bg-card/95 backdrop-blur border border-border rounded-full shadow-lg text-xs font-ui text-muted-foreground overflow-hidden">
          <button
            type="button"
            onClick={onContinue}
            disabled={busy || !nextStep}
            className="group flex items-center gap-2 min-w-0 pl-3.5 pr-2 py-1.5 hover:bg-accent hover:text-foreground transition-colors cursor-pointer disabled:cursor-default disabled:hover:bg-transparent"
            title={nextStep ? tt.chipContinueTitle(nextStep.title) : active?.title}
            aria-keyshortcuts={nextStep ? "Control+Enter Meta+Enter" : undefined}
          >
            {active ? <TrackDot tone={toneForTrack(active.id, tones)} /> : <Route className="w-3.5 h-3.5 text-success" />}
            <span className="text-foreground font-medium max-w-[160px] truncate">⇶ {active ? active.title : tt.menuLabel}</span>
            {nextStep && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0">{tt.chipNext}</span>
                <span className="text-foreground max-w-[220px] truncate">{nextStep.title}</span>
                <span className="flex items-center gap-1 bg-accent group-hover:bg-border px-2 py-0.5 rounded-full text-[11px] text-foreground border border-border shrink-0">
                  {t.composerContinue}
                </span>
              </>
            )}
            {!nextStep && status && (
              <>
                <span aria-hidden>·</span>
                <span className={active?.error ? "text-danger" : active?.generating ? "text-warning" : ""}>{status}</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={tt.chipSwitch}
            title={tt.chipSwitch}
            className={`flex items-center px-2 border-l border-border hover:bg-accent hover:text-foreground transition-colors cursor-pointer ${
              menuOpen ? "bg-accent text-foreground" : ""
            }`}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>

        {menuOpen && (
          <div
            role="menu"
            aria-label={tt.menuLabel}
            className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-[320px] max-w-[calc(100vw-32px)] bg-card border border-border rounded-xl shadow-2xl p-1 font-ui z-40"
          >
            <div className="px-2 pt-1.5 pb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground">{tt.menuLabel}</div>
            <div className="max-h-[280px] overflow-y-auto">
              {switchable.map((track) => (
                <button
                  key={track.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={track.active}
                  disabled={activating !== null}
                  onClick={() => void choose(track)}
                  className={`w-full text-left px-2 py-1.5 rounded flex flex-col gap-1 cursor-pointer transition-colors hover:bg-accent focus-visible:bg-accent disabled:cursor-wait ${
                    track.active ? "bg-accent/60" : ""
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <TrackDot tone={toneForTrack(track.id, tones)} />
                    <span className="flex-1 min-w-0 truncate text-[12.5px] text-foreground">{track.title}</span>
                    {track.active && (
                      <span className="inline-flex items-center gap-1 text-[10.5px] text-success shrink-0">
                        <Check className="w-3 h-3" aria-hidden />
                        {tt.menuActive}
                      </span>
                    )}
                    {activating === track.id && <span className="text-[10.5px] text-muted-foreground">…</span>}
                  </span>
                  <span className="flex items-center gap-2 pl-4">
                    <TrackProgressBar track={track} tone={toneForTrack(track.id, tones)} className="flex-1" />
                    <TrackJobState track={track} generatingLabel={tt.menuGenerating} errorLabel={tt.menuError} />
                  </span>
                </button>
              ))}
            </div>
            {error && <p role="alert" className="px-2 py-1 text-[11px] text-danger">{error}</p>}
            {leveling.error && <p role="alert" className="px-2 py-1 text-[11px] text-danger">{leveling.error.text}</p>}
            <div className="border-t border-accent mt-1 pt-1 flex flex-col">
              {active && canLevelTrack(active) && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={leveling.busyId !== null}
                  title={tt.levelTrackTitle(pendingSteps(active))}
                  onClick={() => {
                    void leveling.start(active.id).then((ok) => ok && setMenuOpen(false));
                  }}
                  className="w-full text-left px-2 py-1.5 rounded text-[12px] text-foreground hover:bg-accent focus-visible:bg-accent cursor-pointer flex items-center gap-2 disabled:cursor-wait"
                >
                  <ListChecks className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
                  <span className="truncate">{tt.levelTrack}</span>
                  {leveling.busyId === active.id && <span className="text-[10.5px] text-muted-foreground">…</span>}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setNewOpen(true);
                }}
                className="w-full text-left px-2 py-1.5 rounded text-[12px] text-foreground hover:bg-accent focus-visible:bg-accent cursor-pointer"
              >
                {tt.menuNew}
              </button>
              <Link
                href="/settings#tracks"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                className="w-full px-2 py-1.5 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:bg-accent"
              >
                {tt.menuManage}
              </Link>
            </div>
          </div>
        )}
      </div>
      <NewTrackDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}
