/**
 * Per-viewer memory of the questions this browser displayed, so answered
 * cards can show choice labels even when the answer record only carries
 * indices. A convenience only: every access is guarded and may return null.
 */

import type { QuizOption, QuizPayload } from "./types";

const KEY = "learnharness:quiz-memory";
const LIMIT = 200;

interface Remembered {
  question: string;
  choices: QuizOption[];
  at: number;
}

function load(): Record<string, Remembered> {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, Remembered>) : {};
  } catch {
    return {};
  }
}

export function rememberQuiz(quiz: QuizPayload): void {
  try {
    if (typeof window === "undefined") return;
    const all = load();
    all[quiz.quiz_id] = { question: quiz.question, choices: quiz.choices, at: Date.now() };
    const kept = Object.entries(all)
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, LIMIT);
    window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage unavailable: labels fall back to letters */
  }
}

export function recallQuiz(quizId: string): Remembered | null {
  const entry = load()[quizId];
  return entry && Array.isArray(entry.choices) ? entry : null;
}
