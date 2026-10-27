"use client";

/**
 * ⇶ Roteiro chrome around the canvas constellations: the step card (hover and
 * pinned) and the legend (track colours, status glyphs, "Focar roteiro").
 */

import React from "react";
import { BookOpen, Focus, ListChecks, Loader2, X } from "lucide-react";
import type { RoadmapItem } from "@/lib/types";
import { palette, toneAlpha, type PaletteTone } from "@/lib/palette";
import type { RoadmapLegendEntry, RoadmapScope, TrackSummary } from "@/lib/tracks";
import { canLevelTrack, pendingSteps } from "@/lib/leveling";
import { tracksText } from "@/lib/tracks-i18n";
import { TrackDot } from "./tracks-ui";

type TT = ReturnType<typeof tracksText>;

const LEVELED_TONE: PaletteTone = ["success", "mutedForeground", 0.55];

export function stepStatusLabel(item: RoadmapItem, tt: TT): string {
  if (item.status === "completed") return item.status_detail === "nivelado" ? tt.stepStatus.leveled : tt.stepStatus.completed;
  return item.status === "active" ? tt.stepStatus.active : tt.stepStatus.pending;
}

/** Tiny SVG version of the canvas glyphs (legend + card header). */
export function StepGlyph({
  state,
  tone,
  shape = "circle",
}: {
  state: "completed" | "leveled" | "active" | "pending";
  tone: PaletteTone;
  shape?: "circle" | "diamond" | "square";
}) {
  const fill =
    state === "completed" ? toneAlpha(tone, 1) : state === "leveled" ? toneAlpha(LEVELED_TONE, 0.95) : state === "active" ? toneAlpha(tone, 1) : palette.background;
  const stroke = state === "pending" ? toneAlpha(tone, 0.85) : "none";
  const r = state === "active" ? 2.2 : 3;
  const body =
    shape === "diamond" ? (
      <path d={`M7 ${7 - 3.6} L${7 + 3.6} 7 L7 ${7 + 3.6} L${7 - 3.6} 7 Z`} fill={fill} stroke={stroke} strokeWidth={1} />
    ) : shape === "square" ? (
      <rect x={4.2} y={4.2} width={5.6} height={5.6} fill={fill} stroke={stroke} strokeWidth={1} />
    ) : (
      <circle cx={7} cy={7} r={r} fill={fill} stroke={stroke} strokeWidth={1} />
    );
  return (
    <svg aria-hidden width={14} height={14} viewBox="0 0 14 14" className="shrink-0">
      {state === "completed" && <circle cx={7} cy={7} r={6.5} fill={toneAlpha(tone, 0.22)} />}
      {state === "completed" && <path d="M1 7 H13 M7 1 V13" stroke={toneAlpha(tone, 0.55)} strokeWidth={0.8} />}
      {state === "active" && <circle cx={7} cy={7} r={5.2} fill="none" stroke={palette.foreground} strokeWidth={1.1} />}
      {body}
    </svg>
  );
}

const glyphState = (item: RoadmapItem) =>
  item.status === "completed" ? (item.status_detail === "nivelado" ? "leveled" : "completed") : item.status === "active" ? "active" : "pending";
const glyphShape = (kind: string) => (kind === "livre" || kind === "lab" ? "diamond" : kind === "base" ? "square" : "circle");

export interface RoadmapStepCardProps {
  item: RoadmapItem;
  tone: PaletteTone;
  track: TrackSummary | null;
  total: number;
  linkedCount: number;
  tt: TT;
  defaultModule: string;
  busy: "teach" | "level" | null;
  levelError?: string | null;
  onTeach: () => void;
  onLevel: () => void;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
  style?: React.CSSProperties;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function RoadmapStepCard({
  item,
  tone,
  track,
  total,
  linkedCount,
  tt,
  defaultModule,
  busy,
  levelError,
  onTeach,
  onLevel,
  onClose,
  closeLabel = "Fechar",
  className = "",
  style,
  onMouseEnter,
  onMouseLeave,
}: RoadmapStepCardProps) {
  const moduleTitle = item.module.title || defaultModule;
  const levelable = track ? canLevelTrack(track) : false;
  const kind = tt.stepKind[item.kind] ?? item.kind;
  return (
    <div
      className={`bg-card border border-border rounded-xl p-3.5 shadow-2xl font-ui ${className}`}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="dialog"
      aria-label={item.title}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <TrackDot tone={tone} />
            <span className="truncate">{item.track_title || tt.stepTrackItem}</span>
          </span>
          <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mt-1 truncate" title={moduleTitle}>
            {moduleTitle}
            {item.submodule ? ` › ${item.submodule.title}` : ""}
          </span>
          <h3 className="font-title text-base text-foreground font-bold leading-tight break-words mt-0.5">{item.title}</h3>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent" aria-label={closeLabel} title={closeLabel}>
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted-foreground mb-2.5">
        <span className="flex items-center gap-1 text-foreground">
          <StepGlyph state={glyphState(item)} tone={tone} shape={glyphShape(item.kind)} />
          {stepStatusLabel(item, tt)}
        </span>
        <span className="px-1.5 rounded border border-border bg-accent">{kind}</span>
        {total > 0 && <span>{tt.stepOrder(item.order + 1, total)}</span>}
      </div>
      {linkedCount > 0 && <p className="text-[10.5px] text-muted-foreground mb-2.5">{tt.stepLinked(linkedCount)}</p>}
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={busy !== null}
          onClick={onTeach}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-foreground text-background text-xs font-semibold hover:bg-foreground/90 cursor-pointer disabled:opacity-60"
        >
          {busy === "teach" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookOpen className="w-3.5 h-3.5" />}
          {tt.stepTeach}
        </button>
        {levelable && track && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={onLevel}
            title={tt.levelTrackTitle(pendingSteps(track))}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-border bg-accent hover:bg-border text-foreground text-xs cursor-pointer disabled:opacity-60"
          >
            {busy === "level" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ListChecks className="w-3.5 h-3.5" />}
            {tt.stepLevel}
          </button>
        )}
        {levelError && <p className="text-[10.5px] text-danger">{levelError}</p>}
      </div>
    </div>
  );
}

