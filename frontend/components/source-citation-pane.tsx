"use client";

import React, { useEffect, useState } from "react";
import {
  BookOpen,
  Check,
  Copy,
  FileText,
  Loader2,
  Lock,
  X,
} from "lucide-react";
import { getSourceParagraph } from "@/lib/api";
import { useLocale } from "./locale-provider";

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
  const { t } = useLocale();
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
            err?.message || t.paragraphLoadFailed(cleanPid, sourceName)
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
    <div className="fixed inset-0 z-50 flex justify-end bg-background/60 backdrop-blur-xs transition-opacity animate-fade-in">
      {/* Backdrop overlay to close */}
      <div
        className="fixed inset-0 cursor-pointer"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over panel */}
      <aside
        className={`relative w-full max-w-lg md:max-w-xl h-full bg-card border-l border-border shadow-2xl flex flex-col font-ui text-xs z-10 select-text ${className}`}
        aria-label={t.sourcePaneAria}
      >
        {/* Header */}
        <div className="p-4 bg-background border-b border-border flex flex-col gap-2 select-none">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-muted-foreground" />
              <span className="font-title font-bold text-sm text-foreground">
                {t.originalSource}
              </span>
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-card border border-border text-[10px] text-muted-foreground">
                <Lock className="w-2.5 h-2.5" />
                {t.readOnlyVault}
              </span>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded cursor-pointer transition-colors"
              title={t.closePaneEsc}
              aria-label={t.closePaneEsc}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Source Details & Anchor Badge */}
          <div className="flex items-center justify-between gap-2 mt-1">
            <div className="flex items-center gap-1.5 truncate">
              <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-[12px] font-prose font-semibold text-foreground truncate">
                {t.sourcesFolder}/{sourceName}
              </span>
            </div>

            <span className="px-2 py-0.5 rounded bg-accent border border-border font-ui text-[11px] text-warning font-bold shrink-0">
              #^{displayParagraphId}
            </span>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="font-ui text-xs">
                {t.locatingParagraph(displayParagraphId)}
              </span>
            </div>
          ) : error ? (
            <div className="p-4 rounded bg-background border border-warning/40 text-warning font-prose text-sm flex flex-col gap-2">
              <p className="font-semibold font-ui text-xs">{t.paragraphNotIndexed}</p>
              <p className="text-[13px] text-muted-foreground">{error}</p>
              <p className="text-[12px] text-muted-foreground mt-1">
                {t.checkAnchorBefore}<code>{t.sourcesFolder}/{sourceName}</code>{t.checkAnchorMiddle}<code>^{displayParagraphId}</code>.
              </p>
            </div>
          ) : data ? (
            <div className="flex flex-col gap-4">
              {/* Context Before */}
              {data.context_before && (
                <div className="text-muted-foreground font-prose text-[14px] leading-relaxed opacity-60 line-clamp-4 select-text border-b border-accent pb-3">
                  <span className="font-ui text-[10px] uppercase text-muted-foreground block mb-1">
                    {t.contextBefore}
                  </span>
                  {data.context_before}
                </div>
              )}

              {/* Highlighted Paragraph */}
              <div className="relative p-4 rounded-lg bg-card border-2 border-foreground/30 shadow-md select-text">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-border">
                  <span className="font-ui text-[10.5px] uppercase tracking-wider text-warning font-semibold">
                    {t.citedParagraph(displayParagraphId)}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopySnippet}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors p-1"
                    title={t.copyCitation}
                  >
                    {copied ? (
                      <>
                        <Check className="w-3 h-3 text-success" />
                        <span className="text-success text-[10px]">{t.copied}</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span className="text-[10px]">{t.copy}</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="font-prose text-[15.5px] leading-relaxed text-foreground select-text">
                  {data.content}
                </div>
              </div>

              {/* Context After */}
              {data.context_after && (
                <div className="text-muted-foreground font-prose text-[14px] leading-relaxed opacity-60 line-clamp-4 select-text border-t border-accent pt-3">
                  <span className="font-ui text-[10px] uppercase text-muted-foreground block mb-1">
                    {t.contextAfter}
                  </span>
                  {data.context_after}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-16 text-muted-foreground font-prose text-sm">
              {t.noSourceSelected}
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="p-3 bg-background border-t border-border flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            Obsidian: <code>[[{sourceName}#^{displayParagraphId}]]</code>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 bg-card hover:bg-accent text-foreground border border-border rounded cursor-pointer transition-colors"
          >
            {t.close}
          </button>
        </div>
      </aside>
    </div>
  );
}
