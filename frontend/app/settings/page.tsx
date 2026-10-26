"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Cpu,
  FolderOpen,
  Globe,
  HardDrive,
  Key,
  Layers,
  Loader2,
  RefreshCw,
  Route,
  Save,
  Terminal,
} from "lucide-react";
import type {
  ConnectorStatus,
  EngineKind,
  HarnessConfig,
  ModelSlots,
  TrackConfig,
  TrackMode,
} from "@/lib/types";
import { completeSetup, getSetupStatus } from "@/lib/api";
import { McpServerManager } from "@/components/mcp-server-manager";
import { AgyPermissionCard } from "@/components/agy-permission-card";
import { GithubTrackLinker } from "@/components/github-track-linker";
import { ConnectorStateBadge, ModelSlotsEditor } from "@/components/slot-editor";
import { normalizeSlots } from "@/lib/config-wire";

const DEFAULT_VAULT_PATH = "~/Documents/StudyVault";
const DEFAULT_REPO_PATH = "";

type SettingsTab = "connectors" | "vault" | "mcp" | "track";

export default function SettingsPage() {
  const {t} = useLocale();
  const [activeTab, setActiveTab] = useState<SettingsTab>("connectors");
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);

  // Form State
  const [apiKey, setApiKey] = useState<string>("");
  // Never invent model ids: the loaded config wins, otherwise `auto` (account default).
  const [slots, setSlots] = useState<ModelSlots>(() => normalizeSlots(undefined));
  const connector = (engine: EngineKind) => connectors.find((c) => c.engine === engine);
  // Session-only: engines whose slot test succeeded in this window.
  const [verifiedEngines, setVerifiedEngines] = useState<Set<EngineKind>>(new Set());
  const markVerified = (engine: EngineKind) =>
    setVerifiedEngines((prev) => (prev.has(engine) ? prev : new Set(prev).add(engine)));

  const [language, setLanguage] = useState<"pt-br" | "en">("pt-br");
  const [vaultPath, setVaultPath] = useState<string>(DEFAULT_VAULT_PATH);

  // Servidores MCP são geridos pelas rotas /api/import/mcp/servers (McpServerManager).
  const [selectedMcp, setSelectedMcp] = useState<string | null>(null);

  const [trackMode, setTrackMode] = useState<TrackMode>("free");
  const [trackRepoPath, setTrackRepoPath] = useState<string>(DEFAULT_REPO_PATH);
  const [goalDescription, setGoalDescription] = useState<string>(t.defaultGoal);

  const loadSettings = async () => {
    setLoading(true);
    setStatusMessage(null);
    try {
      const res = await getSetupStatus();
      if (res.connectors) setConnectors(res.connectors);
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
    } catch (err) {
      console.error("Failed to load settings:", err);
      setStatusMessage({
        type: "error",
        text: t.settingsLoadFailed,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  // Após vincular um repositório GitHub como Trilha, o backend já gravou
  // track.repo_path/mode: relê só a trilha para que "Salvar" não a sobrescreva.
  const refreshTrack = async () => {
    try {
      const res = await getSetupStatus();
      if (res.config?.track) {
        setTrackMode(res.config.track.mode);
        if (res.config.track.repo_path) setTrackRepoPath(res.config.track.repo_path);
      }
    } catch {
      /* O toast global já informa a falha. */
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setStatusMessage(null);

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
      // content_mcps é omitido: os servidores são salvos individualmente pelo McpServerManager.
    };

    try {
      const res = await completeSetup(finalConfig, apiKey);
      if (res.success) {
        setApiKey("");
        setStatusMessage({
          type: "success",
          text: t.settingsSaved,
        });
      } else {
        setStatusMessage({
          type: "error",
          text: t.settingsSaveFailed,
        });
      }
    } catch (err: unknown) {
      setStatusMessage({
        type: "error",
        text: err instanceof Error ? err.message : t.requestFailed,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 min-h-screen bg-background text-foreground flex flex-col font-prose overflow-y-auto">
      {/* Top Bar */}
      <header className="p-4 border-b border-border bg-background flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-card rounded transition-colors"
            title={t.backHome}
            aria-label={t.backHome}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="font-title text-lg font-bold text-foreground tracking-wide">
              {t.settings}
            </h1>
            <p className="text-[11px] font-ui text-muted-foreground">
              {t.settingsSubtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadSettings}
            disabled={loading || saving}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-card rounded border border-border cursor-pointer transition-colors"
            title={t.reloadFromServer}
            aria-label={t.reloadFromServer}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-foreground text-background font-ui text-xs font-semibold rounded hover:bg-foreground/90 cursor-pointer transition-colors shadow-xs active:scale-[0.98]"
          >
            {saving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{t.saving}</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                <span>{t.saveChanges}</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-4xl w-full mx-auto p-6 space-y-6">
        {statusMessage && (
          <div
            className={`p-3 rounded border text-xs font-ui flex items-center gap-2 ${
              statusMessage.type === "success"
                ? "bg-success/10 border-success/40 text-success"
                : "bg-danger/10 border-danger/40 text-danger"
            }`}
          >
            {statusMessage.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-success" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 text-danger" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex border-b border-border gap-2 font-ui text-xs">
          <button
            type="button"
            onClick={() => setActiveTab("connectors")}
            className={`pb-2.5 px-3 border-b-2 transition-colors cursor-pointer font-medium ${
              activeTab === "connectors"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.tabConnectors}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("vault")}
            className={`pb-2.5 px-3 border-b-2 transition-colors cursor-pointer font-medium ${
              activeTab === "vault"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.tabVault}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("mcp")}
            className={`pb-2.5 px-3 border-b-2 transition-colors cursor-pointer font-medium ${
              activeTab === "mcp"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.tabMcp}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("track")}
            className={`pb-2.5 px-3 border-b-2 transition-colors cursor-pointer font-medium ${
              activeTab === "track"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.tabTrack}
          </button>
        </div>

        {/* Tab Content */}
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="font-ui text-xs">{t.settingsLoading}</span>
          </div>
        ) : (
          <div className="space-y-6">
            {/* TAB 1: CONNECTORS & SLOTS */}
            {activeTab === "connectors" && (
              <div className="space-y-6">
                <div>
                  <h2 className="font-title text-base font-bold text-foreground">
                    {t.connectorsHeading}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t.connectorsHint}
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* agy */}
                  <div className="p-4 bg-card border border-border rounded space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Terminal className="w-4 h-4 text-foreground" />
                        <span className="font-ui text-xs font-semibold text-foreground">
                          Google Antigravity CLI (agy)
                        </span>
                      </div>
                      <ConnectorStateBadge
                        available={connector("agy")?.available}
                        verified={verifiedEngines.has("agy")}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t.agyDescription}{" "}
                      <code className="text-foreground font-ui">
                        stream-json
                      </code>
                      .
                    </p>
                  </div>

                  {/* gemini-cli */}
                  <div className="p-4 bg-card border border-border rounded space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Cpu className="w-4 h-4 text-foreground" />
                        <span className="font-ui text-xs font-semibold text-foreground">
                          @google/gemini-cli (ACP)
                        </span>
                      </div>
                      <ConnectorStateBadge
                        available={connector("gemini")?.available}
                        verified={verifiedEngines.has("gemini")}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t.geminiCliDescription}
                    </p>
                  </div>
                </div>

                {slots.strong.engine === "agy" && <AgyPermissionCard />}

                {/* API Key Fallback */}
                <div className="p-4 bg-card border border-border rounded space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Key className="w-4 h-4 text-muted-foreground" />
                      <span className="font-ui text-xs font-semibold text-foreground">
                        Google AI Studio / Vertex AI (SDK Fallback)
                      </span>
                    </div>
                    <ConnectorStateBadge
                      available={connector("sdk")?.available}
                      verified={verifiedEngines.has("sdk")}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t.apiKeyHint}{" "}
                    <code className="text-foreground font-ui">google-genai</code>.
                  </p>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={t.apiKeyPlaceholder}
                    aria-label={t.apiKeyPlaceholder}
                    className="w-full bg-background border border-border rounded px-3 py-2 font-ui text-xs text-foreground placeholder-muted-foreground"
                  />
                </div>

                {/* Model Slot Configuration */}
                <div className="p-4 bg-card border border-border rounded space-y-3">
                  <span className="font-ui text-xs font-semibold text-foreground block uppercase tracking-wider">
                    {t.slotsHeading}
                  </span>
                  <ModelSlotsEditor
                    slots={slots}
                    onChange={setSlots}
                    apiKey={apiKey}
                    onEngineVerified={markVerified}
                  />
                </div>
              </div>
            )}

            {/* TAB 2: VAULT & LANGUAGE */}
            {activeTab === "vault" && (
              <div className="space-y-6">
                <div>
                  <h2 className="font-title text-base font-bold text-foreground">
                    {t.vaultHeading}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t.vaultHint}
                  </p>
                </div>

                {/* Language Switcher */}
                <div className="p-4 bg-card border border-border rounded space-y-2.5">
                  <label className="font-ui text-xs font-semibold text-foreground flex items-center gap-2">
                    <Globe className="w-3.5 h-3.5 text-muted-foreground" />
                    {t.systemLanguage}
                  </label>
                  <div className="grid grid-cols-2 gap-3 font-ui text-xs">
                    <button
                      type="button"
                      onClick={() => setLanguage("pt-br")}
                      className={`p-3 rounded border text-left cursor-pointer transition-colors ${
                        language === "pt-br"
                          ? "bg-accent border-foreground text-foreground"
                          : "bg-background border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <div className="font-semibold">Português (PT-BR)</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        Aulas/, Conceitos/, Fontes/, 00 Mapa.md
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setLanguage("en")}
                      className={`p-3 rounded border text-left cursor-pointer transition-colors ${
                        language === "en"
                          ? "bg-accent border-foreground text-foreground"
                          : "bg-background border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <div className="font-semibold">English (EN)</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        Lessons/, Concepts/, Sources/, 00 Map.md
                      </div>
                    </button>
                  </div>
                </div>

                {/* Vault Directory */}
                <div className="p-4 bg-card border border-border rounded space-y-3">
                  <label className="font-ui text-xs font-semibold text-foreground flex items-center gap-2">
                    <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                    {t.vaultDirectory}
                  </label>
                  <input
                    type="text"
                    value={vaultPath}
                    onChange={(e) => setVaultPath(e.target.value)}
                    className="w-full bg-background border border-border rounded px-3 py-2 font-ui text-xs text-foreground"
                  />

                  {/* Folder Mapping Spec */}
                  <div className="p-3 bg-background border border-border rounded font-ui text-[11px] space-y-1">
                    <div className="text-muted-foreground uppercase text-[10px] tracking-wider mb-1">
                      {t.folderMapping}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-foreground">
                      <div>
                        {t.folderLessons} <span className="text-muted-foreground">{language === "pt-br" ? "Aulas/" : "Lessons/"}</span>
                      </div>
                      <div>
                        {t.folderConcepts}{" "}
                        <span className="text-muted-foreground">{language === "pt-br" ? "Conceitos/" : "Concepts/"}</span>
                      </div>
                      <div>
                        {t.folderSources} <span className="text-muted-foreground">{language === "pt-br" ? "Fontes/" : "Sources/"}</span>
                      </div>
                      <div>
                        {t.folderDrawings}{" "}
                        <span className="text-muted-foreground">{language === "pt-br" ? "Desenhos/" : "Drawings/"}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: CONTENT MCPS */}
            {activeTab === "mcp" && (
              <div className="space-y-6">
                <div>
                  <h2 className="font-title text-base font-bold text-foreground">
                    {t.mcpSettingsTitle}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.mcpSettingsHint}</p>
                </div>
                <McpServerManager
                  className="bg-card border border-border rounded min-h-[320px]"
                  selected={selectedMcp}
                  onSelect={setSelectedMcp}
                />
              </div>
            )}

            {/* TAB 4: TRACK CONFIGURATION */}
            {activeTab === "track" && (
              <div className="space-y-6">
                <div>
                  <h2 className="font-title text-base font-bold text-foreground">
                    {t.trackHeading}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t.trackHint}
                  </p>
                </div>

                <div className="space-y-3">
                  {/* Repo + Binary Leveling */}
                  <div
                    onClick={() => setTrackMode("repo_binary")}
                    className={`p-4 rounded border cursor-pointer transition-all ${
                      trackMode === "repo_binary"
                        ? "bg-accent border-foreground"
                        : "bg-card border-border hover:border-muted-foreground"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Route className="w-4 h-4 text-foreground" />
                      <span className="font-ui text-xs font-semibold text-foreground">
                        {t.trackOption1}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 font-prose">
                      {t.trackOption1Before}{" "}
                      <code className="text-foreground font-ui">
                        00 Mapa.md / LEARNING.md
                      </code>
                      {t.trackOption1After}
                    </p>
                    {trackMode === "repo_binary" && (
                      <div
                        className="mt-3 pt-3 border-t border-border"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <GithubTrackLinker onLinked={() => void refreshTrack()} />
                      </div>
                    )}
                    {trackMode === "repo_binary" && (
                      <div className="mt-3 pt-2.5 border-t border-border">
                        <label className="font-ui text-[10.5px] text-muted-foreground block mb-1">
                          {t.courseDirectory}
                        </label>
                        <input
                          type="text"
                          value={trackRepoPath}
                          onChange={(e) => setTrackRepoPath(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full bg-background border border-border rounded px-3 py-1.5 font-ui text-xs text-foreground"
                        />
                      </div>
                    )}
                  </div>

                  {/* Goal Generated Track */}
                  <div
                    onClick={() => setTrackMode("goal_generated")}
                    className={`p-4 rounded border cursor-pointer transition-all ${
                      trackMode === "goal_generated"
                        ? "bg-accent border-foreground"
                        : "bg-card border-border hover:border-muted-foreground"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-foreground" />
                      <span className="font-ui text-xs font-semibold text-foreground">
                        {t.trackOption2}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 font-prose">
                      {t.trackOption2Hint}
                    </p>
                    {trackMode === "goal_generated" && (
                      <div className="mt-3 pt-2.5 border-t border-border">
                        <label className="font-ui text-[10.5px] text-muted-foreground block mb-1">
                          {t.goalDescription}
                        </label>
                        <textarea
                          value={goalDescription}
                          onChange={(e) => setGoalDescription(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          rows={3}
                          className="w-full bg-background border border-border rounded px-3 py-1.5 font-ui text-xs text-foreground resize-none"
                        />
                      </div>
                    )}
                  </div>

                  {/* Free Mode */}
                  <div
                    onClick={() => setTrackMode("free")}
                    className={`p-4 rounded border cursor-pointer transition-all ${
                      trackMode === "free"
                        ? "bg-accent border-foreground"
                        : "bg-card border-border hover:border-muted-foreground"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-foreground" />
                      <span className="font-ui text-xs font-semibold text-foreground">
                        {t.trackOption3}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 font-prose">
                      {t.trackOption3Hint}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
