/** HTTP calls for Settings → Agente (errors shown inline: silent). */
import { fetchJson } from "./api";
import {
  decodeAgentSettings,
  decodePromptSegments,
  promptUrl,
  type AgentSettings,
  type PromptSegment,
} from "./settings-wire";

const silent = { silent: true };

export const getAgentSettings = async (): Promise<AgentSettings> =>
  decodeAgentSettings(await fetchJson("/api/settings/agent", {}, silent));

export const putAgentSettings = async (patch: Partial<AgentSettings>): Promise<AgentSettings> =>
  decodeAgentSettings(await fetchJson("/api/settings/agent", { method: "PUT", body: JSON.stringify(patch) }, silent));

export const listPrompts = async (): Promise<PromptSegment[]> =>
  decodePromptSegments(await fetchJson("/api/settings/prompts", {}, silent));

export const putPrompt = async (path: string, text: string, enabled: boolean): Promise<PromptSegment> =>
  decodePromptSegments([await fetchJson(promptUrl(path), { method: "PUT", body: JSON.stringify({ text, enabled }) }, silent)])[0];

export const deletePrompt = async (path: string): Promise<PromptSegment> =>
  decodePromptSegments([await fetchJson(promptUrl(path), { method: "DELETE" }, silent)])[0];
