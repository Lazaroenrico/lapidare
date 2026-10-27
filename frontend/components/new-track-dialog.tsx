"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { isGithubRepoUrl } from "@/lib/import-wire";
import { buildCreateTrack, emptyTrackDraft, type DraftError, type NewTrackDraft, type TrackSummary } from "@/lib/tracks";
import { createTrack } from "@/lib/tracks-api";
import { tracksText } from "@/lib/tracks-i18n";
import { useLocale } from "./locale-provider";
import { Banner, Btn, errMsg } from "./import-ui";
import { TrackCreateForm } from "./track-create-form";

/** Modal "Nova trilha" → POST /api/tracks. The list refreshes through `config:updated`. */
export function NewTrackDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (track: TrackSummary | null) => void;
}) {
  const { locale } = useLocale();
  const tt = tracksText(locale);
  const [draft, setDraft] = useState<NewTrackDraft>(() => emptyTrackDraft());
  const [fieldError, setFieldError] = useState<DraftError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyTrackDraft());
    setFieldError(null);
    setSubmitError(null);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const built = buildCreateTrack(draft, isGithubRepoUrl);
    if (!built.ok) {
      setFieldError(built.error);
      return;
    }
    setFieldError(null);
    setSubmitError(null);
    setBusy(true);
    try {
      const track = await createTrack(built.payload);
      onCreated?.(track);
      onClose();
    } catch (err) {
      setSubmitError(errMsg(err, tt.createFailed));
    } finally {
      setBusy(false);
    }
  };

  // Portal: the composer dock is its own stacking context.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/75 backdrop-blur-xs p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-track-title"
        onSubmit={submit}
        className="w-full max-w-xl max-h-[90vh] overflow-y-auto bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4 font-ui"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id="new-track-title" className="font-title text-base font-bold text-foreground">
            {tt.dialogTitle}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={tt.cancel}
            title={tt.cancel}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <TrackCreateForm draft={draft} onChange={setDraft} error={fieldError} disabled={busy} />

        {submitError && <Banner tone="error">{submitError}</Banner>}

        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            {tt.cancel}
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            {busy ? tt.creating : tt.create}
          </Btn>
        </div>
      </form>
    </div>,
    document.body,
  );
}
