"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SseEventType, UsageReport } from "@/lib/types";
import { getUsage } from "@/lib/api";
import { formatTokens } from "@/lib/usage";
import { useEventSubscription } from "./server-events";
import { useLocale } from "./locale-provider";

/** Events after which usage may have grown (turn finished, background job finished). */
const USAGE_EVENTS: SseEventType[] = ["usage:updated", "jobs:updated"];
/** Bursts of SSE notifications collapse into one fetch (a one-shot timer, never polling). */
const REFETCH_DELAY_MS = 1000;

/**
 * Discreet "12,4k tok hoje" text (no border); the popover shows total + top sessions.
 * Hidden when GET /api/usage is missing (404) or fails.
 */
export function UsagePill({ className = "" }: { className?: string }) {
  const { locale, t } = useLocale();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    getUsage()
      .then(setReport)
      .catch(() => setReport(null));
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [load]);

  useEventSubscription(USAGE_EVENTS, () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      load();
    }, REFETCH_DELAY_MS);
  });

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

  if (!report) return null;
  const fmt = (n: number) => formatTokens(n, locale);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={t.usageTitle}
        className="font-ui text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <span>{t.usagePill(fmt(report.today.total_tokens))}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t.usageTitle}
          className="absolute top-full right-0 mt-2 w-72 text-left bg-card border border-border rounded-lg shadow-2xl p-3 z-40 font-ui text-[11px] text-muted-foreground"
        >
          <div className="text-foreground font-semibold mb-2">{t.usageTitle}</div>
          {[
            [t.usageToday, report.today] as const,
            [t.usageTotal, report.total] as const,
          ].map(([label, c]) => (
            <div key={label} className="mb-2">
              <div className="flex items-center justify-between">
                <span>{label}</span>
                <span className="text-foreground">{fmt(c.total_tokens)} tok · {t.usageTurns(c.turns)}</span>
              </div>
              <div className="text-[10.5px]">
                {t.usageBreakdown(fmt(c.input_tokens), fmt(c.output_tokens), fmt(c.thinking_tokens))}
              </div>
            </div>
          ))}
          <div className="border-t border-accent pt-2 mt-1">
            <div className="uppercase tracking-wider text-[10px] mb-1">{t.usageTopSessions}</div>
            {report.by_session.length === 0 ? (
              <p>{t.usageEmpty}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {report.by_session.map((s) => (
                  <li key={s.session_id}>
                    <Link
                      href={`/chat/${encodeURIComponent(s.session_id)}`}
                      className="flex items-center justify-between gap-2 px-1 py-0.5 rounded hover:bg-accent hover:text-foreground"
                    >
                      <span className="truncate">{s.title}</span>
                      <span className="shrink-0 text-foreground">{fmt(s.total_tokens)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
