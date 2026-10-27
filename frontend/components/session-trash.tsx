"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { listTrash, purgeTrash, restoreTrash } from "@/lib/api";
import { relativeTime } from "@/lib/session-ux";
import { touchesTrash, trashText, type TrashEntry } from "@/lib/session-trash";
import type { SseEventType } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { useEventSubscription } from "./server-events";
import { ConfirmDialog } from "./session-ux";

const TRASH_EVENTS: SseEventType[] = ["session:updated"];

/** Trash entries, refetched on SSE frames that can change them (notify -> fetch, no polling). */
export function useSessionTrash() {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const list = await listTrash();
      if (mounted.current) setEntries(list);
    } catch {
      // Backend warming up or no vault yet: keep the last list.
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEventSubscription(TRASH_EVENTS, (frame) => {
    if (touchesTrash(frame.data)) void refresh();
  });

  return { entries, loading, refresh };
}

/**
 * Trashed sessions with "Restore" and "Delete permanently" (behind a confirm dialog).
 * `onRestored` receives the restored session id (the sidebar navigates to it).
 */
export function SessionTrashList({
  entries,
  loading,
  refresh,
  onRestored,
}: {
  entries: TrashEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
  onRestored?: (sessionId: string, entry: TrashEntry) => void;
}) {
  const { locale } = useLocale();
  const tt = trashText(locale);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ file: string; text: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; sessionId: string | null } | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashEntry | null>(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const now = Date.now();

  const restore = async (entry: TrashEntry) => {
    if (busyFile) return;
    setBusyFile(entry.file);
    setRowError(null);
    setNotice(null);
    try {
      const result = await restoreTrash(entry.file);
      if (entry.graph_unlinked && !result.graphRestored) {
        setNotice({ text: tt.restoredGraphNote, sessionId: result.sessionId });
      }
      await refresh();
      if (result.sessionId) onRestored?.(result.sessionId, entry);
    } catch (err) {
      setRowError({ file: entry.file, text: `${tt.restoreFailed} ${err instanceof Error ? err.message : ""}`.trim() });
    } finally {
      setBusyFile(null);
    }
  };

  const confirmPurge = async () => {
    if (!purgeTarget || purgeBusy) return;
    setPurgeBusy(true);
    setPurgeError(null);
    try {
      await purgeTrash(purgeTarget.file);
      setPurgeTarget(null);
      await refresh();
    } catch (err) {
      setPurgeError(`${tt.purgeFailed} ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setPurgeBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 font-ui">
      {notice && (
        <p role="status" className="flex items-start gap-1.5 text-[11px] text-warning">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>
            {notice.text}{" "}
            {notice.sessionId && (
              <Link href={`/chat/${notice.sessionId}`} className="underline hover:text-foreground">
                {tt.openSession}
              </Link>
            )}
          </span>
        </p>
      )}
      {loading && entries.length === 0 ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {tt.loading}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">{tt.empty}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={tt.heading}>
          {entries.map((entry) => {
            const busy = busyFile === entry.file;
            const when = relativeTime(entry.deleted_at, now, locale);
            return (
              <li key={entry.file} className="p-3 bg-background border border-border rounded flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-prose text-[13px] font-medium text-foreground break-words min-w-0">
                    {entry.title || tt.untitled}
                  </span>
                  <span className="text-[9.5px] uppercase px-1 py-px bg-card border border-border text-muted-foreground rounded shrink-0">
                    {entry.mode}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  {when && <span title={entry.deleted_at}>{tt.deleted(when)}</span>}
                  <span aria-hidden="true">·</span>
                  <span>{tt.messages(entry.message_count)}</span>
                  {entry.graph_unlinked && (
                    <span
                      className="px-1 py-px rounded border border-warning/40 bg-warning/10 text-warning text-[10px]"
                      title={tt.graphUnlinkedTitle}
                    >
                      {tt.graphUnlinked}
                    </span>
                  )}
                </div>
                {entry.graph_unlinked && (
                  <p className="text-[11px] text-muted-foreground">{tt.graphUnlinkedTitle}</p>
                )}
                {rowError?.file === entry.file && (
                  <p role="alert" className="flex items-start gap-1.5 text-[11px] text-danger">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span className="break-words">{rowError.text}</span>
                  </p>
                )}
                <div className="flex flex-wrap justify-end gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => {
                      setPurgeError(null);
                      setPurgeTarget(entry);
                    }}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-danger/50 text-danger hover:bg-danger/10 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {tt.purge}
                  </button>
                  <button
                    type="button"
                    onClick={() => void restore(entry)}
                    disabled={busyFile !== null}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-border bg-accent hover:bg-border text-foreground font-semibold cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                    {busy ? tt.restoring : tt.restore}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={purgeTarget !== null}
        fixed
        danger
        title={tt.purgeTitle}
        body={tt.purgeBody(purgeTarget?.title || tt.untitled)}
        confirmLabel={tt.purgeConfirm}
        busyLabel={tt.purgeBusy}
        busy={purgeBusy}
        error={purgeError}
        onCancel={() => setPurgeTarget(null)}
        onConfirm={() => void confirmPurge()}
      />
    </div>
  );
}

/** Sidebar modal: the trash list; a restore navigates to the session and closes it. */
export function SessionTrashDialog({
  open,
  onClose,
  trash,
}: {
  open: boolean;
  onClose: () => void;
  trash: ReturnType<typeof useSessionTrash>;
}) {
  const { locale } = useLocale();
  const tt = trashText(locale);
  const router = useRouter();
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-trash-title"
        className="w-full max-w-lg max-h-[80vh] flex flex-col bg-card border border-border rounded-xl shadow-2xl font-ui"
      >
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <div>
            <h3 id="session-trash-title" className="font-title text-base font-bold text-foreground">
              {tt.heading}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-1">{tt.hint}</p>
          </div>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            aria-label={tt.close}
            title={tt.close}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 pb-5 overflow-y-auto">
          <SessionTrashList
            entries={trash.entries}
            loading={trash.loading}
            refresh={trash.refresh}
            onRestored={(sessionId, entry) => {
              // With graph nodes unlinked, stay open so the learner reads the notice first.
              if (entry.graph_unlinked) return;
              onClose();
              router.push(`/chat/${sessionId}`);
            }}
          />
        </div>
      </div>
    </div>
  );
}
