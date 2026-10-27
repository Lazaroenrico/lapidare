/**
 * Pure decoders for the session wire (GET /api/chats/{id}, POST /answer) and
 * the transcript builder. Tolerates the Fase 8 contract and older records
 * (single `chosen_index`, `options`/`title`/`dependencies` aliases, legacy phases).
 */

import type {
  CalibrationBand,
  CalibrationResult,
  DenseBlockDimensions,
  PlanDag,
  PlanNode,
  PlanNodeKind,
  PlanNodeStatus,
  ProbeAssessment,
  QuestionKind,
  QuizMode,
  QuizOption,
  QuizPayload,
  RecallGrade,
  SessionMessage,
  SessionPhase,
  SessionRecord,
  TeachPhase,
} from "./types";
import { decodeSlotOverride } from "./model-choice";
import { decodeUsageCounters } from "./usage";

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const intList = (v: unknown): number[] | null =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isInteger(x)) : null;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

const KINDS = ["quiz", "explain", "ask"] as const;
const MODES = ["PROBE", "PREDICTION", "CHECK"] as const;
const GRADES = ["correct", "partial", "incorrect"] as const;
const STATUSES = ["pending", "current", "visited", "mastered", "needs_review"] as const;
const NODE_KINDS = ["unconditional_truth", "derived_step", "goal"] as const;
const BANDS = [
  "calibrated_mastery",
  "illusion_of_competence",
  "fragile_intuition",
  "conscious_gap",
  "moderate_correct",
  "moderate_error",
] as const;

/** Default option value: A, B, C… */
export const optionLetter = (i: number) => String.fromCharCode(65 + i);

export function decodeOptions(raw: unknown): QuizOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i) => {
    if (typeof c === "string") return { value: optionLetter(i), label: c };
    const o = isObj(c) ? c : {};
    return {
      value: str(o.value) || optionLetter(i),
      label: str(o.label ?? o.text),
      description: strOrNull(o.description),
    };
  });
}

export function decodeQuiz(raw: unknown): QuizPayload | null {
  if (!isObj(raw)) return null;
  const quizId = str(raw.quiz_id ?? raw.id);
  if (!quizId) return null;
  let choices = decodeOptions(raw.choices);
  if (choices.length === 0 && Array.isArray(raw.options)) {
    // Legacy alias: [{index, label: "A", text}]
    choices = raw.options.map((o, i) => {
      const r = isObj(o) ? o : {};
      return { value: str(r.label) || optionLetter(i), label: str(r.text ?? r.label) };
    });
  }
  return {
    quiz_id: quizId,
    session_id: str(raw.session_id),
    node_id: strOrNull(raw.node_id ?? raw.plan_node_id),
    topic: str(raw.topic ?? raw.target_concept),
    question: str(raw.question),
    details: strOrNull(raw.details),
    kind: oneOf(raw.kind, KINDS) ?? (choices.length > 0 ? "quiz" : "explain"),
    mode: oneOf(raw.mode, MODES),
    choices,
    multi_select: raw.multi_select === true,
    created_at: str(raw.created_at),
  };
}

export function decodeAnswer(raw: unknown, quizId = ""): CalibrationResult | null {
  if (!isObj(raw)) return null;
  const chosen = intList(raw.chosen_indices) ?? (num(raw.chosen_index) !== null ? [raw.chosen_index as number] : []);
  const correctIdx = intList(raw.correct_indices) ?? (num(raw.correct_index) !== null ? [raw.correct_index as number] : []);
  const correct = typeof raw.correct === "boolean" ? raw.correct : typeof raw.is_correct === "boolean" ? raw.is_correct : null;
  const choices = decodeOptions(raw.choices);
  return {
    quiz_id: str(raw.quiz_id) || quizId,
    kind: (oneOf(raw.kind, KINDS) ?? "quiz") as QuestionKind,
    mode: oneOf(raw.mode, MODES) as QuizMode | null,
    node_id: strOrNull(raw.node_id),
    topic: str(raw.topic),
    question: strOrNull(raw.question ?? raw.quiz) ?? undefined,
    choices: choices.length ? choices : undefined,
    correct,
    is_dont_know: raw.is_dont_know === true,
    chosen_indices: chosen,
    correct_indices: correctIdx,
    confidence: num(raw.confidence),
    confidence_band: strOrNull(raw.confidence_band),
    calibration_band: oneOf(raw.calibration_band ?? raw.band, BANDS) as CalibrationBand | null,
    learner_thinking: str(raw.learner_thinking),
    reading_thinking: str(raw.reading_thinking),
    text: str(raw.text),
    other_text: str(raw.other_text),
    grade: oneOf(raw.grade, GRADES) as RecallGrade | null,
    grade_feedback: str(raw.grade_feedback),
    explanation: str(raw.explanation),
    timestamp: str(raw.timestamp),
  };
}

