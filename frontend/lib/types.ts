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

export type TeachContextKind = "free_topic" | "dense_source" | "track_step";

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
  status: "active" | "waiting_quiz" | "completed";
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

export interface DrawingReviewResult {
  slug: string;
  what_is_correct: string[];
  what_was_missed: string[];
  what_is_incorrect: string[];
  conceptual_quiz?: QuizPayload;
  summary: string;
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

export interface BackgroundJobStatus {
  id: string;
  type: "graph_extraction" | "practice_generation" | "vault_indexing";
  name: string;
  status: "running" | "completed" | "failed";
  progress?: number;
  started_at: string;
  details?: string;
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
