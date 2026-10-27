/**
 * Construtores puros das requisições de import multi-fonte (Fase 3B).
 * Sem dependência de fetch/React para serem testados em Node.
 */
import type {
  GithubImportRequest,
  McpAuthMode,
  McpImportServer,
  McpOAuthState,
  McpOAuthStatus,
  McpServerUpsert,
} from "./types";

export interface RequestSpec {
  path: string;
  method: "GET" | "POST" | "DELETE";
  body?: string | FormData;
}

export const LOCAL_IMPORT_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf"] as const;

const GITHUB_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/tree\/[^\s?#]+)?\/?$/;

/** Mesma forma aceita pelo backend: https://github.com/<owner>/<repo>[/tree/<ref>[/<subpath>]]. */
export function isGithubRepoUrl(value: string): boolean {
  return GITHUB_URL.test(value.trim());
}

export function hasLocalImportExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return LOCAL_IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const serverPath = (name: string) => `/api/import/mcp/servers/${encodeURIComponent(name)}`;

export const buildListMcpServers = (): RequestSpec => ({
  path: "/api/import/mcp/servers",
  method: "GET",
});

/** Remove opcionais vazios; o token só segue quando preenchido (em branco = manter o atual). */
export function buildUpsertMcpServer(input: McpServerUpsert): RequestSpec {
  const clean = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  const body: McpServerUpsert = { name: input.name.trim(), transport: input.transport };
  if (input.transport === "stdio") {
    body.command = clean(input.command);
    body.args = (input.args ?? []).map((a) => a.trim()).filter(Boolean);
  } else {
    body.url = clean(input.url);
  }
  if (input.enabled !== undefined) body.enabled = input.enabled;
  if (input.auth_mode) {
    body.auth_mode = input.auth_mode;
    // OAuth só existe para http/sse; o token só segue no modo "token".
    if (input.transport === "stdio" && input.auth_mode === "oauth") body.auth_mode = "none";
    if (input.auth_mode === "oauth" && input.oauth_scopes) {
      body.oauth_scopes = input.oauth_scopes.map((x) => x.trim()).filter(Boolean);
    }
  }
  const optional = ["auth_token", "catalog_tool", "content_tool", "content_id_argument"] as const;
  for (const key of optional) {
    if (key === "auth_token" && body.auth_mode && body.auth_mode !== "token") continue;
    const value = clean(input[key]);
    if (value) body[key] = value;
  }
  return { path: "/api/import/mcp/servers", method: "POST", body: JSON.stringify(body) };
}

export const buildDeleteMcpServer = (name: string): RequestSpec => ({
  path: serverPath(name),
  method: "DELETE",
});

export const buildTestMcpServer = (name: string): RequestSpec => ({
  path: `${serverPath(name)}/test`,
  method: "POST",
});

export const buildListMcpItems = (name: string): RequestSpec => ({
  path: `${serverPath(name)}/items`,
  method: "GET",
});

export function buildImportMcpItems(
  name: string,
  itemIds: string[],
  startSession: boolean
): RequestSpec {
  return {
    path: `${serverPath(name)}/import`,
    method: "POST",
    body: JSON.stringify({ item_ids: itemIds, start_session: startSession }),
  };
}

export const buildMcpOAuthLogin = (name: string): RequestSpec => ({
  path: `${serverPath(name)}/oauth/login`,
  method: "POST",
});

export const buildMcpOAuthLogout = (name: string): RequestSpec => ({
  path: `${serverPath(name)}/oauth/logout`,
  method: "POST",
});

const OAUTH_STATUSES: readonly McpOAuthStatus[] = ["signed_out", "pending", "signed_in", "error"];

/** Estado OAuth vindo da API; qualquer forma inesperada vira `signed_out` (nunca quebra a UI). */
export function decodeOAuthState(raw: unknown): McpOAuthState | null {
  if (!raw || typeof raw !== "object") return null;
  const { status, error } = raw as { status?: unknown; error?: unknown };
  const known = OAUTH_STATUSES.find((s) => s === status) ?? "signed_out";
  return typeof error === "string" && error && known === "error"
    ? { status: known, error }
    : { status: known };
}

/** Normaliza um servidor da API; backends antigos não enviam `auth_mode`. */
export function decodeMcpServer(raw: McpImportServer): McpImportServer {
  const mode: McpAuthMode =
    raw.auth_mode === "oauth" || raw.auth_mode === "token" || raw.auth_mode === "none"
      ? raw.auth_mode
      : raw.has_auth
        ? "token"
        : "none";
  return {
    ...raw,
    auth_mode: mode,
    oauth_scopes: Array.isArray(raw.oauth_scopes) ? raw.oauth_scopes : [],
    oauth: mode === "oauth" ? (decodeOAuthState(raw.oauth) ?? { status: "signed_out" }) : null,
  };
}

/** URL de autorização devolvida pelo login; só http(s) pode ser aberto no navegador. */
export function decodeAuthorizationUrl(raw: unknown): string {
  const value = raw && typeof raw === "object" ? (raw as { authorization_url?: unknown }).authorization_url : null;
  if (typeof value !== "string") throw new Error("authorization_url ausente");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("authorization_url inválida");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("authorization_url inválida");
  return url.toString();
}

export function buildGithubPreview(url: string): RequestSpec {
  return {
    path: "/api/import/github/preview",
    method: "POST",
    body: JSON.stringify({ url: url.trim() }),
  };
}

export function buildGithubImport(req: GithubImportRequest): RequestSpec {
  const body: GithubImportRequest = {
    url: req.url.trim(),
    paths: req.paths,
    start_session: req.start_session,
    use_as_track: req.use_as_track,
  };
  return { path: "/api/import/github/import", method: "POST", body: JSON.stringify(body) };
}

/** Multipart: `file`, `title?`, `start_session`. O navegador define o boundary. */
export function buildLocalImport(
  file: Blob,
  fileName: string,
  title: string,
  startSession: boolean
): RequestSpec {
  const form = new FormData();
  form.append("file", file, fileName);
  if (title.trim()) form.append("title", title.trim());
  form.append("start_session", startSession ? "true" : "false");
  return { path: "/api/import/local", method: "POST", body: form };
}
