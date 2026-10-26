"use client";

/**
 * Gerência de servidores MCP de conteúdo (HTTP / SSE / stdio), compartilhada entre
 * o diálogo "↑ Import" e a aba MCP das Configurações.
 * Contrato: GET/POST /api/import/mcp/servers, DELETE /{name}, POST /{name}/test.
 * O token nunca volta da API: só exibimos o selo `has_auth`.
 */

import React, { useEffect, useState } from "react";
import { Server, Plug, Trash2, Pencil, X } from "lucide-react";
import { deleteMcpServer, listMcpServers, testMcpServer, upsertMcpServer } from "@/lib/api";
import type { McpImportServer, McpServerTestResult, McpTransport } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { Badge, Banner, Btn, Check, Field, cx, errMsg, handleListKeys, inputClass } from "./import-ui";

interface Draft {
  name: string;
  transport: McpTransport;
  url: string;
  command: string;
  argsText: string;
  token: string;
  enabled: boolean;
  catalog_tool: string;
  content_tool: string;
  content_id_argument: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  transport: "http",
  url: "",
  command: "",
  argsText: "",
  token: "",
  enabled: true,
  catalog_tool: "",
  content_tool: "",
  content_id_argument: "",
};

const toDraft = (s: McpImportServer): Draft => ({
  name: s.name,
  transport: s.transport,
  url: s.url ?? "",
  command: s.command ?? "",
  argsText: (s.args ?? []).join("\n"),
  token: "",
  enabled: s.enabled,
  catalog_tool: s.catalog_tool ?? "",
  content_tool: s.content_tool ?? "",
  content_id_argument: s.content_id_argument ?? "",
});

type TestState = { busy: boolean; result?: McpServerTestResult; error?: string };

export interface McpServerManagerProps {
  selected: string | null;
  onSelect: (name: string | null) => void;
  /** Lista já carregada por quem chama (evita um GET duplicado). */
  initialServers?: McpImportServer[];
  onServersChange?: (servers: McpImportServer[]) => void;
  /** Conteúdo extra abaixo do cabeçalho do servidor selecionado (ex.: itens importáveis). */
  renderDetail?: (server: McpImportServer) => React.ReactNode;
  className?: string;
}

