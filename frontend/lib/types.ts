/**
 * Core TypeScript definitions for learnharness.
 * Strictly aligned with backend Pydantic v2 schemas and product invariants.
 */

// --- 1. Engine & Configuration Types ---

export type EngineKind = "agy" | "gemini" | "sdk";

export type EffortLevel = "low" | "medium" | "high";

export interface ModelSlotConfig {
  engine: EngineKind;
  model: string;
  effort?: EffortLevel;
}

/** Backend engine names (wire contract). */
export type WireEngine = "agy" | "gemini_cli" | "genai_sdk";

/** GET /api/setup/models?engine=… */
export interface ModelOption {
  id: string;
  label: string;
}
export interface ModelCatalog {
  engine: WireEngine;
  models: ModelOption[];
  source: "agy" | "api" | "static";
  error: string | null;
}

/** POST /api/setup/connectors/test (200). Failures arrive as 502/422 `{detail}`. */
export interface ConnectorTestResult {
  ok: true;
  engine: WireEngine;
  model_id: string;
  latency_ms: number;
}

export interface ModelSlots {
  strong: ModelSlotConfig;
  fast: ModelSlotConfig;
  background: ModelSlotConfig;
}

export interface VaultFolderMap {
  aulas: string;
  conceitos: string;
  fontes: string;
  desenhos: string;
  viz: string;
  templates: string;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  active: boolean;
}

export type TrackMode = "repo_binary" | "goal_generated" | "free";

export interface TrackItem {
  id: string;
  title: string;
  kind: "lecture" | "exercise" | "foundation" | "checkpoint";
  source_path?: string;
  completed: boolean;
  current?: boolean;
  phase?: string;
}

export interface TrackConfig {
  mode: TrackMode;
  active: boolean;
  repo_path?: string;
  goal_description?: string;
  current_step_id?: string;
  items?: TrackItem[];
}

export interface ConnectorStatus {
  engine: EngineKind;
  name: string;
  available: boolean;
  authenticated: boolean;
  binary_path?: string;
  details?: string;
  available_models?: string[];
}

export interface HarnessConfig {
  initialized: boolean;
  language: "pt-br" | "en";
  vault_path: string;
  vault_folders: VaultFolderMap;
  slots: ModelSlots;
  track: TrackConfig;
  content_mcps: McpServerConfig[];
}

/** GET/POST /api/setup/agy-permission — regra global `mcp(harness/*)` do agy. */
export interface AgyPermissionStatus {
  granted: boolean;
  rule: string;
  settings_path: string;
  error: string | null;
}

export interface SetupStatusResponse {
  initialized: boolean;
  config?: HarnessConfig;
  connectors: ConnectorStatus[];
}

// --- 2. Session & Teaching Types ---

export type SessionMode = "TEACH" | "PRACTICE";

export type TeachContextKind = "free_topic" | "dense_source" | "track_step" | "drawing_review";

/** Teaching cycle phases (spec Fase 8 §3). */
export type TeachPhase = "probing" | "planning" | "teaching" | "completed";

/** Wire phase: the cycle phases plus legacy values kept only by old records. */
export type SessionPhase =
  | TeachPhase
  | "awaiting_answer"
  | "consolidating"
  | "practice"
  | "review";

export interface DenseBlockDimensions {
  what_was_said: string;
  what_was_assumed: string[];
  what_was_skipped: string[];
  simplifications: string[];
  source_anchors: string[];
}

export type PlanNodeStatus = "pending" | "current" | "visited" | "mastered" | "needs_review";

export type PlanNodeKind = "unconditional_truth" | "derived_step" | "goal";

export interface PlanNode {
  id: string;
  label: string;
  kind: PlanNodeKind;
  /** Prerequisite ids (edges prerequisite → this node). */
  depends_on: string[];
  status: PlanNodeStatus;
  /** Dense-source 4 dimensions (decoded from the backend `four_dimensions`). */
  dimensions?: DenseBlockDimensions;
}

export interface PlanDag {
  approach_prose: string;
  nodes: PlanNode[];
  updated_at?: string;
}

export interface ProbeStrand {
  strand: string;
  assessment: string;
}

