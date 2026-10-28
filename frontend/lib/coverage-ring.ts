/**
 * Extraction coverage ring (Fase 21): how close a TEACH session is to its next
 * graph extraction. Pure: the component only draws what `ringState` returns.
 */
import type { SessionCoverage } from "./types";
import { formatTokens } from "./usage";

export interface RingState {
  visible: boolean;
  /** 0..1 share of the next chunk already filled with uncovered tokens. */
  fraction: number;
  /** An extraction job is queued or running. */
  pulsing: boolean;
  tooltip: string;
}

export function ringState(cov: SessionCoverage | null | undefined, locale: string = "pt-BR"): RingState {
  if (!cov || !cov.enabled) return { visible: false, fraction: 0, pulsing: false, tooltip: "" };
  const en = locale.toLowerCase().startsWith("en");
  const fraction = cov.chunk_tokens > 0 ? Math.min(1, Math.max(0, cov.uncovered_tokens / cov.chunk_tokens)) : 0;
  const tooltip = cov.extracting
    ? en
      ? "Extracting to the graph…"
      : "Extraindo para o grafo…"
    : en
      ? `${formatTokens(cov.uncovered_tokens, locale)} of ${formatTokens(cov.chunk_tokens, locale)} tokens until the next extraction`
      : `${formatTokens(cov.uncovered_tokens, locale)} de ${formatTokens(cov.chunk_tokens, locale)} tokens até a próxima extração`;
  return { visible: true, fraction, pulsing: cov.extracting, tooltip };
}
