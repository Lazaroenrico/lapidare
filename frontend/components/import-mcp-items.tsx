"use client";

/** Itens importáveis de um servidor MCP: busca, seleção múltipla e import. */

import React, { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { importMcpItems, isAbortError, listMcpItems } from "@/lib/api";
import type { ImportResult, McpImportItem, McpImportServer } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { Badge, Banner, Btn, Check, cx, errMsg, handleListKeys, inputClass } from "./import-ui";

export function McpItemsBrowser({
  server,
  onImported,
}: {
  server: McpImportServer;
  onImported: (result: ImportResult) => void;
}) {
  const { t } = useLocale();
  const [items, setItems] = useState<McpImportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startSession, setStartSession] = useState(false);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setSelected(new Set());
    listMcpItems(server.name, ctrl.signal)
      .then((list) => setItems(list ?? []))
      .catch((err) => {
        if (!isAbortError(err)) setError(errMsg(err, t.impNoItems));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.name, reload]);

  // Padrão: abrir sessão só quando exatamente 1 item está selecionado.
  useEffect(() => {
    setStartSession(selected.size === 1);
  }, [selected.size]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) =>
      [i.title, i.description, i.id, i.kind].some((f) => (f ?? "").toLowerCase().includes(q))
    );
  }, [items, query]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    setImporting(true);
    setError(null);
    setDone(null);
    try {
      const ids = items.filter((i) => selected.has(i.id)).map((i) => i.id);
      const result = await importMcpItems(server.name, ids, startSession);
      setDone(result.imported.length);
      onImported(result);
      if (!result.session_id) setReload((n) => n + 1);
    } catch (err) {
      setError(errMsg(err, t.impImporting));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-[#2a2a2a] pt-3">
      <div className="relative">
        <Search className="w-3 h-3 absolute left-3 top-1/2 -translate-y-1/2 text-[#8d8d8d]" aria-hidden />
        <label htmlFor="mcp-filter" className="sr-only">
          {t.impFilterLabel}
        </label>
        <input
          id="mcp-filter"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.impFilter}
          className={cx(inputClass, "pl-8")}
        />
      </div>

      <div className="flex items-center justify-between text-[11px] text-[#8d8d8d] font-ui">
        <span>{t.impSelected(selected.size)}</span>
        <span className="flex gap-1">
          <Btn
            variant="ghost"
            disabled={visible.length === 0}
            onClick={() => setSelected((prev) => new Set([...prev, ...visible.map((i) => i.id)]))}
          >
            {t.impSelectAll}
          </Btn>
          <Btn variant="ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
            {t.impClear}
          </Btn>
        </span>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <div
        role="group"
        aria-label={server.name}
        onKeyDown={handleListKeys}
        className="max-h-72 overflow-y-auto rounded-md border border-[#2a2a2a] divide-y divide-[#2a2a2a]"
      >
        {loading ? (
          <p className="p-3 text-[11px] text-[#8d8d8d] font-ui">{t.impLoading}</p>
        ) : items.length === 0 ? (
          <p className="p-3 text-[11px] text-[#8d8d8d] font-ui">{t.impNoItems}</p>
        ) : visible.length === 0 ? (
          <p className="p-3 text-[11px] text-[#8d8d8d] font-ui">{t.impNoMatch}</p>
        ) : (
          visible.map((item) => {
            const id = `mcp-item-${item.id}`;
            const isSel = selected.has(item.id);
            return (
              <label
                key={item.id}
                htmlFor={id}
                className={cx(
                  "flex items-start gap-2 px-3 py-2 cursor-pointer transition-colors",
                  isSel ? "bg-[#2a2a2a]" : "hover:bg-[#141414]"
                )}
              >
                <input
                  id={id}
                  data-nav
                  type="checkbox"
                  checked={isSel}
                  onChange={() => toggle(item.id)}
                  className="mt-1 accent-[#e6e6e6] cursor-pointer"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-ui text-[12.5px] text-[#e6e6e6] truncate">{item.title}</span>
                    {item.is_new && <Badge tone="new">{t.impNew}</Badge>}
                    {item.kind && <Badge>{item.kind}</Badge>}
                  </span>
                  {item.description && (
                    <span className="block font-prose text-[12.5px] text-[#8d8d8d] line-clamp-2">
                      {item.description}
                    </span>
                  )}
                </span>
              </label>
            );
          })
        )}
      </div>

      {done !== null && <Banner tone="ok">{t.impImported(done)}</Banner>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Check
          id="mcp-start-session"
          checked={startSession}
          onChange={setStartSession}
          label={t.impStartSession}
        />
        <Btn variant="primary" disabled={selected.size === 0} busy={importing} onClick={submit}>
          {importing ? t.impImporting : `${t.impImport} (${selected.size})`}
        </Btn>
      </div>
    </div>
  );
}
