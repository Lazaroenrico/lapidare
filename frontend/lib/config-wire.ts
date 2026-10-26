import type { EngineKind, HarnessConfig, ModelSlotConfig, ModelSlots, SetupStatusResponse, WireEngine } from './types';

type Wire = Record<string, any>;
const engineToWire: Record<string, string> = { agy: 'agy', gemini: 'gemini_cli', sdk: 'genai_sdk' };
const engineFromWire: Record<string, string> = { agy: 'agy', gemini_cli: 'gemini', genai_sdk: 'sdk' };

export const AUTO_MODEL = 'auto';
const SLOT_NAMES = ['strong', 'fast', 'background'] as const;
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

export const engineWire = (engine: EngineKind | string): WireEngine =>
  (engineToWire[engine] || engine) as WireEngine;

/** Ids such as `gemini-3.8-flash-low` already pin the reasoning effort. */
export const modelPinsEffort = (model: string) => model !== AUTO_MODEL && EFFORT_SUFFIX.test(model);

export function encodeSlot(slot: ModelSlotConfig) {
  return {engine: engineWire(slot.engine), model_id: slot.model?.trim() || AUTO_MODEL, effort: slot.effort};
}

/** Fill missing slots/models with `auto`; agy never accepts the legacy gemini-2.5-* ids. */
export function normalizeSlots(slots: Partial<ModelSlots> | undefined, engine: EngineKind = 'agy'): ModelSlots {
  const out = {} as ModelSlots;
  for (const name of SLOT_NAMES) {
    const slot = slots?.[name];
    const slotEngine = slot?.engine || engine;
    let model = slot?.model?.trim() || AUTO_MODEL;
    if (slotEngine === 'agy' && model.startsWith('gemini-2.5-')) model = AUTO_MODEL;
    out[name] = {engine: slotEngine, model, effort: slot?.effort || (name === 'fast' ? 'low' : 'medium')};
  }
  return out;
}

/** The API boundary alone translates legacy presentation names to canonical contracts. */
export function encodeConfig(config: Partial<HarnessConfig>, apiKey?: string) {
  const { initialized, vault_folders, slots, track, content_mcps, ...rest } = config;
  return {
    ...rest,
    configured: initialized,
    language: config.language === 'en' ? 'en' : 'pt-BR',
    ...(apiKey?.trim() ? { api_key: apiKey.trim() } : {}),
    folders: vault_folders && {
      lessons_dir: vault_folders.aulas, concepts_dir: vault_folders.conceitos,
      sources_dir: vault_folders.fontes, drawings_dir: vault_folders.desenhos,
      templates_dir: vault_folders.templates, viz_dir: vault_folders.viz,
      map_file: config.language === 'en' ? '00 Map.md' : '00 Mapa.md',
    },
    slots: slots && Object.fromEntries(Object.entries(slots).map(([name, slot]) => [name, encodeSlot(slot)])),
    track: track && {
      mode: track.mode === 'repo_binary' ? 'repo_leveling' : track.mode,
      repo_path: track.repo_path, goal_description: track.goal_description,
      ...(track.current_step_id !== undefined ? { active_item_id: track.current_step_id } : {}),
      ...(track.items !== undefined ? { queue: track.items.map(item => ({
        id: item.id, title: item.title, completed: item.completed, source_ref: item.source_path,
        kind: item.kind === 'foundation' ? 'base' : 'curriculo',
      })) } : {}),
    },
    content_mcps: content_mcps?.map(({active, ...mcp}) => ({...mcp, enabled: active})),
  };
}

export function decodeConfig(raw: Wire): HarnessConfig {
  const f = raw.folders || raw.vault_folders || {};
  const track = raw.track || {mode: 'free'};
  return {
    ...raw, initialized: raw.configured ?? raw.initialized ?? false,
    language: raw.language === 'en' ? 'en' : 'pt-br',
    vault_folders: { aulas: f.lessons_dir ?? f.aulas, conceitos: f.concepts_dir ?? f.conceitos,
      fontes: f.sources_dir ?? f.fontes, desenhos: f.drawings_dir ?? f.desenhos,
      templates: f.templates_dir ?? f.templates, viz: f.viz_dir ?? f.viz },
    slots: Object.fromEntries(Object.entries(raw.slots || {}).map(([name, value]) => {
      const slot = value as Wire;
      return [name, {...slot, engine: engineFromWire[slot.engine] || slot.engine, model: slot.model_id ?? slot.model}];
    })) as unknown as HarnessConfig['slots'],
    track: {...track, mode: track.mode === 'repo_leveling' ? 'repo_binary' : track.mode,
      active: track.mode !== 'free', current_step_id: track.active_item_id ?? track.current_step_id,
      items: (track.queue ?? track.items ?? []).map((item: Wire) => ({...item, source_path: item.source_ref ?? item.source_path,
        current: item.id === (track.active_item_id ?? track.current_step_id)}))},
    content_mcps: (raw.content_mcps || []).map((m: Wire) => ({...m, active: m.enabled ?? m.active})),
  } as HarnessConfig;
}

export function decodeSetup(raw: Wire): SetupStatusResponse {
  return {initialized: raw.configured ?? raw.initialized ?? raw.config?.configured ?? false,
    config: raw.config ? decodeConfig(raw.config) : undefined,
    connectors: (raw.connectors || []).map((c: Wire) => ({...c,
      engine: engineFromWire[c.engine] || c.engine, name: c.name || c.engine,
      details: c.detail ?? c.details, available_models: c.models ?? c.available_models ?? []}))};
}