export function decodeAssessment(raw: unknown): ProbeAssessment | null {
  if (!isObj(raw) || !Array.isArray(raw.strands)) return null;
  const strands = raw.strands
    .filter(isObj)
    .map((s) => ({ strand: str(s.strand), assessment: str(s.assessment) }))
    .filter((s) => s.strand || s.assessment);
  if (strands.length === 0) return null;
  return { strands, summary: strOrNull(raw.summary), created_at: str(raw.created_at) };
}

function decodeDimensions(raw: unknown): DenseBlockDimensions | undefined {
  if (!isObj(raw)) return undefined;
  const dims: DenseBlockDimensions = {
    what_was_said: str(raw.what_was_said ?? raw.said),
    what_was_assumed: strList(raw.what_was_assumed ?? raw.assumed),
    what_was_skipped: strList(raw.what_was_skipped ?? raw.skipped),
    simplifications: strList(raw.simplifications),
    source_anchors: strList(raw.source_anchors ?? raw.paragraph_refs),
  };
  const empty =
    !dims.what_was_said && !dims.what_was_assumed.length && !dims.what_was_skipped.length &&
    !dims.simplifications.length && !dims.source_anchors.length;
  return empty ? undefined : dims;
}

export function decodePlan(raw: unknown): PlanDag {
  const r = isObj(raw) ? raw : {};
  const rawNodes = Array.isArray(r.nodes) ? r.nodes.filter(isObj) : [];
  const nodes: PlanNode[] = rawNodes.map((n) => {
    const status = n.status === "review" ? "needs_review" : oneOf(n.status, STATUSES);
    return {
      id: str(n.id),
      label: str(n.label ?? n.title) || str(n.id),
      kind: (oneOf(n.kind, NODE_KINDS) ?? "derived_step") as PlanNodeKind,
      depends_on: strList(n.depends_on ?? n.dependencies),
      status: (status ?? "pending") as PlanNodeStatus,
      dimensions: decodeDimensions(n.four_dimensions ?? n.dimensions),
    };
  });
  return { approach_prose: str(r.approach_prose), nodes, updated_at: str(r.updated_at) || undefined };
}

function decodeMessage(raw: Raw): SessionMessage {
  const ts = str(raw.timestamp ?? raw.created_at);
  return {
    ...(raw as unknown as SessionMessage),
    content: str(raw.content),
    timestamp: ts,
    created_at: str(raw.created_at) || ts,
  };
}

/** Normalizes a GET /api/chats/{id} body into a SessionRecord. */
export function decodeSession(raw: unknown): SessionRecord {
  const r = isObj(raw) ? raw : {};
  const answers: Record<string, CalibrationResult> = {};
  // The API sends a list; older payloads (and tests) use a quiz_id-keyed map.
  const entries: [string, unknown][] = Array.isArray(r.answers)
    ? r.answers.filter(isObj).map((a) => [str(a.quiz_id), a])
    : isObj(r.answers)
      ? Object.entries(r.answers)
      : [];
  for (const [id, a] of entries) {
    const decoded = decodeAnswer(a, id);
    if (decoded) answers[decoded.quiz_id || id] = decoded;
  }
  return {
    ...(r as unknown as SessionRecord),
    messages: Array.isArray(r.messages) ? r.messages.filter(isObj).map(decodeMessage) : [],
    pending_quiz: decodeQuiz(r.pending_quiz),
    answers,
    assessment: decodeAssessment(r.assessment),
    plan: r.plan === undefined || r.plan === null ? undefined : decodePlan(r.plan),
    slot_override: decodeSlotOverride(r.slot_override),
    effective_slot: decodeSlotOverride(r.effective_slot),
    usage: decodeUsageCounters(r.usage),
    graph_context: strList(r.graph_context),
  };
}

