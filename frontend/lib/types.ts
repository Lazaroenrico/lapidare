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

export interface SetupStatusResponse {
  initialized: boolean;
  config?: HarnessConfig;
  connectors: ConnectorStatus[];
}

// --- 2. Session & Teaching Types ---

export type SessionMode = "TEACH" | "PRACTICE";

export type TeachContextKind = "free_topic" | "dense_source" | "track_step" | "drawing_review";

export type SessionPhase =
  | "probing"
  | "planning"
  | "teaching"
  | "practice"
  | "review"
  | "completed";

export interface DenseBlockDimensions {
  what_was_said: string;
  what_was_assumed: string[];
  what_was_skipped: string[];
  simplifications: string[];
  source_anchors: string[];
}

export interface PlanNode {
  id: string;
  title: string;
  summary?: string;
  status: "pending" | "current" | "mastered" | "review";
  source_block_idx?: number;
  dependencies?: string[];
}

export interface PlanDag {
  nodes: PlanNode[];
  current_node_id?: string;
}

export interface SourceCitation {
  anchor: string; // e.g. "^p14"
  source_name: string;
  excerpt: string;
  block_title?: string;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  phase?: SessionPhase;
  plan_update?: PlanDag;
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
}

// --- 3. Quiz & Calibration Matrix ---

export type QuizMode = "PREDICTION" | "CHECK";

export type CalibrationBand =
  | "calibrated" // Correct + Conf >= 70%
  | "illusion_of_competence" // Wrong + Conf >= 70%
  | "fragile_intuition" // Correct + Conf < 50%
  | "conscious_gap"; // Wrong + Conf < 50% or "I don't know"

export interface QuizOption {
  index: number;
  label: string;
  text: string;
}

export interface QuizPayload {
  id: string;
  session_id: string;
  mode: QuizMode;
  question: string;
  options: QuizOption[];
  has_dont_know: boolean;
  target_concept?: string;
  plan_node_id?: string;
  block_idx?: number;
}

export interface QuizSubmission {
  quiz_id: string;
  chosen_index: number;
  confidence: number; // 0 to 100
  learner_thinking?: string;
}

export interface CalibrationResult {
  is_correct: boolean;
  correct_index: number;
  chosen_index: number;
  confidence: number;
  band: CalibrationBand;
  feedback_prose: string;
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
