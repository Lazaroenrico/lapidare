"use client";

import React from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { progressLabel, progressRatio, type TrackSummary } from "@/lib/tracks";
import { toneAlpha, type PaletteTone } from "@/lib/palette";

/** Thin `feitos/total` bar; the fill uses the track's palette tone when given. */
export function TrackProgressBar({
  track,
  tone,
  className = "",
  showLabel = true,
}: {
  track: TrackSummary;
  tone?: PaletteTone;
  className?: string;
  showLabel?: boolean;
}) {
  const pct = Math.round(progressRatio(track.progress) * 100);
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={track.progress.total}
        aria-valuenow={track.progress.done}
        aria-label={progressLabel(track.progress)}
        className="relative h-1 flex-1 min-w-[48px] rounded-full bg-accent overflow-hidden"
      >
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${tone ? "" : "bg-success"}`}
          style={{ width: `${pct}%`, ...(tone ? { backgroundColor: toneAlpha(tone, 0.9) } : {}) }}
        />
      </span>
      {showLabel && (
        <span className="font-ui text-[10.5px] text-muted-foreground tabular-nums shrink-0">{progressLabel(track.progress)}</span>
      )}
    </span>
  );
}

/** Small dot in the track's tone (legend, sidebar tag). */
export function TrackDot({ tone, className = "" }: { tone: PaletteTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${className}`}
      style={{ backgroundColor: toneAlpha(tone, 0.9) }}
    />
  );
}

/** "gerando…" / error state of the track's `track:<id>` job. */
export function TrackJobState({
  track,
  generatingLabel,
  errorLabel,
}: {
  track: TrackSummary;
  generatingLabel: string;
  errorLabel: string;
}) {
  if (track.generating) {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] text-warning">
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
        {generatingLabel}
      </span>
    );
  }
  if (track.error) {
    return (
      <span className="inline-flex items-start gap-1 text-[10.5px] text-danger" title={track.error}>
        <AlertCircle className="w-3 h-3 shrink-0 mt-px" aria-hidden />
        {/* The reason says what to do (e.g. quota spent → switch the main model), so show it. */}
        <span className="line-clamp-3">
          {errorLabel}: {track.error}
        </span>
      </span>
    );
  }
  return null;
}