export interface ProbeAssessment {
  strands: ProbeStrand[];
  summary: string | null;
  created_at: string;
}

export interface SourceCitation {
  anchor: string; // e.g. "^p14"
  source_name: string;
  excerpt: string;
  block_title?: string;
}

export interface NodeSpan {
  start: number;
  node_id: string | null;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  created_at?: string;
  node_id?: string | null;
  /** Set on the user message that carries a question answer. */
  quiz_id?: string | null;
  node_spans?: NodeSpan[];
  source_citations?: SourceCitation[];
}

export type SessionExecutionStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "interrupted"
  | "failed"
  | "completed";

export interface SessionRecord {
  id: string;
  mode: SessionMode;
  teach_context?: TeachContextKind;
  title: string;
  topic: string;
  created_at: string;
  updated_at: string;
  phase: SessionPhase;
  plan?: PlanDag;
  messages: SessionMessage[];
  /** Coarse legacy status (kept for backward compat). Prefer `execution_status`. */
  status: "active" | "waiting_quiz" | "completed";
  /** Durable execution state of the agent run behind this session. */
  execution_status: SessionExecutionStatus;
  /** Redacted error from the last failed run, if any. */
  error?: string | null;
  /** True when the session can only continue by restarting the diagnostic. */
  recovery_required: boolean;
  source_file?: string;
  track_item_id?: string;
  pending_quiz?: QuizPayload | null;
  /** Answered questions by quiz_id (extended CalibrationResult). */
  answers: Record<string, CalibrationResult>;
  /** Result of `probe_done` (diagnosis per strand). */
  assessment: ProbeAssessment | null;
}

// --- 3. Questions & Calibration ---

export type QuestionKind = "quiz" | "explain" | "ask";

export type QuizMode = "PROBE" | "PREDICTION" | "CHECK";

export type CalibrationBand =
  | "calibrated_mastery"
  | "illusion_of_competence"
  | "fragile_intuition"
  | "conscious_gap"
  | "moderate_correct"
  | "moderate_error";

export type RecallGrade = "correct" | "partial" | "incorrect";

export interface QuizOption {
  value: string;
  label: string;
  description?: string | null;
}

/** Pending question as served by the API (never carries the answer key). */
export interface QuizPayload {
  quiz_id: string;
  session_id: string;
  node_id: string | null;
  topic: string;
  question: string;
  details: string | null;
  kind: QuestionKind;
  mode: QuizMode | null;
  choices: QuizOption[];
  multi_select: boolean;
  created_at: string;
}

/** Body of POST /api/chats/{id}/answer. */
export interface QuizSubmission {
  quiz_id: string;
  session_id: string;
  chosen_indices: number[];
  is_dont_know: boolean;
  confidence: number | null;
  learner_thinking: string;
  reading_thinking: string;
  text: string;
  other_text: string;
}

/** Extended answer record (session.answers[quiz_id] and the POST /answer response). */
export interface CalibrationResult {
  quiz_id: string;
  kind: QuestionKind;
  mode: QuizMode | null;
  node_id: string | null;
  topic: string;
  question?: string;
  /**
   * Choice labels in ORIGINAL order, when the backend includes them
   * (or the client remembered them from the pending question).
   */
  choices?: QuizOption[];
  correct: boolean | null;
  is_dont_know: boolean;
  chosen_indices: number[];
  correct_indices: number[];
  confidence: number | null;
  confidence_band?: string | null;
  calibration_band?: CalibrationBand | null;
  learner_thinking: string;
  reading_thinking: string;
  text: string;
  other_text: string;
  grade: RecallGrade | null;
  grade_feedback: string;
  explanation: string;
  timestamp: string;
}

// --- 4. Knowledge Graph & Chains ---

export type ConceptStatus = "aprendendo" | "sólido" | "revisar";

export interface ConceptNode {
  id: string;
  name: string;
  status: ConceptStatus;
  summary: string;
  file_path: string;
  depends_on: string[];
  cluster?: string;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind?: "dependency" | "implication" | "reinforces";
}

export interface LogicalChain {
  id: string;
  premises: string[];
  conclusion: string;
  formula?: string;
  source_session_id?: string;
  notes?: string;
}

