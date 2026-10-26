/**
 * Construtores puros das requisições de import multi-fonte (Fase 3B).
 * Sem dependência de fetch/React para serem testados em Node.
 */
import type { GithubImportRequest, McpServerUpsert } from "./types";

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
  const optional = ["auth_token", "catalog_tool", "content_tool", "content_id_argument"] as const;
  for (const key of optional) {
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
  if (req.replace_track) body.replace_track = true;
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