export interface RoadmapLegendProps {
  tt: TT;
  legend: RoadmapLegendEntry[];
  activeTrackId: string | null;
  showScope: boolean;
  scope: RoadmapScope;
  onScope: (scope: RoadmapScope) => void;
  onFrame: () => void;
  onFrameTrack: (trackId: string) => void;
}

export function RoadmapLegend({ tt, legend, activeTrackId, showScope, scope, onScope, onFrame, onFrameTrack }: RoadmapLegendProps) {
  const neutral: PaletteTone = legend.find((e) => e.trackId === activeTrackId)?.tone ?? legend[0]?.tone ?? "mutedForeground";
  return (
    <div
      role="group"
      aria-label={tt.legend}
      className="absolute top-20 left-4 z-10 w-72 max-w-[calc(100%-32px)] bg-card/90 backdrop-blur border border-border rounded-lg p-2.5 shadow-lg font-ui space-y-2"
    >
      {showScope && (
        <div role="group" aria-label={tt.roadmapScope} className="grid grid-cols-[3fr_2fr] bg-background p-0.5 border border-border rounded text-[10.5px]">
          {(["focus", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onScope(s)}
              aria-pressed={scope === s}
              className={`py-1 px-1 rounded cursor-pointer transition-colors truncate ${
                scope === s ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s === "focus" ? tt.roadmapFocus : tt.roadmapAll}
            </button>
          ))}
        </div>
      )}
      {legend.length > 0 && (
        <ul className="space-y-0.5">
          {legend.map((entry) => (
            <li key={entry.trackId}>
              <button
                type="button"
                onClick={() => onFrameTrack(entry.trackId)}
                title={tt.roadmapFrameTrack(entry.title)}
                className="w-full flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent rounded px-1 py-0.5 cursor-pointer transition-colors"
              >
                <TrackDot tone={entry.tone} />
                <span className={`flex-1 min-w-0 truncate text-left ${entry.trackId === activeTrackId ? "text-foreground" : ""}`}>
                  {entry.title}
                </span>
                <span className="tabular-nums text-[10.5px]">
                  {entry.done}/{entry.count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-accent pt-2">
        <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{tt.roadmapStates}</span>
        <ul className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10.5px] text-muted-foreground">
          <li className="flex items-center gap-1.5"><StepGlyph state="completed" tone={neutral} />{tt.stepStatus.completed}</li>
          <li className="flex items-center gap-1.5"><StepGlyph state="leveled" tone={neutral} />{tt.stepStatus.leveled}</li>
          <li className="flex items-center gap-1.5"><StepGlyph state="active" tone={neutral} />{tt.stepStatus.active}</li>
          <li className="flex items-center gap-1.5"><StepGlyph state="pending" tone={neutral} />{tt.stepStatus.pending}</li>
          <li className="flex items-center gap-1.5"><StepGlyph state="pending" tone={neutral} shape="diamond" />{tt.glyphFree}</li>
          <li className="flex items-center gap-1.5"><StepGlyph state="pending" tone={neutral} shape="square" />{tt.glyphBase}</li>
        </ul>
      </div>
      <button
        type="button"
        onClick={onFrame}
        title={tt.roadmapFrameTitle}
        data-roadmap-frame
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded border border-border bg-background hover:bg-accent text-[11px] text-foreground cursor-pointer transition-colors"
      >
        <Focus className="w-3.5 h-3.5 text-muted-foreground" />
        {tt.roadmapFrame}
      </button>
    </div>
  );
}
