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

// ---------------------------------------------------------------------------
// Family grouping for the picker: "gemini-3.8-flash-low" / "Gemini 3.8 Flash (Low)"
// → family "Gemini 3.8 Flash" with variants low | medium | high.
// ---------------------------------------------------------------------------

/** Display order of effort variants inside a family row. */
export const VARIANT_ORDER: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

const LABEL_EFFORT_SUFFIX = /\s*[([]\s*(low|medium|high|x-?high|max)\s*[)\]]\s*$/i;

export interface ModelVariant {
  /** Exact model id sent to the backend. */
  id: string;
  /** Effort pinned by the id suffix, or null for a plain id. */
  effort: string | null;
}

export interface ModelFamily {
  /** Id without the effort suffix (`gemini-3.8-flash`). */
  key: string;
  /** Readable name without the effort suffix (`Gemini 3.8 Flash`). */
  label: string;
  /** Effort variants in VARIANT_ORDER, plain (effort-less) id last. */
  variants: ModelVariant[];
}

/** Split one catalog entry into family key/label and pinned effort. */
export function splitModelVariant(id: string, label?: string | null): { key: string; label: string; effort: string | null } {
  const cleanId = (id ?? "").trim();
  const effort = pinnedEffort(cleanId);
  const key = effort ? cleanId.slice(0, cleanId.length - effort.length - 1) : cleanId;
  const rawLabel = (label ?? "").trim();
  const familyLabel = (rawLabel ? rawLabel.replace(LABEL_EFFORT_SUFFIX, "").trim() : "") || key;
  return { key, label: familyLabel, effort };
}

/** Group a flat model catalog into families (order of first appearance; "auto" excluded). */
export function groupModelFamilies(options: readonly { id: string; label?: string | null }[]): ModelFamily[] {
  const byKey = new Map<string, ModelFamily>();
  for (const o of options) {
    const id = (o?.id ?? "").trim();
    if (!id || id === "auto") continue;
    const part = splitModelVariant(id, o.label);
    let fam = byKey.get(part.key);
    if (!fam) {
      fam = { key: part.key, label: part.label, variants: [] };
      byKey.set(part.key, fam);
    } else if (!part.effort && (o.label ?? "").trim()) {
      fam.label = part.label;
    }
    if (!fam.variants.some((v) => v.id === id)) fam.variants.push({ id, effort: part.effort });
  }
  const rank = (e: string | null) => (e === null ? VARIANT_ORDER.length : VARIANT_ORDER.indexOf(e));
  for (const fam of byKey.values()) fam.variants.sort((a, b) => rank(a.effort) - rank(b.effort));
  return [...byKey.values()];
}

/** Variant chosen when the family name is clicked: plain id, else medium, else the first. */
export function familyDefaultId(family: ModelFamily): string {
  return (
    family.variants.find((v) => v.effort === null)?.id ??
    family.variants.find((v) => v.effort === "medium")?.id ??
    family.variants[0]?.id ??
    family.key
  );
}

/** Variants rendered as effort chips (the effort-less id is selected through the name). */
export const effortVariants = (family: ModelFamily): ModelVariant[] => family.variants.filter((v) => v.effort !== null);

/** Family containing this exact id, or null. */
export function findFamily(families: readonly ModelFamily[], modelId: string): ModelFamily | null {
  const id = (modelId ?? "").trim();
  return families.find((f) => f.variants.some((v) => v.id === id)) ?? null;
}

/** Case/accent-insensitive search over family names, keys and variant ids. */
export function filterFamilies(families: readonly ModelFamily[], query: string): ModelFamily[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const terms = norm(query ?? "").split(/\s+/).filter(Boolean);
  if (!terms.length) return [...families];
  return families.filter((f) => {
    const hay = norm([f.label, f.key, ...f.variants.map((v) => v.id)].join(" "));
    return terms.every((t) => hay.includes(t));
  });
}

/** Compact trigger parts: family name + effort (pinned by the id, else the chosen effort). */
export function modelTriggerParts(
  modelId: string,
  options: readonly { id: string; label?: string | null }[],
  autoLabel: string,
  chosenEffort: string,
): { name: string; effort: string; pinned: boolean } {
  const id = (modelId ?? "").trim();
  if (!id || id === "auto") return { name: autoLabel, effort: chosenEffort, pinned: false };
  const part = splitModelVariant(id, options.find((o) => o.id === id)?.label);
  return part.effort ? { name: part.label, effort: part.effort, pinned: true } : { name: part.label, effort: chosenEffort, pinned: false };
}

/**
 * Grid keyboard navigation for the picker list. `cols[i]` = focusable cells in row i
 * (name button + effort chips). Row -1 is the search box when `hasSearch`.
 * Returns the new {row, col}, or null when the key does not move focus.
 */
export function pickerNav(
  cols: readonly number[],
  pos: { row: number; col: number },
  key: string,
  hasSearch = false,
): { row: number; col: number } | null {
  if (!cols.length) return null;
  const minRow = hasSearch ? -1 : 0;
  const clampCol = (row: number, col: number) => (row < 0 ? 0 : Math.max(0, Math.min(col, cols[row] - 1)));
  switch (key) {
    case "ArrowDown": {
      const row = pos.row >= cols.length - 1 ? minRow : pos.row + 1;
      return { row, col: clampCol(row, pos.col) };
    }
    case "ArrowUp": {
      const row = pos.row <= minRow ? cols.length - 1 : pos.row - 1;
      return { row, col: clampCol(row, pos.col) };
    }
    case "ArrowRight":
      return pos.row < 0 ? null : { row: pos.row, col: Math.min(pos.col + 1, cols[pos.row] - 1) };
    case "ArrowLeft":
      return pos.row < 0 ? null : { row: pos.row, col: Math.max(pos.col - 1, 0) };
    case "Home":
      return pos.row < 0 ? null : { row: 0, col: 0 };
    case "End":
      return pos.row < 0 ? null : { row: cols.length - 1, col: 0 };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shift+Tab: cycle the effort of the current choice.
// ---------------------------------------------------------------------------

export interface EffortCycleResult {
  model_id: string;
  /** Next effort for a free-effort model; null when the new model id pins it. */
  effort: EffortLevel | null;
}

/**
 * Next step of the effort cycle. Free-effort models advance through EFFORT_LEVELS;
 * ids that pin effort by suffix advance through the variants of their family in the
 * catalog. Null when there is nothing to toggle.
 */
export function nextEffort(
  current: { model_id: string; effort: EffortLevel | null | undefined },
  models: readonly { id: string; label?: string | null }[],
): EffortCycleResult | null {
  const id = (current.model_id ?? "").trim() || "auto";
  if (effortSelectable(id)) {
    const at = current.effort ? EFFORT_LEVELS.indexOf(current.effort) : -1;
    return { model_id: id, effort: EFFORT_LEVELS[(at + 1) % EFFORT_LEVELS.length] };
  }
  const family = findFamily(groupModelFamilies(models), id);
  const variants = family ? effortVariants(family) : [];
  const at = variants.findIndex((v) => v.id === id);
  if (at < 0 || variants.length < 2) return null;
  return { model_id: variants[(at + 1) % variants.length].id, effort: null };
}
