/**
 * Pure QuestionDock logic (no React, no I/O): deterministic option shuffle,
 * display→original index mapping, confidence-slider snapping and submission
 * building. Compiled by `npm test` and exercised in tests/question-core.test.cjs.
 */

import type { QuestionKind, QuizPayload, QuizSubmission } from "./types";

// --- Deterministic shuffle ---------------------------------------------------

/** FNV-1a 32-bit hash of a string (stable seed from `quiz_id`). */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 PRNG: returns a function yielding floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Display order for `n` options seeded by `seed` (Fisher–Yates).
 * `order[displayIndex] === originalIndex`. Same seed → same order, always.
 */
export function shuffleOrder(n: number, seed: string): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  const rand = seededRandom(hashSeed(seed));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Maps selected display positions back to original choice indices (sorted, unique). */
export function toOriginalIndices(order: number[], displayIndices: Iterable<number>): number[] {
  const out = new Set<number>();
  for (const d of displayIndices) {
    const original = order[d];
    if (original !== undefined) out.add(original);
  }
  return [...out].sort((a, b) => a - b);
}

// --- Confidence slider -------------------------------------------------------

export const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100] as const;
export const DEFAULT_CONFIDENCE = 50;

/** Snaps any value to the nearest stop (ties go to the higher stop). */
export function snapConfidence(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONFIDENCE;
  let best: number = CONFIDENCE_STOPS[0];
  for (const stop of CONFIDENCE_STOPS) {
    if (Math.abs(stop - value) <= Math.abs(best - value)) best = stop;
  }
  return best;
}

/** Moves one stop up (+1) or down (-1) from `value`, clamped to the ends. */
export function stepConfidence(value: number, direction: 1 | -1): number {
  const idx = CONFIDENCE_STOPS.indexOf(snapConfidence(value) as (typeof CONFIDENCE_STOPS)[number]);
  const next = Math.min(CONFIDENCE_STOPS.length - 1, Math.max(0, idx + direction));
  return CONFIDENCE_STOPS[next];
}

// --- Submission ----------------------------------------------------------------

/** Whether "Não sei" applies (never for ask). */
export const allowsDontKnow = (kind: QuestionKind) => kind !== "ask";
/** Confidence only exists for quiz (and disappears with "Não sei"). */
export const usesConfidence = (kind: QuestionKind, dontKnow: boolean) => kind === "quiz" && !dontKnow;
/** Shuffle only graded quizzes: ask keeps the author's order. */
export const shufflesOptions = (kind: QuestionKind) => kind === "quiz";

export interface DockDraft {
  /** Selected DISPLAY positions. */
  selected: number[];
  dontKnow: boolean;
  confidence: number;
  thinking: string;
  readingThinking: string;
  text: string;
  otherSelected: boolean;
  otherText: string;
}

export function canSubmit(kind: QuestionKind, d: DockDraft): boolean {
  if (kind === "explain") return d.dontKnow || d.text.trim().length > 0;
  if (kind === "ask") {
    if (d.otherSelected && !d.otherText.trim()) return false;
    return d.selected.length > 0 || d.otherSelected;
  }
  return d.dontKnow || d.selected.length > 0;
}

/** Builds the POST /answer body; `order` maps display → original indices. */
export function buildSubmission(
  quiz: Pick<QuizPayload, "quiz_id" | "session_id" | "kind">,
  sessionId: string,
  order: number[],
  d: DockDraft,
): QuizSubmission {
  const kind = quiz.kind;
  const dontKnow = allowsDontKnow(kind) && d.dontKnow;
  return {
    quiz_id: quiz.quiz_id,
    session_id: quiz.session_id || sessionId,
    chosen_indices: dontKnow || kind === "explain" ? [] : toOriginalIndices(order, d.selected),
    is_dont_know: dontKnow,
    confidence: usesConfidence(kind, dontKnow) ? snapConfidence(d.confidence) : null,
    learner_thinking: d.thinking.trim(),
    reading_thinking: d.readingThinking.trim(),
    text: kind === "explain" && !dontKnow ? d.text.trim() : "",
    other_text: kind === "ask" && d.otherSelected ? d.otherText.trim() : "",
  };
}

/** Next row in a wrap-around list of `count` rows. */
export function moveRow(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}
