/**
 * Pure decoders/formatters for token usage: `SessionRecord.usage` and
 * GET /api/usage → {today, total, by_session[]}.
 */

import type { SessionCoverage, SessionUsage, SessionUsageEntry, TurnUsage, UsageCounters, UsageReport } from "./types";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export const ZERO_USAGE: UsageCounters = {
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  turns: 0,
  total_tokens: 0,
};

export function decodeUsageCounters(raw: unknown): UsageCounters | null {
  if (!isObj(raw)) return null;
  const input = count(raw.input_tokens ?? raw.prompt_tokens);
  const output = count(raw.output_tokens ?? raw.completion_tokens);
  const thinking = count(raw.thinking_tokens ?? raw.thoughts_tokens);
  const sum = input + output + thinking;
  return {
    input_tokens: input,
    output_tokens: output,
    thinking_tokens: thinking,
    turns: count(raw.turns),
    total_tokens: count(raw.total_tokens) || sum,
  };
}

export function decodeUsageReport(raw: unknown): UsageReport | null {
  if (!isObj(raw)) return null;
  const today = decodeUsageCounters(raw.today) ?? ZERO_USAGE;
  const total = decodeUsageCounters(raw.total) ?? ZERO_USAGE;
  const bySession: SessionUsageEntry[] = [];
  if (Array.isArray(raw.by_session)) {
    for (const s of raw.by_session) {
      if (!isObj(s)) continue;
      const id = typeof s.session_id === "string" ? s.session_id : typeof s.id === "string" ? s.id : "";
      if (!id) continue;
      const counters = decodeUsageCounters(isObj(s.usage) ? s.usage : s) ?? ZERO_USAGE;
      bySession.push({ ...counters, session_id: id, title: typeof s.title === "string" && s.title ? s.title : id });
    }
  }
  bySession.sort((a, b) => b.total_tokens - a.total_tokens);
  return { today, total, by_session: bySession.slice(0, 10) };
}

/**
 * Compact token count: 980 → "980", 12_400 → "12,4k" (pt-BR) / "12.4k" (en),
 * 1_250_000 → "1,3M". One decimal below 100 of a unit, none above.
 */
export function formatTokens(n: number, locale: string = "pt-BR"): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  const sep = locale.toLowerCase().startsWith("en") ? "." : ",";
  const fmt = (x: number, unit: string) => {
    const digits = x < 100 ? 1 : 0;
    const s = x.toFixed(digits).replace(/\.0$/, "");
    return `${s.replace(".", sep)}${unit}`;
  };
  if (v < 1000) return String(Math.round(v));
  if (v < 999_950) return fmt(v / 1000, "k");
  return fmt(v / 1_000_000, "M");
}

const optCount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

function decodeTurnUsage(raw: unknown): TurnUsage | null {
  if (!isObj(raw)) return null;
  return {
    input_tokens: count(raw.input_tokens),
    output_tokens: count(raw.output_tokens),
    thinking_tokens: count(raw.thinking_tokens),
    cached_tokens: optCount(raw.cached_tokens),
  };
}

/** GET /api/chats/{id} `usage`: counters plus the Fase 21 context meter (every new field optional). */
export function decodeSessionUsage(raw: unknown): SessionUsage | null {
  const counters = decodeUsageCounters(raw);
  if (!counters || !isObj(raw)) return null;
  return {
    ...counters,
    context_tokens: optCount(raw.context_tokens),
    context_limit: count(raw.context_limit),
    limit_kind: raw.limit_kind === "window" ? "window" : "compaction",
    last_turn: decodeTurnUsage(raw.last_turn),
  };
}

/** GET /api/chats/{id} `coverage` (null for PRACTICE and older servers). */
export function decodeCoverage(raw: unknown): SessionCoverage | null {
  if (!isObj(raw)) return null;
  return {
    uncovered_tokens: count(raw.uncovered_tokens),
    chunk_tokens: count(raw.chunk_tokens),
    extracting: raw.extracting === true,
    enabled: raw.enabled !== false,
  };
}

export interface ContextMeter {
  /** True when the server sent a limit to measure against. */
  known: boolean;
  /** 0..1 fill of the bar (0 when unknown). */
  fraction: number;
  /** "42k" or "?" when no report has arrived (or after a compaction). */
  used: string;
  /** "150k" or "?" when the server did not send a limit. */
  limit: string;
  kind: "compaction" | "window";
}

/** Context bar numbers: null tokens render as "?", the fill is capped at 1. */
export function contextMeter(usage: SessionUsage, locale: string = "pt-BR"): ContextMeter {
  const known = usage.context_limit > 0;
  const fraction = known && usage.context_tokens !== null ? Math.min(1, usage.context_tokens / usage.context_limit) : 0;
  return {
    known,
    fraction,
    used: usage.context_tokens === null ? "?" : formatTokens(usage.context_tokens, locale),
    limit: known ? formatTokens(usage.context_limit, locale) : "?",
    kind: usage.limit_kind,
  };
}

export interface TurnRow {
  key: "input" | "output" | "thinking" | "cached";
  value: string;
}

/** Last-turn rows for the popover: input, output, thinking; cache only when reported. */
export function lastTurnRows(turn: TurnUsage | null, locale: string = "pt-BR"): TurnRow[] {
  if (!turn) return [];
  const rows: TurnRow[] = [
    { key: "input", value: formatTokens(turn.input_tokens, locale) },
    { key: "output", value: formatTokens(turn.output_tokens, locale) },
    { key: "thinking", value: formatTokens(turn.thinking_tokens, locale) },
  ];
  if (turn.cached_tokens !== null) rows.push({ key: "cached", value: formatTokens(turn.cached_tokens, locale) });
  return rows;
}