export function McpServerManager({
  selected,
  onSelect,
  initialServers,
  onServersChange,
  renderDetail,
  className,
}: McpServerManagerProps) {
  const { t } = useLocale();
  const [servers, setServers] = useState<McpImportServer[]>(initialServers ?? []);
  const [loading, setLoading] = useState(!initialServers);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const commit = (next: McpImportServer[]) => {
    setServers(next);
    onServersChange?.(next);
  };

  useEffect(() => {
    if (initialServers) return;
    let alive = true;
    listMcpServers()
      .then((list) => alive && commit(list ?? []))
      .catch((err) => alive && setError(errMsg(err, t.mcpEmpty)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mantém uma seleção válida: o primeiro habilitado (ou o primeiro) quando a atual some.
  useEffect(() => {
    if (draft || loading) return;
    if (selected && servers.some((s) => s.name === selected)) return;
    const first = servers.find((s) => s.enabled) ?? servers[0];
    onSelect(first ? first.name : null);
  }, [servers, selected, draft, loading, onSelect]);

  const current = servers.find((s) => s.name === selected) ?? null;

  const runTest = async (name: string) => {
    setTests((prev) => ({ ...prev, [name]: { busy: true } }));
    try {
      const result = await testMcpServer(name);
      setTests((prev) => ({ ...prev, [name]: { busy: false, result } }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [name]: { busy: false, error: errMsg(err, t.mcpTestFail) } }));
    }
  };

  const openCreate = () => {
    setDraft({ ...EMPTY_DRAFT });
    setEditing(false);
    setShowAdvanced(false);
    setFormError(null);
  };

  const openEdit = (server: McpImportServer) => {
    const d = toDraft(server);
    setDraft(d);
    setEditing(true);
    setShowAdvanced(Boolean(d.catalog_tool || d.content_tool || d.content_id_argument));
    setFormError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const endpointOk = draft.transport === "stdio" ? draft.command.trim() : draft.url.trim();
    if (!draft.name.trim() || !endpointOk) {
      setFormError(t.mcpRequired);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const saved = await upsertMcpServer({
        name: draft.name,
        transport: draft.transport,
        url: draft.url,
        command: draft.command,
        args: draft.argsText.split("\n"),
        enabled: draft.enabled,
        auth_token: draft.token,
        catalog_tool: draft.catalog_tool,
        content_tool: draft.content_tool,
        content_id_argument: draft.content_id_argument,
      });
      const next = servers.some((s) => s.name === saved.name)
        ? servers.map((s) => (s.name === saved.name ? saved : s))
        : [...servers, saved];
      commit(next);
      setDraft(null);
      onSelect(saved.name);
      void runTest(saved.name);
    } catch (err) {
      setFormError(errMsg(err, t.mcpTestFail));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    setRemoving(true);
    try {
      await deleteMcpServer(name);
      commit(servers.filter((s) => s.name !== name));
      setConfirmRemove(null);
      if (selected === name) onSelect(null);
    } catch (err) {
      setError(errMsg(err, t.mcpRemove));
    } finally {
      setRemoving(false);
    }
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));

  const statusDot = (s: McpImportServer) => {
    const st = tests[s.name];
    if (st?.result?.ok) return "bg-[#34d399]";
    if (st?.error || (st?.result && !st.result.ok)) return "bg-[#f87171]";
    return s.enabled ? "bg-[#8d8d8d]" : "border border-[#434343]";
  };

  const endpoint = (s: McpImportServer) =>
    s.transport === "stdio" ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") : s.url ?? "";

  return (
    <div className={cx("grid grid-cols-1 md:grid-cols-[208px_1fr] min-h-0 gap-0 font-ui", className)}>
      {/* Lista de servidores */}
      <aside className="flex flex-col min-h-0 border-b md:border-b-0 md:border-r border-[#2a2a2a] bg-[#141414]">
        <div className="px-3 pt-3 pb-2 text-[11px] uppercase tracking-wider text-[#8d8d8d]">{t.mcpServers}</div>
        <div
          role="listbox"
          aria-label={t.mcpServers}
          onKeyDown={handleListKeys}
          className="flex-1 overflow-y-auto px-2 space-y-1"
        >
          {loading && <p className="px-2 py-2 text-[11px] text-[#8d8d8d]">{t.impLoading}</p>}
          {!loading && servers.length === 0 && (
            <p className="px-2 py-2 text-[11px] text-[#8d8d8d]">{t.mcpEmpty}</p>
          )}
          {servers.map((s) => {
            const active = s.name === selected && !draft;
            return (
              <button
                key={s.name}
                type="button"
                role="option"
                aria-selected={active}
                data-nav
                onClick={() => {
                  setDraft(null);
                  setConfirmRemove(null);
                  onSelect(s.name);
                }}
                className={cx(
                  "w-full text-left rounded-md px-2 py-1 border transition-colors cursor-pointer",
                  active
                    ? "bg-[#2a2a2a] border-[#434343] text-[#e6e6e6]"
                    : "border-transparent text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#1c1c1c] focus-visible:border-[#434343] focus-visible:text-[#e6e6e6]"
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={cx("w-2 h-2 rounded-full shrink-0", statusDot(s))} aria-hidden />
                  <span className="text-[12.5px] truncate flex-1">{s.name}</span>
                  {s.has_auth && <Badge>{t.mcpHasAuth}</Badge>}
                </span>
                <span className="block pl-4 text-[11px] text-[#8d8d8d] truncate">
                  {s.transport}
                  {!s.enabled && ` · ${t.mcpDisabled}`}
                  {tests[s.name]?.busy && ` · ${t.mcpTesting}`}
                  {!tests[s.name] && s.enabled && ` · ${t.mcpUntested}`}
                </span>
              </button>
            );
          })}
        </div>
        <div className="p-2 border-t border-[#2a2a2a]">
          <Btn className="w-full" onClick={openCreate} aria-pressed={Boolean(draft && !editing)}>
            {t.mcpConnect}
          </Btn>
        </div>
      </aside>

      {/* Painel direito: formulário ou detalhe */}
      <section className="min-h-0 overflow-y-auto p-4 space-y-3">
        {error && <Banner tone="error">{error}</Banner>}

        {draft ? (
          <form onSubmit={submit} className="space-y-3" aria-label={t.mcpConnect}>
            <div className="flex items-center justify-between">
              <h3 className="font-title text-base font-bold text-[#e6e6e6]">
                {editing ? `${t.mcpEdit} · ${draft.name}` : t.mcpConnect.replace(/^\+\s*/, "")}
              </h3>
              <Btn variant="ghost" aria-label={t.impCancel} onClick={() => setDraft(null)}>
                <X className="w-3 h-3" aria-hidden />
              </Btn>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={t.mcpName} htmlFor="mcp-name">
                <input
                  id="mcp-name"
                  autoFocus={!editing}
                  readOnly={editing}
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="praxis"
                  className={cx(inputClass, editing && "text-[#8d8d8d]")}
                />
              </Field>
              <Field label={t.mcpTransport} htmlFor="mcp-transport">
                <select
                  id="mcp-transport"
                  value={draft.transport}
                  onChange={(e) => set("transport", e.target.value as McpTransport)}
                  className={inputClass}
                >
                  <option value="http">http (streamable)</option>
                  <option value="sse">sse</option>
                  <option value="stdio">stdio</option>
                </select>
              </Field>
            </div>

            {draft.transport === "stdio" ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label={t.mcpCommand} htmlFor="mcp-command">
                  <input
                    id="mcp-command"
                    value={draft.command}
                    onChange={(e) => set("command", e.target.value)}
                    placeholder="uvx"
                    className={inputClass}
                  />
                </Field>
                <Field label={t.mcpArgs} htmlFor="mcp-args">
                  <textarea
                    id="mcp-args"
                    rows={3}
                    value={draft.argsText}
                    onChange={(e) => set("argsText", e.target.value)}
                    placeholder={"my-mcp-server\n--stdio"}
                    className={cx(inputClass, "resize-none")}
                  />
                </Field>
              </div>
            ) : (
              <Field label={t.mcpUrl} htmlFor="mcp-url">
                <input
                  id="mcp-url"
                  type="url"
                  value={draft.url}
                  onChange={(e) => set("url", e.target.value)}
                  placeholder={draft.transport === "sse" ? "http://127.0.0.1:8765/sse" : "http://127.0.0.1:8765/mcp"}
                  className={inputClass}
                />
              </Field>
            )}

            <Field
              label={t.mcpToken}
              htmlFor="mcp-token"
              hint={editing && current?.has_auth ? `${t.mcpTokenKeep}. ${t.mcpTokenHint}` : t.mcpTokenHint}
            >
              <input
                id="mcp-token"
                type="password"
                autoComplete="off"
                value={draft.token}
                onChange={(e) => set("token", e.target.value)}
                placeholder={editing && current?.has_auth ? "••••••••" : ""}
                className={inputClass}
              />
            </Field>

            <Check id="mcp-enabled" checked={draft.enabled} onChange={(v) => set("enabled", v)} label={t.mcpEnabled} />

            <div className="border-t border-[#2a2a2a] pt-2">
              <button
                type="button"
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((v) => !v)}
                className="font-ui text-[11px] text-[#8d8d8d] hover:text-[#e6e6e6] focus-visible:text-[#e6e6e6] cursor-pointer"
              >
                {showAdvanced ? "▾" : "▸"} {t.mcpAdvanced}
              </button>
              {showAdvanced && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <Field label={t.mcpCatalogTool} htmlFor="mcp-catalog">
                    <input
                      id="mcp-catalog"
                      value={draft.catalog_tool}
                      onChange={(e) => set("catalog_tool", e.target.value)}
                      placeholder="list_lessons"
                      className={inputClass}
                    />
                  </Field>
                  <Field label={t.mcpContentTool} htmlFor="mcp-content">
                    <input
                      id="mcp-content"
                      value={draft.content_tool}
                      onChange={(e) => set("content_tool", e.target.value)}
                      placeholder="get_lesson"
                      className={inputClass}
                    />
                  </Field>
                  <Field label={t.mcpContentIdArg} htmlFor="mcp-idarg">
                    <input
                      id="mcp-idarg"
                      value={draft.content_id_argument}
                      onChange={(e) => set("content_id_argument", e.target.value)}
                      placeholder="lesson_id"
                      className={inputClass}
                    />
                  </Field>
                </div>
              )}
            </div>

            {formError && <Banner tone="error">{formError}</Banner>}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setDraft(null)}>
                {t.impCancel}
              </Btn>
              <Btn type="submit" variant="primary" busy={saving}>
                {t.mcpSave}
              </Btn>
            </div>
          </form>
        ) : current ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-title text-base font-bold text-[#e6e6e6] flex items-center gap-2">
                  <Server className="w-4 h-4 text-[#8d8d8d]" aria-hidden />
                  <span className="truncate">{current.name}</span>
                </h3>
                <p className="text-[11px] text-[#8d8d8d] truncate">
                  {current.transport} · {endpoint(current)}
                </p>
                <div className="flex gap-1 pt-1">
                  {current.has_auth && <Badge>{t.mcpHasAuth}</Badge>}
                  {!current.enabled && <Badge tone="warn">{t.mcpDisabled}</Badge>}
                </div>
              </div>
              <div className="flex gap-2">
                <Btn onClick={() => runTest(current.name)} busy={tests[current.name]?.busy}>
                  <Plug className="w-3 h-3" aria-hidden />
                  {t.mcpTest}
                </Btn>
                <Btn variant="ghost" onClick={() => openEdit(current)} aria-label={t.mcpEdit}>
                  <Pencil className="w-3 h-3" aria-hidden />
                  {t.mcpEdit}
                </Btn>
                <Btn variant="danger" onClick={() => setConfirmRemove(current.name)} aria-label={t.mcpRemove}>
                  <Trash2 className="w-3 h-3" aria-hidden />
                </Btn>
              </div>
            </div>

            {confirmRemove === current.name && (
              <Banner
                tone="warn"
                action={
                  <>
                    <Btn variant="ghost" onClick={() => setConfirmRemove(null)}>
                      {t.impCancel}
                    </Btn>
                    <Btn variant="danger" busy={removing} onClick={() => remove(current.name)}>
                      {t.mcpRemove}
                    </Btn>
                  </>
                }
              >
                {t.mcpConfirmRemove(current.name)}
              </Banner>
            )}

            <TestLine state={tests[current.name]} />
            {renderDetail?.(current)}
          </div>
        ) : (
          !loading && (
            <div className="py-12 text-center text-[11px] text-[#8d8d8d] space-y-3">
              <Server className="w-6 h-6 mx-auto opacity-50" aria-hidden />
              <p>{t.impPickServer}</p>
              <Btn onClick={openCreate}>{t.mcpConnect}</Btn>
            </div>
          )
        )}
      </section>
    </div>
  );
}

function TestLine({ state }: { state?: TestState }) {
  const { t } = useLocale();
  if (!state || state.busy) return null;
  if (state.error || (state.result && !state.result.ok)) {
    return <Banner tone="error">{state.error ?? state.result?.error ?? t.mcpTestFail}</Banner>;
  }
  if (!state.result) return null;
  const { tools, resources } = state.result;
  return (
    <Banner tone="ok">
      <span>{t.mcpTestOk(tools.length, resources)}</span>
      {tools.length > 0 && (
        <span className="block text-[#8d8d8d] truncate" title={tools.join(", ")}>
          {t.mcpTools}: {tools.join(", ")}
        </span>
      )}
    </Banner>
  );
}
