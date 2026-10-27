"use client";

/**
 * Nivelamento de trilha (Fase 15): the "Nivelar esta trilha" action, the
 * LevelingDoneCard (with Undo) and the "Nivelamento" phase chip.
 * The track chip and Settings refresh through `config:updated` (notify → fetch).
 */

import React, { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, ListChecks, Undo2 } from "lucide-react";
import { startLeveling, undoLeveling } from "@/lib/tracks-api";
import { tracksText } from "@/lib/tracks-i18n";
import type { LevelingResult } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { ConfirmDialog } from "./session-ux";
import { errMsg } from "./import-ui";

/** Starts (or reopens) the leveling session of a track and opens it. */
export function useStartLeveling() {
  const router = useRouter();
  const { locale } = useLocale();
  const tt = tracksText(locale);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ trackId: string; text: string } | null>(null);

  const start = useCallback(
    async (trackId: string): Promise<boolean> => {
      setBusyId(trackId);
      setError(null);
      try {
        const sessionId = await startLeveling(trackId);
        router.push(`/chat/${encodeURIComponent(sessionId)}`);
        return true;
      } catch (err) {
        setError({ trackId, text: errMsg(err, tt.levelFailed) });
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [router, tt.levelFailed],
  );

  return { start, busyId, error };
}

const chip = "px-1.5 py-0.5 rounded border font-ui text-[10.5px] uppercase tracking-wider";

/** Header chip of a leveling session (it has no Planejamento → Ensino cycle). */
export function LevelingPhaseChip({ completed }: { completed: boolean }) {
  const { locale, t } = useLocale();
  const tt = tracksText(locale);
  return (
    <span className="flex items-center gap-1" aria-label={t.phaseChipAria}>
      <span className={`${chip} border-foreground bg-accent text-foreground font-semibold`}>{tt.levelingPhase}</span>
      {completed && <span className={`${chip} border-success/60 text-success`}>{t.phaseName("completed")}</span>}
    </span>
  );
}

/** Result of `leveling_done`: known steps (collapsible), the start, the summary and Undo. */
export function LevelingDoneCard({ leveling, sessionId }: { leveling: LevelingResult; sessionId: string }) {
  const { locale } = useLocale();
  const tt = tracksText(locale);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = leveling.known_items;
  const undone = leveling.undone_at !== null;

  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await undoLeveling(leveling.track_id, sessionId);
      // `session:updated` / `config:updated` refetch the session and the track chip.
      setConfirming(false);
    } catch (err) {
      setError(errMsg(err, tt.levelingUndoFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-3 px-4 pt-3">
        <span className="flex items-center gap-2 min-w-0">
          <ListChecks className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="font-ui text-[12.5px] font-semibold text-foreground">{tt.levelingDone}</span>
        </span>
        {!undone && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-background hover:bg-accent text-muted-foreground hover:text-foreground font-ui text-[11px] cursor-pointer transition-colors shrink-0"
          >
            <Undo2 className="w-3 h-3" />
            {tt.levelingUndo}
          </button>
        )}
      </div>

      <div className={`px-4 pt-2 pb-3 flex flex-col gap-2 ${undone ? "opacity-60" : ""}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-[12px]">
          <span className={undone ? "line-through text-muted-foreground" : "text-foreground"}>{tt.levelingKnown(known.length)}</span>
          {known.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {open ? tt.levelingHideList : tt.levelingShowList}
            </button>
          )}
        </div>
        {open && known.length > 0 && (
          <ul className="flex flex-col gap-0.5 pl-4 border-l border-accent">
            {known.map((item) => (
              <li key={item.id} className="font-prose text-[14px] leading-relaxed text-foreground select-text">
                {item.title}
              </li>
            ))}
          </ul>
        )}
        {leveling.start_item && (
          <span className="font-ui text-[12px] text-foreground">{tt.levelingStart(leveling.start_item.title)}</span>
        )}
        {leveling.summary && (
          <p className="font-prose text-[14px] leading-relaxed text-foreground select-text">{leveling.summary}</p>
        )}
        {undone && <p className="font-ui text-[11px] text-muted-foreground">{tt.levelingUndone}</p>}
      </div>

      <ConfirmDialog
        open={confirming}
        fixed
        title={tt.levelingUndoTitle}
        body={tt.levelingUndoBody(known.length)}
        confirmLabel={tt.levelingUndo}
        busyLabel={tt.levelingUndoing}
        busy={busy}
        error={error}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void undo()}
      />
    </div>
  );
}
