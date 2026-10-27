"use client";

import React from "react";
import { AlertTriangle, Cpu, Loader2, RotateCcw } from "lucide-react";
import { classifyEngineError } from "@/lib/engine-error";
import { tracksText } from "@/lib/tracks-i18n";
import { useLocale } from "./locale-provider";

/** A failed run, in plain words: the (redacted) error, what it means and what to do next. */
export function EngineErrorCard({
  error,
  retrying,
  onRetry,
  onChangeModel,
}: {
  error: string;
  retrying: boolean;
  onRetry: () => void;
  onChangeModel: () => void;
}) {
  const { locale } = useLocale();
  const tt = tracksText(locale);
  const quota = classifyEngineError(error) === "quota";
  const button =
    "flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent hover:bg-border border border-border text-foreground text-[11px] font-ui font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-muted-foreground";
  return (
    <div role="alert" className="flex flex-col gap-2 p-3 rounded border border-danger/50 bg-card">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-danger shrink-0" />
        <span className="font-ui text-[12.5px] font-semibold text-foreground">{tt.engineErrorTitle}</span>
      </div>
      {quota && <p className="font-prose text-[14px] leading-snug text-foreground">{tt.engineErrorQuota}</p>}
      <code className="font-ui text-[11px] text-muted-foreground break-words whitespace-pre-wrap select-text">{error}</code>
      <div className="flex flex-wrap items-center gap-2">
        {quota && (
          <button type="button" onClick={onChangeModel} className={button}>
            <Cpu className="w-3.5 h-3.5" />
            <span>{tt.engineErrorChangeModel}</span>
          </button>
        )}
        <button type="button" onClick={onRetry} disabled={retrying} className={button}>
          {retrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          <span>{retrying ? tt.engineErrorRetrying : tt.engineErrorRetry}</span>
        </button>
      </div>
    </div>
  );
}
