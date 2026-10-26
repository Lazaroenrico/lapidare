"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Play, X } from "lucide-react";
import type {
  EffortLevel,
  EngineKind,
  ModelCatalog,
  ModelOption,
  ModelSlotConfig,
  ModelSlots,
} from "@/lib/types";
import { getModels, isAbortError, testConnector } from "@/lib/api";
import { AUTO_MODEL, modelPinsEffort } from "@/lib/config-wire";

type T = ReturnType<typeof useLocale>["t"];
type SlotName = keyof ModelSlots;

const OTHER = "__other__";
const SLOT_NAMES: SlotName[] = ["strong", "fast", "background"];

export type CatalogState =
  | { status: "loading" }
  | { status: "ready"; data: ModelCatalog }
  | { status: "error"; error: string };

/** Model lists cached per engine for the lifetime of the editor. */
function useModelCatalogs() {
  const [catalogs, setCatalogs] = useState<Partial<Record<EngineKind, CatalogState>>>({});
  const requested = useRef(new Set<EngineKind>());

  const ensure = useCallback((engine: EngineKind) => {
    if (requested.current.has(engine)) return;
    requested.current.add(engine);
    setCatalogs((prev) => ({ ...prev, [engine]: { status: "loading" } }));
    getModels(engine)
      .then((data) =>
        setCatalogs((prev) => ({ ...prev, [engine]: { status: "ready", data } })),
      )
      .catch((err: unknown) => {
        // Allow a retry the next time the engine is selected.
        requested.current.delete(engine);
        setCatalogs((prev) => ({
          ...prev,
          [engine]: { status: "error", error: err instanceof Error ? err.message : String(err) },
        }));
      });
  }, []);

  return { catalogs, ensure };
}

interface ModelSlotsEditorProps {
  slots: ModelSlots;
  onChange: (slots: ModelSlots) => void;
  /** API key typed but not yet saved — forwarded to the test (google-genai). */
  apiKey?: string;
  /** Called after a successful test, so connector cards can show "Verificado". */
  onEngineVerified?: (engine: EngineKind) => void;
  gridClassName?: string;
}

/** The three model slots (strong / fast / background), each with engine, model, effort and test. */
export function ModelSlotsEditor({
  slots,
  onChange,
  apiKey,
  onEngineVerified,
  gridClassName = "grid grid-cols-1 md:grid-cols-3 gap-3",
}: ModelSlotsEditorProps) {
  const { t } = useLocale();
  const { catalogs, ensure } = useModelCatalogs();
  const meta: Record<SlotName, { title: string; role: string }> = {
    strong: { title: t.slotStrong, role: t.slotStrongRole },
    fast: { title: t.slotFast, role: t.slotFastRole },
    background: { title: t.slotBackground, role: t.slotBackgroundRole },
  };

  return (
    <div className={`${gridClassName} font-ui text-xs`}>
      {SLOT_NAMES.map((name) => (
        <SlotEditor
          key={name}
          title={meta[name].title}
          role={meta[name].role}
          slot={slots[name]}
          onChange={(slot) => onChange({ ...slots, [name]: slot })}
          catalog={catalogs[slots[name].engine]}
          ensureCatalog={ensure}
          apiKey={apiKey}
          onVerified={onEngineVerified}
        />
      ))}
    </div>
  );
}

type TestState =
  | { status: "idle" }
  | { status: "running"; signature: string }
  | { status: "ok"; signature: string; seconds: string }
  | { status: "error"; signature: string; message: string }
  | { status: "cancelled"; signature: string };

const signatureOf = (slot: ModelSlotConfig) =>
  `${slot.engine}|${slot.model}|${modelPinsEffort(slot.model) ? "" : slot.effort ?? ""}`;

function familyOf(id: string, t: T): string {
  const head = id.toLowerCase();
  if (head.startsWith("gemini")) return "Gemini";
  if (head.startsWith("claude")) return "Claude";
  if (head.startsWith("gpt")) return "GPT-OSS";
  return t.slotGroupOther;
}

function groupModels(models: ModelOption[], t: T): [string, ModelOption[]][] {
  const groups = new Map<string, ModelOption[]>();
  for (const model of models) {
    const family = familyOf(model.id, t);
    groups.set(family, [...(groups.get(family) ?? []), model]);
  }
  return [...groups.entries()];
}

interface SlotEditorProps {
  title: string;
  role: string;
  slot: ModelSlotConfig;
  onChange: (slot: ModelSlotConfig) => void;
  catalog?: CatalogState;
  ensureCatalog: (engine: EngineKind) => void;
  apiKey?: string;
  onVerified?: (engine: EngineKind) => void;
}

