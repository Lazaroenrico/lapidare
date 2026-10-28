"use client";

import React from "react";
import { ringState } from "@/lib/coverage-ring";
import type { SessionCoverage } from "@/lib/types";
import { useLocale } from "./locale-provider";

const SIZE = 16;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Fase 21: ~16px ring in the chat header, replacing the "Extrair para o grafo" text button.
 * Track = --border, arc = --foreground (share of the next chunk already uncovered); it
 * pulses while an extraction job runs. Click extracts now.
 */
export function ExtractionRing({
  coverage,
  busy,
  onExtract,
}: {
  coverage: SessionCoverage | null | undefined;
  busy: boolean;
  onExtract: () => void;
}) {
  const { locale } = useLocale();
  const ring = ringState(coverage, locale);
  if (!ring.visible) return null;
  return (
    <button
      type="button"
      onClick={onExtract}
      disabled={busy}
      title={ring.tooltip}
      aria-label={ring.tooltip}
      className="p-1.5 rounded-md hover:bg-accent cursor-pointer disabled:cursor-not-allowed transition-colors"
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" className={ring.pulsing || busy ? "ring-pulse" : ""}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="var(--foreground)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${CIRCUMFERENCE * ring.fraction} ${CIRCUMFERENCE}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
    </button>
  );
}
