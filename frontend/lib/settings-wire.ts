/**
 * Settings → Agente wire helpers (pure): `/api/settings/agent` and the system prompt
 * segments of `/api/settings/prompts`, grouped by path for the editor.
 */

export const MIN_COMPACTION_TOKENS = 32_000;
export const MIN_EXTRACTION_CHUNK_TOKENS = 500;

export type AgentToolId = "research" | "pdf" | "visual" | "demo";
export const AGENT_TOOL_IDS: AgentToolId[] = ["research", "pdf", "visual", "demo"];

export interface AgentSettings {
  tools: Record<AgentToolId, boolean>;
  compaction_tokens: number;
  extraction_chunk_tokens: number;
  /** Fase 21: false stops the automatic and manual extraction to the graph. */
  extraction_enabled: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  tools: { research: true, pdf: true, visual: true, demo: true },
  compaction_tokens: 150_000,
  extraction_chunk_tokens: 4096,
  extraction_enabled: true,
};

const intOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;

export function decodeAgentSettings(raw: unknown): AgentSettings {
  const src = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const tools = typeof src.tools === "object" && src.tools !== null ? (src.tools as Record<string, unknown>) : {};
  return {
    tools: Object.fromEntries(
      AGENT_TOOL_IDS.map((id) => [id, typeof tools[id] === "boolean" ? tools[id] : DEFAULT_AGENT_SETTINGS.tools[id]]),
    ) as Record<AgentToolId, boolean>,
    compaction_tokens: intOr(src.compaction_tokens, DEFAULT_AGENT_SETTINGS.compaction_tokens),
    extraction_chunk_tokens: intOr(src.extraction_chunk_tokens, DEFAULT_AGENT_SETTINGS.extraction_chunk_tokens),
    extraction_enabled: typeof src.extraction_enabled === "boolean" ? src.extraction_enabled : DEFAULT_AGENT_SETTINGS.extraction_enabled,
  };
}

/** Field-level problems before a PUT (the backend enforces the same minimums). */
export function agentSettingsErrors(s: AgentSettings): Array<"compaction" | "chunk"> {
  const out: Array<"compaction" | "chunk"> = [];
  if (!Number.isInteger(s.compaction_tokens) || s.compaction_tokens < MIN_COMPACTION_TOKENS) out.push("compaction");
  if (!Number.isInteger(s.extraction_chunk_tokens) || s.extraction_chunk_tokens < MIN_EXTRACTION_CHUNK_TOKENS) out.push("chunk");
  return out;
}

// --- System prompts ---

export interface PromptSegment {
  path: string;
  source: string;
  override: string | null;
  enabled: boolean;
}

export type PromptGroupId = "shared" | "prober" | "teacher" | "practice" | "handoff" | "other";
export const PROMPT_GROUP_ORDER: PromptGroupId[] = ["shared", "prober", "teacher", "practice", "handoff", "other"];

/** Group by the first path segment: shared/ · prober/ (Diagnóstico) · teacher/ · practice/ · handoff.md. */
export function promptGroupOf(path: string): PromptGroupId {
  const head = path.split("/")[0];
  if (path === "handoff.md" || head === "handoff") return "handoff";
  if (head === "shared" || head === "prober" || head === "teacher" || head === "practice") return head;
  return "other";
}

export function decodePromptSegments(raw: unknown): PromptSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const r = item as Record<string, unknown>;
    if (typeof r.path !== "string" || !r.path) return [];
    return [{
      path: r.path,
      source: typeof r.source === "string" ? r.source : "",
      override: typeof r.override === "string" ? r.override : null,
      enabled: r.enabled === true,
    }];
  });
}

/** Non-empty groups in display order; segments keep the server order inside a group. */
export function groupPrompts(segments: PromptSegment[]): Array<{ id: PromptGroupId; segments: PromptSegment[] }> {
  const groups = new Map<PromptGroupId, PromptSegment[]>();
  for (const segment of segments) {
    const id = promptGroupOf(segment.path);
    groups.set(id, [...(groups.get(id) ?? []), segment]);
  }
  return PROMPT_GROUP_ORDER.filter((id) => groups.has(id)).map((id) => ({ id, segments: groups.get(id)! }));
}

/** URL path for one segment: each part encoded, slashes kept (the route is `{path:path}`). */
export const promptUrl = (path: string) =>
  `/api/settings/prompts/${path.split("/").map(encodeURIComponent).join("/")}`;

/** What the editor starts from: the saved override, else the original text. */
export function promptBaseline(segment: PromptSegment): { text: string; enabled: boolean } {
  return segment.override !== null ? { text: segment.override, enabled: segment.enabled } : { text: segment.source, enabled: true };
}

/**
 * Whether the editor holds something worth saving. Without an override, only a text that
 * differs from the original counts (saving the untouched original would just pin a copy).
 */
export function promptDirty(segment: PromptSegment, draft: string, enabled: boolean): boolean {
  if (segment.override === null) return draft !== segment.source;
  return draft !== segment.override || enabled !== segment.enabled;
}

/** Short label for a segment: file name without the numeric prefix and extension. */
export function promptLabel(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/, "").replace(/^\d+-/, "");
}
