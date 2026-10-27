"use client";

import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, Loader2 } from "lucide-react";
import type { EffortLevel, EngineKind, ModelOption } from "@/lib/types";
import { getModels, isAbortError } from "@/lib/api";
import { EFFORT_LEVELS, modelChipLabel, pinnedEffort, type ModelChoice } from "@/lib/model-choice";
import { OPEN_MODEL_PICKER_EVENT, registerCommandTarget } from "@/lib/command-events";
import { useLocale } from "./locale-provider";

interface ModelPickerProps {
  engine: EngineKind;
  value: ModelChoice;
  /** Strong-slot model, marked as "default" in the list. */
  defaultModel?: string;
  onChange: (choice: ModelChoice) => void;
  /** Popover direction: "up" for the bottom composer dock, "down" for headers. */
  placement?: "up" | "down";
  disabled?: boolean;
  busy?: boolean;
  /** Render the effort control inline next to the chip (composer dock) instead of inside the popover. */
  inlineEffort?: boolean;
  className?: string;
}

/** low | medium | high segmented control. */
export function EffortPicker({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: EffortLevel;
  onChange: (effort: EffortLevel) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div
      className={`flex items-center gap-1 bg-background p-0.5 rounded border border-accent font-ui text-[11px] ${compact ? "" : "w-full"}`}
      role="radiogroup"
      aria-label={t.slotEffort}
      title={t.slotEffort}
    >
      {EFFORT_LEVELS.map((e) => (
        <button
          key={e}
          type="button"
          role="radio"
          disabled={disabled}
          aria-checked={value === e}
          onClick={() => onChange(e)}
          className={`flex-1 px-2 py-0.5 rounded transition-colors cursor-pointer disabled:cursor-not-allowed ${
            value === e ? "bg-accent text-foreground border border-border" : "text-muted-foreground hover:text-foreground border border-transparent"
          }`}
        >
          {t.effortName(e)}
        </button>
      ))}
    </div>
  );
}

/**
 * Model + effort chip. The model list comes from GET /api/setup/models?engine=…
 * (fetched once per engine, on first open). Effort is hidden when the model id
 * already pins it (`…-low`, `…-high`, `…-max`).
 */
export function ModelPicker({
  engine,
  value,
  defaultModel,
  onChange,
  placement = "up",
  disabled = false,
  busy = false,
  inlineEffort = false,
  className = "",
}: ModelPickerProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const loadedEngineRef = useRef<EngineKind | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // ⌘K (Settings → Teclado `modelPicker`): one visible, enabled picker opens.
  useEffect(
    () =>
      registerCommandTarget(OPEN_MODEL_PICKER_EVENT, {
        run: () => setOpen(true),
        eligible: () => !disabledRef.current && !!rootRef.current && rootRef.current.offsetParent !== null,
        claims: () => !!rootRef.current?.contains(document.activeElement),
      }),
    [],
  );

  useEffect(() => {
    if (!open || loadedEngineRef.current === engine) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    getModels(engine, controller.signal)
      .then((catalog) => {
        loadedEngineRef.current = engine;
        setModels(Array.isArray(catalog?.models) ? catalog.models : []);
        if (catalog?.error) setLoadError(catalog.error);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setModels([]);
        setLoadError(err instanceof Error ? err.message : t.slotModelsFailed);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [open, engine, t.slotModelsFailed]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const options = models ?? [];
  const pinned = pinnedEffort(value.model);
  const label = modelChipLabel(value.model, options, "auto");
  const rows: ModelOption[] = [
    { id: "auto", label: t.slotModelAuto },
    ...options.filter((o) => o.id !== "auto"),
    ...(value.model && !options.some((o) => o.id === value.model) && value.model !== "auto"
      ? [{ id: value.model, label: t.slotModelCustom(value.model) }]
      : []),
  ];

  const pickModel = (id: string) => onChange({ ...value, model: id });
  const pickEffort = (effort: EffortLevel) => onChange({ ...value, effort });

  return (
    <div ref={rootRef} className={`relative flex items-center gap-2 ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t.modelPickerTitle}
        className="flex items-center gap-1.5 max-w-[240px] px-2 py-1 rounded-md border border-border bg-background hover:bg-accent text-[11px] font-ui text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : <Cpu className="w-3 h-3 shrink-0" />}
        <span className="truncate text-foreground">{label}</span>
        {(!inlineEffort || pinned) && (
          <span className="shrink-0" title={pinned ? t.slotEffortPinned : undefined}>· {pinned ?? t.effortName(value.effort)}</span>
        )}
        <ChevronDown className="w-3 h-3 shrink-0" />
      </button>
      {inlineEffort && !pinned && <EffortPicker compact value={value.effort} onChange={pickEffort} disabled={disabled} />}

      {open && (
        <div
          role="dialog"
          aria-label={t.modelPickerTitle}
          className={`absolute ${placement === "up" ? "bottom-full mb-2" : "top-full mt-2"} left-0 w-72 bg-card border border-border rounded-lg shadow-2xl z-40 font-ui text-[11px] p-2`}
        >
          <div className="text-muted-foreground uppercase tracking-wider text-[10px] px-1 pb-1">{t.slotModel}</div>
          <div className="max-h-56 overflow-y-auto flex flex-col">
            {loading && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t.slotModelsLoading}
              </div>
            )}
            {rows.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => pickModel(m.id)}
                className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left transition-colors cursor-pointer ${
                  m.id === value.model ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <span className="truncate">{m.label || m.id}</span>
                <span className="flex items-center gap-1 shrink-0">
                  {m.id === (defaultModel || "auto") && (
                    <span className="text-[10px] px-1 rounded border border-border text-muted-foreground">{t.modelDefaultBadge}</span>
                  )}
                  {m.id === value.model && <Check className="w-3 h-3" />}
                </span>
              </button>
            ))}
          </div>
          {loadError && <p className="px-2 pt-1 text-warning">{t.slotModelsFailed}: {loadError}</p>}
          <form
            className="flex items-center gap-1 pt-2 mt-1 border-t border-accent"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.trim()) {
                pickModel(custom.trim());
                setCustom("");
              }
            }}
          >
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={t.slotModelOtherPlaceholder}
              aria-label={t.slotModelOther}
              className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-foreground placeholder-muted-foreground"
            />
            <button type="submit" className="px-2 py-1 rounded border border-border bg-accent hover:bg-border text-foreground cursor-pointer">
              ↵
            </button>
          </form>

          {!inlineEffort && (
            <>
              <div className="text-muted-foreground uppercase tracking-wider text-[10px] px-1 pt-2 pb-1">{t.slotEffort}</div>
              {pinned ? (
                <p className="px-1 text-muted-foreground">
                  {t.slotEffortPinned} ({pinned})
                </p>
              ) : (
                <EffortPicker value={value.effort} onChange={pickEffort} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
