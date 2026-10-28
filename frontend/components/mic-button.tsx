"use client";

import { Loader2, Mic, Square } from "lucide-react";
import { isActive, type DictationState } from "@/lib/dictation-core";

export type MicButtonVariant = "pill" | "compact" | "icon";

export interface MicButtonProps {
  /** Deepgram key saved: false hides the button entirely. */
  configured: boolean;
  state: DictationState;
  /** Mic level 0..1 while listening. */
  level: number;
  onToggle: () => void;
  /** Accessible name when idle ("Ditar por voz"). */
  label: string;
  /** Accessible name while active ("Parar ditado"). */
  stopLabel: string;
  /** Visible caption (pill / compact); icon variant has none. */
  text?: string;
  variant?: MicButtonVariant;
}

const SHAPE: Record<MicButtonVariant, string> = {
  pill: "flex-1 min-w-[96px] justify-center gap-2 py-1.5 rounded-full text-[12.5px]",
  compact: "gap-1 px-2 py-0.5 rounded text-[10.5px]",
  icon: "p-2.5 rounded shrink-0",
};

/** Pure-props mic button: idle mic, connecting spinner, or stop with a level bar. */
export function MicButton({ configured, state, level, onToggle, label, stopLabel, text, variant = "pill" }: MicButtonProps) {
  if (!configured) return null;
  const active = isActive(state);
  const listening = state === "listening";
  const name = active ? stopLabel : label;
  const iconClass = variant === "pill" ? "w-3.5 h-3.5" : variant === "compact" ? "w-3 h-3" : "w-4 h-4";
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault() /* keep focus in the active field */}
      onClick={onToggle}
      disabled={state === "finishing"}
      aria-pressed={active}
      aria-label={name}
      title={name}
      data-state={state}
      className={`relative overflow-hidden flex items-center border font-ui transition-colors cursor-pointer disabled:cursor-wait ${SHAPE[variant]} ${
        active
          ? "bg-danger/10 text-danger border-danger"
          : "bg-card/85 text-muted-foreground border-border hover:text-foreground hover:bg-accent"
      }`}
    >
      {state === "requesting" || state === "finishing" ? (
        <Loader2 className={`${iconClass} animate-spin`} aria-hidden />
      ) : listening ? (
        <Square className={`${iconClass} fill-current`} aria-hidden />
      ) : (
        <Mic className={iconClass} aria-hidden />
      )}
      {text && <span>{text}</span>}
      {listening && (
        <span
          aria-hidden
          data-level={level}
          className="absolute left-0 bottom-0 h-0.5 w-full origin-left bg-danger transition-transform"
          style={{ transform: `scaleX(${Math.max(0.04, level)})` }}
        />
      )}
    </button>
  );
}
