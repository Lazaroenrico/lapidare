"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { SessionTurns, SessionUsage, SseEventType } from "@/lib/types";
import { getSessionTurns } from "@/lib/api";
import { bucketTotal, contextMeter, formatTokens, lastTurnRows, turnBars } from "@/lib/usage";
import { metersText } from "@/lib/meters-i18n";
import { useEventSubscription } from "./server-events";
import { useLocale } from "./locale-provider";

const TURN_EVENTS: SseEventType[] = ["usage:updated"];
/** Bursts of usage rows collapse into one fetch (a one-shot timer, never polling). */
const REFETCH_DELAY_MS = 1000;
const BARS = 10;

/**
 * Fase 21: the session usage chip of the chat header is the trigger of a popover with
 * the context bar (used / limit until compaction), the last turn and the session total.
 * Fase 23: plus bars of the last turns and the background jobs, fetched only while open.
 */
export function SessionUsageChip({ sessionId, usage }: { sessionId: string; usage: SessionUsage }) {
  const { locale, t } = useLocale();
  const m = metersText(locale);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<SessionTurns | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTurns = useCallback(() => {
    getSessionTurns(sessionId)
      .then(setTurns)
      .catch(() => setTurns(null));
  }, [sessionId]);

  useEffect(() => {
    if (open) loadTurns();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [open, loadTurns]);

  useEventSubscription(TURN_EVENTS, (event) => {
    if (!open) return;
    const sid = (event.data as { session_id?: unknown } | undefined)?.session_id;
    if (sid !== undefined && sid !== sessionId) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      loadTurns();
    }, REFETCH_DELAY_MS);
  });

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

          {turns && <TurnsSection turns={turns} />}

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

/** Bars of the last turns (the most expensive highlighted) and background totals by job kind. */
export function TurnsSection({ turns }: { turns: SessionTurns }) {
  const { locale } = useLocale();
  const m = metersText(locale);
  const bars = turnBars(turns.turns, BARS);
  return (
    <div className="border-t border-accent pt-2 mb-2">
      <div className="uppercase tracking-wider text-[10px] mb-1">{m.turnsTitle(BARS)}</div>
      {bars.length === 0 ? (
        <p>{m.turnsNone}</p>
      ) : (
        <ul className="flex items-end gap-1 h-8" aria-label={m.turnsTitle(BARS)}>
          {bars.map((b) => {
            const label = m.turnBar(b.turn, formatTokens(b.total, locale), b.peak);
            return (
              <li key={b.turn} title={label} aria-label={label} className="flex-1 h-full flex items-end bg-background rounded-sm">
                <div
                  data-peak={b.peak ? "true" : undefined}
                  className={`w-full rounded-sm ${b.peak ? "bg-foreground" : "bg-border"}`}
                  style={{ height: `${Math.max(b.fraction * 100, 4)}%` }}
                />
              </li>
            );
          })}
        </ul>
      )}
      {turns.background.length > 0 && (
        <div className="mt-2">
          <div className="uppercase tracking-wider text-[10px] mb-1">{m.background}</div>
          <ul className="flex flex-col gap-0.5">
            {turns.background.map((b) => (
              <li key={b.job_kind} className="flex items-center justify-between">
                <span>{m.jobKind(b.job_kind)}</span>
                <span className="text-foreground tabular-nums">{formatTokens(bucketTotal(b), locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
