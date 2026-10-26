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
  GraphSnapshot,
  HarnessConfig,
  HintStep,
  PracticeAttemptGrade,
  PracticeSet,
  QuizSubmission,
  SessionMode,
  SessionRecord,
  SetupStatusResponse,
} from "./types";

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

async function fetchJson<T>(
  endpoint: string,
  options: RequestInit = {}
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
    const msg =
      typeof errBody === "object" && errBody !== null && "detail" in errBody
        ? String((errBody as { detail: unknown }).detail)
        : `Request to ${endpoint} failed with status ${res.status}`;
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("harness:error", {detail: msg}));
    throw new ApiError(msg, res.status, errBody);
  }

  return res.json() as Promise<T>;
}

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
    }
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
