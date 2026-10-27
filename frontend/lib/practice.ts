/**
 * Pure logic for PRACTICE sessions (Fase 9): decoding `practice` from
 * GET /api/chats/{id}, the transcript ordering, the PracticeDock state
 * machine and the outcome/rung/miss-class/mode labels (PT-BR + EN).
 */

import type {
  CalibrationResult,
  ChatMessageKind,
  HintLevel,
  PracticeAttempt,
  PracticeMissClass,
  PracticeOutcome,
  PracticeProblem,
  PracticeProblemMode,
  PracticeState,
  QuizPayload,
  SessionExecutionStatus,
  SessionMessage,
} from "./types";

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

export const PROBLEM_MODES: readonly PracticeProblemMode[] = ["recall", "discrimination", "composition"];
export const OUTCOMES: readonly PracticeOutcome[] = ["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"];
export const RUNGS: readonly HintLevel[] = ["R0", "R1", "R2", "R3", "R4", "R5"];
export const MISS_CLASSES: readonly PracticeMissClass[] = ["cue", "discrimination", "execution", "careless", "structural"];

export const EMPTY_PRACTICE: PracticeState = { active_problem_id: null, problems: [] };

// --- Decoding ------------------------------------------------------------------

/** Accepts snake_case and the obvious camelCase / spelling variants of an outcome. */
function decodeOutcome(v: unknown): PracticeOutcome | null {
  if (typeof v !== "string") return null;
  const direct = oneOf(v, OUTCOMES);
  if (direct) return direct;
  const norm = v.replace(/[_\s-]/g, "").toLowerCase();
  return OUTCOMES.find((o) => o.toLowerCase() === norm) ?? null;
}

function decodeRung(v: unknown): HintLevel | null {
  if (typeof v === "number" && Number.isInteger(v)) return oneOf(`R${v}`, RUNGS);
  return typeof v === "string" ? oneOf(v.trim().toUpperCase(), RUNGS) : null;
}

function decodeAttempts(raw: unknown): PracticeAttempt[] {
  if (!Array.isArray(raw)) return [];
  const out: PracticeAttempt[] = [];
  for (const a of raw) {
    if (typeof a === "string") {
      if (a.trim()) out.push({ at: "", text: a });
      continue;
    }
    if (!isObj(a)) continue;
    const text = str(a.text ?? a.content);
    if (text.trim()) out.push({ at: str(a.at ?? a.created_at ?? a.timestamp), text });
  }
  return out;
}

export function decodeProblem(raw: unknown): PracticeProblem | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id ?? raw.problem_id);
  if (!id) return null;
  const outcome = decodeOutcome(raw.outcome);
  const concludedAt = strOrNull(raw.concluded_at);
  return {
    id,
    statement: str(raw.statement ?? raw.prompt),
    mode: oneOf(raw.mode, PROBLEM_MODES) ?? "recall",
    target: strList(raw.target ?? raw.targets),
    model_solution: strOrNull(raw.model_solution),
    created_at: str(raw.created_at),
    attempts: decodeAttempts(raw.attempts),
    outcome,
    verdict: str(raw.verdict),
    rung: decodeRung(raw.rung),
    miss_class: oneOf(raw.miss_class, MISS_CLASSES),
    retest: raw.retest === true,
    concluded_at: concludedAt,
  };
}

/** Normalizes `session.practice`; missing or malformed → empty state. */
export function decodePractice(raw: unknown): PracticeState {
  if (!isObj(raw)) return EMPTY_PRACTICE;
  const problems = Array.isArray(raw.problems)
    ? raw.problems.map(decodeProblem).filter((p): p is PracticeProblem => p !== null)
    : [];
  const activeId = strOrNull(raw.active_problem_id);
  // An active id that points nowhere (or at a concluded problem) is ignored.
  const active = activeId ? problems.find((p) => p.id === activeId && p.outcome === null) : undefined;
  return { active_problem_id: active ? active.id : null, problems };
}

export const isConcluded = (p: Pick<PracticeProblem, "outcome">) => p.outcome !== null;

export function activeProblem(state: PracticeState): PracticeProblem | null {
  if (!state.active_problem_id) return null;
  return state.problems.find((p) => p.id === state.active_problem_id) ?? null;
}

/** Header counter: solved (with or without hints) over problems presented, dismissed ones excluded. */
export function practiceCounts(state: PracticeState): { solved: number; total: number } {
  const counted = state.problems.filter((p) => p.outcome !== "dismissed");
  const solved = counted.filter((p) => p.outcome === "solved" || p.outcome === "solvedWithHints").length;
  return { solved, total: counted.length };
}

// --- Attempt messages ------------------------------------------------------------

/** Prefixes the backend puts on `kind=attempt` user messages ("Tentativa:\n"). */
const ATTEMPT_PREFIX = /^\s*(tentativa|attempt)\s*:\s*\n?/i;

