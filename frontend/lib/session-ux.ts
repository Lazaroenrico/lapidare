/**
 * Pure logic for the session UX (spec Fase 12 §2): fuzzy session search, the Esc
 * priority chain, literal in-session find with DOM-independent offsets, the learner
 * steer queue, per-row sidebar status and the compaction anchor. No React, no DOM,
 * no network: everything here is unit-tested from tests/session-ux.test.cjs.
 */

import type { SessionCompaction, SessionMessage, SessionRecord } from "./types";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

// --- Fuzzy search (sidebar, ⌘⇧F) ---------------------------------------------------

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Subsequence score of `query` in `text` (accent- and case-insensitive), or null when
 * `query` is not a subsequence. Higher is better: consecutive runs, word starts and an
 * early first hit are rewarded; a literal substring always beats a scattered match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = fold(query.trim());
  if (!q) return 0;
  const t = fold(text);
  if (!t) return null;
  const literal = t.indexOf(q);
  if (literal >= 0) {
    const wordStart = literal === 0 || /[\s\-_/.:([]/.test(t[literal - 1]);
    // Tighter fits (the query covers more of the text) rank higher.
    return 1000 + q.length * 10 + (wordStart ? 50 : 0) - literal + Math.round((20 * q.length) / t.length);
  }
  let score = 0;
  let ti = 0;
  let prev = -2;
  let first = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (first < 0) first = found;
    score += 1;
    if (found === prev + 1) score += 5;
    if (found === 0 || /[\s\-_/.:([]/.test(t[found - 1])) score += 3;
    prev = found;
    ti = found + 1;
  }
  return score - Math.min(first, 20) * 0.1 - (prev - first) * 0.01;
}

/** Items whose best field matches, best first (stable for ties). Empty query keeps the order. */
export function fuzzyFilter<T>(items: readonly T[], query: string, fields: (item: T) => (string | null | undefined)[]): T[] {
  if (!query.trim()) return [...items];
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    let best: number | null = null;
    for (const field of fields(item)) {
      if (!field) continue;
      const s = fuzzyScore(query, field);
      if (s !== null && (best === null || s > best)) best = s;
    }
    if (best !== null) scored.push({ item, score: best, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}

/** ↑/↓ over a list: clamps (no wrap) and handles an empty list (-1). */
export function moveCursor(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : total - 1;
  return Math.max(0, Math.min(total - 1, current + dir));
}

// --- Esc priority chain -------------------------------------------------------------

export type EscAction = "dismiss-question" | "dismiss-problem" | "abort" | "none";

export interface EscContext {
  /** A dialog, the find bar or the inline rename already owns Esc. */
  overlayOpen: boolean;
  pendingQuestion: boolean;
  /** PRACTICE: a problem is active. */
  activeProblem: boolean;
  /** A turn is queued, running or compacting. */
  running: boolean;
}

/** Esc order (spec §2.2): pending question → active problem → running turn. */
export function resolveEsc(ctx: EscContext): EscAction {
  if (ctx.overlayOpen) return "none";
  if (ctx.pendingQuestion) return "dismiss-question";
  if (ctx.activeProblem) return "dismiss-problem";
  if (ctx.running) return "abort";
  return "none";
}

export const isRunningStatus = (status: string | null | undefined) =>
  status === "queued" || status === "running" || status === "compacting";

// --- Literal find (⌘F) ----------------------------------------------------------------

export interface TextMatch {
  start: number;
  end: number;
}

/** Non-overlapping, case-insensitive literal occurrences of `query` in `text`. */
export function findLiteral(text: string, query: string): TextMatch[] {
  if (!query) return [];
  const out: TextMatch[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerText.length === text.length && lowerQuery.length === query.length) {
    let from = 0;
    for (;;) {
      const i = lowerText.indexOf(lowerQuery, from);
      if (i < 0) break;
      out.push({ start: i, end: i + query.length });
      from = i + query.length;
    }
    return out;
  }
  // Lower-casing changed some lengths (e.g. "İ"): compare window by window on the original offsets.
  for (let i = 0; i + query.length <= text.length; ) {
    if (text.slice(i, i + query.length).toLowerCase() === lowerQuery) {
      out.push({ start: i, end: i + query.length });
      i += query.length;
    } else i += 1;
  }
  return out;
}

export interface MatchPiece {
  /** Index of the text segment (DOM text node) the piece lives in. */
  segment: number;
  start: number;
  end: number;
}

/**
 * Finds `query` across consecutive text segments (the text nodes of the transcript, in
 * document order) and maps each match back to per-segment pieces, so a match may span
 * nodes (e.g. "**bold** text"). Segments are joined without separators.
 */
export function findInSegments(segments: readonly string[], query: string): MatchPiece[][] {
  const matches = findLiteral(segments.join(""), query);
  if (matches.length === 0) return [];
  const starts: number[] = [];
  let acc = 0;
  for (const s of segments) {
    starts.push(acc);
    acc += s.length;
  }
  const out: MatchPiece[][] = [];
  let seg = 0;
  for (const m of matches) {
    while (seg < segments.length - 1 && starts[seg] + segments[seg].length <= m.start) seg += 1;
    const pieces: MatchPiece[] = [];
    let k = seg;
    while (k < segments.length && starts[k] < m.end) {
      const from = Math.max(m.start, starts[k]) - starts[k];
      const to = Math.min(m.end, starts[k] + segments[k].length) - starts[k];
      if (to > from) pieces.push({ segment: k, start: from, end: to });
      k += 1;
    }
    if (pieces.length) out.push(pieces);
  }
  return out;
}

/** Next/previous match index with wrap-around. */
export function stepMatch(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : total - 1;
  return (current + dir + total) % total;
}

// --- Learner steer queue ------------------------------------------------------------------

export type SteerKind = "learner" | "job";

export const steerKindOf = (m: Pick<SessionMessage, "steer_kind">): SteerKind | null =>
  m.steer_kind === "learner" || m.steer_kind === "job" ? m.steer_kind : null;

export type LocalSteerStatus = "sending" | "failed";

/** Optimistic steer typed while the agent runs, shown until the server echoes it. */
export interface LocalSteer {
  localId: string;
  content: string;
  status: LocalSteerStatus;
  /** Server message count when sent; the echo is searched after it. */
  baseline: number;
}

export type SteerAction =
  | { type: "send"; localId: string; content: string; baseline: number }
  | { type: "accepted"; localId: string }
  | { type: "failed"; localId: string }
  | { type: "discard"; localId: string };

/**
 * State machine of the local steer queue:
 * send → sending; accepted → removed (the server message now carries the badge);
 * failed → failed (kept so the learner can retry or discard); discard → removed.
 */
export function steerReducer(state: readonly LocalSteer[], action: SteerAction): LocalSteer[] {
  switch (action.type) {
    case "send":
      return [...state.filter((s) => s.localId !== action.localId), {
        localId: action.localId,
        content: action.content,
        status: "sending",
        baseline: action.baseline,
      }];
    case "accepted":
    case "discard":
      return state.filter((s) => s.localId !== action.localId);
    case "failed":
      return state.map((s) => (s.localId === action.localId ? { ...s, status: "failed" } : s));
  }
}

/**
 * Local steers still worth showing: drops a `sending` entry once a learner steer with the
 * same content shows up after its baseline (the SSE refetch may land before the POST returns).
 */
export function visibleLocalSteers(state: readonly LocalSteer[], messages: readonly SessionMessage[]): LocalSteer[] {
  return state.filter((s) => {
    if (s.status === "failed") return true;
    return !messages.slice(s.baseline).some(
      (m) => m.role === "user" && steerKindOf(m) === "learner" && m.content.trim() === s.content.trim(),
    );
  });
}

// --- Compaction -------------------------------------------------------------------------

export function decodeCompaction(raw: unknown): SessionCompaction | null {
  if (!isObj(raw) || typeof raw.summary !== "string") return null;
  return {
    summary: raw.summary,
    first_kept_message_id: typeof raw.first_kept_message_id === "string" ? raw.first_kept_message_id : null,
    tokens_before: typeof raw.tokens_before === "number" && Number.isFinite(raw.tokens_before) ? raw.tokens_before : null,
    at: typeof raw.at === "string" ? raw.at : "",
  };
}

/**
 * Id of the first visible (user/assistant) message at or after `first_kept_message_id`:
 * the "Contexto resumido aqui" divider goes right before it. Null when it cannot be placed.
 */
export function compactionAnchorId(
  messages: readonly Pick<SessionMessage, "id" | "role">[],
  compaction: Pick<SessionCompaction, "first_kept_message_id"> | null | undefined,
): string | null {
  const firstKept = compaction?.first_kept_message_id;
  if (!firstKept) return null;
  const idx = messages.findIndex((m) => m.id === firstKept);
  if (idx < 0) return null;
  for (let i = idx; i < messages.length; i += 1) {
    if (messages[i].role === "user" || messages[i].role === "assistant") return messages[i].id;
  }
  return null;
}

// --- Sidebar row status ------------------------------------------------------------------

export type RowStatus =
  | { kind: "failed" }
  | { kind: "waiting" }
  | { kind: "problem" }
  | { kind: "compacting" }
  | { kind: "working" }
  | { kind: "idle"; updatedAt: string };

type RowInput = Pick<SessionRecord, "mode" | "execution_status" | "updated_at"> &
  Partial<Pick<SessionRecord, "pending" | "status" | "recovery_required" | "pending_quiz" | "practice">>;

/**
 * A `session:updated` sent only to refresh the live text of a streaming reply
 * (`{session_id, streaming: true}`, every ~0.2 s): it changes no sidebar row.
 */
export function isStreamingTick(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { streaming?: unknown }).streaming === true;
}

/**
 * Per-row status: failed, waiting for an answer, open problem (PRACTICE), compacting,
 * working, else the relative time of the last update.
 */
export function rowStatus(row: RowInput): RowStatus {
  const exec = row.execution_status as string;
  if (row.recovery_required || exec === "failed" || exec === "interrupted") return { kind: "failed" };
  if (exec === "compacting") return { kind: "compacting" };
  const waiting = Boolean(row.pending_quiz) || row.status === "waiting_quiz" || exec === "waiting";
  if (waiting) return { kind: "waiting" };
  if (exec === "queued" || exec === "running") return { kind: "working" };
  const openProblem = row.mode === "PRACTICE" && Boolean(row.practice?.active_problem_id);
  if (openProblem || (row.pending && row.mode === "PRACTICE")) return { kind: "problem" };
  if (row.pending) return { kind: "waiting" };
  return { kind: "idle", updatedAt: row.updated_at };
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "há 5 min" / "5 min ago" style label; empty for an invalid date. */
export function relativeTime(iso: string, now: number, locale: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((then - now) / 1000);
  const fmt = new Intl.RelativeTimeFormat(locale === "en" ? "en" : "pt-BR", { numeric: "auto", style: "short" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return fmt.format(Math.trunc(seconds / size), unit);
  }
  return fmt.format(0, "minute");
}

export type SessionFilter = "TEACH" | "ALL" | "PRACTICE";

export const filterByMode = <T extends { mode: string }>(items: readonly T[], filter: SessionFilter): T[] =>
  filter === "ALL" ? [...items] : items.filter((s) => s.mode === filter);

// --- Rename -------------------------------------------------------------------------------

export const TITLE_MAX = 200;

/** Trimmed title, or null when empty, too long or unchanged. */
export function normalizeTitle(draft: string, current: string): string | null {
  const title = draft.replace(/\s+/g, " ").trim();
  if (!title || title.length > TITLE_MAX || title === current.trim()) return null;
  return title;
}
