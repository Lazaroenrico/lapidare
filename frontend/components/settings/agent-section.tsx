"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { getAgentSettings, putAgentSettings } from "@/lib/settings-api";
import {
  AGENT_TOOL_IDS,
  agentSettingsErrors,
  MIN_COMPACTION_TOKENS,
  MIN_EXTRACTION_CHUNK_TOKENS,
  type AgentSettings,
} from "@/lib/settings-wire";
import { formatTokens, settingsText } from "@/lib/settings-i18n";
import { useLocale } from "@/components/locale-provider";
import { useEventSubscription } from "@/components/server-events";
import { buttonClass, Card, InlineStatus, SectionHeader, Switch } from "./ui";
import { PromptEditor } from "./prompt-editor";

const COMPACTION_SLIDER_MAX = 1_000_000;

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  step,
  error,
  onChange,
  slider,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  step: number;
  error: string | null;
  onChange: (next: number) => void;
  slider?: { max: number };
}) {
  const { locale } = useLocale();
  const s = settingsText(locale);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="font-ui text-xs font-semibold text-foreground">
          {label}
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id={id}
            type="number"
            min={min}
            step={step}
            value={Number.isFinite(value) ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
            aria-invalid={!!error}
            className={`w-32 bg-background border rounded px-2 py-1 font-ui text-xs text-foreground text-right tabular-nums ${
              error ? "border-danger" : "border-border"
            }`}
          />
          <span className="font-ui text-[11px] text-muted-foreground">{s.tokens}</span>
        </div>
      </div>
      {slider && (
        <input
          type="range"
          min={min}
          max={slider.max}
          step={step}
          value={Number.isFinite(value) ? Math.min(value, slider.max) : min}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className="w-full accent-foreground cursor-pointer"
        />
      )}
      <p className={`font-ui text-[11px] ${error ? "text-danger" : "text-muted-foreground"}`}>{error ?? hint}</p>
    </div>
  );
}

/** Settings → Agente: tool toggles, compaction, extraction batch and the prompt editor. */
export function AgentSection() {
  const { locale } = useLocale();
  const s = settingsText(locale);
  const [saved, setSaved] = useState<AgentSettings | null>(null);
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft);

  const load = useCallback(() => {
    getAgentSettings()
      .then((settings) => {
        setSaved(settings);
        // Do not clobber unsaved edits when another window saves.
        if (!dirtyRef.current) setDraft(settings);
      })
      .catch((err) => setStatus({ type: "error", text: err instanceof Error ? err.message : s.agentLoadFailed }));
  }, [s.agentLoadFailed]);

  useEffect(load, [load]);
  useEventSubscription("config:updated", load);

  if (!draft) {
    return (
      <div className="space-y-6">
        <SectionHeader title={s.agentHeading} hint={s.agentHint} />
        {status ? <InlineStatus status={status} /> : <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
      </div>
    );
  }

  const errors = agentSettingsErrors(draft);
  const minText = (n: number) => formatTokens(n, locale);
  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const next = await putAgentSettings(draft);
      setSaved(next);
      setDraft(next);
      setStatus({ type: "success", text: s.agentSaved });
    } catch (err) {
      setStatus({ type: "error", text: err instanceof Error ? err.message : s.agentLoadFailed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader title={s.agentHeading} hint={s.agentHint} />

      <Card>
        <span className="font-ui text-xs font-semibold text-foreground block uppercase tracking-wider">{s.toolsHeading}</span>
        <ul className="divide-y divide-border">
          {AGENT_TOOL_IDS.map((id) => {
            const [name, description] = s.tools[id];
            return (
              <li key={id} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <div className="font-ui text-xs text-foreground">{name}</div>
                  <div className="text-xs text-muted-foreground">{description}</div>
                </div>
                <Switch
                  checked={draft.tools[id]}
                  label={name}
                  onChange={(on) => setDraft({ ...draft, tools: { ...draft.tools, [id]: on } })}
                />
              </li>
            );
          })}
        </ul>
      </Card>

      <Card className="space-y-5">
        <NumberField
          id="agent-compaction"
          label={s.compaction}
          hint={s.compactionHint(minText(MIN_COMPACTION_TOKENS))}
          value={draft.compaction_tokens}
          min={MIN_COMPACTION_TOKENS}
          step={1000}
          slider={{ max: COMPACTION_SLIDER_MAX }}
          error={errors.includes("compaction") ? s.minError(minText(MIN_COMPACTION_TOKENS)) : null}
          onChange={(n) => setDraft({ ...draft, compaction_tokens: n })}
        />
        <NumberField
          id="agent-chunk"
          label={s.chunk}
          hint={s.chunkHint(minText(MIN_EXTRACTION_CHUNK_TOKENS))}
          value={draft.extraction_chunk_tokens}
          min={MIN_EXTRACTION_CHUNK_TOKENS}
          step={100}
          error={errors.includes("chunk") ? s.minError(minText(MIN_EXTRACTION_CHUNK_TOKENS)) : null}
          onChange={(n) => setDraft({ ...draft, extraction_chunk_tokens: n })}
        />
        <div className="flex items-center justify-end gap-3">
          <InlineStatus status={status} />
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || errors.length > 0 || !dirtyRef.current}
            className={buttonClass}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {s.saveAgent}
          </button>
        </div>
      </Card>

      <PromptEditor />
    </div>
  );
}
