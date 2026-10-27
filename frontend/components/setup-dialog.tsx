"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cpu,
  FolderOpen,
  Globe,
  HardDrive,
  Key,
  Layers,
  Loader2,
  Route,
  Server,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import type {
  ConnectorStatus,
  EngineKind,
  HarnessConfig,
  McpServerConfig,
  ModelSlots,
  TrackConfig,
  TrackMode,
} from "@/lib/types";
import { completeSetup, getSetupStatus } from "@/lib/api";
import { AgyPermissionCard } from "@/components/agy-permission-card";
import { ConnectorStateBadge, ModelSlotsEditor } from "@/components/slot-editor";
import { normalizeSlots } from "@/lib/config-wire";

interface SetupDialogProps {
  isOpen: boolean;
  onClose?: () => void;
  onComplete?: (config: HarnessConfig) => void;
}

const DEFAULT_VAULT_PATH = "~/Documents/StudyVault";

// Model ids are account-specific (`agy models`): "auto" lets the engine pick its default.
const defaultSlotsFor = (engine: EngineKind): ModelSlots => normalizeSlots(undefined, engine);

type DetectedConnector = ConnectorStatus & { recommended?: boolean };
const DEFAULT_REPO_PATH = "";

export function SetupDialog({ isOpen, onClose, onComplete }: SetupDialogProps) {
  const {t} = useLocale();
  const [step, setStep] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Connectors detected from backend
  const [connectors, setConnectors] = useState<DetectedConnector[]>([]);
  const connector = (engine: EngineKind) => connectors.find((c) => c.engine === engine);
  // Session-only: engines whose slot test succeeded in this dialog.
  const [verifiedEngines, setVerifiedEngines] = useState<Set<EngineKind>>(new Set());
  const markVerified = (engine: EngineKind) =>
    setVerifiedEngines((prev) => (prev.has(engine) ? prev : new Set(prev).add(engine)));

  // Step 1: Engines & Model Slots
  const [apiKey, setApiKey] = useState<string>("");
  const [slots, setSlots] = useState<ModelSlots>(defaultSlotsFor("agy"));

  // Step 2: Language & Vault
  const [language, setLanguage] = useState<"pt-br" | "en">("pt-br");
  const [vaultPath, setVaultPath] = useState<string>(DEFAULT_VAULT_PATH);
  const [isExistingVault, setIsExistingVault] = useState<boolean>(true);

  // Step 3: Content MCPs
  const [praxisActive, setPraxisActive] = useState<boolean>(false);
  const [praxisUrl, setPraxisUrl] = useState<string>("http://127.0.0.1:8765/sse");
  const [customMcps, setCustomMcps] = useState<McpServerConfig[]>([]);

  // Step 4: Track Selection
  const [trackMode, setTrackMode] = useState<TrackMode>("free");
  const [trackRepoPath, setTrackRepoPath] = useState<string>(DEFAULT_REPO_PATH);
  const [goalDescription, setGoalDescription] = useState<string>(
    "Dominar Engenharia de IA de ponta a ponta: Transformers, RLHF, RAG e Sistemas Multi-Agente."
  );

  useEffect(() => {
    if (!isOpen) return;

    let mounted = true;
    setLoading(true);

    getSetupStatus()
      .then((res) => {
        if (!mounted) return;
        if (res.connectors && res.connectors.length > 0) {
          setConnectors(res.connectors);
          // Preselect the backend recommendation: agy > google-genai (with credentials) > gemini.
          const detected = res.connectors as DetectedConnector[];
          const recommended =
            detected.find((c) => c.recommended)?.engine ??
            (detected.some((c) => c.engine === "agy" && c.available) ? "agy" : "gemini");
          setSlots(defaultSlotsFor(recommended));
        }
        if (res.config) {
          if (res.config.language) setLanguage(res.config.language);
          if (res.config.vault_path) setVaultPath(res.config.vault_path);
          if (res.config.slots) setSlots(normalizeSlots(res.config.slots));
          if (res.config.track) {
            setTrackMode(res.config.track.mode);
            if (res.config.track.repo_path)
              setTrackRepoPath(res.config.track.repo_path);
            if (res.config.track.goal_description)
              setGoalDescription(res.config.track.goal_description);
          }
        }
      })
      .catch((err) => {
        setErrorMsg(err instanceof Error ? err.message : t.sdLoadFailed);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleFinishSetup = async () => {
    setSubmitting(true);
    setErrorMsg(null);

    const content_mcps: McpServerConfig[] = [];
    if (praxisActive) {
      content_mcps.push({
        name: "praxis",
        url: praxisUrl,
        active: true,
      });
    }
    content_mcps.push(...customMcps);

    const track: TrackConfig = {
      mode: trackMode,
      active: trackMode !== "free",
      repo_path: trackMode === "repo_binary" ? trackRepoPath : undefined,
      goal_description:
        trackMode === "goal_generated" ? goalDescription : undefined,
    };

    const finalConfig: Partial<HarnessConfig> = {
      initialized: true,
      language,
      vault_path: vaultPath,
      vault_folders: {
        aulas: language === "pt-br" ? "Aulas" : "Lessons",
        conceitos: language === "pt-br" ? "Conceitos" : "Concepts",
        fontes: language === "pt-br" ? "Fontes" : "Sources",
        desenhos: language === "pt-br" ? "Desenhos" : "Drawings",
        viz: "viz",
        templates: "Templates",
      },
      slots,
      track,
      content_mcps,
    };

    try {
      const res = await completeSetup(finalConfig, apiKey);
      if (res.success) {
        setApiKey("");
        onComplete?.(res.config);
        onClose?.();
      } else {
        setErrorMsg(t.sdPersistFailed);
      }
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : t.sdSaveError
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/75 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-2xl bg-card border border-border rounded shadow-2xl flex flex-col max-h-[90vh] overflow-hidden text-foreground">
        {/* Modal Header */}
        <div className="p-4 border-b border-border flex items-center justify-between bg-background">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-foreground" />
            <span className="font-title text-base font-bold text-foreground tracking-wide">
              {t.setup}
            </span>
            <span className="text-xs font-ui text-muted-foreground ml-2">
              {t.sdStepOf(step, 4)}
            </span>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t.close}
              title={t.close}
              className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Progress Rail */}
        <div className="grid grid-cols-4 gap-1 px-4 py-2 bg-background border-b border-border text-[10px] font-ui">
          <div
            className={`py-1 text-center rounded border ${
              step >= 1
                ? "bg-accent border-foreground text-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            {t.sdRail1}
          </div>
          <div
            className={`py-1 text-center rounded border ${
              step >= 2
                ? "bg-accent border-foreground text-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            {t.sdRail2}
          </div>
          <div
            className={`py-1 text-center rounded border ${
              step >= 3
                ? "bg-accent border-foreground text-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            {t.sdRail3}
          </div>
          <div
            className={`py-1 text-center rounded border ${
              step >= 4
                ? "bg-accent border-foreground text-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            {t.sdRail4}
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 font-prose text-sm space-y-6">
          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="font-ui text-xs">
                {t.sdInspecting}
              </p>
            </div>
          ) : (
            <>
              {errorMsg && (
                <div className="p-3 bg-danger/10 border border-danger/40 text-danger rounded text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-danger" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* STEP 1: CONECTOR GOOGLE & SLOTS */}
              {step === 1 && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-title text-base font-bold text-foreground">
                      {t.sdStep1Title}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1 font-prose">
                      {t.sdStep1Hint}
                    </p>
                  </div>

                  {/* Connectors Status Cards */}
                  <div className="space-y-2">
                    {/* Agy Stream Engine */}
                    <div className="p-3 bg-background border border-border rounded flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Terminal className="w-4 h-4 text-foreground" />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-ui text-xs font-semibold text-foreground">
                              Google Antigravity CLI (agy)
                            </span>
                            <span className="text-[9px] px-1.5 py-0.2 bg-accent text-muted-foreground rounded font-ui">
                              stream-json
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {t.sdAgyHint}
                          </p>
                        </div>
                      </div>
                      <ConnectorBadge status={connector("agy")} verified={verifiedEngines.has("agy")} t={t} />
                    </div>

                    {/* Gemini ACP Engine */}
                    <div className="p-3 bg-background border border-border rounded flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Cpu className="w-4 h-4 text-foreground" />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-ui text-xs font-semibold text-foreground">
                              @google/gemini-cli (ACP)
                            </span>
                            <span className="text-[9px] px-1.5 py-0.2 bg-accent text-muted-foreground rounded font-ui">
                              Login with Google
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {t.sdGeminiHint}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            {t.setupGeminiDeprecation}
                          </p>
                        </div>
                      </div>
                      <ConnectorBadge status={connector("gemini")} verified={verifiedEngines.has("gemini")} t={t} />
                    </div>

                    {/* GenAI SDK fallback */}
                    <div className="p-3 bg-background border border-border rounded flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Key className="w-4 h-4 text-muted-foreground" />
                          <div>
                            <span className="font-ui text-xs font-semibold text-foreground">
                              Google AI Studio (google-genai SDK Fallback)
                            </span>
                            <p className="text-[11px] text-muted-foreground">
                              {t.sdSdkHint}
                            </p>
                          </div>
                        </div>
                        <ConnectorBadge status={connector("sdk")} verified={verifiedEngines.has("sdk")} t={t} />
                      </div>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={t.sdApiKeyPlaceholder}
                        className="w-full bg-card border border-border rounded px-3 py-1.5 font-ui text-xs text-foreground placeholder-muted-foreground mt-1"
                      />
                    </div>
                  </div>

                  {slots.strong.engine === "agy" && <AgyPermissionCard />}

                  {/* Model Slots: engine, model, effort + connection test */}
                  <div className="p-3.5 bg-background border border-border rounded space-y-3">
                    <span className="font-ui text-xs font-semibold text-foreground block uppercase tracking-wider">
                      {t.sdSlotsTitle}
                    </span>
                    <ModelSlotsEditor
                      slots={slots}
                      onChange={setSlots}
                      apiKey={apiKey}
                      onEngineVerified={markVerified}
                      gridClassName="grid grid-cols-1 sm:grid-cols-3 gap-2"
                    />
                  </div>
                </div>
              )}

              {/* STEP 2: IDIOMA & VAULT OBSIDIAN */}
              {step === 2 && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-title text-base font-bold text-foreground">
                      {t.sdStep2Title}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1 font-prose">
                      {t.sdStep2Hint}
                    </p>
                  </div>

                  {/* Language Selection */}
                  <div className="p-3.5 bg-background border border-border rounded space-y-2">
                    <label className="font-ui text-xs font-semibold text-foreground flex items-center gap-2">
                      <Globe className="w-3.5 h-3.5 text-muted-foreground" />
                      {t.sdLanguageLabel}
                    </label>
                    <div className="grid grid-cols-2 gap-2 font-ui text-xs">
                      <button
                        type="button"
                        onClick={() => setLanguage("pt-br")}
                        className={`p-2.5 rounded border text-left transition-colors cursor-pointer ${
                          language === "pt-br"
                            ? "bg-accent border-foreground text-foreground"
                            : "bg-card border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <div className="font-semibold">Português (PT-BR)</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {t.sdLangPtFolders}
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setLanguage("en")}
                        className={`p-2.5 rounded border text-left transition-colors cursor-pointer ${
                          language === "en"
                            ? "bg-accent border-foreground text-foreground"
                            : "bg-card border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <div className="font-semibold">English (EN)</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {t.sdLangEnFolders}
                        </div>
                      </button>
                    </div>
                  </div>

                  {/* Vault Directory Path */}
                  <div className="p-3.5 bg-background border border-border rounded space-y-2.5">
                    <label className="font-ui text-xs font-semibold text-foreground flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                      {t.sdVaultPathLabel}
                    </label>
                    <input
                      type="text"
                      value={vaultPath}
                      onChange={(e) => setVaultPath(e.target.value)}
                      className="w-full bg-card border border-border rounded px-3 py-2 font-ui text-xs text-foreground"
                    />

                    {/* Non-destructive adoption callout */}
                    <div className="p-3 bg-card border border-border rounded text-xs space-y-1">
                      <div className="flex items-center gap-1.5 text-success font-ui text-[11px] font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{t.sdAdoptionTitle}</span>
                      </div>
                      <p className="text-muted-foreground text-[11px] leading-relaxed">
                        {t.sdAdoptionA}{" "}
                        <code className="text-foreground font-ui">Aulas/</code> {t.sdAnd}{" "}
                        <code className="text-foreground font-ui">Conceitos/</code>)
                        {t.sdAdoptionB}{" "}
                        <code className="text-foreground font-ui">.harness/</code>.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 3: CONECTORES MCP DE CONTEÚDO */}
              {step === 3 && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-title text-base font-bold text-foreground">
                      {t.sdStep3Title}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1 font-prose">
                      {t.sdStep3Hint}
                    </p>
                  </div>

                  {/* Praxis MCP Toggle Card */}
                  <div className="p-3.5 bg-background border border-border rounded space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <Server className="w-4 h-4 text-foreground" />
                        <div>
                          <div className="font-ui text-xs font-semibold text-foreground">
                            Praxis AI Engineering MCP (mcp__praxis__*)
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {t.sdPraxisHint}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPraxisActive((prev) => !prev)}
                        className={`px-3 py-1 rounded font-ui text-xs border cursor-pointer transition-colors ${
                          praxisActive
                            ? "bg-accent border-foreground text-foreground"
                            : "bg-card border-border text-muted-foreground"
                        }`}
                      >
                        {praxisActive ? t.sdEnabled : t.sdDisabled}
                      </button>
                    </div>

                    {praxisActive && (
                      <div className="space-y-1.5 pt-2 border-t border-border">
                        <label className="font-ui text-[10.5px] text-muted-foreground">
                          {t.sdPraxisUrl}
                        </label>
                        <input
                          type="text"
                          value={praxisUrl}
                          onChange={(e) => setPraxisUrl(e.target.value)}
                          className="w-full bg-card border border-border rounded px-2.5 py-1.5 font-ui text-xs text-foreground"
                        />
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground italic">
                    {t.sdImportNote}
                  </p>
                </div>
              )}

              {/* STEP 4: TRILHA INICIAL (TRACK) */}
              {step === 4 && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-title text-base font-bold text-foreground">
                      {t.sdStep4Title}
                    </h3>
                    <p className="font-ui text-[11px] text-muted-foreground mt-1">
                      {t.sdStep4Optional}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 font-prose">
                      {t.sdStep4Hint}
                    </p>
                  </div>

                  {/* Track options — "Livre" first and default: the graph is the base, the track is an optional layer */}
                  <div className="space-y-2.5">
                    <div
                      onClick={() => setTrackMode("free")}
                      className={`p-3.5 rounded border cursor-pointer transition-all ${
                        trackMode === "free"
                          ? "bg-accent border-foreground"
                          : "bg-background border-border hover:border-muted-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <HardDrive className="w-4 h-4 text-foreground" />
                        <span className="font-ui text-xs font-semibold text-foreground">
                          {t.sdOption3}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 font-prose">
                        {t.sdOption3Hint}
                      </p>
                    </div>

                    {/* Option 1: Local Repo & Binary Leveling */}
                    <div
                      onClick={() => setTrackMode("repo_binary")}
                      className={`p-3.5 rounded border cursor-pointer transition-all ${
                        trackMode === "repo_binary"
                          ? "bg-accent border-foreground"
                          : "bg-background border-border hover:border-muted-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Route className="w-4 h-4 text-foreground" />
                        <span className="font-ui text-xs font-semibold text-foreground">
                          {t.sdOption1}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 font-prose">
                        {t.sdOption1HintA}{" "}
                        <code className="text-foreground font-ui">
                          00 Mapa.md / LEARNING.md
                        </code>
                        {t.sdOption1HintB}
                      </p>
                      {trackMode === "repo_binary" && (
                        <div className="mt-2.5 pt-2 border-t border-border">
                          <label className="font-ui text-[10.5px] text-muted-foreground block mb-1">
                            {t.sdRepoPathLabel}
                          </label>
                          <input
                            type="text"
                            value={trackRepoPath}
                            onChange={(e) => setTrackRepoPath(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full bg-card border border-border rounded px-2.5 py-1.5 font-ui text-xs text-foreground"
                          />
                        </div>
                      )}
                    </div>

                    {/* Option 2: Goal Generated Track */}
                    <div
                      onClick={() => setTrackMode("goal_generated")}
                      className={`p-3.5 rounded border cursor-pointer transition-all ${
                        trackMode === "goal_generated"
                          ? "bg-accent border-foreground"
                          : "bg-background border-border hover:border-muted-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-foreground" />
                        <span className="font-ui text-xs font-semibold text-foreground">
                          {t.sdOption2}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 font-prose">
                        {t.sdOption2Hint}
                      </p>
                      {trackMode === "goal_generated" && (
                        <div className="mt-2.5 pt-2 border-t border-border">
                          <label className="font-ui text-[10.5px] text-muted-foreground block mb-1">
                            {t.sdGoalLabel}
                          </label>
                          <textarea
                            value={goalDescription}
                            onChange={(e) => setGoalDescription(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            rows={2}
                            className="w-full bg-card border border-border rounded px-2.5 py-1.5 font-ui text-xs text-foreground resize-none"
                          />
                        </div>
                      )}
                    </div>

                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="p-4 border-t border-border flex items-center justify-between bg-background font-ui text-xs">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              disabled={submitting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border bg-card text-foreground hover:bg-accent cursor-pointer transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>{t.back}</span>
            </button>
          ) : (
            <div />
          )}

          {step < 4 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded border border-foreground bg-accent text-foreground hover:bg-border cursor-pointer transition-colors font-medium"
            >
              <span>{t.next}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleFinishSetup}
              disabled={submitting}
              className="flex items-center gap-1.5 px-5 py-2 rounded bg-foreground text-background hover:bg-foreground/90 cursor-pointer transition-colors font-semibold"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t.sdSavingToVault}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-background" />
                  <span>{t.finish}</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectorBadge({
  status,
  verified,
  t,
}: {
  status?: DetectedConnector;
  verified: boolean;
  t: ReturnType<typeof useLocale>["t"];
}) {
  return (
    <div className="flex items-center gap-1.5 font-ui text-[11px] shrink-0">
      {status?.recommended && (
        <span className="px-1.5 bg-accent border border-border text-foreground rounded">
          {t.setupRecommended}
        </span>
      )}
      <ConnectorStateBadge available={status?.available} verified={verified} />
    </div>
  );
}