// --- Phases ------------------------------------------------------------------

/** Maps wire phases (incl. legacy) onto the teaching cycle; null for PRACTICE-only phases. */
export function normalizePhase(phase: SessionPhase | string | undefined, hasPlan: boolean): TeachPhase | null {
  switch (phase) {
    case "probing":
    case "planning":
    case "teaching":
    case "completed":
      return phase;
    case "awaiting_answer":
    case "consolidating":
      return hasPlan ? "teaching" : "probing";
    default:
      return null;
  }
}

// --- Transcript ----------------------------------------------------------------

export type TranscriptItem =
  | { type: "divider"; key: string; phase: TeachPhase }
  | { type: "message"; key: string; message: SessionMessage }
  | { type: "answer"; key: string; answer: CalibrationResult }
  | { type: "probe_done"; key: string; assessment: ProbeAssessment }
  | { type: "pending"; key: string; quiz: QuizPayload };

/** A question that is part of teaching (not a probe, not an ungraded ask) on a plan node. */
const isTeachingQuestion = (q: { kind: QuestionKind; mode: QuizMode | null; node_id: string | null }) =>
  !!q.node_id && q.kind !== "ask" && q.mode !== "PROBE";

/** Legacy answer messages carried the result as JSON: {"quiz": question, ...result}. */
export function parseAnswerMessage(message: SessionMessage): CalibrationResult | null {
  if (!message.quiz_id) return null;
  try {
    return decodeAnswer(JSON.parse(message.content), message.quiz_id);
  } catch {
    return null;
  }
}

/**
 * Builds the ordered transcript: messages, answered-question cards, the
 * ProbeDoneCard and phase dividers (Diagnóstico → Planejamento → Ensino).
 */
export function buildTranscript(
  session: Pick<SessionRecord, "mode" | "messages" | "answers" | "assessment" | "pending_quiz">,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const teach = session.mode !== "PRACTICE";
  const assessment = session.assessment;
  const assessedAt = assessment?.created_at ?? "";
  let planningShown = false;
  let teachingShown = false;

  const showPlanning = () => {
    if (planningShown || !assessment) return;
    planningShown = true;
    items.push({ type: "probe_done", key: "probe-done", assessment });
    items.push({ type: "divider", key: "divider-planning", phase: "planning" });
  };
  const showTeaching = () => {
    if (teachingShown || !teach) return;
    showPlanning();
    teachingShown = true;
    items.push({ type: "divider", key: "divider-teaching", phase: "teaching" });
  };

  const visible = session.messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (teach && (visible.length > 0 || session.pending_quiz)) {
    items.push({ type: "divider", key: "divider-probing", phase: "probing" });
  }

  for (const message of visible) {
    const ts = message.created_at || message.timestamp;
    if (assessedAt && ts && ts > assessedAt) showPlanning();
    const stored = message.quiz_id ? session.answers[message.quiz_id] : undefined;
    const fromMessage = parseAnswerMessage(message);
    const answer = stored
      ? { ...stored, question: stored.question ?? fromMessage?.question, choices: stored.choices ?? fromMessage?.choices }
      : fromMessage;
    if (answer) {
      if (isTeachingQuestion(answer)) showTeaching();
      items.push({ type: "answer", key: message.id, answer });
      continue;
    }
    if (message.node_id || message.node_spans?.some((s) => s.node_id)) showTeaching();
    items.push({ type: "message", key: message.id, message });
  }

  showPlanning();
  const pending = session.pending_quiz;
  if (pending) {
    if (isTeachingQuestion(pending)) showTeaching();
    items.push({ type: "pending", key: `pending-${pending.quiz_id}`, quiz: pending });
  }
  return items;
}