/** The attempt text of a user message, or null when the message is not an attempt. */
export function attemptText(message: Pick<SessionMessage, "role" | "content">): string | null {
  if (message.role !== "user" || !ATTEMPT_PREFIX.test(message.content)) return null;
  return message.content.replace(ATTEMPT_PREFIX, "");
}

const normText = (s: string) => s.replace(/\s+/g, " ").trim();

// --- Transcript ------------------------------------------------------------------

export type PracticeTranscriptItem =
  | { type: "message"; key: string; message: SessionMessage }
  | { type: "attempt"; key: string; text: string; at: string; problemId: string | null; messageId: string | null }
  | { type: "problem"; key: string; problem: PracticeProblem }
  | { type: "conclusion"; key: string; problem: PracticeProblem }
  | { type: "answer"; key: string; answer: CalibrationResult }
  | { type: "pending"; key: string; quiz: QuizPayload };

export interface PracticeTranscriptInput {
  messages: SessionMessage[];
  practice: PracticeState;
  answers?: Record<string, CalibrationResult>;
  pending_quiz?: QuizPayload | null;
}

const toMillis = (ts: string): number | null => {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
};

/** Tie-break when two items share a timestamp: the problem shows before what reacts to it. */
const RANK: Record<PracticeTranscriptItem["type"], number> = {
  problem: 0,
  message: 1,
  answer: 1,
  attempt: 1,
  conclusion: 2,
  pending: 3,
};

/** Which problem was open at time `ms` (latest created at or before it). */
function problemAt(problems: PracticeProblem[], ms: number | null): string | null {
  if (ms === null) return null;
  let best: { id: string; at: number } | null = null;
  for (const p of problems) {
    const at = toMillis(p.created_at);
    if (at !== null && at <= ms && (!best || at >= best.at)) best = { id: p.id, at };
  }
  return best?.id ?? null;
}

/**
 * Orders messages, problems, attempts and conclusions by timestamp
 * (messages `created_at`, problem `created_at`, conclusion `concluded_at`).
 * Attempts come from the `Tentativa:` user messages; attempts recorded on a
 * problem without a matching message are added from `problem.attempts`.
 * Items without a timestamp inherit the previous item's time (stable order).
 */
export function buildPracticeTranscript(input: PracticeTranscriptInput): PracticeTranscriptItem[] {
  const { messages, practice } = input;
  const answers = input.answers ?? {};
  const entries: { item: PracticeTranscriptItem; ms: number | null; seq: number }[] = [];
  let seq = 0;
  const push = (item: PracticeTranscriptItem, ts: string) => entries.push({ item, ms: toMillis(ts), seq: seq++ });

  const seenAttempts = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const ts = message.created_at || message.timestamp;
    const answer = message.quiz_id ? answers[message.quiz_id] : undefined;
    if (answer) {
      push({ type: "answer", key: message.id, answer }, ts);
      continue;
    }
    const text = attemptText(message);
    if (text !== null) {
      seenAttempts.add(normText(text));
      push(
        { type: "attempt", key: message.id, text, at: ts, problemId: problemAt(practice.problems, toMillis(ts)), messageId: message.id },
        ts,
      );
      continue;
    }
    push({ type: "message", key: message.id, message }, ts);
  }

  for (const problem of practice.problems) {
    push({ type: "problem", key: `problem-${problem.id}`, problem }, problem.created_at);
    problem.attempts.forEach((a, i) => {
      if (seenAttempts.has(normText(a.text))) return;
      push(
        { type: "attempt", key: `attempt-${problem.id}-${i}`, text: a.text, at: a.at, problemId: problem.id, messageId: null },
        a.at || problem.created_at,
      );
    });
    if (problem.outcome !== null) {
      push({ type: "conclusion", key: `conclusion-${problem.id}`, problem }, problem.concluded_at ?? "");
    }
  }

  // Items without a time keep their place after the previous timed item of their stream.
  let last = Number.NEGATIVE_INFINITY;
  const timed = entries.map((e) => {
    if (e.ms !== null) last = e.ms;
    return { ...e, ms: e.ms ?? last };
  });
  timed.sort((a, b) => a.ms - b.ms || RANK[a.item.type] - RANK[b.item.type] || a.seq - b.seq);
  const items = timed.map((e) => e.item);
  if (input.pending_quiz) {
    items.push({ type: "pending", key: `pending-${input.pending_quiz.quiz_id}`, quiz: input.pending_quiz });
  }
  return items;
}

// --- PracticeDock state machine ------------------------------------------------

export type DockMode = "attempt" | "free";

export interface DockState {
  /** `attempt` while a problem is active; `free` otherwise. */
  mode: DockMode;
  /** The agent is running (or a send is in flight): no submission allowed. */
  busy: boolean;
  /** Shows the "Próximo problema" button (no active problem, agent idle). */
  canNext: boolean;
  /** Esc opens the "Descartar problema?" dialog. */
  canDismiss: boolean;
}

