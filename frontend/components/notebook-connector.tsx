"use client";

import React, { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/api";
import type { ImportResult } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { useEventSubscription } from "./server-events";
import { Banner, Btn, inputClass } from "./import-ui";

type Status = { connected: boolean; connecting: boolean; login_error: boolean };
type Item = { id: string; title: string; status?: string };
type Result = ImportResult & { errors: { id: string; reason: string }[] };
const base = "/api/import/notebook";
const call = <T,>(path: string, options: RequestInit = {}) => fetchJson<T>(base + path, options, { silent: true });
const post = <T,>(path: string, body?: unknown) => call<T>(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

export function NotebookConnector({ settings = false, onImported }: { settings?: boolean; onImported?: (result: ImportResult) => void }) {
  const { locale } = useLocale();
  const pt = locale.toLowerCase().startsWith("pt");
  const [status, setStatus] = useState<Status | null>(null);
  const [notebooks, setNotebooks] = useState<Item[]>([]);
  const [notebook, setNotebook] = useState("");
  const [sources, setSources] = useState<Item[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [start, setStart] = useState(true);
  const refresh = useCallback(async () => { try { setStatus(await call<Status>("/status")); } catch { setError(pt ? "Não foi possível verificar a conexão." : "Could not check the connection."); } }, [pt]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEventSubscription("config:updated", () => void refresh());
  useEffect(() => {
    if (!status?.connected || settings) return;
    let active = true;
    call<Item[]>("/notebooks").then(rows => { if (active) setNotebooks(rows); }).catch(() => { if (active) setError(pt ? "Não foi possível listar os notebooks. Reconecte e tente novamente." : "Could not list notebooks. Reconnect and try again."); });
    return () => { active = false; };
  }, [status?.connected, settings, pt]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch { setError(pt ? "Não foi possível concluir. Tente novamente ou reconecte sua conta." : "Could not complete the request. Try again or reconnect your account."); } finally { setBusy(false); }
  };
  const selectNotebook = async (id: string) => {
    setNotebook(id); setSources([]); setSelected([]); setResult(null);
    if (id) await action(async () => setSources(await call<Item[]>(`/notebooks/${encodeURIComponent(id)}/sources`)));
  };
  return <div className="space-y-3 p-4 font-ui text-xs">
    <h3 className="font-semibold text-foreground">Gemini Notebook</h3>
    <p className="text-muted-foreground">{pt ? "Conexão de leitura por biblioteca não oficial; pode exigir nova autenticação." : "Read-only connection using an unofficial library; you may need to sign in again."}</p>
    {error && <Banner tone="error">{error}</Banner>}
    {status?.login_error && <Banner tone="error">{pt ? "O login falhou ou foi cancelado. Tente novamente." : "Sign-in failed or was cancelled. Try again."}</Banner>}
    <p className="text-muted-foreground">{status?.connecting ? (pt ? "Conclua o login na janela do navegador." : "Complete sign-in in the browser window.") : status?.connected ? (pt ? "Conectado" : "Connected") : (pt ? "Não conectado" : "Not connected")}</p>
    <div className="flex gap-2">
      <Btn disabled={busy || !!status?.connecting} onClick={() => void action(async () => { setStatus(await post<Status>("/login")); })}>{status?.connected ? (pt ? "Reconectar" : "Reconnect") : (pt ? "Conectar" : "Connect")}</Btn>
      {(status?.connected || status?.connecting) && <Btn disabled={busy} onClick={() => void action(async () => { setStatus(await post<Status>("/logout")); setNotebooks([]); setSources([]); setNotebook(""); setSelected([]); })}>{pt ? "Desconectar" : "Disconnect"}</Btn>}
    </div>
    {!settings && status?.connected && <>
      <label className="block" htmlFor="notebook-select">{pt ? "Notebook" : "Notebook"}</label>
      <select id="notebook-select" className={inputClass} value={notebook} onChange={e => void selectNotebook(e.target.value)}>
        <option value="">{pt ? "Selecione um notebook" : "Select a notebook"}</option>
        {notebooks.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
      </select>
      {notebook && sources.length === 0 && !busy && <p>{pt ? "Nenhuma fonte disponível." : "No sources available."}</p>}
      {sources.map(row => <label key={row.id} className="flex gap-2 items-start"><input type="checkbox" checked={selected.includes(row.id)} onChange={e => setSelected(e.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id))} /><span>{row.title} <span className="text-muted-foreground">{row.status}</span></span></label>)}
      {selected.length === 1 && <label className="flex gap-2"><input type="checkbox" checked={start} onChange={e => setStart(e.target.checked)} />{pt ? "Iniciar TEACH após importar" : "Start TEACH after import"}</label>}
      {sources.length > 0 && <Btn disabled={busy || !selected.length} onClick={() => void action(async () => { const data = await post<Result>("/import", { notebook_id: notebook, source_ids: selected, start_session: start && selected.length === 1 }); setResult(data); onImported?.(data); })}>{pt ? "Importar fontes" : "Import sources"}</Btn>}
      {result && <div role="status"><p>{pt ? `${result.imported.length} fonte(s) importada(s).` : `${result.imported.length} source(s) imported.`}</p>{result.errors.map(e => <p key={e.id}>{sources.find(s => s.id === e.id)?.title || e.id}: {e.reason === "empty" ? (pt ? "sem texto" : "no text") : (pt ? "indisponível" : "unavailable")}</p>)}</div>}
    </>}
  </div>;
}