export interface GraphSnapshot {
  nodes: ConceptNode[];
  edges: GraphEdge[];
  chains: LogicalChain[];
}

// --- 5. Practice & Hint Ladder (R0-R5) ---

export type HintLevel = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";

export interface HintStep {
  level: HintLevel;
  title: string;
  content: string;
}

export interface RubricCriterion {
  name: string;
  weight: number;
  description: string;
}

export interface PracticeProblem {
  id: string;
  title: string;
  topic?: string;
  prompt: string;
  target_concepts: string[];
  kind: "recall" | "discrimination" | "composition";
  hints: HintStep[];
  rubric: RubricCriterion[];
  max_score: number;
}

export interface PracticeAttemptGrade {
  score: number;
  max_score: number;
  feedback: string;
  rubric_scores: Record<string, number>;
}

export interface PracticeSet {
  id: string;
  title: string;
  created_at: string;
  problems: PracticeProblem[];
  session_id?: string;
  completed: boolean;
}

// --- 6. Excalidraw Multimodal Review ---

/** Response of POST /api/drawings/{slug}/review. */
export interface DrawingReviewResult {
  slug: string;
  correct_points: string[];
  missing_points: string[];
  incorrect_points: string[];
  summary_markdown: string;
  /** TEACH session (context_kind "drawing_review") hosting the follow-up quiz. */
  session_id: string | null;
  /** Follow-up quiz on conceptual errors; answered via POST /api/chats/{session_id}/answer. */
  pending_quiz: QuizPayload | null;
}

// --- 7. Server-Sent Events & Background Jobs ---

export type SseEventType =
  | "session:updated"
  | "dock:opened"
  | "dock:resolved"
  | "plan:updated"
  | "vault:changed"
  | "graph:updated"
  | "jobs:updated"
  | "config:updated";

export type BackgroundJobKind = "practice_gen" | "extraction" | "track_gen" | "demo_builder" | (string & {});

/** Raw job record as persisted in `.harness/jobs.jsonl` and served by GET /api/jobs. */
export interface BackgroundJobStatus {
  job_id: string;
  kind: BackgroundJobKind;
  label: string;
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  /** Redacted error message for failed jobs. */
  error?: string | null;
  result_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

// --- 8. MCP Catalog & Sources ---

export interface CatalogLessonItem {
  id: string;
  title: string;
  week?: number;
  category?: string;
  source_mcp?: string;
  has_transcript: boolean;
  has_code: boolean;
  imported: boolean;
  local_source_path?: string;
}

// --- 9. Import multi-fonte (Fase 3B): contrato de API ---

export type McpTransport = "http" | "sse" | "stdio";

/** Servidor MCP de conteúdo como devolvido pela API (o token nunca volta). */
export interface McpImportServer {
  name: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  enabled: boolean;
  has_auth: boolean;
  catalog_tool?: string | null;
  content_tool?: string | null;
  content_id_argument?: string | null;
}

/** Corpo de `POST /api/import/mcp/servers` (cria ou substitui por `name`). */
export interface McpServerUpsert {
  name: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
  auth_token?: string;
  catalog_tool?: string;
  content_tool?: string;
  content_id_argument?: string;
}

export interface McpServerTestResult {
  ok: boolean;
  tools: string[];
  resources: number;
  error?: string | null;
}

export interface McpImportItem {
  id: string;
  title: string;
  kind: string;
  description: string;
  is_new: boolean;
}

export interface ImportedSource {
  source_path: string;
  paragraph_count: number;
  title: string;
}

export interface ImportResult {
  imported: ImportedSource[];
  session_id: string | null;
}

export interface GithubRepoRef {
  owner: string;
  name: string;
  ref: string;
  commit: string;
  subpath: string;
}

export interface GithubPreviewFile {
  path: string;
  title: string;
  size: number;
}

export interface GithubPreview {
  repo: GithubRepoRef;
  files: GithubPreviewFile[];
  truncated: boolean;
}

export interface GithubImportRequest {
  url: string;
  paths: string[];
  start_session: boolean;
  use_as_track: boolean;
  /** Confirma a substituição de uma Trilha existente após um 409. */
  replace_track?: boolean;
}

export interface GithubImportResult extends ImportResult {
  track_job_id: string | null;
}