export function dockState(input: {
  activeProblemId: string | null;
  executionStatus: SessionExecutionStatus | string | undefined;
  sending?: boolean;
  pendingQuiz?: boolean;
}): DockState {
  const running = input.executionStatus === "queued" || input.executionStatus === "running";
  const busy = running || Boolean(input.sending) || Boolean(input.pendingQuiz);
  const mode: DockMode = input.activeProblemId ? "attempt" : "free";
  return {
    mode,
    busy,
    canNext: mode === "free" && !busy,
    canDismiss: mode === "attempt" && !input.sending,
  };
}

export interface DockSubmission {
  kind: ChatMessageKind;
  content: string;
}

/**
 * What a submit (Enter / Enviar) sends:
 * - active problem: non-empty text → `attempt`; empty → nothing;
 * - no active problem: empty → `next`; text → `text`;
 * - busy → nothing.
 */
export function dockSubmission(state: DockState, draft: string): DockSubmission | null {
  if (state.busy) return null;
  const content = draft.trim();
  if (state.mode === "attempt") return content ? { kind: "attempt", content } : null;
  return content ? { kind: "text", content } : { kind: "next", content: "" };
}

export type DockKeyAction = "submit" | "confirm-dismiss" | "none";

/** Enter (without Shift / IME composition) submits; Esc with an active problem asks to dismiss. */
export function dockKeyAction(
  state: DockState,
  key: string,
  mods: { shift?: boolean; composing?: boolean } = {},
): DockKeyAction {
  if (mods.composing) return "none";
  if (key === "Escape") return state.canDismiss ? "confirm-dismiss" : "none";
  if (key === "Enter" && !mods.shift) return "submit";
  return "none";
}

// --- Labels (PT-BR / EN) -------------------------------------------------------

export type PracticeLocale = "pt-BR" | "en";

const pick = (locale: string): PracticeLocale => (locale === "en" ? "en" : "pt-BR");

const OUTCOME_LABELS: Record<PracticeLocale, Record<PracticeOutcome, string>> = {
  "pt-BR": {
    solved: "Resolvido",
    solvedWithHints: "Resolvido com dicas",
    movedOn: "Seguiu adiante",
    surrendered: "Desistiu",
    dismissed: "Descartado",
  },
  en: {
    solved: "Solved",
    solvedWithHints: "Solved with hints",
    movedOn: "Moved on",
    surrendered: "Surrendered",
    dismissed: "Dismissed",
  },
};

const RUNG_LABELS: Record<PracticeLocale, Record<HintLevel, string>> = {
  "pt-BR": {
    R0: "Só a pergunta de volta",
    R1: "Pista de categoria",
    R2: "Princípio nomeado",
    R3: "Primeiro passo",
    R4: "Resolução parcial guiada",
    R5: "Caminhada completa",
  },
  en: {
    R0: "Question handed back",
    R1: "Category cue",
    R2: "Principle named",
    R3: "First step",
    R4: "Guided partial solution",
    R5: "Full walkthrough",
  },
};

const MISS_LABELS: Record<PracticeLocale, Record<PracticeMissClass, string>> = {
  "pt-BR": {
    cue: "Gatilho",
    discrimination: "Discriminação",
    execution: "Execução",
    careless: "Descuido",
    structural: "Estrutural",
  },
  en: {
    cue: "Cue",
    discrimination: "Discrimination",
    execution: "Execution",
    careless: "Careless",
    structural: "Structural",
  },
};

const MODE_LABELS: Record<PracticeLocale, Record<PracticeProblemMode, string>> = {
  "pt-BR": { recall: "Recordar", discrimination: "Discriminar", composition: "Compor" },
  en: { recall: "Recall", discrimination: "Discriminate", composition: "Compose" },
};

export const outcomeLabel = (outcome: PracticeOutcome, locale: string) => OUTCOME_LABELS[pick(locale)][outcome];
/** "R2 · Princípio nomeado". */
export const rungLabel = (rung: HintLevel, locale: string) => `${rung} · ${RUNG_LABELS[pick(locale)][rung]}`;
export const missClassLabel = (miss: PracticeMissClass, locale: string) => MISS_LABELS[pick(locale)][miss];
export const problemModeLabel = (mode: PracticeProblemMode, locale: string) => MODE_LABELS[pick(locale)][mode];

export type OutcomeTone = "success" | "warning" | "danger" | "muted";

export function outcomeTone(outcome: PracticeOutcome): OutcomeTone {
  switch (outcome) {
    case "solved":
      return "success";
    case "solvedWithHints":
      return "warning";
    case "surrendered":
      return "danger";
    default:
      return "muted";
  }
}
