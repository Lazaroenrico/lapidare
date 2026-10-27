"use client";

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Layers, Loader2, RotateCcw, X } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { useShortcut } from "@/components/use-shortcut";
import { normalizeTitle, TITLE_MAX, type LocalSteer } from "@/lib/session-ux";
import type { SessionCompaction } from "@/lib/types";
import { formatTokens } from "@/lib/usage";

const chip = "px-1.5 py-0.5 rounded border font-ui text-[10px] uppercase tracking-wider";

// --- Steer badges ------------------------------------------------------------------------

/** "na fila" badge on a learner steer the agent has not received yet. */
export function SteerQueuedBadge() {
  const { t } = useLocale();
  return (
    <span className={`${chip} border-warning/60 text-warning`} title={t.uxSteerQueuedTitle}>
      {t.uxSteerQueued}
    </span>
  );
}

/** Optimistic bubble for a steer still in flight (or that failed to send). */
export function LocalSteerBubble({
  steer,
  onRetry,
  onDiscard,
}: {
  steer: LocalSteer;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { t } = useLocale();
  const failed = steer.status === "failed";
  return (
    <div className="flex justify-end my-2">
      <div
        className={`max-w-[85%] rounded-lg bg-card border p-3.5 text-foreground font-prose text-[15.5px] leading-relaxed shadow-sm whitespace-pre-wrap ${
          failed ? "border-danger/60" : "border-border opacity-80"
        }`}
      >
        <span className="font-ui text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-2 mb-1">
          {t.you}
          <span className={`${chip} ${failed ? "border-danger/60 text-danger" : "border-border text-muted-foreground"}`}>
            {failed ? t.uxSteerFailed : t.uxSteerSending}
          </span>
        </span>
        {steer.content}
        {failed && (
          <div className="flex justify-end gap-2 mt-2 font-ui text-[11px]">
            <button
              type="button"
              onClick={onDiscard}
              className="flex items-center gap-1 px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              <X className="w-3 h-3" />
              {t.uxSteerDiscard}
            </button>
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-1 px-2 py-1 rounded border border-border bg-accent text-foreground hover:bg-border cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              {t.uxSteerRetry}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Confirm dialog ------------------------------------------------------------------------

/**
 * Modal confirmation (Esc → dismiss question / abort, sidebar delete). Esc and the
 * backdrop cancel; the cancel button gets the focus so a second Esc never confirms.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busyLabel,
  busy,
  error,
  danger = false,
  fixed = false,
  children,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  error: string | null;
  danger?: boolean;
  /** Viewport overlay (sidebar) instead of covering the positioned parent (session). */
  fixed?: boolean;
  children?: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  if (!open) return null;
  return (
    <div
      className={`${fixed ? "fixed" : "absolute"} inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4`}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) onCancel();
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-sm bg-card border border-border rounded-xl p-5 shadow-2xl font-ui"
      >
        <h3 id="confirm-dialog-title" className="font-title text-base font-bold text-foreground mb-2">
          {title}
        </h3>
        <p className="font-prose text-[13px] text-muted-foreground mb-4 break-words">{body}</p>
        {children}
        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-[11px] text-danger mb-3">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="break-words">{error}</span>
          </p>
        )}
        <div className="flex justify-end gap-2 text-xs">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded border border-border bg-background hover:bg-accent text-foreground cursor-pointer disabled:cursor-not-allowed"
          >
            {t.cancel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded border bg-accent hover:bg-border font-semibold cursor-pointer disabled:opacity-60 ${
              danger ? "border-danger/60 text-danger" : "border-border text-foreground"
            }`}
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Compaction ----------------------------------------------------------------------------

/** "Contexto resumido aqui": the agent sees a summary of everything above. */
export function CompactionDivider({ compaction }: { compaction: SessionCompaction }) {
  const { locale, t } = useLocale();
  const tokens = compaction.tokens_before !== null ? formatTokens(compaction.tokens_before, locale) : "?";
  return (
    <div
      className="flex items-center gap-3 my-2 select-none"
      role="separator"
      aria-label={t.uxCompactionDivider}
      title={t.uxCompactionTitle(tokens)}
    >
      <div className="flex-1 h-px bg-border" />
      <span className="flex items-center gap-1.5 font-ui text-[10.5px] uppercase tracking-wider text-muted-foreground">
        <Layers className="w-3 h-3" />
        {t.uxCompactionDivider}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

/** Placeholder at the end of the transcript while `execution_status === "compacting"`. */
export function CompactingPlaceholder() {
  const { t } = useLocale();
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 my-3 font-ui text-[11px] tracking-wider text-muted-foreground">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      <span className="animate-pulse">{t.uxCompacting}</span>
    </div>
  );
}

// --- Inline rename ---------------------------------------------------------------------------

/**
 * Session title: click or F2 (`useShortcut("rename")`) turns it into an input. Enter saves
 * through `onRename` (PUT /api/chats/{id}); Esc or blur without changes cancels.
 */
export function SessionTitle({
  title,
  onRename,
  onEditingChange,
}: {
  title: string;
  onRename: (title: string) => Promise<void>;
  onEditingChange?: (editing: boolean) => void;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const setMode = (next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  };

  const start = () => {
    setDraft(title);
    setError(null);
    setMode(true);
  };

  useShortcut("rename", () => {
    if (!editing) start();
  });

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    const next = normalizeTitle(draft, title);
    if (!next) {
      setMode(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(next);
      setMode(false);
    } catch (err) {
      setError(`${t.uxRenameFailed} ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <h1 className="font-title font-bold text-lg md:text-xl text-foreground truncate">
        <button
          type="button"
          onClick={start}
          title={t.uxRenameTitle}
          className="truncate max-w-full text-left cursor-text rounded hover:bg-card px-1 -mx-1"
        >
          {title}
        </button>
      </h1>
    );
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={draft}
          maxLength={TITLE_MAX}
          disabled={busy}
          aria-label={t.uxRenameLabel}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (!busy && !error) void commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              // Owns Esc: the abort chain (useShortcut skips prevented events) must not fire.
              e.preventDefault();
              e.stopPropagation();
              setMode(false);
            }
          }}
          className="font-title font-bold text-lg md:text-xl text-foreground bg-card border border-border rounded px-2 py-0.5 min-w-[240px] focus:border-foreground"
        />
        {busy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
      </div>
      {error && (
        <span role="alert" className="font-ui text-[11px] text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
