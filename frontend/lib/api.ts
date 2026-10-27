import { decodeConfig, decodeSetup, encodeConfig, encodeSlot, engineWire } from "./config-wire";
/**
 * Typed HTTP client helper functions calling the /api/* backend routes.
 * Follows notify -> fetch architecture without polling.
 */

import type {
  AgyPermissionStatus,
  BackgroundJobStatus,
  CalibrationResult,
  CatalogLessonItem,
  ConnectorTestResult,
  EngineKind,
  ModelCatalog,
  ModelSlotConfig,
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
  ChatMessageKind,
  HarnessConfig,
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
import { decodeAnswer, decodeQuiz, decodeSession } from "./session-wire";
import { decodeGraph } from "./graph-wire";
import { decodeUsageReport } from "./usage";
import type { ModelChoicePayload } from "./model-choice";
import type { UsageReport } from "./types";

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
    if (typeof window !== "undefined" && res.status === 409 && /setup/i.test(msg)) {
      // Any action that needs a configured vault (TEACH from sidebar, import, graph…) opens Setup.
      window.dispatchEvent(new CustomEvent("harness:open-setup"));
    }
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

/** Estado da permissão global `mcp(harness/*)` do agy (erros inline, silent). */
/** Lista de modelos do motor (agy: `agy models`; demais: API ou lista estática). */
export const getModels = (engine: EngineKind, signal?: AbortSignal) =>
  fetchJson<ModelCatalog>(
    `/api/setup/models?engine=${encodeURIComponent(engineWire(engine))}`,
    { signal },
    { silent: true },
  );

/** Gasta um prompt mínimo para provar auth + modelo do slot (pode levar 10–30 s). */
export const testConnector = (slot: ModelSlotConfig, apiKey?: string, signal?: AbortSignal) =>
  fetchJson<ConnectorTestResult>(
    "/api/setup/connectors/test",
    {
      method: "POST",
      body: JSON.stringify({ slot: encodeSlot(slot), ...(apiKey?.trim() ? { api_key: apiKey.trim() } : {}) }),
      signal,
    },
    { silent: true },
  );

export const getAgyPermission = () =>
  fetchJson<AgyPermissionStatus>("/api/setup/agy-permission", {}, { silent: true });

/** Concede a regra só com consentimento explícito do usuário (backup + escrita atômica no backend). */
export const grantAgyPermission = () =>
  fetchJson<AgyPermissionStatus>(
    "/api/setup/agy-permission",
    { method: "POST", body: JSON.stringify({ consent: true }) },
    { silent: true }
  );

// --- Knowledge Graph & Chains ---

export async function getGraphSnapshot(): Promise<GraphSnapshot> {
  return decodeGraph(await fetchJson<unknown>("/api/graph"));
}

/** DELETE /api/graph/nodes/{id}: tombstones the node and its chains (the note's free text stays). */
export const deleteGraphNode = (id: string) =>
  fetchJson<unknown>(`/api/graph/nodes/${encodeURIComponent(id)}`, { method: "DELETE" }, { silent: true });

/** PUT /api/graph/positions with {node_id: {x, y}} (dragged positions). */
export const putGraphPositions = (positions: Record<string, { x: number; y: number }>) =>
  fetchJson<unknown>("/api/graph/positions", { method: "PUT", body: JSON.stringify(positions) }, { silent: true });

// --- Usage ---

/** GET /api/usage; null when the endpoint does not exist yet (404/405). */
export async function getUsage(signal?: AbortSignal): Promise<UsageReport | null> {
  try {
    return decodeUsageReport(await fetchJson<unknown>("/api/usage", { signal }, { silent: true }));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
    throw err;
  }
}

// --- Chat & Classroom Sessions ---

export async function listChats(): Promise<SessionRecord[]> {
  const raw = await fetchJson<unknown[]>("/api/chats");
  return Array.isArray(raw) ? raw.map(decodeSession) : [];
}

export async function getChat(id: string): Promise<SessionRecord> {
  return decodeSession(await fetchJson<unknown>(`/api/chats/${encodeURIComponent(id)}`));
}

export async function createChat(payload: {
  mode: SessionMode;
  topic?: string;
  source_file?: string;
  track_item_id?: string;
  /** Per-session model override (omitted = strong slot). */
  model_id?: string;
  effort?: ModelChoicePayload["effort"];
  /** Selected graph node ids handed to the session as context (max 64). */
  graph_context?: string[];
}): Promise<SessionRecord> {
  return decodeSession(await fetchJson<unknown>("/api/chats", {
    method: "POST",
    body: JSON.stringify(payload),
  }));
}

/** PUT /api/chats/{id}/settings {model_id, effort}; the backend may answer with the session, {session}, or nothing. */
export async function updateChatSettings(id: string, payload: ModelChoicePayload): Promise<SessionRecord | null> {
  const raw = await fetchJson<unknown>(
    `/api/chats/${encodeURIComponent(id)}/settings`,
    { method: "PUT", body: JSON.stringify(payload) },
    { silent: true },
  );
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const sessionRaw = r && r.session && typeof r.session === "object" ? r.session : r && typeof r.id === "string" ? r : null;
  return sessionRaw ? decodeSession(sessionRaw) : null;
}

/** The backend may answer with the session, {session}, or nothing. */
function sessionFromResponse(raw: unknown): SessionRecord | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const sessionRaw = r && r.session && typeof r.session === "object" ? r.session : r && typeof r.id === "string" ? r : null;
  return sessionRaw ? decodeSession(sessionRaw) : null;
}

