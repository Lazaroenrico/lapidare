/**
 * Fase 16 — notas → grafo: construtores de requisição, decoders, árvore de notas do Vault
 * (agrupada por pasta, com busca) e strings PT-BR/EN. Puro: sem fetch nem React.
 *
 * POST /api/graph/import (multipart `files[]`) · POST /api/graph/import-vault `{paths}` ·
 * GET /api/graph/importable-notes · GET /api/graph/sources · GET /api/graph/sources/{id}/note ·
 * DELETE /api/graph/sources/{id}?mode=preserve-graph|delete-nodes
 */

import type { RequestSpec } from "./import-wire";
import type { NodeSourceRef } from "./types";

export type { NodeSourceRef };

export const NOTE_UPLOAD_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf"] as const;

export type NotesFileStatus = "queued" | "running" | "completed" | "partial" | "failed" | "rejected";

/** One file of an import: the route's immediate answer, later merged with the job's live status. */
export interface NotesFileResult {
  filename: string;
  status: NotesFileStatus;
  source_id: string | null;
  path: string | null;
  title: string;
  error: string | null;
  batches: number;
  new_nodes: number;
}

export interface NotesImportResponse {
  job_id: string | null;
  files: NotesFileResult[];
}

export interface ImportableNote {
  path: string;
  name: string;
  folder: string;
  source_id: string;
  imported: boolean;
}

export interface ImportableNotes {
  notes: ImportableNote[];
  truncated: boolean;
}

export interface GraphSource {
  id: string;
  path: string;
  title: string;
  imported_at: string;
  node_count: number;
}

export interface SourceNote {
  id: string;
  path: string;
  title: string;
  markdown: string;
}

export type DeleteSourceMode = "preserve-graph" | "delete-nodes";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const STATUSES: readonly NotesFileStatus[] = ["queued", "running", "completed", "partial", "failed", "rejected"];

// ------------------------------------------------------------------ requests

export function hasNoteUploadExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return NOTE_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Multipart `files[]`; o navegador define o boundary. */
export function buildNotesUpload(files: Array<{ blob: Blob; name: string }>): RequestSpec {
  const form = new FormData();
  for (const f of files) form.append("files[]", f.blob, f.name);
  return { path: "/api/graph/import", method: "POST", body: form };
}

export const buildImportVaultNotes = (paths: string[]): RequestSpec => ({
  path: "/api/graph/import-vault",
  method: "POST",
  body: JSON.stringify({ paths: Array.from(new Set(paths)) }),
});

export const buildImportableNotes = (): RequestSpec => ({ path: "/api/graph/importable-notes", method: "GET" });
export const buildListSources = (): RequestSpec => ({ path: "/api/graph/sources", method: "GET" });

export const sourceNotePath = (sourceId: string) => `/api/graph/sources/${encodeURIComponent(sourceId)}/note`;

export const buildDeleteSource = (sourceId: string, mode: DeleteSourceMode): RequestSpec => ({
  path: `/api/graph/sources/${encodeURIComponent(sourceId)}?mode=${mode}`,
  method: "DELETE",
});

// ------------------------------------------------------------------ decoders

export function decodeFileResult(raw: unknown): NotesFileResult | null {
  if (!isObj(raw)) return null;
  const path = str(raw.path) || null;
  const filename = str(raw.filename) || path || "";
  if (!filename) return null;
  const ids = Array.isArray(raw.new_node_ids) ? raw.new_node_ids.length : count(raw.new_nodes);
  return {
    filename,
    status: STATUSES.find((s) => s === raw.status) ?? "queued",
    source_id: str(raw.source_id) || null,
    path,
    title: str(raw.title) || (path ? baseName(path) : filename),
    error: str(raw.error) || null,
    batches: count(raw.batches),
    new_nodes: ids,
  };
}

const decodeFiles = (raw: unknown): NotesFileResult[] =>
  Array.isArray(raw) ? raw.map(decodeFileResult).filter((f): f is NotesFileResult => f !== null) : [];

export function decodeNotesImport(raw: unknown): NotesImportResponse {
  if (!isObj(raw)) return { job_id: null, files: [] };
  const job = isObj(raw.job) ? str(raw.job.job_id) || null : null;
  return { job_id: job, files: decodeFiles(raw.files) };
}

/** Per-file live status of a `notes_import` job record (GET /api/jobs). */
export const decodeJobFiles = (job: unknown): NotesFileResult[] => (isObj(job) ? decodeFiles(job.files) : []);

/**
 * Funde a resposta imediata da rota com o estado vivo do job: arquivos recusados ficam
 * como estão; os aceitos passam a mostrar o status por arquivo do job (por source_id).
 */
export function mergeJobFiles(initial: NotesFileResult[], jobFiles: NotesFileResult[]): NotesFileResult[] {
  const live = new Map(jobFiles.filter((f) => f.source_id).map((f) => [f.source_id as string, f]));
  return initial.map((f) => {
    const update = f.source_id ? live.get(f.source_id) : undefined;
    return update ? { ...f, status: update.status, error: update.error, batches: update.batches, new_nodes: update.new_nodes } : f;
  });
}

