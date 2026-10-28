/**
 * Pure decoding for steers (Fase 10): background-job results delivered into the
 * transcript (`steer_kind: "job"`) and learner messages sent mid-turn
 * (`steer_kind: "learner"`). Decodes `details` defensively — unknown kinds and
 * missing fields degrade to a generic summary instead of failing — and holds
 * the card labels (PT-BR + EN).
 */

import type { SessionMessage } from "./types";

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export type JobKind = "research" | "pdf" | "visual" | "demo";
export interface JobFigure {
  page: number;
  description: string;
}

export type JobStatus = "done" | "failed";

export interface JobSource {
  title: string;
  url: string;
}

export type JobResult =
  | { kind: "research"; brief: string; sources: JobSource[]; facets: string[] }
  | { kind: "pdf"; path: string; question: string; brief: string; pages: number[]; pagesViewed: number[]; figures: JobFigure[] }
  // The backend stores visuals as vault files (`slug`); `svg` is filled only when inlined.
  // `checked` / `verified`: the artifact passed the vision / headless-browser check (Fase 17);
  // null when the backend did not run the check (older results or no Chromium).
  | { kind: "visual"; svg: string; slug: string | null; path: string; notes: string | null; checked: boolean | null; checkNotes: string | null }
  | { kind: "demo"; slug: string | null; title: string; url: string | null; verified: boolean | null }
  /** Unknown kind, or a known kind whose result lacks what its card needs. */
  | { kind: "unknown"; summary: string };

export interface JobSteer {
  jobId: string;
  /** Normalized kind, null when the wire kind is not one we render. */
  kind: JobKind | null;
  /** The kind as sent (for the generic card). */
  rawKind: string;
  status: JobStatus;
  error: string | null;
  /** Present only when `status === "done"`. */
  result: JobResult | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Dispatch → arrival, whole seconds; null when the times are missing. */
  elapsedSeconds: number | null;
}

const KIND_ALIASES: Record<string, JobKind> = {
  research: "research",
  pdf: "pdf",
  read_pdf: "pdf",
  visual: "visual",
  svg: "visual",
  demo: "demo",
  spawn_demo: "demo",
  demo_builder: "demo",
};

export function normalizeJobKind(v: unknown): JobKind | null {
  return typeof v === "string" ? KIND_ALIASES[v.trim().toLowerCase()] ?? null : null;
}

function decodeSources(raw: unknown): JobSource[] {
  if (!Array.isArray(raw)) return [];
  const out: JobSource[] = [];
  for (const s of raw) {
    if (typeof s === "string") {
      if (s.trim()) out.push({ title: s, url: /^https?:\/\//i.test(s) ? s : "" });
      continue;
    }
    if (!isObj(s)) continue;
    const url = str(s.url ?? s.uri ?? s.link);
    const title = str(s.title ?? s.name) || url;
    if (title || url) out.push({ title, url });
  }
  return out;
}

function decodePages(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const pages = raw
    .map((p) => (typeof p === "string" ? Number.parseInt(p, 10) : p))
    .filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0);
  return [...new Set(pages)].sort((a, b) => a - b);
}

function decodeFacets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .map((f) => (typeof f === "string" ? f : isObj(f) ? str(f.name) : "").trim())
    .filter(Boolean);
  return [...new Set(out)];
}

function decodeFigures(raw: unknown): JobFigure[] {
  if (!Array.isArray(raw)) return [];
  const out: JobFigure[] = [];
  for (const f of raw) {
    if (!isObj(f)) continue;
    const page = typeof f.page === "string" ? Number.parseInt(f.page, 10) : f.page;
    const description = str(f.description ?? f.text).trim();
    if (typeof page === "number" && Number.isInteger(page) && page > 0 && description) out.push({ page, description });
  }
  return out.sort((a, b) => a.page - b.page);
}