/**
 * POST /api/chats/{id}/messages. `kind` (Fase 9, PRACTICE): `attempt` attaches
 * the text to the active problem, `next` asks for the next problem.
 */
export async function sendChatMessage(
  id: string,
  content: string,
  kind?: ChatMessageKind,
  options: FetchJsonOptions = {},
): Promise<{ session: SessionRecord | null }> {
  const raw = await fetchJson<unknown>(
    `/api/chats/${encodeURIComponent(id)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(kind ? { content, kind } : { content }),
    },
    options,
  );
  return { session: sessionFromResponse(raw) };
}

export async function submitQuizAnswer(
  id: string,
  submission: QuizSubmission
): Promise<CalibrationResult> {
  const raw = await fetchJson<unknown>(
    `/api/chats/${encodeURIComponent(id)}/answer`,
    {
      method: "POST",
      body: JSON.stringify(submission),
    },
    // The dock shows the error inline.
    { silent: true }
  );
  const result = decodeAnswer(raw, submission.quiz_id);
  if (!result) throw new ApiError("Malformed answer response", 502, raw);
  return result;
}

export async function resumeChat(
  id: string,
  restartDiagnostic = false
): Promise<SessionRecord> {
  return decodeSession(await fetchJson<unknown>(
    `/api/chats/${encodeURIComponent(id)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ restart_diagnostic: restartDiagnostic }),
    }
  ));
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
  const raw = await fetchJson<DrawingReviewResult>(
    `/api/drawings/${encodeURIComponent(slug)}/review`,
    {
      method: "POST",
    }
  );
  return { ...raw, pending_quiz: decodeQuiz(raw.pending_quiz) };
}

// --- Practice session (Fase 9) ---

/** POST /api/chats/{id}/practice/dismiss: discards the active problem (no run is triggered). */
export async function dismissPracticeProblem(id: string): Promise<SessionRecord | null> {
  const raw = await fetchJson<unknown>(
    `/api/chats/${encodeURIComponent(id)}/practice/dismiss`,
    { method: "POST" },
    { silent: true },
  );
  return sessionFromResponse(raw);
}

// --- Graph extraction ---

/**
 * POST /api/graph/extract/{session_id} (202): queues the extraction of a TEACH
 * session into the trail. The job shows in BACKGROUND AGENTS via `jobs:updated`.
 */
export async function extractSessionToGraph(sessionId: string): Promise<{ job_id: string | null }> {
  const raw = await fetchJson<unknown>(
    `/api/graph/extract/${encodeURIComponent(sessionId)}`,
    { method: "POST" },
    { silent: true },
  );
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const jobId = typeof r.job_id === "string" ? r.job_id : typeof r.id === "string" ? r.id : null;
  return { job_id: jobId };
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

/** Queues a `demo_builder` job (202). The slug arrives as `result_id` once `jobs:updated` reports completion. */
export async function createDemo(payload: {
  title: string;
  topic: string;
  description?: string;
  lesson_rel_path?: string;
  session_id?: string;
}): Promise<BackgroundJobStatus> {
  return fetchJson<BackgroundJobStatus>("/api/demos", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