export const isFinalStatus = (s: NotesFileStatus) => s === "completed" || s === "partial" || s === "failed" || s === "rejected";

export function decodeImportableNotes(raw: unknown): ImportableNotes {
  if (!isObj(raw) || !Array.isArray(raw.notes)) return { notes: [], truncated: false };
  const notes: ImportableNote[] = [];
  const seen = new Set<string>();
  for (const n of raw.notes) {
    if (!isObj(n)) continue;
    const path = str(n.path);
    if (!path || seen.has(path) || !path.toLowerCase().endsWith(".md")) continue;
    seen.add(path);
    notes.push({
      path,
      name: str(n.name) || baseName(path).replace(/\.md$/i, ""),
      folder: str(n.folder) || folderOf(path),
      source_id: str(n.source_id),
      imported: n.imported === true,
    });
  }
  return { notes, truncated: raw.truncated === true };
}

export function decodeSources(raw: unknown): GraphSource[] {
  if (!Array.isArray(raw)) return [];
  const out: GraphSource[] = [];
  for (const s of raw) {
    if (!isObj(s)) continue;
    const id = str(s.id);
    const path = str(s.path);
    if (!id || !path) continue;
    out.push({ id, path, title: str(s.title) || baseName(path), imported_at: str(s.imported_at), node_count: count(s.node_count) });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Body of a note without its YAML frontmatter (the read-only pane shows only the prose). */
export function stripFrontmatter(markdown: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(markdown);
  return m ? markdown.slice(m[0].length).replace(/^\s*\n/, "") : markdown;
}

export function decodeSourceNote(raw: unknown): SourceNote | null {
  if (!isObj(raw)) return null;
  const path = str(raw.path);
  if (!path) return null;
  return { id: str(raw.id), path, title: str(raw.title) || baseName(path), markdown: stripFrontmatter(str(raw.markdown)) };
}

// ------------------------------------------------------------------ tree + search

export const baseName = (path: string) => path.split("/").pop() ?? path;
export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export interface NoteFolder {
  /** Pasta relativa ao Vault ("" = raiz). */
  folder: string;
  depth: number;
  notes: ImportableNote[];
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Todas as palavras da busca aparecem no caminho (sem acento, sem caixa). */
export function matchesQuery(note: Pick<ImportableNote, "path">, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(note.path);
  return words.every((w) => hay.includes(w));
}

/**
 * Árvore de pastas para o seletor: uma entrada por pasta com notas que casam com a busca,
 * em ordem de caminho (pastas-pai antes das filhas; raiz primeiro), notas por nome.
 */
export function buildNoteTree(notes: ImportableNote[], query = ""): NoteFolder[] {
  const byFolder = new Map<string, ImportableNote[]>();
  for (const n of notes) {
    if (!matchesQuery(n, query)) continue;
    const list = byFolder.get(n.folder) ?? [];
    list.push(n);
    byFolder.set(n.folder, list);
  }
  return Array.from(byFolder.entries())
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, list]) => ({
      folder,
      depth: folder ? folder.split("/").length - 1 : 0,
      notes: list.sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

/** Seleção de uma pasta inteira: "all" | "some" | "none". */
export function folderState(folder: NoteFolder, selected: ReadonlySet<string>): "all" | "some" | "none" {
  const n = folder.notes.filter((x) => selected.has(x.path)).length;
  return n === 0 ? "none" : n === folder.notes.length ? "all" : "some";
}

// ------------------------------------------------------------------ node card origin

export function decodeNodeSources(raw: unknown): NodeSourceRef[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeSourceRef[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (!isObj(s)) continue;
    const id = str(s.source_id);
    const path = str(s.path);
    if (!id || !path) continue;
    const paragraph = str(s.paragraph) || null;
    const key = `${id}#${paragraph ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source_id: id, title: str(s.title) || baseName(path), path, paragraph, deleted: s.deleted === true });
  }
  return out;
}

/** Âncora `^pN` citável do parágrafo de origem, quando houver. */
export const paragraphAnchor = (ref: Pick<NodeSourceRef, "paragraph">) =>
  ref.paragraph && /^p\d+$/.test(ref.paragraph) ? `^${ref.paragraph}` : null;

// ------------------------------------------------------------------ strings

export interface NotesText {
  tab: string;
  intro: string;
  modeVault: string;
  modeFiles: string;
  searchLabel: string;
  searchPlaceholder: string;
  loading: string;
  empty: string;
  noMatch: string;
  truncated: string;
  root: string;
  selectFolder: string;
  toggleFolder: string;
  imported: string;
  selected: (n: number) => string;
  clear: string;
  drop: string;
  accept: string;
  badExt: (name: string) => string;
  remove: string;
  submit: (n: number) => string;
  submitting: string;
  results: string;
  status: (s: NotesFileStatus) => string;
  newNodes: (n: number) => string;
  onGraph: string;
  sourcesTitle: string;
  sourcesEmpty: string;
  nodeCount: (n: number) => string;
  removeSource: string;
  removeKeep: string;
  removeNodes: string;
  removeHint: string;
  cancel: string;
  origin: string;
  originNote: (title: string) => string;
  openNote: (title: string) => string;
  noteRemoved: string;
  readOnly: string;
}

const ptBR: NotesText = {
  tab: "Adicionar ao grafo",
  intro: "Extrai proposições e cadeias das suas notas para o grafo. As notas nunca são alteradas.",
  modeVault: "Notas do Vault",
  modeFiles: "Arquivos locais",
  searchLabel: "Buscar notas",
  searchPlaceholder: "Buscar por nome ou pasta…",
  loading: "Carregando notas do Vault…",
  empty: "Nenhuma nota .md encontrada fora de .harness/ e Conceitos/.",
  noMatch: "Nenhuma nota corresponde à busca.",
  truncated: "Vault grande: a lista mostra as primeiras 5000 notas. Use a busca.",
  root: "(raiz do Vault)",
  selectFolder: "Selecionar pasta",
  toggleFolder: "Abrir ou fechar pasta",
  imported: "no grafo",
  selected: (n) => `${n} selecionada${n === 1 ? "" : "s"}`,
  clear: "Limpar",
  drop: "Solte arquivos aqui ou clique para escolher",
  accept: ".md, .markdown, .txt ou .pdf · vão para Fontes/Notas/ (somente leitura)",
  badExt: (name) => `${name}: só .md, .markdown, .txt e .pdf.`,
  remove: "Remover",
  submit: (n) => (n === 0 ? "Adicionar ao grafo" : n === 1 ? "Adicionar 1 nota ao grafo" : `Adicionar ${n} notas ao grafo`),
  submitting: "Enviando…",
  results: "Resultado por arquivo",
  status: (s) =>
    ({ queued: "na fila", running: "extraindo", completed: "concluído", partial: "parcial", failed: "falhou", rejected: "recusado" })[s],
  newNodes: (n) => (n === 1 ? "1 nó novo" : `${n} nós novos`),
  onGraph: "Notas no grafo",
  sourcesTitle: "Notas no grafo",
  sourcesEmpty: "Nenhuma nota adicionada ainda.",
  nodeCount: (n) => (n === 1 ? "1 nó" : `${n} nós`),
  removeSource: "Tirar do grafo",
  removeKeep: "Manter os nós",
  removeNodes: "Remover os nós",
  removeHint: "A nota continua no Vault. Remover os nós apaga os que só vieram dela.",
  cancel: "Cancelar",
  origin: "Origem",
  originNote: (title) => `nota: ${title}`,
  openNote: (title) => `Abrir a nota ${title}`,
  noteRemoved: "fora do grafo",
  readOnly: "somente leitura",
};

const en: NotesText = {
  tab: "Add to graph",
  intro: "Extracts propositions and chains from your notes into the graph. Notes are never changed.",
  modeVault: "Vault notes",
  modeFiles: "Local files",
  searchLabel: "Search notes",
  searchPlaceholder: "Search by name or folder…",
  loading: "Loading vault notes…",
  empty: "No .md notes found outside .harness/ and Concepts/.",
  noMatch: "No note matches the search.",
  truncated: "Large vault: the list shows the first 5000 notes. Use the search.",
  root: "(vault root)",
  selectFolder: "Select folder",
  toggleFolder: "Open or close folder",
  imported: "on graph",
  selected: (n) => `${n} selected`,
  clear: "Clear",
  drop: "Drop files here or click to choose",
  accept: ".md, .markdown, .txt or .pdf · stored in Sources/Notes/ (read-only)",
  badExt: (name) => `${name}: only .md, .markdown, .txt and .pdf.`,
  remove: "Remove",
  submit: (n) => (n === 0 ? "Add to the graph" : n === 1 ? "Add 1 note to the graph" : `Add ${n} notes to the graph`),
  submitting: "Sending…",
  results: "Per-file result",
  status: (s) =>
    ({ queued: "queued", running: "extracting", completed: "done", partial: "partial", failed: "failed", rejected: "rejected" })[s],
  newNodes: (n) => (n === 1 ? "1 new node" : `${n} new nodes`),
  onGraph: "Notes on the graph",
  sourcesTitle: "Notes on the graph",
  sourcesEmpty: "No notes added yet.",
  nodeCount: (n) => (n === 1 ? "1 node" : `${n} nodes`),
  removeSource: "Remove from graph",
  removeKeep: "Keep the nodes",
  removeNodes: "Remove the nodes",
  removeHint: "The note stays in the vault. Removing the nodes deletes the ones that only came from it.",
  cancel: "Cancel",
  origin: "Origin",
  originNote: (title) => `note: ${title}`,
  openNote: (title) => `Open the note ${title}`,
  noteRemoved: "off the graph",
  readOnly: "read-only",
};

export function notesText(locale: string): NotesText {
  return locale === "en" ? en : ptBR;
}