/** Short `key: value` rendering of an object for the generic card. */
export function summarizeDetails(raw: unknown, max = 240): string {
  if (!isObj(raw)) return typeof raw === "string" ? raw.slice(0, max) : "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    let shown: string;
    if (typeof v === "string") shown = v.length > 60 ? `${v.slice(0, 57)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean") shown = String(v);
    else if (v === null || v === undefined) continue;
    else if (Array.isArray(v)) shown = `[${v.length}]`;
    else shown = `{${Object.keys(v as Raw).length}}`;
    parts.push(`${k}: ${shown}`);
  }
  const joined = parts.join(" · ");
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

function decodeResult(kind: JobKind | null, raw: unknown, details: Raw): JobResult {
  const r = isObj(raw) ? raw : {};
  switch (kind) {
    case "research": {
      const brief = str(r.brief ?? r.summary ?? r.markdown);
      const sources = decodeSources(r.sources);
      if (brief || sources.length) return { kind, brief, sources, facets: decodeFacets(r.facets) };
      break;
    }
    case "pdf": {
      const brief = str(r.brief ?? r.answer ?? r.summary);
      if (brief) {
        return { kind, brief, path: str(r.path ?? details.path), question: str(r.question ?? details.question), pages: decodePages([r.pages, r.pages_cited, r.pages_read].find((p) => Array.isArray(p) && p.length > 0) ?? r.pages), pagesViewed: decodePages(r.pages_viewed), figures: decodeFigures(r.figures) };
      }
      break;
    }
    case "visual": {
      const svg = str(r.svg);
      const slug = strOrNull(r.slug);
      if (svg.trim() || slug) {
        return {
          kind, svg, slug, path: str(r.path), notes: strOrNull(r.notes ?? r.alt),
          checked: typeof r.checked === "boolean" ? r.checked : null, checkNotes: strOrNull(r.check_notes),
        };
      }
      break;
    }
    case "demo": {
      const slug = strOrNull(r.slug ?? r.result_id ?? details.slug);
      const url = strOrNull(r.url);
      if (slug || url) {
        return { kind, slug, url, title: str(r.title ?? details.title), verified: typeof r.verified === "boolean" ? r.verified : null };
      }
      break;
    }
  }
  return { kind: "unknown", summary: summarizeDetails(isObj(raw) ? raw : details) };
}

const toMillis = (ts: string | null): number | null => {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Decodes the `details` of a job steer. `fallbackFinishedAt` (the message's
 * `created_at`) stands in for a missing `finished_at`.
 */
export function decodeJobSteer(details: unknown, fallbackFinishedAt = ""): JobSteer {
  const d = isObj(details) ? details : {};
  const rawKind = str(d.kind ?? d.tool);
  const kind = normalizeJobKind(rawKind);
  const error = strOrNull(d.error);
  const status: JobStatus = d.status === "failed" || (d.status !== "done" && error !== null) ? "failed" : "done";
  // The result usually sits under `result`; tolerate it inlined into `details`.
  const resultRaw = isObj(d.result) ? d.result : d;
  const startedAt = strOrNull(d.started_at ?? d.dispatched_at);
  const finishedAt = strOrNull(d.finished_at) ?? strOrNull(fallbackFinishedAt);
  const start = toMillis(startedAt);
  const end = toMillis(finishedAt);
  const elapsedSeconds = start !== null && end !== null && end >= start ? Math.round((end - start) / 1000) : null;
  return {
    jobId: str(d.job_id ?? d.id),
    kind,
    rawKind,
    status,
    error,
    result: status === "done" ? decodeResult(kind, resultRaw, d) : null,
    startedAt,
    finishedAt,
    elapsedSeconds,
  };
}

export const isJobSteer = (m: Pick<SessionMessage, "steer_kind">): boolean => m.steer_kind === "job";
export const isLearnerSteer = (m: Pick<SessionMessage, "steer_kind">): boolean => m.steer_kind === "learner";

/** `data:` URI for an SVG, rendered through <img> (never injected into the DOM). */
export function svgDataUri(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** File name for downloading a visual: the vault path's basename, else the job id. */
export function visualFileName(path: string, jobId: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  if (base) return base.toLowerCase().endsWith(".svg") ? base : `${base}.svg`;
  return `${jobId || "visual"}.svg`;
}

export const pdfFileName = (path: string): string => path.split(/[\\/]/).pop() || path;

/** localStorage key holding the per-job "invert brightness" choice. */
export const visualInvertKey = (jobId: string): string => `learnharness:visual-invert:${jobId}`;

// --- Labels -----------------------------------------------------------------------

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

const LABELS = {
  "pt-BR": {
    dispatched: "Despachado",
    done: "concluído",
    failed: "falhou",
    research: "Pesquisa concluída",
    pdf: "Leitura do PDF concluída",
    visual: "Visual pronto",
    demo: "Simulador pronto",
    unknown: "Tarefa concluída",
    failedKind: {
      research: "Pesquisa falhou",
      pdf: "Leitura do PDF falhou",
      visual: "Visual falhou",
      demo: "Simulador falhou",
      unknown: "Tarefa falhou",
    },
    sources: "Fontes",
    facets: "Facetas",
    pagesViewed: (p: string) => `páginas vistas: ${p}`,
    pages: (p: string) => `p. ${p}`,
    question: "Pergunta",
    expand: "Expandir",
    collapse: "Recolher",
    download: "Baixar SVG",
    fullscreen: "Tela cheia",
    closeFullscreen: "Fechar (Esc)",
    invert: "Inverter brilho",
    visualAlt: "Figura gerada para a aula",
    demoVerified: "testada no navegador",
    demoUnverified: "não testada no navegador",
    visualChecked: "conferida",
    visualUnchecked: "não conferida",
    openDemo: "Abrir simulador",
    unknownError: "erro desconhecido",
    learnerSent: "enviada durante o turno",
    learnerQueued: "na fila",
  },
  en: {
    dispatched: "Dispatched",
    done: "done",
    failed: "failed",
    research: "Research done",
    pdf: "PDF reading done",
    visual: "Visual ready",
    demo: "Simulator ready",
    unknown: "Job done",
    failedKind: {
      research: "Research failed",
      pdf: "PDF reading failed",
      visual: "Visual failed",
      demo: "Simulator failed",
      unknown: "Job failed",
    },
    sources: "Sources",
    facets: "Facets",
    pagesViewed: (p: string) => `pages viewed: ${p}`,
    pages: (p: string) => (p.includes(",") ? `pp. ${p}` : `p. ${p}`),
    question: "Question",
    expand: "Expand",
    collapse: "Collapse",
    download: "Download SVG",
    fullscreen: "Fullscreen",
    closeFullscreen: "Close (Esc)",
    invert: "Invert brightness",
    visualAlt: "Figure generated for the lesson",
    demoVerified: "tested in the browser",
    demoUnverified: "not tested in the browser",
    visualChecked: "checked",
    visualUnchecked: "not checked",
    openDemo: "Open simulator",
    unknownError: "unknown error",
    learnerSent: "sent during the turn",
    learnerQueued: "queued",
  },
} as const;

export type JobLabels = (typeof LABELS)["pt-BR"] | (typeof LABELS)["en"];

export const jobLabels = (locale: string): JobLabels => (locale === "en" ? LABELS.en : LABELS["pt-BR"]);

/** "Despachado → concluído · 42 s" (time omitted when unknown). */
export function dispatchLabel(job: JobSteer, locale: string): string {
  const l = jobLabels(locale);
  const head = `${l.dispatched} → ${job.status === "failed" ? l.failed : l.done}`;
  return job.elapsedSeconds === null ? head : `${head} · ${formatElapsed(job.elapsedSeconds)}`;
}

/** Card title for a job: "Pesquisa concluída", "Visual falhou", … */
export function jobTitle(job: JobSteer, locale: string): string {
  const l = jobLabels(locale);
  const key = job.kind ?? "unknown";
  return job.status === "failed" ? l.failedKind[key] : l[key];
}

/** Badge text for a learner steer; null when the message is not one. */
export function learnerSteerLabel(m: Pick<SessionMessage, "steer_kind" | "delivered">, locale: string): string | null {
  if (!isLearnerSteer(m)) return null;
  const l = jobLabels(locale);
  return m.delivered === false ? l.learnerQueued : l.learnerSent;
}

/** "1, 3, 4" — the cited pages, collapsed into ranges ("1, 3–5"). */
export function formatPages(pages: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(j - i >= 2 ? `${pages[i]}–${pages[j]}` : pages.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return out.join(", ");
}
