/**
 * Pure helpers for the per-session model/effort picker (composer + chat header).
 */

import type { EffortLevel, EngineKind, ModelSlotConfig } from "./types";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"];

const PINNED_SUFFIX = /-(low|medium|high|xhigh|max)$/i;

/** Effort fixed by the model id suffix (`gemini-x-flash-low` → "low"), or null. */
export function pinnedEffort(modelId: string | null | undefined): string | null {
  const id = (modelId ?? "").trim();
  if (!id || id === "auto") return null;
  const m = PINNED_SUFFIX.exec(id);
  return m ? m[1].toLowerCase() : null;
}

export const effortSelectable = (modelId: string | null | undefined) => pinnedEffort(modelId) === null;

export interface ModelChoice {
  model: string;
  effort: EffortLevel;
}

export interface ModelChoicePayload {
  model_id?: string;
  effort?: EffortLevel;
}

/**
 * Body fields for POST /api/chats or PUT /api/chats/{id}/settings.
 * Effort is omitted when the model id already pins it.
 */
export function modelChoicePayload(choice: ModelChoice): ModelChoicePayload {
  const model = choice.model.trim();
  const out: ModelChoicePayload = {};
  if (model) out.model_id = model;
  if (effortSelectable(model) && EFFORT_LEVELS.includes(choice.effort)) out.effort = choice.effort;
  return out;
}

/** True when the learner picked something other than the strong-slot default. */
export function differsFromSlot(choice: ModelChoice, slot: Pick<ModelSlotConfig, "model" | "effort"> | null | undefined): boolean {
  const slotModel = slot?.model?.trim() || "auto";
  const slotEffort = slot?.effort ?? "medium";
  if (choice.model.trim() !== slotModel) return true;
  return effortSelectable(choice.model) && choice.effort !== slotEffort;
}

const ENGINE_FROM_WIRE: Record<string, EngineKind> = {
  agy: "agy",
  gemini_cli: "gemini",
  gemini: "gemini",
  genai_sdk: "sdk",
  sdk: "sdk",
};

/** `SessionRecord.slot_override` (wire: {engine, model_id, effort}) → ModelSlotConfig. */
export function decodeSlotOverride(raw: unknown): ModelSlotConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const model = typeof r.model_id === "string" ? r.model_id : typeof r.model === "string" ? r.model : "";
  if (!model) return null;
  const engine = ENGINE_FROM_WIRE[String(r.engine ?? "")] ?? "agy";
  const effort = EFFORT_LEVELS.find((e) => e === r.effort);
  return { engine, model, ...(effort ? { effort } : {}) };
}

/** Short chip label: "flash-low" style ids stay intact, "auto" gets the caller's label. */
export function modelChipLabel(modelId: string, options: readonly { id: string; label: string }[], autoLabel: string): string {
  const id = modelId.trim();
  if (!id || id === "auto") return autoLabel;
  return options.find((o) => o.id === id)?.label || id;
}
