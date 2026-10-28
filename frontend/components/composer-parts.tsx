"use client";

/**
 * The Home composer's pieces, shared by every learning screen (Home, TEACH follow-up,
 * PRACTICE dock): the large rounded field with the action inside its right edge, and
 * the row below it (`TEACH | PRACTICE` · dictation · model · effort).
 */

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, CornerDownLeft, Loader2 } from "lucide-react";
import type { EffortLevel, SessionMode } from "@/lib/types";
import { EFFORT_LEVELS } from "@/lib/model-choice";
import { useLocale } from "./locale-provider";

/** Square action inside the field (send ↵ by default). */
export function ComposerSendButton({
  onClick,
  disabled,
  busy = false,
  label,
  icon,
}: {
  onClick: () => void;
  disabled: boolean;
  busy?: boolean;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={`${label} (↵)`}
      aria-label={label}
      className={`flex items-center justify-center w-10 h-10 rounded-xl transition-colors cursor-pointer shrink-0 ${
        !disabled ? "bg-foreground text-background hover:bg-foreground/90" : "bg-accent text-muted-foreground cursor-not-allowed"
      }`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (icon ?? <CornerDownLeft className="w-4 h-4" />)}
    </button>
  );
}

/** Large rounded box: a textarea plus the action (`ComposerSendButton` or a labelled pill). */
export function ComposerField({
  textareaRef,
  action,
  className = "",
  ...textarea
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  action: React.ReactNode;
}) {
  return (
    <div className="w-full flex items-end gap-2 bg-card border border-border focus-within:border-muted-foreground rounded-2xl shadow-2xl transition-colors pl-5 pr-3 py-3">
      <textarea
        ref={textareaRef}
        rows={1}
        {...textarea}
        className={`flex-1 bg-transparent text-foreground placeholder-muted-foreground font-prose text-[18px] resize-none border-none leading-normal block py-1.5 max-h-40 disabled:opacity-60 ${className}`}
      />
      {action}
    </div>
  );
}

/** Row below the field: mode · dictation (flexes) · model · effort. */
export function ComposerControls({ mode, mic, model }: { mode: React.ReactNode; mic: React.ReactNode; model: React.ReactNode }) {
  return (
    <div className="w-full flex items-center gap-2 flex-wrap sm:flex-nowrap">
      {mode}
      {mic ?? <div className="flex-1" />}
      {model}
    </div>
  );
}

export function ModeToggle({ mode, onChange }: { mode: SessionMode; onChange: (mode: SessionMode) => void }) {
  const { t } = useLocale();
  return (
    <div className="flex items-center bg-card/85 border border-border rounded-full p-0.5 shrink-0" role="group" aria-label="TEACH / PRACTICE">
      {(["TEACH", "PRACTICE"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          title={m === "TEACH" ? t.tipTeach : t.tipPractice}
          className={`px-3 py-1 rounded-full text-[11px] font-ui uppercase tracking-wider transition-colors cursor-pointer ${
            mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

/** [esforço ▾] pill: opens a tiny menu with the effort levels. */
export function EffortMenu({
  value,
  pinned,
  disabled,
  onChange,
}: {
  value: EffortLevel;
  pinned: string | null;
  disabled: boolean;
  onChange: (effort: EffortLevel) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shown = pinned ?? value;
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled || pinned !== null}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={pinned ? t.slotEffortPinned : t.tipEffort}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-card/85 hover:bg-accent text-[12.5px] font-ui text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span>{t.effortName(shown)}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="menu" aria-label={t.slotEffort} className="absolute bottom-full right-0 mb-2 min-w-32 bg-card border border-border rounded-lg shadow-2xl p-1 font-ui z-40">
          {EFFORT_LEVELS.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitemradio"
              aria-checked={value === e}
              onClick={() => {
                onChange(e);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 rounded text-[12.5px] cursor-pointer hover:bg-accent ${value === e ? "bg-accent text-foreground" : "text-muted-foreground"}`}
            >
              {t.effortName(e)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
