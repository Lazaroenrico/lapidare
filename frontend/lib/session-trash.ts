/**
 * Session trash (`.harness/trash/`): pure decoders, request paths and PT-BR/EN strings.
 * GET /api/chats/trash · POST /api/chats/trash/{file}/restore · DELETE /api/chats/trash/{file}?confirm=true
 */

export type TrashMode = "TEACH" | "PRACTICE";

export interface TrashEntry {
  id: string;
  /** Basename inside `.harness/trash/` (may carry a timestamp suffix on a name clash). */
  file: string;
  title: string;
  mode: TrashMode;
  deleted_at: string;
  updated_at: string | null;
  message_count: number;
  /** The deletion also removed graph provenance (`delete-nodes`); a restore does not bring it back. */
  graph_unlinked: boolean;
}

export interface RestoreResult {
  sessionId: string | null;
  graphRestored: boolean;
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function decodeTrashEntry(raw: unknown): TrashEntry | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const file = str(raw.file);
  if (!id || !file || !file.endsWith(".jsonl")) return null;
  const count = raw.message_count;
  return {
    id,
    file,
    title: str(raw.title).trim(),
    mode: raw.mode === "PRACTICE" ? "PRACTICE" : "TEACH",
    deleted_at: str(raw.deleted_at),
    updated_at: str(raw.updated_at) || null,
    message_count: typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    graph_unlinked: raw.graph_unlinked === true,
  };
}

/** Valid entries, most recently deleted first (the server already sorts; this keeps it stable). */
export function decodeTrashList(raw: unknown): TrashEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TrashEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = decodeTrashEntry(item);
    if (entry && !seen.has(entry.file)) {
      seen.add(entry.file);
      out.push(entry);
    }
  }
  const at = (e: TrashEntry) => {
    const t = Date.parse(e.deleted_at);
    return Number.isFinite(t) ? t : 0;
  };
  return out.sort((a, b) => at(b) - at(a));
}

export function decodeRestoreResult(raw: unknown): RestoreResult {
  const session = isObj(raw) && isObj(raw.session) ? raw.session : null;
  return {
    sessionId: session && typeof session.id === "string" && session.id ? session.id : null,
    graphRestored: isObj(raw) && raw.graph_restored === true,
  };
}

export const TRASH_LIST_PATH = "/api/chats/trash";
export const trashRestorePath = (file: string) => `${TRASH_LIST_PATH}/${encodeURIComponent(file)}/restore`;
export const trashPurgePath = (file: string) => `${TRASH_LIST_PATH}/${encodeURIComponent(file)}?confirm=true`;

/** True when an SSE `session:updated` frame can change the trash (a delete, restore or purge). */
export function touchesTrash(data: unknown): boolean {
  if (!isObj(data)) return true; // resync frames and unknown payloads: refetch
  return data.resync === true || data.deleted === true || data.restored === true || data.purged === true;
}

const ptBR = {
  entry: (n: number) => `Lixeira (${n})`,
  heading: "Lixeira",
  hint: "Sessões excluídas ficam em .harness/trash/ até você restaurá-las ou excluí-las definitivamente.",
  empty: "A lixeira está vazia.",
  loading: "Carregando…",
  close: "Fechar",
  untitled: "Sessão sem título",
  messages: (n: number) => (n === 1 ? "1 mensagem" : `${n} mensagens`),
  deleted: (when: string) => `excluída ${when}`,
  graphUnlinked: "nós do grafo removidos",
  graphUnlinkedTitle: "Esta exclusão também removeu do grafo os nós que só vieram da sessão. Restaurar não os traz de volta.",
  restore: "Restaurar",
  restoring: "Restaurando…",
  purge: "Excluir definitivamente",
  openSession: "Abrir sessão",
  restoreFailed: "Não foi possível restaurar a sessão.",
  restoredGraphNote: "Sessão restaurada. Os nós do grafo removidos na exclusão não foram restaurados.",
  purgeTitle: "Excluir definitivamente?",
  purgeBody: (title: string) =>
    `O histórico de "${title}" será apagado de .harness/trash/ para sempre e não poderá ser restaurado. A nota em Aulas/ continua no Vault.`,
  purgeConfirm: "Excluir para sempre",
  purgeBusy: "Excluindo…",
  purgeFailed: "Não foi possível excluir o arquivo da lixeira.",
};

type TrashText = typeof ptBR;

const en: TrashText = {
  entry: (n: number) => `Trash (${n})`,
  heading: "Trash",
  hint: "Deleted sessions stay in .harness/trash/ until you restore them or delete them permanently.",
  empty: "The trash is empty.",
  loading: "Loading…",
  close: "Close",
  untitled: "Untitled session",
  messages: (n: number) => (n === 1 ? "1 message" : `${n} messages`),
  deleted: (when: string) => `deleted ${when}`,
  graphUnlinked: "graph nodes removed",
  graphUnlinkedTitle: "This deletion also removed graph nodes that came only from the session. Restoring does not bring them back.",
  restore: "Restore",
  restoring: "Restoring…",
  purge: "Delete permanently",
  openSession: "Open session",
  restoreFailed: "Could not restore the session.",
  restoredGraphNote: "Session restored. Graph nodes removed by the deletion were not restored.",
  purgeTitle: "Delete permanently?",
  purgeBody: (title: string) =>
    `The history of "${title}" will be erased from .harness/trash/ forever and cannot be restored. The note in Lessons/ stays in the Vault.`,
  purgeConfirm: "Delete forever",
  purgeBusy: "Deleting…",
  purgeFailed: "Could not delete the trash file.",
};

export function trashText(locale: string): TrashText {
  return locale === "en" ? en : ptBR;
}
