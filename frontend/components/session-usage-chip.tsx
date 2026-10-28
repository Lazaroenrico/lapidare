"use client";

import React, { useEffect, useRef, useState } from "react";
import type { SessionUsage } from "@/lib/types";
import { contextMeter, formatTokens, lastTurnRows } from "@/lib/usage";
import { metersText } from "@/lib/meters-i18n";
import { useLocale } from "./locale-provider";

/**
 * Fase 21: the session usage chip of the chat header is the trigger of a popover with
 * the context bar (used / limit until compaction), the last turn and the session total.
 */
export function SessionUsageChip({ usage }: { usage: SessionUsage }) {
  const { locale, t } = useLocale();
  const m = metersText(locale);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Prevented: the session's Esc chain (abort) skips this keypress.
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const fmt = (n: number) => formatTokens(n, locale);
  const meter = contextMeter(usage, locale);
  const rows = lastTurnRows(usage.last_turn, locale);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t.usageBreakdown(fmt(usage.input_tokens), fmt(usage.output_tokens), fmt(usage.thinking_tokens))}
        className="font-ui text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded-md border border-accent hover:border-border transition-colors cursor-pointer"
      >
        {t.sessionUsage(fmt(usage.total_tokens), usage.turns)}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={m.contextTitle}
          className="absolute top-full right-0 mt-2 w-72 text-left bg-card border border-border rounded-lg shadow-2xl p-3 z-40 font-ui text-[11px] text-muted-foreground"
        >
          <div className="text-foreground font-semibold mb-2">{m.contextTitle}</div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(meter.fraction * 100)}
            aria-label={m.contextOf(meter.used, meter.limit, meter.kind)}
            className="h-1.5 rounded-full bg-background border border-border overflow-hidden"
          >
            <div className="h-full bg-foreground" style={{ width: `${meter.fraction * 100}%` }} />
          </div>
          <div className="mt-1 mb-3 text-foreground">{m.contextOf(meter.used, meter.limit, meter.kind)}</div>

          <div className="border-t border-accent pt-2 mb-2">
            <div className="uppercase tracking-wider text-[10px] mb-1">{m.lastTurn}</div>
            {rows.length === 0 ? (
              <p>{m.lastTurnNone}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {rows.map((r) => (
                  <li key={r.key} className="flex items-center justify-between">
                    <span>{m.turnRow[r.key]}</span>
                    <span className="text-foreground tabular-nums">{r.value}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-accent pt-2">
            <div className="uppercase tracking-wider text-[10px] mb-1">{m.sessionTotal}</div>
            <div className="flex items-center justify-between">
              <span>{t.sessionUsage(fmt(usage.total_tokens), usage.turns)}</span>
            </div>
            <div className="text-[10.5px]">{t.usageBreakdown(fmt(usage.input_tokens), fmt(usage.output_tokens), fmt(usage.thinking_tokens))}</div>
          </div>
        </div>
      )}
    </div>
  );
}
