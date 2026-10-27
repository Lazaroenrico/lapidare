"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Cpu,
  FolderOpen,
  Globe,
  Keyboard,
  Key,
  Loader2,
  Network,
  Palette,
  Plug,
  RefreshCw,
  Route,
  Save,
  Settings2,
  Terminal,
  Trash2,
} from "lucide-react";
import type {
  ConnectorStatus,
  EngineKind,
  HarnessConfig,
  ModelSlots,
} from "@/lib/types";
import { completeSetup, getSetupStatus } from "@/lib/api";
import { McpServerManager } from "@/components/mcp-server-manager";
import { AgyPermissionCard } from "@/components/agy-permission-card";
import { ConnectorStateBadge, ModelSlotsEditor } from "@/components/slot-editor";
import { openSetup } from "@/components/setup-gate";
import { NavDrawerButton } from "@/components/nav-drawer";
import { AgentSection } from "@/components/settings/agent-section";
import { GraphSection } from "@/components/settings/graph-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { KeyboardSection } from "@/components/settings/keyboard-section";
import { TracksSection } from "@/components/settings/tracks-section";
import { buttonClass, SectionHeader } from "@/components/settings/ui";
import { SessionTrashList, useSessionTrash } from "@/components/session-trash";
import { normalizeSlots } from "@/lib/config-wire";
import { trashText } from "@/lib/session-trash";
import { settingsText } from "@/lib/settings-i18n";
import { tracksText } from "@/lib/tracks-i18n";

const DEFAULT_VAULT_PATH = "~/Documents/StudyVault";
const SECTIONS = ["connectors", "tracks", "agent", "graph", "appearance", "keyboard", "general"] as const;
type SettingsSection = (typeof SECTIONS)[number];

const SECTION_ICONS: Record<SettingsSection, React.ComponentType<{ className?: string }>> = {
  connectors: Plug,
  tracks: Route,
  agent: Bot,
  graph: Network,
  appearance: Palette,
  keyboard: Keyboard,
  general: Settings2,
};

/** Sections whose fields are saved by the header "Save" (POST /api/setup/complete). */
const SETUP_SECTIONS = new Set<SettingsSection>(["connectors", "general"]);

const isSection = (value: string): value is SettingsSection => (SECTIONS as readonly string[]).includes(value);

