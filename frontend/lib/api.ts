import { decodeConfig, decodeSetup, encodeConfig } from "./config-wire";
/**
 * Typed HTTP client helper functions calling the /api/* backend routes.
 * Follows notify -> fetch architecture without polling.
 */

import type {
  BackgroundJobStatus,
  CalibrationResult,
  CatalogLessonItem,
  DrawingReviewResult,
  GithubImportRequest,
  GithubImportResult,
  GithubPreview,
  GraphSnapshot,
  ImportResult,
  McpImportItem,
  McpImportServer,
  McpServerTestResult,
  McpServerUpsert,
  HarnessConfig,
  HintStep,
  PracticeAttemptGrade,
  PracticeSet,
  QuizSubmission,
  SessionMode,
  SessionRecord,
  SetupStatusResponse,
} from "./types";
import {
  buildDeleteMcpServer,
  buildGithubImport,
  buildGithubPreview,
  buildImportMcpItems,
  buildListMcpItems,
  buildListMcpServers,
  buildLocalImport,
  buildTestMcpServer,
  buildUpsertMcpServer,
  type RequestSpec,
} from "./import-wire";

const BASE_URL = "";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface FetchJsonOptions {
  /** Não dispara o toast global `harness:error` (quem chama mostra o erro inline). */
  silent?: boolean;
}

