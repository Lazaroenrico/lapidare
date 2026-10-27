/**
 * Pure decoders/formatters for token usage: `SessionRecord.usage` and
 * GET /api/usage → {today, total, by_session[]}.
 */

import type { SessionUsageEntry, UsageCounters, UsageReport } from "./types";

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
