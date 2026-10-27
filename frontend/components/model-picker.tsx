"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Cpu, Loader2, Search } from "lucide-react";
import type { EffortLevel, EngineKind, ModelOption } from "@/lib/types";
import { getModels, isAbortError } from "@/lib/api";
import {
  EFFORT_LEVELS,
  effortVariants,
  familyDefaultId,
  filterFamilies,
  groupModelFamilies,
  modelTriggerParts,
  pickerNav,
  pinnedEffort,
  type ModelChoice,
  type ModelFamily,
} from "@/lib/model-choice";
import { computePopoverPosition, type PopoverPosition } from "@/lib/popover-position";
import { OPEN_MODEL_PICKER_EVENT, registerCommandTarget } from "@/lib/command-events";
import { useLocale } from "./locale-provider";

interface ModelPickerProps {
  engine: EngineKind;
  value: ModelChoice;
  /** Strong-slot model, marked as "default" in the list. */
  defaultModel?: string;
  onChange: (choice: ModelChoice) => void;
  /** Preferred panel side: "up" for the bottom composer dock, "down" for headers (flips when there is no room). */
  placement?: "up" | "down";
  disabled?: boolean;
  busy?: boolean;
  /** Render the effort control inline next to the chip (composer dock) instead of inside the panel. */
  inlineEffort?: boolean;
  /** Composer pill: quiet rounded trigger with only the model label (effort lives in its own menu). */
  pill?: boolean;
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
          className={`flex-1 px-2 py-0.5 rounded transition-colors cursor-pointer disabled:cursor-not-allowed focus-visible:border-foreground ${
            value === e ? "bg-accent text-foreground border border-border" : "text-muted-foreground hover:text-foreground border border-transparent"
          }`}
        >
          {t.effortName(e)}
        </button>
      ))}
    </div>
  );
}

const PANEL_WIDTH = 400;
const SEARCH_MIN_FAMILIES = 6;

/** One list row: the "auto" entry, a model family, or the current custom id. */
type PickerRow =
  | { kind: "auto" }
  | { kind: "family"; family: ModelFamily }
  | { kind: "custom"; id: string };

const cellCount = (row: PickerRow) => (row.kind === "family" ? 1 + effortVariants(row.family).length : 1);

