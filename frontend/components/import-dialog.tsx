"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  FileText,
  Loader2,
  Server,
  Settings,
  Upload,
  X,
} from "lucide-react";
import type { CatalogLessonItem } from "@/lib/types";
import { createChat, getImportCatalog, importSource } from "@/lib/api";

interface ImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete?: (sourcePath: string, sessionId?: string) => void;
}

type ImportTab = "mcp_catalog" | "local_note";

export function ImportDialog({
  isOpen,
  onClose,
  onImportComplete,
}: ImportDialogProps) {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<ImportTab>("mcp_catalog");
  const [loading, setLoading] = useState<boolean>(true);
  const [mcpConnected, setMcpConnected] = useState<boolean>(false);
  const [catalogItems, setCatalogItems] = useState<CatalogLessonItem[]>([]);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Local Note Form State
  const [localTitle, setLocalTitle] = useState<string>("");
  const [localContent, setLocalContent] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [localSubmitting, setLocalSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;

    let mounted = true;
    const fetchCatalog = async () => {
      try {
        setLoading(true);
        setErrorMsg(null);
        const data = await getImportCatalog();
        if (mounted) {
          setMcpConnected(data.mcp_connected);
          setCatalogItems(data.items || []);
          if (!data.mcp_connected) {
            setActiveTab("local_note");
          } else {
            setActiveTab("mcp_catalog");
          }
        }
      } catch (err) {
        if (mounted) {
          console.error("Failed to fetch import catalog:", err);
          setActiveTab("local_note");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    void fetchCatalog();

    return () => {
      mounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // 1-Click Import MCP Lesson & Start TEACH
  const handleImportMcpItem = async (item: CatalogLessonItem) => {
    try {
      setImportingId(item.id);
      setErrorMsg(null);

      const result = await importSource({
        item_id: item.id,
        title: item.title,
      });

      let targetSessionId = result.session_id;

      if (!targetSessionId) {
        const session = await createChat({
          mode: "TEACH",
          topic: item.title,
          source_file: result.source_path,
        });
        targetSessionId = session.id;
      }

      if (onImportComplete) {
        onImportComplete(result.source_path, targetSessionId);
      }
      onClose();
      router.push(`/chat/${targetSessionId}`);
    } catch (err: any) {
      console.error("Failed to import MCP item:", err);
      setErrorMsg(err.message || "Falha ao importar aula do servidor MCP.");
    } finally {
      setImportingId(null);
    }
  };

  // Import Local Text / File & Start TEACH
  const handleImportLocalNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localTitle.trim() || !localContent.trim()) {
      setErrorMsg("Forneça um título e o conteúdo da nota/transcrição.");
      return;
    }

    try {
      setLocalSubmitting(true);
      setErrorMsg(null);

      const result = await importSource({
        title: localTitle.trim(),
        file_content: localContent,
        file_name: fileName || `${localTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`,
      });

      let targetSessionId = result.session_id;

      if (!targetSessionId) {
        const session = await createChat({
          mode: "TEACH",
          topic: localTitle.trim(),
          source_file: result.source_path,
        });
        targetSessionId = session.id;
      }

      if (onImportComplete) {
        onImportComplete(result.source_path, targetSessionId);
      }
      onClose();
      router.push(`/chat/${targetSessionId}`);
    } catch (err: any) {
      console.error("Failed to import local note:", err);
      setErrorMsg(err.message || "Falha ao ingerir nota local no Vault.");
    } finally {
      setLocalSubmitting(false);
    }
  };

  // File Upload Reader Handler
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    if (!localTitle) {
      setLocalTitle(file.name.replace(/\.[^/.]+$/, ""));
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === "string") {
        setLocalContent(text);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none animate-in fade-in duration-150">
      <div className="bg-[#1c1c1c] border border-[#434343] rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl font-ui">
        {/* Header */}
        <div className="p-4 border-b border-[#2a2a2a] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-[#2a2a2a] rounded-lg border border-[#434343]">
              <Upload className="w-4 h-4 text-[#e6e6e6]" />
            </div>
            <div>
              <h2 className="font-title text-base text-[#e6e6e6] font-bold">
                Importar Conteúdo para o Vault
              </h2>
              <p className="text-[11px] text-[#8d8d8d] font-prose">
                Ingira aulas completas ancoradas com numeração de parágrafo (^p1..^pN)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#8d8d8d] hover:text-[#e6e6e6] p-1.5 rounded-lg hover:bg-[#2a2a2a] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs Bar */}
        <div className="flex items-center border-b border-[#2a2a2a] px-4 bg-[#141414]">
          <button
            type="button"
            onClick={() => setActiveTab("mcp_catalog")}
            className={`flex items-center gap-2 py-2.5 px-3 border-b-2 text-xs font-ui transition-colors cursor-pointer ${
              activeTab === "mcp_catalog"
                ? "border-[#e6e6e6] text-[#e6e6e6] font-semibold"
                : "border-transparent text-[#8d8d8d] hover:text-[#e6e6e6]"
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            <span>Catálogo MCP (Praxis)</span>
            {mcpConnected && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#34d399]" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("local_note")}
            className={`flex items-center gap-2 py-2.5 px-3 border-b-2 text-xs font-ui transition-colors cursor-pointer ${
              activeTab === "local_note"
                ? "border-[#e6e6e6] text-[#e6e6e6] font-semibold"
                : "border-transparent text-[#8d8d8d] hover:text-[#e6e6e6]"
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Nota / Transcrição Local</span>
          </button>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="m-4 mb-0 p-3 bg-[#f87171]/15 border border-[#f87171]/40 rounded-lg flex items-center gap-2.5 text-xs text-[#f87171]">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Tab 1: MCP Catalog Tab */}
        {activeTab === "mcp_catalog" && (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-16 text-[#8d8d8d] gap-2">
                <Loader2 className="w-6 h-6 animate-spin text-[#8d8d8d]" />
                <span className="text-xs">Consultando servidor MCP...</span>
              </div>
            ) : !mcpConnected ? (
              <div className="text-center py-12 px-4 bg-[#141414] border border-[#2a2a2a] rounded-xl">
                <Server className="w-8 h-8 mx-auto mb-2 text-[#8d8d8d] opacity-50" />
                <h3 className="text-sm font-semibold text-[#e6e6e6] mb-1">
                  Nenhum servidor MCP de conteúdo ativo
                </h3>
                <p className="text-xs text-[#8d8d8d] max-w-md mx-auto mb-4 font-prose">
                  Para importar semanas, aulas e desafios automaticamente da mentoria (ex: MCP Praxis), configure o conector nas Configurações.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    router.push("/settings");
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#2a2a2a] hover:bg-[#333333] border border-[#434343] text-xs font-ui text-[#e6e6e6] transition-colors cursor-pointer"
                >
                  <Settings className="w-3.5 h-3.5" />
                  <span>Configurar MCP</span>
                </button>
              </div>
            ) : catalogItems.length === 0 ? (
              <div className="text-center py-12 text-[#8d8d8d]">
                <p className="text-xs">Nenhuma aula listada pelo servidor MCP no momento.</p>
              </div>
            ) : (
              catalogItems.map((item) => (
                <div
                  key={item.id}
                  className="bg-[#141414] border border-[#2a2a2a] hover:border-[#434343] rounded-xl p-3 flex items-center justify-between gap-3 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {item.week && (
                        <span className="text-[10px] bg-[#2a2a2a] text-[#8d8d8d] px-1.5 py-0.2 rounded border border-[#434343]">
                          Semana {String(item.week).padStart(2, "0")}
                        </span>
                      )}
                      {!item.imported ? (
                        <span className="text-[10px] bg-[#34d399]/15 text-[#34d399] px-1.5 py-0.2 rounded border border-[#34d399]/40 font-semibold">
                          NEW
                        </span>
                      ) : (
                        <span className="text-[10px] text-[#8d8d8d] flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3 text-[#34d399]" />
                          Importada
                        </span>
                      )}
                      {item.category && (
                        <span className="text-[10px] text-[#666666]">
                          · {item.category}
                        </span>
                      )}
                    </div>
                    <h4 className="text-xs font-semibold text-[#e6e6e6] truncate">
                      {item.title}
                    </h4>
                  </div>

                  <button
                    type="button"
                    disabled={importingId === item.id}
                    onClick={() => handleImportMcpItem(item)}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2a2a2a] hover:bg-[#333333] active:bg-[#434343] border border-[#434343] hover:border-[#8d8d8d] text-xs font-ui text-[#e6e6e6] transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {importingId === item.id ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Importando...</span>
                      </>
                    ) : (
                      <>
                        <BookOpen className="w-3.5 h-3.5 text-[#34d399]" />
                        <span>{item.imported ? "Abrir TEACH" : "Importar & Abrir TEACH"}</span>
                      </>
                    )}
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Tab 2: Local Note Tab */}
        {activeTab === "local_note" && (
          <form
            onSubmit={handleImportLocalNote}
            className="flex-1 overflow-y-auto p-4 space-y-3 font-ui"
          >
            {/* Vault Notice */}
            <div className="p-3 bg-[#141414] border border-[#2a2a2a] rounded-xl text-[11px] text-[#8d8d8d] leading-relaxed font-prose">
              <span className="text-[#e6e6e6] font-semibold">Regra de Integridade:</span> Arquivos em{" "}
              <code className="text-[#e6e6e6] bg-[#2a2a2a] px-1 py-0.5 rounded font-mono">
                Fontes/
              </code>{" "}
              são estritamente somente-leitura. O conteúdo será fatiado e receberá numeração de parágrafos{" "}
              <code className="text-[#34d399] font-mono">^p1..^pN</code> para ancorar todas as citações e afirmações nas aulas.
            </div>

            {/* Title & File Upload */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8d8d8d] block font-ui">
                Título da Fonte / Aula
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Ex: Aula 03 — Multi-Head Attention e RoPE"
                  value={localTitle}
                  onChange={(e) => setLocalTitle(e.target.value)}
                  className="flex-1 bg-[#141414] border border-[#434343] focus:border-[#8d8d8d] rounded-lg px-3 py-2 text-xs text-[#e6e6e6] placeholder-[#666666] outline-none"
                  required
                />
                <label className="flex items-center gap-1.5 px-3 py-2 bg-[#2a2a2a] hover:bg-[#333333] border border-[#434343] rounded-lg text-xs text-[#e6e6e6] cursor-pointer shrink-0 transition-colors">
                  <Upload className="w-3.5 h-3.5 text-[#8d8d8d]" />
                  <span>Arquivo .md/.txt</span>
                  <input
                    type="file"
                    accept=".md,.txt,.markdown"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            {/* Content Textarea */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8d8d8d] block font-ui">
                Transcrição / Conteúdo Completo
              </label>
              <textarea
                rows={8}
                value={localContent}
                onChange={(e) => setLocalContent(e.target.value)}
                placeholder="Cole aqui a transcrição de áudio, notas brutas de aula ou documento da mentoria..."
                className="w-full bg-[#141414] border border-[#434343] focus:border-[#8d8d8d] rounded-lg p-3 text-xs text-[#e6e6e6] placeholder-[#666666] font-prose resize-none outline-none leading-relaxed"
                required
              />
            </div>

            {/* Actions */}
            <div className="pt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-[#2a2a2a] text-[#8d8d8d] hover:text-[#e6e6e6] text-xs font-ui transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={localSubmitting || !localTitle.trim() || !localContent.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#e6e6e6] text-[#141414] hover:bg-[#ffffff] text-xs font-ui font-semibold transition-colors cursor-pointer disabled:opacity-50"
              >
                {localSubmitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Ingerindo no Vault...</span>
                  </>
                ) : (
                  <>
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>Ingerir & Iniciar TEACH</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
