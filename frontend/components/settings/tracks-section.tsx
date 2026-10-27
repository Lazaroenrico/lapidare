"use client";

/**
 * Configurações → Trilhas (Fase 14): list with progress and job state,
 * activate, inline rename, archive/unarchive, regenerate, delete (confirmed)
 * and "Nova trilha". Every mutation is followed by `config:updated` (and
 * `jobs:updated` for generation), which refetches the list.
 */

import React, { useMemo, useState } from "react";
import { Archive, ArchiveRestore, Check, Loader2, Pencil, Plus, RefreshCw, Target, Trash2 } from "lucide-react";
import { canRegenerate, orderTracks, toneForTrack, trackTones, TITLE_MAX_TRACK, type TrackSummary } from "@/lib/tracks";
import { activateTrack, deleteTrack, regenerateTrack, updateTrack } from "@/lib/tracks-api";
import { tracksText } from "@/lib/tracks-i18n";
import { useLocale } from "@/components/locale-provider";
import { useTracks } from "@/components/use-tracks";
import { NewTrackDialog } from "@/components/new-track-dialog";
import { ConfirmDialog } from "@/components/session-ux";
import { TrackDot, TrackJobState, TrackProgressBar } from "@/components/tracks-ui";
import { Banner, errMsg } from "@/components/import-ui";
import { buttonClass, SectionHeader } from "./ui";

type Action = "activate" | "rename" | "archive" | "regenerate" | "delete";

