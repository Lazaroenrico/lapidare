"use client";

/**
 * Modal "↑ Import" multi-fonte (Fase 3B): MCP · GitHub · Arquivo local · Adicionar ao grafo (Fase 16).
 * Aba padrão (§3.2.2): MCP quando há servidor habilitado; senão, o importador local.
 * Após gravar, o backend emite `vault:changed` e o grafo se atualiza pelo SSE único.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, GitBranch, Network, Server, Upload, X } from "lucide-react";
import { listMcpServers } from "@/lib/api";
import type { ImportResult, McpImportServer } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { McpServerManager } from "./mcp-server-manager";
import { McpItemsBrowser } from "./import-mcp-items";
import { GithubImportPanel } from "./import-github-panel";
import { LocalImportPanel } from "./import-local-panel";
import { NotesGraphPanel } from "./import-notes-panel";
import { notesText } from "@/lib/notes-import";
import { Banner, cx, errMsg } from "./import-ui";

interface ImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete?: (sourcePath: string, sessionId?: string) => void;
  /** Aba inicial (ex.: "graph" para "Importar notas para o grafo"); sem ela, MCP ou local. */
  initialTab?: ImportTab;
}

export type ImportTab = "mcp" | "github" | "local" | "graph";
const TABS: ImportTab[] = ["mcp", "github", "local", "graph"];

export function ImportDialog({ isOpen, onClose, onImportComplete, initialTab }: ImportDialogProps) {
  if (!isOpen) return null;
  return <ImportDialogBody onClose={onClose} onImportComplete={onImportComplete} initialTab={initialTab} />;
}

function ImportDialogBody({ onClose, onImportComplete, initialTab }: Omit<ImportDialogProps, "isOpen">) {
  const router = useRouter();
  const { t, locale } = useLocale();
  const [servers, setServers] = useState<McpImportServer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<ImportTab | null>(null);
  const [visited, setVisited] = useState<Set<ImportTab>>(new Set());
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<ImportTab, HTMLButtonElement | null>>({ mcp: null, github: null, local: null, graph: null });

  const openTab = useCallback((next: ImportTab) => {
    setTab(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }, []);

  useEffect(() => {
    let alive = true;
    listMcpServers()
      .then((list) => {
        if (!alive) return;
        setServers(list ?? []);
        openTab(initialTab ?? ((list ?? []).some((s) => s.enabled) ? "mcp" : "local"));
      })
      .catch((err) => {
        if (!alive) return;
        setServers([]);
        setLoadError(errMsg(err, t.mcpEmpty));
        openTab(initialTab ?? "local");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc fecha; foco entra no modal e volta ao gatilho ao fechar.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const handleImported = (result: ImportResult) => {
    const first = result.imported[0];
    if (first) onImportComplete?.(first.source_path, result.session_id ?? undefined);
    if (result.session_id) {
      onClose();
      router.push(`/chat/${encodeURIComponent(result.session_id)}`);
    }
  };

  const onTabKey = (e: React.KeyboardEvent) => {
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = TABS.indexOf(tab);
    const next =
      e.key === "Home" ? TABS[0]
      : e.key === "End" ? TABS[TABS.length - 1]
      : TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    openTab(next);
    tabRefs.current[next]?.focus();
  };

  const tabMeta: Record<ImportTab, { label: string; Icon: typeof Server }> = {
    mcp: { label: t.impTabMcp, Icon: Server },
    github: { label: t.impTabGithub, Icon: GitBranch },
    local: { label: t.impTabLocal, Icon: FileText },
    graph: { label: notesText(locale).tab, Icon: Network },
  };
  const enabledCount = servers?.filter((s) => s.enabled).length ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/75 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        tabIndex={-1}
        className="w-full max-w-4xl h-[80vh] flex flex-col rounded-xl border border-border bg-card shadow-2xl font-ui"
      >
        <header className="flex items-start justify-between gap-4 px-4 py-3 border-b border-accent">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-md border border-border bg-accent">
              <Upload className="w-4 h-4 text-foreground" aria-hidden />
            </div>
            <div>
              <h2 id="import-dialog-title" className="font-title text-lg font-bold text-foreground leading-6">
                {t.impTitle}
              </h2>
              <p className="text-[11px] text-muted-foreground">{t.impSubtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.close}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:text-foreground focus-visible:bg-accent cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden />
          </button>
        </header>

        <div
          role="tablist"
          aria-label={t.impSources}
          onKeyDown={onTabKey}
          className="flex items-center gap-1 px-4 border-b border-accent bg-background"
        >
          {TABS.map((id) => {
            const { label, Icon } = tabMeta[id];
            const active = tab === id;
            return (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[id] = el;
                }}
                id={`import-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`import-panel-${id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => openTab(id)}
                className={cx(
                  "flex items-center gap-2 px-3 py-2 border-b-2 text-[12.5px] cursor-pointer transition-colors",
                  active
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground focus-visible:text-foreground"
                )}
              >
                <Icon className="w-3 h-3" aria-hidden />
                <span>{label}</span>
                {id === "mcp" && enabledCount > 0 && (
                  <span className="w-2 h-2 rounded-full bg-success" aria-hidden />
                )}
              </button>
            );
          })}
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          {loadError && tab === "mcp" && (
            <div className="px-4 pt-3">
              <Banner tone="error">{loadError}</Banner>
            </div>
          )}

          {servers === null && <p className="p-4 text-[11px] text-muted-foreground">{t.impLoading}</p>}

          {visited.has("mcp") && servers !== null && (
            <div
              id="import-panel-mcp"
              role="tabpanel"
              aria-labelledby="import-tab-mcp"
              hidden={tab !== "mcp"}
              className="flex-1 min-h-0"
            >
              <McpServerManager
                className="h-full"
                initialServers={servers}
                onServersChange={setServers}
                selected={selectedServer}
                onSelect={setSelectedServer}
                renderDetail={(server) => (
                  <McpItemsBrowser key={server.name} server={server} onImported={handleImported} />
                )}
              />
            </div>
          )}

          {visited.has("github") && (
            <div
              id="import-panel-github"
              role="tabpanel"
              aria-labelledby="import-tab-github"
              hidden={tab !== "github"}
              className="flex-1 min-h-0 overflow-y-auto p-4"
            >
              <GithubImportPanel onImported={handleImported} />
            </div>
          )}

          {visited.has("local") && (
            <div
              id="import-panel-local"
              role="tabpanel"
              aria-labelledby="import-tab-local"
              hidden={tab !== "local"}
              className="flex-1 min-h-0 overflow-y-auto p-4"
            >
              <LocalImportPanel onImported={handleImported} />
            </div>
          )}

          {visited.has("graph") && (
            <div
              id="import-panel-graph"
              role="tabpanel"
              aria-labelledby="import-tab-graph"
              hidden={tab !== "graph"}
              className="flex-1 min-h-0 overflow-y-auto p-4"
            >
              <NotesGraphPanel />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