function errorDetail(errBody: unknown): string | null {
  if (typeof errBody !== "object" || errBody === null || !("detail" in errBody)) return null;
  const detail = (errBody as { detail: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
      .join("; ");
  }
  if (typeof detail === "object" && detail !== null && "message" in detail) {
    return String((detail as { message: unknown }).message);
  }
  return JSON.stringify(detail);
}

async function fetchJson<T>(
  endpoint: string,
  options: RequestInit = {},
  { silent = false }: FetchJsonOptions = {}
): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const headers = new Headers(options.headers);

  if (!headers.has("Content-Type") && options.body && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const raw = await res.text();
    let errBody: unknown = raw;
    try { errBody = JSON.parse(raw); } catch { /* Keep plain-text response. */ }
    const msg = errorDetail(errBody) ?? `Request to ${endpoint} failed with status ${res.status}`;
    if (!silent && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("harness:error", {detail: msg}));
    throw new ApiError(msg, res.status, errBody);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Executa um RequestSpec puro (lib/import-wire) com erros inline (silent). */
function send<T>(spec: RequestSpec, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(spec.path, { method: spec.method, body: spec.body, signal }, { silent: true });
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

// --- Import multi-fonte (Fase 3B) ---
// Todas silenciosas: os componentes de import mostram o erro inline.

export const listMcpServers = () => send<McpImportServer[]>(buildListMcpServers());
export const upsertMcpServer = (input: McpServerUpsert) =>
  send<McpImportServer>(buildUpsertMcpServer(input));
export const deleteMcpServer = (name: string) => send<void>(buildDeleteMcpServer(name));
export const testMcpServer = (name: string) => send<McpServerTestResult>(buildTestMcpServer(name));
export const listMcpItems = (name: string, signal?: AbortSignal) =>
  send<McpImportItem[]>(buildListMcpItems(name), signal);
export const importMcpItems = (name: string, itemIds: string[], startSession: boolean) =>
  send<ImportResult>(buildImportMcpItems(name, itemIds, startSession));
export const previewGithubRepo = (url: string, signal?: AbortSignal) =>
  send<GithubPreview>(buildGithubPreview(url), signal);
export const importGithubRepo = (req: GithubImportRequest, signal?: AbortSignal) =>
  send<GithubImportResult>(buildGithubImport(req), signal);
export const importLocalFile = (file: File, title: string, startSession: boolean) =>
  send<ImportResult>(buildLocalImport(file, file.name, title, startSession));

// --- Setup & Configuration ---

export async function getSetupStatus(): Promise<SetupStatusResponse> {
  return decodeSetup(await fetchJson("/api/setup/status"));
}

export async function completeSetup(
  config: Partial<HarnessConfig>, apiKey?: string
): Promise<{ success: boolean; config: HarnessConfig }> {
  const result = await fetchJson<{ success: boolean; config: HarnessConfig }>("/api/setup/complete", {
    method: "POST",
    body: JSON.stringify(encodeConfig(config, apiKey)),
  });
  if (result.success) window.dispatchEvent(new Event("harness:config"));
  return {...result, config: decodeConfig(result.config)};
}

// --- Knowledge Graph & Chains ---

export async function getGraphSnapshot(): Promise<GraphSnapshot> {
  return fetchJson<GraphSnapshot>("/api/graph");
}

// --- Chat & Classroom Sessions ---

export async function listChats(): Promise<SessionRecord[]> {
  return fetchJson<SessionRecord[]>("/api/chats");
}

export async function getChat(id: string): Promise<SessionRecord> {
  return fetchJson<SessionRecord>(`/api/chats/${encodeURIComponent(id)}`);
}

export async function createChat(payload: {
  mode: SessionMode;
  topic?: string;
  source_file?: string;
  track_item_id?: string;
}): Promise<SessionRecord> {
  return fetchJson<SessionRecord>("/api/chats", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function sendChatMessage(
  id: string,
  content: string
): Promise<{ session: SessionRecord }> {
  return fetchJson<{ session: SessionRecord }>(
    `/api/chats/${encodeURIComponent(id)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ content }),
    }
  );
}

export async function submitQuizAnswer(
  id: string,
  submission: QuizSubmission
): Promise<CalibrationResult> {
  return fetchJson<CalibrationResult>(
    `/api/chats/${encodeURIComponent(id)}/answer`,
    {
      method: "POST",
      body: JSON.stringify(submission),
    }
  );
}

export async function resumeChat(
  id: string,
  restartDiagnostic = false
): Promise<SessionRecord> {
  return fetchJson<SessionRecord>(
    `/api/chats/${encodeURIComponent(id)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ restart_diagnostic: restartDiagnostic }),
    }
  );
}

// --- Concept notes (read-only in-app pane) ---

export interface ConceptNote {
  /** Vault-relative path, e.g. "Conceitos/Attention.md". */
  path: string;
  markdown: string;
}

/**
 * GET /api/graph/concepts/{id}/note → {path, markdown}.
 * Silent: the pane renders a graceful message (404 when the endpoint/note is missing).
 */
export async function getConceptNote(id: string, signal?: AbortSignal): Promise<ConceptNote> {
  return fetchJson(`/api/graph/concepts/${encodeURIComponent(id)}/note`, { signal }, { silent: true });
}

// --- Sources & Citations ---

export async function getSourceParagraph(
  sourceName: string,
  paragraphId: string
): Promise<{
  sourceName: string;
  paragraphId: string;
  content: string;
  context_before?: string;
  context_after?: string;
}> {
  const query = new URLSearchParams({
    source: sourceName,
    p: paragraphId,
  });
  return fetchJson(`/api/sources/paragraph?${query.toString()}`);
}

export async function getImportCatalog(): Promise<{
  mcp_connected: boolean;
  items: CatalogLessonItem[];
}> {
  return fetchJson<{ mcp_connected: boolean; items: CatalogLessonItem[] }>(
    "/api/import/catalog"
  );
}

export async function importSource(payload: {
  item_id?: string;
  file_content?: string;
  file_name?: string;
  title: string;
}): Promise<{ source_path: string; session_id?: string }> {
  return fetchJson<{ source_path: string; session_id?: string }>(
    "/api/import/ingest",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    { silent: true }
  );
}

// --- Excalidraw Drawings & Vision Review ---

export async function getDrawing(slug: string): Promise<{
  slug: string;
  file_path: string;
  title: string;
  elements: unknown[];
  files?: Record<string, any>;
  appState?: Record<string, any>;
  prompt?: string;
}> {
  return fetchJson(`/api/drawings/${encodeURIComponent(slug)}`);
}

export async function createDrawing(payload: {
  title: string;
  session_id?: string;
  concept_ids?: string[];
  prompt?: string;
}): Promise<{ slug: string; file_path: string }> {
  return fetchJson("/api/drawings", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function saveDrawing(
  slug: string,
  payload: {
    elements: unknown[];
    appState?: unknown;
    files?: Record<string, unknown>;
    pngBase64?: string;
  }
): Promise<{ success: boolean }> {
  return fetchJson(`/api/drawings/${encodeURIComponent(slug)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function reviewDrawing(
  slug: string
): Promise<DrawingReviewResult> {
  return fetchJson<DrawingReviewResult>(
    `/api/drawings/${encodeURIComponent(slug)}/review`,
    {
      method: "POST",
    }
  );
}

// --- Practice Sets & Hint Ladder ---

export async function getPracticeSets(): Promise<PracticeSet[]> {
  return fetchJson<PracticeSet[]>("/api/practice/sets");
}

export async function generatePracticeSet(
  topics?: string[]
): Promise<PracticeSet | {job_id: string; status: string}> {
  return fetchJson<PracticeSet | {job_id: string; status: string}>("/api/practice/generate", {
    method: "POST",
    body: JSON.stringify({ topics: topics || [] }),
  });
}

export async function submitPracticeAttempt(
  setId: string,
  problemId: string,
  answer: string,
  requestHint = false
): Promise<{
  grade?: PracticeAttemptGrade;
  next_hint?: HintStep;
}> {
  return fetchJson(
    `/api/practice/sets/${encodeURIComponent(setId)}/problems/${encodeURIComponent(problemId)}/attempt`,
    {
      method: "POST",
      body: JSON.stringify({ answer, request_hint: requestHint }),
    }
  );
}

// --- Background Jobs ---

export async function getBackgroundJobs(): Promise<BackgroundJobStatus[]> {
  return fetchJson<BackgroundJobStatus[]>("/api/jobs");
}

export async function retryJob(id: string): Promise<BackgroundJobStatus> {
  return fetchJson<BackgroundJobStatus>(
    `/api/jobs/${encodeURIComponent(id)}/retry`,
    { method: "POST" }
  );
}

// --- Interactive Demos ---

export async function createDemo(payload: {
  title: string;
  topic: string;
  description?: string;
  lesson_rel_path?: string;
}): Promise<{ slug: string; html: string }> {
  return fetchJson<{ slug: string; html: string }>("/api/demos", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