/**
 * Model + effort chip. The model list comes from GET /api/setup/models?engine=…
 * (fetched once per engine, on first open) and is grouped by family: one row per
 * model with inline effort chips. The panel is portalled to <body> and placed with
 * fixed coordinates so it never leaves the viewport (bottom sheet below 640px).
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
  pill = false,
  className = "",
}: ModelPickerProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const loadedEngineRef = useRef<EngineKind | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // ⌘K (Settings → Teclado `modelPicker`): one visible, enabled picker opens.
  useEffect(
    () =>
      registerCommandTarget(OPEN_MODEL_PICKER_EVENT, {
        run: () => setOpen(true),
        eligible: () => !disabledRef.current && !!rootRef.current && rootRef.current.offsetParent !== null,
        claims: () => !!rootRef.current?.contains(document.activeElement) || !!panelRef.current?.contains(document.activeElement),
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

  const options = useMemo(() => models ?? [], [models]);
  const families = useMemo(() => groupModelFamilies(options), [options]);
  const showSearch = families.length > SEARCH_MIN_FAMILIES;
  const visibleFamilies = useMemo(() => filterFamilies(families, showSearch ? query : ""), [families, query, showSearch]);
  const currentId = value.model.trim() || "auto";
  const pinned = pinnedEffort(currentId);
  const isCustom = currentId !== "auto" && !families.some((f) => f.variants.some((v) => v.id === currentId));
  const defaultId = (defaultModel || "auto").trim() || "auto";

  const rows: PickerRow[] = useMemo(() => {
    const out: PickerRow[] = [];
    if (!query.trim()) out.push({ kind: "auto" });
    for (const family of visibleFamilies) out.push({ kind: "family", family });
    if (isCustom && models !== null && !query.trim()) out.push({ kind: "custom", id: currentId });
    return out;
  }, [visibleFamilies, isCustom, currentId, models, query]);

  const trigger = modelTriggerParts(currentId, options, "auto", value.effort);
  const showTriggerEffort = !pill && (!inlineEffort || pinned !== null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setCustomOpen(false);
    setQuery("");
    setPos(null);
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const pickModel = (id: string) => {
    onChange({ ...value, model: id });
    close(true);
  };
  const pickEffort = (effort: EffortLevel) => onChange({ ...value, effort });

  // ---- placement -----------------------------------------------------------
  const reposition = useCallback(() => {
    const btn = triggerRef.current;
    const panel = panelRef.current;
    if (!btn || !panel) return;
    const list = listRef.current;
    const natural = list ? panel.offsetHeight - list.clientHeight + list.scrollHeight : panel.scrollHeight;
    setPos(
      computePopoverPosition({
        trigger: btn.getBoundingClientRect(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        width: PANEL_WIDTH,
        contentHeight: natural,
        prefer: placement,
        maxHeightCap: 560,
      }),
    );
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onWin = () => reposition();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onWin) : null;
    if (ro && listRef.current?.firstElementChild) ro.observe(listRef.current.firstElementChild);
    if (ro && triggerRef.current) ro.observe(triggerRef.current);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
      ro?.disconnect();
    };
  }, [open, reposition, rows.length, loading, customOpen, loadError]);

  // ---- click outside ---------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // ---- initial focus -----------------------------------------------------------
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedOnceRef.current = false;
      return;
    }
    if (focusedOnceRef.current || !pos || loading) return;
    focusedOnceRef.current = true;
    if (showSearch) {
      searchRef.current?.focus();
      // Still bring the selected row into view.
      panelRef.current?.querySelector<HTMLElement>("[data-selected-cell]")?.scrollIntoView({ block: "nearest" });
    } else {
      (panelRef.current?.querySelector<HTMLElement>("[data-selected-cell]") ?? panelRef.current?.querySelector<HTMLElement>("[data-cell]"))?.focus();
    }
  }, [open, pos, loading, showSearch]);

  // ---- keyboard ----------------------------------------------------------------
  const focusCell = (row: number, col: number) => {
    if (row < 0) {
      searchRef.current?.focus();
      return;
    }
    panelRef.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)?.focus();
  };

  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const inSearch = active === searchRef.current;
    const cell = active?.dataset?.cell;
    if (!inSearch && !cell) return;
    if (inSearch && e.key === "Enter") {
      e.preventDefault();
      const first = rows[0];
      if (first?.kind === "family") pickModel(familyDefaultId(first.family));
      else if (first?.kind === "auto") pickModel("auto");
      return;
    }
    const [r, c] = cell ? cell.split(":").map(Number) : [-1, 0];
    const next = pickerNav(rows.map(cellCount), { row: r, col: c }, e.key, showSearch);
    if (!next) return;
    if (inSearch && (e.key === "Home" || e.key === "End")) return;
    e.preventDefault();
    e.stopPropagation();
    focusCell(next.row, next.col);
  };

  // ---- render --------------------------------------------------------------------
  // Box-shadow rings are disabled globally (globals.css), so focus is a background/underline.
  const cellClass = "cursor-pointer transition-colors";
  const rowFocus = "focus:bg-border/60";

  const renderRow = (row: PickerRow, i: number) => {
    if (row.kind === "auto") {
      const selected = currentId === "auto";
      return (
        <button
          key="auto"
          type="button"
          role="option"
          aria-selected={selected}
          data-cell={`${i}:0`}
          {...(selected ? { "data-selected-cell": "" } : {})}
          onClick={() => pickModel("auto")}
          className={`${cellClass} w-full flex items-start gap-2 px-3 py-2 rounded-md text-left ${rowFocus} ${selected ? "bg-accent" : "hover:bg-accent"}`}
        >
          <span className="w-4 pt-0.5 shrink-0 text-foreground">{selected && <Check className="w-4 h-4" />}</span>
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2">
              <span className="font-prose text-[13px] font-semibold text-foreground">{t.slotModelAuto}</span>
              {defaultId === "auto" && (
                <span className="font-ui text-[10px] px-1.5 rounded border border-border text-muted-foreground">{t.modelDefaultBadge}</span>
              )}
            </span>
            <span className="block font-prose text-[12px] leading-snug text-muted-foreground mt-0.5">{t.modelAutoHint}</span>
          </span>
        </button>
      );
    }
    if (row.kind === "custom") {
      return (
        <button
          key={`custom:${row.id}`}
          type="button"
          role="option"
          aria-selected
          data-cell={`${i}:0`}
          data-selected-cell=""
          onClick={() => pickModel(row.id)}
          className={`${cellClass} w-full flex items-center gap-2 px-3 py-2 rounded-md text-left bg-accent ${rowFocus}`}
        >
          <span className="w-4 shrink-0 text-foreground">
            <Check className="w-4 h-4" />
          </span>
          <span className="font-prose text-[13px] text-foreground truncate">{t.slotModelCustom(row.id)}</span>
        </button>
      );
    }
    const { family } = row;
    const chips = effortVariants(family);
    const famSelected = family.variants.some((v) => v.id === currentId);
    const nameId = familyDefaultId(family);
    const nameIsSelectedCell = famSelected && (!chips.some((v) => v.id === currentId) || chips.length === 0);
    const isDefault = family.variants.some((v) => v.id === defaultId);
    return (
      <div
        key={family.key}
        role="group"
        aria-label={family.label}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-md ${famSelected ? "bg-accent" : "hover:bg-accent/60"}`}
      >
        <span className="w-4 shrink-0 text-foreground">{famSelected && <Check className="w-4 h-4" />}</span>
        <button
          type="button"
          role="option"
          aria-selected={famSelected}
          data-cell={`${i}:0`}
          {...(nameIsSelectedCell ? { "data-selected-cell": "" } : {})}
          onClick={() => pickModel(nameId)}
          title={nameId}
          className={`${cellClass} flex-1 min-w-0 flex items-center gap-2 -ml-2 px-2 py-1 rounded text-left ${rowFocus}`}
        >
          <span className={`font-prose text-[13px] truncate text-foreground ${famSelected ? "font-semibold" : ""}`}>{family.label}</span>
          {isDefault && <span className="shrink-0 font-ui text-[10px] px-1.5 rounded border border-border text-muted-foreground">{t.modelDefaultBadge}</span>}
        </button>
        {chips.length > 0 && (
          <span className="shrink-0 flex items-center gap-0.5 p-0.5 rounded-md border border-border bg-background" role="radiogroup" aria-label={t.slotEffort}>
            {chips.map((v, j) => {
              const sel = v.id === currentId;
              const name = t.effortName(v.effort ?? "");
              return (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={sel}
                  aria-label={t.modelPickEffort(family.label, name)}
                  title={v.id}
                  data-cell={`${i}:${j + 1}`}
                  {...(sel ? { "data-selected-cell": "" } : {})}
                  onClick={() => pickModel(v.id)}
                  className={`${cellClass} px-2 py-0.5 rounded font-ui text-[11px] capitalize ${
                    sel
                      ? "bg-foreground text-background font-semibold focus:underline underline-offset-2"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent focus:bg-border focus:text-foreground"
                  }`}
                >
                  {name}
                </button>
              );
            })}
          </span>
        )}
      </div>
    );
  };

  const sheet = pos?.mode === "sheet";
  const panelStyle: React.CSSProperties = !pos
    ? { position: "fixed", top: 0, left: 0, width: PANEL_WIDTH, visibility: "hidden" }
    : pos.mode === "sheet"
      ? { position: "fixed", left: 0, right: 0, bottom: 0, maxHeight: pos.maxHeight }
      : {
          position: "fixed",
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
          ...(pos.placement === "down" ? { top: pos.top } : { bottom: pos.bottom }),
        };

  const panel = open ? (
    <>
      {sheet && <div className="fixed inset-0 z-[60] bg-background/70" aria-hidden onMouseDown={() => close(true)} />}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.modelPickerTitle}
        onKeyDown={onPanelKeyDown}
        style={panelStyle}
        className={`z-[61] flex flex-col bg-card border border-border shadow-2xl font-ui text-[12px] ${
          sheet ? "rounded-t-xl border-b-0 pb-[env(safe-area-inset-bottom)]" : "rounded-lg"
        }`}
      >
        {sheet && <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border shrink-0" aria-hidden />}
        <div className="shrink-0 px-3 pt-3 pb-2 flex flex-col gap-2 border-b border-accent">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground uppercase tracking-wider text-[11px]">{t.slotModel}</span>
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          </div>
          {showSearch && (
            <label className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border bg-background focus-within:border-foreground">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.modelSearchPlaceholder}
                aria-label={t.modelSearchPlaceholder}
                className="flex-1 min-w-0 bg-transparent text-[13px] text-foreground placeholder-muted-foreground"
              />
            </label>
          )}
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-1.5 py-1.5" role="listbox" aria-label={t.slotModel}>
          <div className="flex flex-col gap-0.5">
            {loading && models === null && (
              <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-[12px]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t.slotModelsLoading}
              </div>
            )}
            {rows.map(renderRow)}
            {!loading && query.trim() && visibleFamilies.length === 0 && (
              <p className="px-3 py-2 text-muted-foreground text-[12px]">{t.modelNoMatch}</p>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-accent px-3 py-2 flex flex-col gap-2">
          {loadError && (
            <p className="text-warning text-[11px] leading-snug">
              {t.slotModelsFailed}: {loadError}
            </p>
          )}
          {!inlineEffort && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground uppercase tracking-wider text-[11px]">{t.slotEffort}</span>
              {pinned ? (
                <p className="text-muted-foreground text-[11px]">
                  {t.slotEffortPinned} · <span className="text-foreground">{t.effortName(pinned)}</span>
                </p>
              ) : (
                <EffortPicker value={value.effort} onChange={pickEffort} />
              )}
            </div>
          )}
          {inlineEffort && pinned && <p className="text-muted-foreground text-[11px]">{t.slotEffortPinned}</p>}
          {customOpen ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (custom.trim()) {
                  pickModel(custom.trim());
                  setCustom("");
                }
              }}
            >
              <input
                autoFocus
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder={t.slotModelOtherPlaceholder}
                aria-label={t.slotModelOther}
                className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-[12px] text-foreground placeholder-muted-foreground focus:border-foreground"
              />
              <button
                type="submit"
                className="px-2 py-1 rounded border border-border bg-accent hover:bg-border text-foreground cursor-pointer focus-visible:border-foreground"
              >
                {t.modelUseCustom}
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCustomOpen(true)}
              className="self-start text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 cursor-pointer rounded focus-visible:text-foreground"
            >
              {t.modelOtherLink}
            </button>
          )}
        </div>
      </div>
    </>
  ) : null;

  return (
    <div ref={rootRef} className={`relative flex items-center gap-2 min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-model-picker-trigger=""
        title={`${t.modelPickerTitle}: ${currentId}`}
        className={`flex items-center gap-1.5 min-w-0 max-w-[260px] px-2 py-1 border border-border hover:bg-accent text-[12px] font-ui text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 focus-visible:border-foreground ${
          pill ? "rounded-full bg-card/85 px-3 py-1.5 text-[12.5px]" : "rounded-md bg-background"
        }`}
      >
        {pill ? null : busy ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <Cpu className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate text-foreground">{trigger.name}</span>
        {showTriggerEffort && (
          <span className="shrink-0 capitalize" title={pinned ? t.slotEffortPinned : undefined}>
            · {t.effortName(trigger.effort)}
          </span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {inlineEffort && !pill && !pinned && <EffortPicker compact value={value.effort} onChange={pickEffort} disabled={disabled} />}
      {panel && typeof document !== "undefined" ? createPortal(panel, document.body) : null}
    </div>
  );
}
