"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RotateCcw, Save } from "lucide-react";
import { deletePrompt, listPrompts, putPrompt } from "@/lib/settings-api";
import { groupPrompts, promptLabel, type PromptSegment } from "@/lib/settings-wire";
import { settingsText } from "@/lib/settings-i18n";
import { useLocale } from "@/components/locale-provider";
import { buttonClass, Card, InlineStatus, SectionHeader, Switch } from "./ui";

type Status = { type: "success" | "error"; text: string } | null;
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

function PromptRow({ segment, onSaved }: { segment: PromptSegment; onSaved: (next: PromptSegment) => void }) {
  const { locale } = useLocale();
  const s = settingsText(locale);
  const [open, setOpen] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [draft, setDraft] = useState(segment.override ?? segment.source);
  const [enabled, setEnabled] = useState(segment.override !== null ? segment.enabled : true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  // Server state changed (save/restore here or another window): reset the editor to it.
  useEffect(() => {
    setDraft(segment.override ?? segment.source);
    setEnabled(segment.override !== null ? segment.enabled : true);
  }, [segment.override, segment.enabled, segment.source]);

  const run = async (action: () => Promise<PromptSegment>, ok: string) => {
    setBusy(true);
    setStatus(null);
    try {
      onSaved(await action());
      setStatus({ type: "success", text: ok });
    } catch (err) {
      setStatus({ type: "error", text: errorText(err, s.promptsLoadFailed) });
    } finally {
      setBusy(false);
    }
  };

  const badge =
    segment.override === null ? s.promptNoOverride : segment.enabled ? s.promptOverrideActive : s.promptOverrideOff;
  const editorId = `prompt-${segment.path.replace(/[^a-z0-9]+/gi, "-")}`;

  return (
    <li className="border border-border rounded bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={editorId}
          className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer text-foreground"
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
          <span className="font-ui text-[12.5px] truncate">{promptLabel(segment.path)}</span>
          <span className="font-ui text-[11px] text-muted-foreground truncate">{segment.path}</span>
        </button>
        <span
          className={`font-ui text-[10px] px-1.5 rounded border ${
            segment.override !== null && segment.enabled ? "border-warning/50 text-warning" : "border-border text-muted-foreground"
          }`}
        >
          {badge}
        </span>
      </div>

      {open && (
        <div id={editorId} className="px-3 pb-3 space-y-3 border-t border-border pt-3">
          <div>
            <button
              type="button"
              onClick={() => setShowOriginal((v) => !v)}
              aria-expanded={showOriginal}
              className="font-ui text-[11px] text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1"
            >
              {showOriginal ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {showOriginal ? s.promptHideOriginal : s.promptShowOriginal}
            </button>
            {showOriginal && (
              <pre
                aria-label={s.promptOriginal}
                className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap p-3 rounded border border-border bg-card font-ui text-[11px] leading-relaxed text-muted-foreground"
              >
                {segment.source}
              </pre>
            )}
          </div>

          <label className="block font-ui text-[11px] text-muted-foreground" htmlFor={`${editorId}-text`}>
            {s.promptOverride}
          </label>
          <textarea
            id={`${editorId}-text`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={12}
            spellCheck={false}
            className="w-full bg-card border border-border rounded px-3 py-2 font-ui text-[12px] leading-relaxed text-foreground resize-y"
          />

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 font-ui text-[11px] text-foreground">
              <Switch checked={enabled} onChange={setEnabled} label={s.promptEnabled} disabled={busy} />
              {s.promptEnabled}
            </label>
            <div className="ml-auto flex items-center gap-2">
              <InlineStatus status={status} />
              <button
                type="button"
                disabled={busy || segment.override === null}
                onClick={() => void run(() => deletePrompt(segment.path), s.promptRestored)}
                className={buttonClass}
              >
                <RotateCcw className="w-3 h-3" />
                {s.promptRestore}
              </button>
              <button
                type="button"
                disabled={busy || !draft.trim()}
                onClick={() => void run(() => putPrompt(segment.path, draft, enabled), s.promptSaved)}
                className={buttonClass}
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                {s.promptSave}
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/** Settings → Agente → Prompts do sistema (GET/PUT/DELETE /api/settings/prompts). */
export function PromptEditor() {
  const { locale } = useLocale();
  const s = settingsText(locale);
  const [segments, setSegments] = useState<PromptSegment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listPrompts()
      .then((list) => {
        setSegments(list);
        setError(null);
      })
      .catch((err) => setError(errorText(err, s.promptsLoadFailed)));
  }, [s.promptsLoadFailed]);

  useEffect(load, [load]);

  const replace = (next: PromptSegment) =>
    setSegments((prev) => (prev ?? []).map((seg) => (seg.path === next.path ? next : seg)));

  return (
    <div className="space-y-3">
      <SectionHeader title={s.promptsHeading} />
      <div role="note" className="flex items-start gap-2 p-3 rounded border border-warning/40 bg-warning/10 text-warning font-ui text-[11px]">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>{s.promptsWarning}</span>
      </div>
      {error && <p className="font-ui text-[11px] text-danger">{error}</p>}
      {!segments && !error && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
      {segments && segments.length === 0 && <p className="font-ui text-[11px] text-muted-foreground">{s.promptsEmpty}</p>}
      {segments &&
        groupPrompts(segments).map((group) => (
          <Card key={group.id}>
            <h3 className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">
              {s.promptGroups[group.id]} <span className="normal-case">· {group.segments.length}</span>
            </h3>
            <ul className="space-y-2">
              {group.segments.map((segment) => (
                <PromptRow key={segment.path} segment={segment} onSaved={replace} />
              ))}
            </ul>
          </Card>
        ))}
    </div>
  );
}
