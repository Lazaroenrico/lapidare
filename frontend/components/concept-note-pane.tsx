"use client";

import React, { useEffect, useState } from "react";
import { FileText, Loader2, Lock, NotebookText, X } from "lucide-react";
import { ApiError, getConceptNote, getSourceNote, isAbortError, type ConceptNote } from "@/lib/api";
import { LessonProse } from "./lesson-prose";
import { useLocale } from "./locale-provider";

interface ConceptNotePaneProps {
  conceptId: string | null;
  conceptName: string;
  fallbackPath: string;
  onClose: () => void;
  /** Fase 16: show a source note (`GET /api/graph/sources/{id}/note`) instead of a concept note. */
  sourceId?: string | null;
}

/**
 * Read-only slide-over showing a concept note (Conceitos/*.md) rendered with LessonProse.
 * Mirrors SourceCitationPane styling. Never writes to the Vault.
 */
export function ConceptNotePane({ conceptId: concept, conceptName, fallbackPath, onClose, sourceId = null }: ConceptNotePaneProps) {
  // One pane, two read-only origins: a concept note or a vault note the graph was fed with.
  const conceptId = sourceId ?? concept;
  const { t } = useLocale();
  const [note, setNote] = useState<ConceptNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ notFound: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!conceptId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [conceptId, onClose]);

  useEffect(() => {
    if (!conceptId) {
      setNote(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setNote(null);
    (sourceId ? getSourceNote(sourceId, controller.signal) : getConceptNote(conceptId, controller.signal))
      .then(setNote)
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        const notFound = err instanceof ApiError && err.status === 404;
        setError({ notFound, message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [conceptId, sourceId]);

  if (!conceptId) return null;

  const path = note?.path || fallbackPath;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/60 backdrop-blur-xs transition-opacity animate-fade-in">
      <div className="fixed inset-0 cursor-pointer" onClick={onClose} aria-hidden="true" />

      <aside
        className="relative w-full max-w-lg md:max-w-xl h-full bg-card border-l border-border shadow-2xl flex flex-col font-ui text-xs z-10 select-text"
        aria-label={t.notePaneAria}
      >
        <div className="p-4 bg-background border-b border-border flex flex-col gap-2 select-none">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <NotebookText className="w-4 h-4 text-muted-foreground" />
              <span className="font-title font-bold text-sm text-foreground">{conceptName}</span>
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-card border border-border text-[10px] text-muted-foreground">
                <Lock className="w-2.5 h-2.5" />
                {t.readOnlyVault}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded cursor-pointer transition-colors"
              title={t.closePaneEsc}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-1.5 truncate mt-1">
            <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-[12px] font-prose font-semibold text-foreground truncate">{path}</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="font-ui text-xs">{t.noteLoading}</span>
            </div>
          ) : error ? (
            <div className="p-4 rounded bg-background border border-warning/40 text-warning font-prose text-sm flex flex-col gap-2">
              <p className="font-semibold font-ui text-xs">
                {error.notFound ? t.noteNotFoundTitle : t.noteErrorTitle}
              </p>
              <p className="text-[13px] text-muted-foreground">
                {error.notFound ? t.noteNotFoundBody(path) : error.message}
              </p>
            </div>
          ) : note ? (
            <LessonProse content={note.markdown} />
          ) : null}
        </div>

        <div className="p-3 bg-background border-t border-border flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            Obsidian: <code>[[{sourceId ? path.replace(/\.md$/, "") : conceptName}]]</code>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 bg-card hover:bg-accent text-foreground border border-border rounded cursor-pointer transition-colors"
          >
            {t.close}
          </button>
        </div>
      </aside>
    </div>
  );
}
