/**
 * Fase 18 — Home vazia e primeiros passos: pure decisions, persisted "auto ⇶ Roteiro once"
 * memory, the decorative constellation and the PT-BR/EN strings. No DOM, no network.
 */

export type HomeLocale = "pt-BR" | "en";

export interface HomeEmptyInput {
  /** True after the first graph snapshot answered (avoids flashing before the fetch). */
  graphLoaded: boolean;
  nodeCount: number;
  trashCount: number;
  /** Id of the active (non-archived) track, if any. */
  activeTrackId: string | null;
  /** Number of roadmap items the snapshot carries for the active track. */
  activeRoadmapSteps: number;
}

export interface HomeEmptyView {
  show: boolean;
  /** "Restaurar sessões (N)" — 0 hides the link. */
  restoreCount: number;
  /** Active track with a drawable roadmap: suggest ⇶ Roteiro. */
  suggestRoadmap: boolean;
}

export function homeEmptyView(input: HomeEmptyInput): HomeEmptyView {
  const show = input.graphLoaded && input.nodeCount === 0;
  if (!show) return { show: false, restoreCount: 0, suggestRoadmap: false };
  return {
    show,
    restoreCount: Math.max(0, Math.floor(input.trashCount)),
    suggestRoadmap: !!input.activeTrackId && input.activeRoadmapSteps > 0,
  };
}

/**
 * Where the first steps sit. With ⇶ Roteiro drawn on a wide screen the constellations take
 * the centre and the graph reserves a left column (legend on top), so the card moves there.
 */
export type HomeEmptyLayout = "centered" | "beside-roadmap";

export function homeEmptyLayout(roadmapOn: boolean, wide: boolean): HomeEmptyLayout {
  return roadmapOn && wide ? "beside-roadmap" : "centered";
}

/** The ⇶ Roteiro suggestion button: only while the roadmap is off. */
export const showRoadmapSuggestion = (view: HomeEmptyView, roadmapOn: boolean): boolean =>
  view.show && view.suggestRoadmap && !roadmapOn;

/** Roadmap items of one track (the snapshot may hold several tracks' constellations). */
export function roadmapStepsFor(roadmap: readonly { track_id?: string | null }[], trackId: string | null): number {
  if (!trackId) return 0;
  return roadmap.filter((r) => r.track_id === trackId).length;
}

// --- Auto ⇶ Roteiro, once per track (localStorage) -------------------------------

export const ROADMAP_AUTO_KEY = "lapidare:home-empty:roadmap-auto";
const MAX_REMEMBERED = 50;

/** Track ids that already got the one-shot auto-on (tolerant to garbage). */
export function decodeAutoRoadmap(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Turn the roadmap on automatically only the first time an empty Home meets this track,
 * and only on wide screens (on a phone the legend would cover the first steps).
 */
export function shouldAutoRoadmap(
  view: HomeEmptyView,
  trackId: string | null,
  seen: readonly string[],
  wide = true,
): boolean {
  return wide && view.show && view.suggestRoadmap && !!trackId && !seen.includes(trackId);
}

export function rememberAutoRoadmap(seen: readonly string[], trackId: string): string {
  const next = [...seen.filter((id) => id !== trackId), trackId].slice(-MAX_REMEMBERED);
  return JSON.stringify(next);
}

// --- Decorative constellation ----------------------------------------------------

export interface Star {
  x: number;
  y: number;
  r: number;
  /** 0..1 — multiplied by the token colour's opacity in the view. */
  alpha: number;
}

export interface Constellation {
  width: number;
  height: number;
  stars: Star[];
  /** Index pairs into `stars`. */
  links: [number, number][];
}

/** Small deterministic PRNG (mulberry32) so the sky is stable across renders/SSR. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A faint sky: `count` scattered dust stars plus one small linked figure (a chain of
 * 5 brighter stars) — a hint of what a learned trail looks like. Inside a width×height box.
 */
export function buildConstellation(seed = 18, count = 22, width = 320, height = 120): Constellation {
  const rand = rng(seed);
  const stars: Star[] = [];
  // The figure: a gentle zig-zag across the middle of the box.
  const figure = 5;
  for (let i = 0; i < figure; i++) {
    const x = width * (0.2 + (0.6 * i) / (figure - 1));
    const y = height * (0.5 + (i % 2 === 0 ? -0.14 : 0.14) + (rand() - 0.5) * 0.12);
    stars.push({ x: round(x), y: round(y), r: i === 2 ? 2.4 : 1.8, alpha: i === 2 ? 0.9 : 0.7 });
  }
  const links: [number, number][] = [];
  for (let i = 0; i < figure - 1; i++) links.push([i, i + 1]);
  links.push([1, 3]);
  // Dust.
  for (let i = 0; i < Math.max(0, count - figure); i++) {
    stars.push({
      x: round(4 + rand() * (width - 8)),
      y: round(4 + rand() * (height - 8)),
      r: round(0.6 + rand() * 0.8),
      alpha: round(0.2 + rand() * 0.35),
    });
  }
  return { width, height, stars, links };
}

const round = (n: number) => Math.round(n * 100) / 100;

// --- Strings ----------------------------------------------------------------------

export interface HomeEmptyText {
  title: string;
  lead: string;
  startTopic: string;
  startTopicHint: string;
  importNotes: string;
  importNotesHint: string;
  createTrack: string;
  createTrackHint: string;
  restore: (n: number) => string;
  roadmapSuggest: string;
  roadmapHint: string;
  regionLabel: string;
}

const PT: HomeEmptyText = {
  title: "Céu limpo, por enquanto",
  lead: "Seu mapa de conhecimento aparece aqui conforme você estuda.",
  startTopic: "Começar um tema",
  startTopicHint: "Escreva no composer o que quer aprender",
  importNotes: "Importar notas para o grafo",
  importNotesHint: "Traga notas ou fontes que você já tem",
  createTrack: "Criar uma trilha",
  createTrackHint: "Um roteiro guiado por etapas",
  restore: (n) => `Restaurar sessões (${n})`,
  roadmapSuggest: "⇶ Ver o roteiro da trilha ativa",
  roadmapHint: "As etapas aparecem como constelações até virarem nós",
  regionLabel: "Primeiros passos",
};

const EN: HomeEmptyText = {
  title: "A clear sky, for now",
  lead: "Your knowledge map shows up here as you study.",
  startTopic: "Start a topic",
  startTopicHint: "Type what you want to learn in the composer",
  importNotes: "Import notes into the graph",
  importNotesHint: "Bring in notes or sources you already have",
  createTrack: "Create a track",
  createTrackHint: "A guided, step-by-step roadmap",
  restore: (n) => `Restore sessions (${n})`,
  roadmapSuggest: "⇶ Show the active track's roadmap",
  roadmapHint: "Steps show as constellations until they become nodes",
  regionLabel: "First steps",
};

export const homeEmptyText = (locale: string): HomeEmptyText => (locale === "en" ? EN : PT);
