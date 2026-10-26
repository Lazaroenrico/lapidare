"use client";

import React, { useEffect, useState } from "react";
import {
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  Lock,
  X,
} from "lucide-react";
import { getSourceParagraph } from "@/lib/api";

interface SourceCitationPaneProps {
  isOpen: boolean;
  onClose: () => void;
  sourceName: string | null;
  paragraphId: string | null;
  className?: string;
}

interface SourceData {
  sourceName: string;
  paragraphId: string;
  content: string;
  context_before?: string;
  context_after?: string;
}

export function SourceCitationPane({
  isOpen,
  onClose,
  sourceName,
  paragraphId,
  className = "",
}: SourceCitationPaneProps) {
  const [loading, setLoading] = useState<boolean>(false);
  const [data, setData] = useState<SourceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Fetch paragraph when pane opens
  useEffect(() => {
    if (!isOpen || !sourceName || !paragraphId) {
      setData(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    const cleanPid = paragraphId.replace(/^\^/, "");

    getSourceParagraph(sourceName, cleanPid)
      .then((res) => {
        if (isMounted) {
          setData(res);
        }
      })
      .catch((err) => {
        if (isMounted) {
          console.error("Failed to fetch source paragraph:", err);
          setError(
            err?.message ||
              `Não foi possível carregar o parágrafo ^${cleanPid} de ${sourceName}.`
          );
        }
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, sourceName, paragraphId]);

  const handleCopySnippet = async () => {
    if (!data?.content) return;
    try {
      const text = `> ${data.content}\n— [[${sourceName}#^${paragraphId}]]`;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard error
    }
  };

  if (!isOpen) return null;

  const displayParagraphId = (paragraphId || "").replace(/^\^/, "p");

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-xs transition-opacity animate-fade-in">
      {/* Backdrop overlay to close */}
      <div
        className="fixed inset-0 cursor-pointer"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over panel */}
      <aside
        className={`relative w-full max-w-lg md:max-w-xl h-full bg-[#1c1c1c] border-l border-[#434343] shadow-2xl flex flex-col font-ui text-xs z-10 select-text ${className}`}
        aria-label="Source Citation Drawer"
      >
        {/* Header */}
        <div className="p-4 bg-[#141414] border-b border-[#434343] flex flex-col gap-2 select-none">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-[#8d8d8d]" />
              <span className="font-title font-bold text-sm text-[#e6e6e6]">
                Fonte Original
              </span>
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#1c1c1c] border border-[#434343] text-[10px] text-[#8d8d8d]">
                <Lock className="w-2.5 h-2.5" />
                SOMENTE-LEITURA · VAULT
              </span>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-1 text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#2a2a2a] rounded cursor-pointer transition-colors"
              title="Fechar painel (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Source Details & Anchor Badge */}
          <div className="flex items-center justify-between gap-2 mt-1">
            <div className="flex items-center gap-1.5 truncate">
              <FileText className="w-3.5 h-3.5 text-[#8d8d8d] shrink-0" />
              <span className="text-[12px] font-prose font-semibold text-[#e6e6e6] truncate">
                Fontes/{sourceName}
              </span>
            </div>

            <span className="px-2 py-0.5 rounded bg-[#2a2a2a] border border-[#434343] font-ui text-[11px] text-[#e0a030] font-bold shrink-0">
              #^{displayParagraphId}
            </span>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-[#8d8d8d] gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="font-ui text-xs">
                Localizando parágrafo #{displayParagraphId} na fonte...
              </span>
            </div>
          ) : error ? (
            <div className="p-4 rounded bg-[#141414] border border-amber-900/40 text-amber-300 font-prose text-sm flex flex-col gap-2">
              <p className="font-semibold font-ui text-xs">Parágrafo não indexado</p>
              <p className="text-[13px] text-[#8d8d8d]">{error}</p>
              <p className="text-[12px] text-[#8d8d8d] mt-1">
                Verifique se o arquivo original em <code>Fontes/{sourceName}</code> contém a âncora <code>^{displayParagraphId}</code>.
              </p>
            </div>
          ) : data ? (
            <div className="flex flex-col gap-4">
              {/* Context Before */}
              {data.context_before && (
                <div className="text-[#8d8d8d] font-prose text-[14px] leading-relaxed opacity-60 line-clamp-4 select-text border-b border-[#2a2a2a] pb-3">
                  <span className="font-ui text-[10px] uppercase text-[#8d8d8d] block mb-1">
                    ... contexto anterior
                  </span>
                  {data.context_before}
                </div>
              )}

              {/* Highlighted Paragraph */}
              <div className="relative p-4 rounded-lg bg-[#242424] border-2 border-[#e6e6e6]/30 shadow-md select-text">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#383838]">
                  <span className="font-ui text-[10.5px] uppercase tracking-wider text-[#e0a030] font-semibold">
                    ▲ Parágrafo Citado (#^{displayParagraphId})
                  </span>
                  <button
                    type="button"
                    onClick={handleCopySnippet}
                    className="flex items-center gap-1 text-[11px] text-[#8d8d8d] hover:text-[#e6e6e6] transition-colors p-1"
                    title="Copiar citação para o Obsidian"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3 h-3 text-green-400" />
                        <span className="text-green-400 text-[10px]">Copiado</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span className="text-[10px]">Copiar</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="font-prose text-[15.5px] leading-relaxed text-white select-text">
                  {data.content}
                </div>
              </div>

              {/* Context After */}
              {data.context_after && (
                <div className="text-[#8d8d8d] font-prose text-[14px] leading-relaxed opacity-60 line-clamp-4 select-text border-t border-[#2a2a2a] pt-3">
                  <span className="font-ui text-[10px] uppercase text-[#8d8d8d] block mb-1">
                    contexto seguinte ...
                  </span>
                  {data.context_after}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-16 text-[#8d8d8d] font-prose text-sm">
              Nenhuma fonte selecionada.
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="p-3 bg-[#141414] border-t border-[#434343] flex items-center justify-between text-[11px] text-[#8d8d8d]">
          <span>
            Obsidian: <code>[[{sourceName}#^{displayParagraphId}]]</code>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 bg-[#1c1c1c] hover:bg-[#2a2a2a] text-[#e6e6e6] border border-[#434343] rounded cursor-pointer transition-colors"
          >
            Fechar
          </button>
        </div>
      </aside>
    </div>
  );
}