const iconButton =
  "inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-background hover:bg-accent text-muted-foreground hover:text-foreground font-ui text-[11px] cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export function TracksSection() {
  const { locale } = useLocale();
  const tt = tracksText(locale);
  const { tracks, loaded, error: loadError } = useTracks();
  const ordered = useMemo(() => orderTracks(tracks), [tracks]);
  const tones = useMemo(() => trackTones(tracks), [tracks]);
  const live = ordered.filter((t) => !t.archived);
  const archived = ordered.filter((t) => t.archived);

  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState<{ id: string; action: Action } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<TrackSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const run = async (track: TrackSummary, action: Action, fn: () => Promise<unknown>) => {
    setBusy({ id: track.id, action });
    setRowError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setRowError({ id: track.id, text: errMsg(err, tt.actionFailed) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const commitRename = async (track: TrackSummary) => {
    const title = draft.replace(/\s+/g, " ").trim();
    if (!title || title === track.title || title.length > TITLE_MAX_TRACK) {
      setRenaming(null);
      return;
    }
    if (await run(track, "rename", () => updateTrack(track.id, { title }))) setRenaming(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    setBusy({ id: deleteTarget.id, action: "delete" });
    try {
      await deleteTrack(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(errMsg(err, tt.actionFailed));
    } finally {
      setBusy(null);
    }
  };

  const row = (track: TrackSummary) => {
    const tone = toneForTrack(track.id, tones);
    const isBusy = busy?.id === track.id;
    const spin = (action: Action) => isBusy && busy?.action === action;
    return (
      <li
        key={track.id}
        className={`p-3 rounded border space-y-2 ${track.active ? "bg-accent/40 border-muted-foreground" : "bg-card border-border"} ${
          track.archived ? "opacity-75" : ""
        }`}
      >
        <div className="flex items-start gap-2">
          <TrackDot tone={tone} className="mt-1.5" />
          <div className="flex-1 min-w-0 space-y-1">
            {renaming === track.id ? (
              <input
                autoFocus
                value={draft}
                maxLength={TITLE_MAX_TRACK}
                aria-label={tt.renameLabel}
                disabled={isBusy}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitRename(track)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void commitRename(track);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
                className="w-full bg-background border border-border focus:border-foreground rounded px-2 py-1 font-ui text-[12.5px] text-foreground"
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-ui text-[12.5px] font-semibold text-foreground break-words">{track.title}</span>
                {track.active && !track.archived && (
                  <span className="inline-flex items-center gap-1 px-1.5 rounded border border-success/40 bg-success/10 text-success font-ui text-[10px]">
                    <Check className="w-3 h-3" aria-hidden />
                    {tt.activeBadge}
                  </span>
                )}
                {track.archived && (
                  <span className="px-1.5 rounded border border-border bg-background text-muted-foreground font-ui text-[10px]">
                    {tt.archivedBadge}
                  </span>
                )}
                <span className="font-ui text-[10.5px] text-muted-foreground">{tt.sources[track.source]}</span>
              </div>
            )}
            <TrackProgressBar track={track} tone={tone} className="max-w-sm" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-[11px] text-muted-foreground">
              {track.next_item && <span className="truncate max-w-full">{tt.nextStep(track.next_item.title)}</span>}
              <TrackJobState track={track} generatingLabel={tt.generating} errorLabel={track.error ? tt.generationError(track.error) : ""} />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pl-4">
          {!track.active && !track.archived && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run(track, "activate", () => activateTrack(track.id))}
              className={iconButton}
            >
              {spin("activate") ? <Loader2 className="w-3 h-3 animate-spin" /> : <Target className="w-3 h-3" />}
              {tt.activate}
            </button>
          )}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setRenaming(track.id);
              setDraft(track.title);
              setRowError(null);
            }}
            className={iconButton}
          >
            {spin("rename") ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pencil className="w-3 h-3" />}
            {tt.rename}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run(track, "archive", () => updateTrack(track.id, { archived: !track.archived }))}
            className={iconButton}
          >
            {spin("archive") ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : track.archived ? (
              <ArchiveRestore className="w-3 h-3" />
            ) : (
              <Archive className="w-3 h-3" />
            )}
            {track.archived ? tt.unarchive : tt.archive}
          </button>
          {canRegenerate(track) && !track.archived && (
            <button
              type="button"
              disabled={busy !== null || track.generating}
              title={tt.regenerateTitle}
              onClick={() => void run(track, "regenerate", () => regenerateTrack(track.id))}
              className={iconButton}
            >
              <RefreshCw className={`w-3 h-3 ${spin("regenerate") || track.generating ? "animate-spin" : ""}`} />
              {tt.regenerate}
            </button>
          )}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setDeleteTarget(track);
              setDeleteError(null);
            }}
            className={`${iconButton} hover:text-danger hover:border-danger/60`}
          >
            <Trash2 className="w-3 h-3" />
            {tt.delete}
          </button>
        </div>

        {rowError?.id === track.id && (
          <p role="alert" className="pl-4 font-ui text-[11px] text-danger break-words">
            {rowError.text}
          </p>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <SectionHeader title={tt.heading} hint={tt.hint} />
        <button type="button" onClick={() => setNewOpen(true)} className={`${buttonClass} shrink-0`}>
          <Plus className="w-3.5 h-3.5" />
          {tt.newTrack}
        </button>
      </div>

      {!loaded && (
        <div className="py-10 flex items-center justify-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      )}
      {loaded && loadError && tracks.length === 0 && <Banner tone="error">{`${tt.loadFailed} ${loadError}`}</Banner>}
      {loaded && !loadError && tracks.length === 0 && (
        <p className="p-4 bg-card border border-dashed border-border rounded font-ui text-xs text-muted-foreground">{tt.empty}</p>
      )}

      {live.length > 0 && <ul className="space-y-2">{live.map(row)}</ul>}

      {archived.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{tt.archivedHeading}</h3>
          <ul className="space-y-2">{archived.map(row)}</ul>
        </div>
      )}

      <NewTrackDialog open={newOpen} onClose={() => setNewOpen(false)} />

      <ConfirmDialog
        open={deleteTarget !== null}
        fixed
        danger
        title={tt.deleteTitle}
        body={deleteTarget ? tt.deleteBody(deleteTarget.title) : ""}
        confirmLabel={tt.deleteConfirm}
        busyLabel={tt.deleteConfirm}
        busy={busy?.action === "delete"}
        error={deleteError}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