export function SlotEditor({
  title,
  role,
  slot,
  onChange,
  catalog,
  ensureCatalog,
  apiKey,
  onVerified,
}: SlotEditorProps) {
  const { t } = useLocale();
  const [otherMode, setOtherMode] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => ensureCatalog(slot.engine), [slot.engine, ensureCatalog]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const models = catalog?.status === "ready" ? catalog.data.models : [];
  const groups = useMemo(() => groupModels(models, t), [models, t]);
  const model = slot.model || AUTO_MODEL;
  const known = model === AUTO_MODEL || models.some((m) => m.id === model);
  const pinned = modelPinsEffort(model);
  const signature = signatureOf({ ...slot, model });
  const current = test.status !== "idle" && test.signature === signature ? test : null;
  const running = test.status === "running";
  const verified = current?.status === "ok";

  const catalogError =
    catalog?.status === "error" ? catalog.error : catalog?.status === "ready" ? catalog.data.error : null;

  const selectModel = (value: string) => {
    if (value === OTHER) {
      setOtherMode(true);
      return;
    }
    setOtherMode(false);
    onChange({ ...slot, model: value });
  };

  const runTest = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const tested = { ...slot, model };
    const sig = signatureOf(tested);
    setTest({ status: "running", signature: sig });
    try {
      const result = await testConnector(tested, apiKey, controller.signal);
      setTest({ status: "ok", signature: sig, seconds: (result.latency_ms / 1000).toFixed(1) });
      onVerified?.(tested.engine);
    } catch (err: unknown) {
      if (isAbortError(err) || controller.signal.aborted) {
        setTest({ status: "cancelled", signature: sig });
      } else {
        setTest({ status: "error", signature: sig, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const selectClass =
    "w-full min-w-0 bg-card border border-border rounded px-1.5 py-1 text-[11px] text-foreground";

  return (
    <div
      className={`p-3 bg-background border rounded flex flex-col gap-2 min-w-0 ${
        verified ? "border-success/40" : "border-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-foreground">{title}</span>
        {verified ? (
          <span className="flex items-center gap-1 text-[10px] text-success">
            <CheckCircle2 className="w-3 h-3" />
            {t.slotVerified}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground truncate">{role}</span>
        )}
      </div>

      <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
        {t.slotEngine}
        <select
          value={slot.engine}
          onChange={(e) => {
            setOtherMode(false);
            onChange({ ...slot, engine: e.target.value as EngineKind, model: AUTO_MODEL });
          }}
          className={selectClass}
        >
          <option value="agy">agy (Antigravity)</option>
          <option value="gemini">gemini-cli (ACP)</option>
          <option value="sdk">google-genai SDK</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {t.slotModel}
          {catalog?.status === "loading" && <Loader2 className="w-3 h-3 animate-spin" aria-label={t.slotModelsLoading} />}
          {catalog?.status === "ready" && catalog.data.source === "static" && (
            <span className="truncate">· {t.slotModelsStatic}</span>
          )}
        </span>
        <select
          value={otherMode ? OTHER : model}
          onChange={(e) => selectModel(e.target.value)}
          className={selectClass}
          title={model}
        >
          <option value={AUTO_MODEL}>{t.slotModelAuto}</option>
          {!known && !otherMode && <option value={model}>{t.slotModelCustom(model)}</option>}
          {groups.map(([family, items]) => (
            <optgroup key={family} label={family}>
              {items.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label || m.id}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={OTHER}>{t.slotModelOther}</option>
        </select>
      </label>
      {otherMode && (
        <input
          type="text"
          value={model === AUTO_MODEL ? "" : model}
          onChange={(e) => onChange({ ...slot, model: e.target.value.trim() || AUTO_MODEL })}
          placeholder={t.slotModelOtherPlaceholder}
          aria-label={t.slotModelOtherPlaceholder}
          className="w-full min-w-0 bg-card border border-border rounded px-1.5 py-1 text-[11px] text-foreground placeholder-muted-foreground"
          autoFocus
        />
      )}
      {catalogError && (
        <span className="text-[10px] text-danger break-words" title={catalogError}>
          {t.slotModelsFailed}: {catalogError}
        </span>
      )}

      {pinned ? (
        <span className="text-[10px] text-muted-foreground">{t.slotEffortPinned}</span>
      ) : (
        <label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          {t.slotEffort}
          <select
            value={slot.effort || "medium"}
            onChange={(e) => onChange({ ...slot, effort: e.target.value as EffortLevel })}
            className="bg-card border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground"
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>
      )}

      <div className="flex items-center gap-2 pt-1">
        {running ? (
          <>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              {t.slotTesting}
            </span>
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="ml-auto flex items-center gap-1 px-2 py-0.5 border border-border rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              <X className="w-3 h-3" />
              {t.slotTestCancel}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void runTest()}
            title={t.slotTestHint}
            className="flex items-center gap-1 px-2 py-0.5 border border-border rounded text-[11px] text-foreground hover:bg-accent cursor-pointer"
          >
            <Play className="w-3 h-3" />
            {t.slotTest}
          </button>
        )}
      </div>
      {current?.status === "ok" && (
        <span className="text-[11px] text-success" role="status">
          {t.slotTestOk(current.seconds)}
        </span>
      )}
      {current?.status === "error" && (
        <span className="text-[11px] text-danger break-words" role="alert">
          {current.message}
        </span>
      )}
      {current?.status === "cancelled" && (
        <span className="text-[11px] text-muted-foreground">{t.slotTestCancelled}</span>
      )}
    </div>
  );
}

/** Connector card badge: a found binary is only "installed" until a slot test succeeds. */
export function ConnectorStateBadge({
  available,
  verified,
}: {
  available?: boolean;
  verified?: boolean;
}) {
  const { t } = useLocale();
  if (verified) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-ui px-1.5 py-0.5 bg-success/10 text-success border border-success/40 rounded shrink-0">
        <CheckCircle2 className="w-3 h-3" />
        {t.connectorVerified}
      </span>
    );
  }
  if (available) {
    return (
      <span className="text-[10px] font-ui px-1.5 py-0.5 bg-accent text-muted-foreground border border-border rounded shrink-0">
        {t.connectorInstalled}
      </span>
    );
  }
  return (
    <span className="text-[10px] font-ui px-1.5 py-0.5 text-muted-foreground border border-border rounded shrink-0">
      {t.setupNotFound}
    </span>
  );
}