export default function SettingsPage() {
  const {t, locale} = useLocale();
  const s = settingsText(locale);
  const navLabel = (section: SettingsSection) => (section === "tracks" ? tracksText(locale).navTracks : s.nav[section]);
  const [activeSection, setActiveSection] = useState<SettingsSection>("connectors");
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

  // Deep link: /settings#keyboard opens that section (the `?` cheat sheet links there).
  useEffect(() => {
    const fromHash = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (isSection(hash)) setActiveSection(hash);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const selectSection = (section: SettingsSection) => {
    setActiveSection(section);
    try {
      window.history.replaceState(null, "", `#${section}`);
    } catch {
      /* History API unavailable: the section still switches. */
    }
  };

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

  const handleSave = async () => {
    setSaving(true);
    setStatusMessage(null);

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
      // track is omitted: tracks are managed by Settings → Trilhas (/api/tracks).
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

  const showSetupSave = SETUP_SECTIONS.has(activeSection);

  return (
    <div className="flex-1 min-h-screen bg-background text-foreground flex flex-col font-prose overflow-y-auto">
      {/* Top Bar */}
      <header className="p-4 max-sm:px-3 max-sm:py-3 border-b border-border bg-background flex items-center justify-between gap-3 sticky top-0 z-20">
        <div className="flex items-center gap-3 max-sm:gap-1.5 min-w-0">
          <NavDrawerButton />
          <Link
            href="/"
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-card rounded transition-colors shrink-0"
            title={t.backHome}
            aria-label={t.backHome}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="font-title text-lg max-sm:text-base font-bold text-foreground tracking-wide truncate">
              {t.settings}
            </h1>
            <p className="text-[11px] font-ui text-muted-foreground max-sm:hidden">
              {t.settingsSubtitle}
            </p>
          </div>
        </div>

        {showSetupSave && (
          <div className="flex items-center gap-2 shrink-0">
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
              className="flex items-center gap-1.5 px-4 max-sm:px-3 py-1.5 whitespace-nowrap bg-foreground text-background font-ui text-xs font-semibold rounded hover:bg-foreground/90 cursor-pointer transition-colors shadow-xs active:scale-[0.98]"
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
        )}
      </header>

      <div className="max-w-6xl w-full mx-auto p-4 md:p-6 flex flex-col md:flex-row gap-6">
        {/* Side navigation */}
        <nav aria-label={s.navLabel} className="md:w-48 shrink-0">
          <ul className="flex md:flex-col gap-1 overflow-x-auto md:sticky md:top-24 font-ui text-xs">
            {SECTIONS.map((section) => {
              const Icon = SECTION_ICONS[section];
              const active = section === activeSection;
              return (
                <li key={section}>
                  <button
                    type="button"
                    onClick={() => selectSection(section)}
                    aria-current={active ? "page" : undefined}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded border transition-colors cursor-pointer whitespace-nowrap ${
                      active
                        ? "bg-accent border-border text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:bg-card"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    {navLabel(section)}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex-1 min-w-0 space-y-6">
          {showSetupSave && statusMessage && (
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

          {activeSection === "tracks" && <TracksSection />}
          {activeSection === "agent" && <AgentSection />}
          {activeSection === "graph" && <GraphSection />}
          {activeSection === "appearance" && <AppearanceSection />}
          {activeSection === "keyboard" && <KeyboardSection />}

          {showSetupSave && loading && (
            <div className="py-20 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
              <span className="font-ui text-xs">{t.settingsLoading}</span>
            </div>
          )}

          {/* 1. CONNECTORS, SLOTS, AGY PERMISSION, CONTENT MCPS */}
          {activeSection === "connectors" && !loading && (
            <div className="space-y-6">
              <SectionHeader title={t.connectorsHeading} hint={t.connectorsHint} />

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

              {/* Content MCP servers (saved individually by the manager) */}
              <div className="space-y-3">
                <SectionHeader title={t.mcpSettingsTitle} hint={t.mcpSettingsHint} />
                <McpServerManager
                  className="bg-card border border-border rounded min-h-[320px]"
                  selected={selectedMcp}
                  onSelect={setSelectedMcp}
                />
              </div>
            </div>
          )}

          {/* GENERAL: LANGUAGE, VAULT PATH (read-only). Tracks live in their own section. */}
          {activeSection === "general" && !loading && (
            <div className="space-y-6">
              <SectionHeader title={s.generalHeading} hint={s.generalHint} />

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
                    aria-pressed={language === "pt-br"}
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
                    aria-pressed={language === "en"}
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
                <p className="font-ui text-[11px] text-muted-foreground">{s.saveSectionHint}</p>
              </div>

              {/* Vault Directory (read-only; switching Vaults goes through the Setup) */}
              <div className="p-4 bg-card border border-border rounded space-y-3">
                <label
                  htmlFor="settings-vault-path"
                  className="font-ui text-xs font-semibold text-foreground flex items-center gap-2"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                  {s.vaultPath}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="settings-vault-path"
                    type="text"
                    value={vaultPath}
                    readOnly
                    className="flex-1 min-w-0 bg-background border border-border rounded px-3 py-2 font-ui text-xs text-muted-foreground"
                  />
                  <button type="button" onClick={openSetup} className={`${buttonClass} shrink-0`}>
                    {s.openSetup}
                  </button>
                </div>
                <p className="font-ui text-[11px] text-muted-foreground">{s.vaultPathHint}</p>
              </div>

              <TrashCard />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Settings → Geral: the same session trash the sidebar opens (restore stays on this page). */
function TrashCard() {
  const { locale } = useLocale();
  const tt = trashText(locale);
  const trash = useSessionTrash();
  return (
    <div className="p-4 bg-card border border-border rounded space-y-3">
      <div>
        <h3 className="font-ui text-xs font-semibold text-foreground flex items-center gap-2">
          <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
          {tt.heading}
          {trash.entries.length > 0 && (
            <span className="text-muted-foreground font-normal">({trash.entries.length})</span>
          )}
        </h3>
        <p className="font-ui text-[11px] text-muted-foreground mt-1">{tt.hint}</p>
      </div>
      <SessionTrashList entries={trash.entries} loading={trash.loading} refresh={trash.refresh} />
    </div>
  );
}
