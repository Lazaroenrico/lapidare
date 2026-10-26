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
  Server,
  Terminal,
} from "lucide-react";
import type {
  ConnectorStatus,
  EffortLevel,
  EngineKind,
  HarnessConfig,
  McpServerConfig,
  ModelSlots,
  TrackConfig,
  TrackMode,
} from "@/lib/types";
import { completeSetup, getSetupStatus } from "@/lib/api";

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
  const [slots, setSlots] = useState<ModelSlots>({
    strong: { engine: "agy", model: "gemini-2.5-pro", effort: "high" },
    fast: { engine: "agy", model: "gemini-2.5-flash", effort: "low" },
    background: { engine: "agy", model: "gemini-2.5-flash", effort: "medium" },
  });

  const [language, setLanguage] = useState<"pt-br" | "en">("pt-br");
  const [vaultPath, setVaultPath] = useState<string>(DEFAULT_VAULT_PATH);

  const [praxisActive, setPraxisActive] = useState<boolean>(false);
  const [praxisUrl, setPraxisUrl] = useState<string>("http://127.0.0.1:8765/sse");
  const [customMcps, setCustomMcps] = useState<McpServerConfig[]>([]);

  const [trackMode, setTrackMode] = useState<TrackMode>("free");
  const [trackRepoPath, setTrackRepoPath] = useState<string>(DEFAULT_REPO_PATH);
  const [goalDescription, setGoalDescription] = useState<string>(
    "Dominar Engenharia de IA de ponta a ponta: Transformers, RLHF, RAG e Sistemas Multi-Agente."
  );

  const loadSettings = async () => {
    setLoading(true);
    setStatusMessage(null);
    try {
      const res = await getSetupStatus();
      if (res.connectors) setConnectors(res.connectors);
      if (res.config) {
        if (res.config.language) setLanguage(res.config.language);
        if (res.config.vault_path) setVaultPath(res.config.vault_path);
        if (res.config.slots) setSlots(res.config.slots);
        if (res.config.track) {
          setTrackMode(res.config.track.mode);
          if (res.config.track.repo_path)
            setTrackRepoPath(res.config.track.repo_path);
          if (res.config.track.goal_description)
            setGoalDescription(res.config.track.goal_description);
        }
        if (res.config.content_mcps) {
          const praxis = res.config.content_mcps.find((m) => m.name === "praxis");
          if (praxis) {
            setPraxisActive(praxis.active);
            if (praxis.url) setPraxisUrl(praxis.url);
          }
          setCustomMcps(
            res.config.content_mcps.filter((m) => m.name !== "praxis")
          );
        }
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
      setStatusMessage({
        type: "error",
        text: "Não foi possível carregar a configuração do backend.",
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
        setStatusMessage({
          type: "success",
          text: "Configurações gravadas com sucesso no Vault (.harness/config.json).",
        });
      } else {
        setStatusMessage({
          type: "error",
          text: "Erro ao gravar as configurações.",
        });
      }
    } catch (err: unknown) {
      setStatusMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Falha na requisição.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 min-h-screen bg-[#141414] text-[#e6e6e6] flex flex-col font-prose overflow-y-auto">
      {/* Top Bar */}
      <header className="p-4 border-b border-[#434343] bg-[#141414] flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="p-1.5 text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#1c1c1c] rounded transition-colors"
            title="Voltar para a Home"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="font-title text-lg font-bold text-white tracking-wide">
              {t.settings}
            </h1>
            <p className="text-[11px] font-ui text-[#8d8d8d]">
              Conectores Google, Vault Obsidian, Trilha e Servidores MCP
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadSettings}
            disabled={loading || saving}
            className="p-2 text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#1c1c1c] rounded border border-[#434343] cursor-pointer transition-colors"
            title="Recarregar do servidor"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-white text-black font-ui text-xs font-semibold rounded hover:bg-[#e6e6e6] cursor-pointer transition-colors shadow-xs active:scale-[0.98]"
          >
            {saving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Gravando...</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                <span>Salvar Alterações</span>
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
                ? "bg-green-950/40 border-green-800 text-green-200"
                : "bg-red-950/40 border-red-800 text-red-200"
            }`}
          >
            {statusMessage.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex border-b border-[#434343] gap-2 font-ui text-xs">
          <button
            type="button"
            onClick={() => setActiveTab("connectors")}
            className={`pb-2.5 px-3 border-b-2 transition-colors cursor-pointer font-medium ${
              activeTab === "connectors"
                ? "border-white text-white"
                : "border-transparent text-[#8d8d8d] hover:text-[#e6e6e6]"
            }`}
          >
            Conectores Google & Slots
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("vault")}
            className={`pb-2.5 px-3 border-b-2 transition-colors cursor-pointer font-medium ${
              activeTab === "vault"
                ? "border-white text-white"
                : "border-transparent text-[#8d8d8d] hover:text-[#e6e6e6]"
            }`}
          >
            Idioma & Vault Obsidian
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("mcp")}
            className={`pb-2.5 px-3 border-b-2 transition-colors cursor-pointer font-medium ${
              activeTab === "mcp"
                ? "border-white text-white"
                : "border-transparent text-[#8d8d8d] hover:text-[#e6e6e6]"
            }`}
          >
            MCP de Conteúdo
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("track")}
            className={`pb-2.5 px-3 border-b-2 transition-colors cursor-pointer font-medium ${
              activeTab === "track"
                ? "border-white text-white"
                : "border-transparent text-[#8d8d8d] hover:text-[#e6e6e6]"
            }`}
          >
            Trilha de Aprendizado (Track)
          </button>
        </div>

        {/* Tab Content */}
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-3 text-[#8d8d8d]">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="font-ui text-xs">Carregando configurações...</span>
          </div>
        ) : (
          <div className="space-y-6">
            {/* TAB 1: CONNECTORS & SLOTS */}
            {activeTab === "connectors" && (
              <div className="space-y-6">
                <div>
                  <h2 className="font-title text-base font-bold text-white">
                    Conectores do Ecossistema Google
                  </h2>
                  <p className="text-xs text-[#8d8d8d] mt-0.5">
                    Utilize sua assinatura Google oficial (Google One AI Pro, AI
                    Ultra ou Workspace Code Assist) via CLI ou fallback SDK.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* agy */}
                  <div className="p-4 bg-[#1c1c1c] border border-[#434343] rounded space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Terminal className="w-4 h-4 text-white" />
                        <span className="font-ui text-xs font-semibold text-white">
                          Google Antigravity CLI (agy)
                        </span>
                      </div>
                      <span className="text-[10px] font-ui px-1.5 py-0.5 bg-green-950/40 text-green-400 border border-green-800 rounded">
                        Detectado
                      </span>
                    </div>
                    <p className="text-xs text-[#8d8d8d]">
                      Executa nativamente Gemini 4 Argon e Gemini 3.8 Flash via{" "}
                      <code className="text-[#e6e6e6] font-ui">
                        stream-json
                      </code>
                      .
                    </p>
                  </div>

                  {/* gemini-cli */}
                  <div className="p-4 bg-[#1c1c1c] border border-[#434343] rounded space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Cpu className="w-4 h-4 text-white" />
                        <span className="font-ui text-xs font-semibold text-white">
                          @google/gemini-cli (ACP)
                        </span>
                      </div>
                      <span className="text-[10px] font-ui px-1.5 py-0.5 bg-[#2a2a2a] text-[#8d8d8d] border border-[#434343] rounded">
                        Login with Google
                      </span>
                    </div>
                    <p className="text-xs text-[#8d8d8d]">
                      Conexão direta JSON-RPC bidirecional via protocolo ACP.
                    </p>
                  </div>
                </div>

                {/* API Key Fallback */}
                <div className="p-4 bg-[#1c1c1c] border border-[#434343] rounded space-y-2.5">
                  <div className="flex items-center gap-2">
                    <Key className="w-4 h-4 text-[#8d8d8d]" />
                    <span className="font-ui text-xs font-semibold text-white">
                      Google AI Studio / Vertex AI (SDK Fallback)
                    </span>
                  </div>
                  <p className="text-xs text-[#8d8d8d]">
                    Caso os CLIs não estejam instalados, você pode fornecer uma chave
                    de API para fallback direto com{" "}
                    <code className="text-[#e6e6e6] font-ui">google-genai</code>.
                  </p>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Cole sua GEMINI_API_KEY aqui..."
                    className="w-full bg-[#141414] border border-[#434343] rounded px-3 py-2 font-ui text-xs text-[#e6e6e6] placeholder-[#8d8d8d]"
                  />
                </div>

                {/* Model Slot Configuration */}
                <div className="p-4 bg-[#1c1c1c] border border-[#434343] rounded space-y-3">
                  <span className="font-ui text-xs font-semibold text-white block uppercase tracking-wider">
                    Alocação dos 3 Slots de Modelo
                  </span>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-ui text-xs">
                    {/* Strong Slot */}
                    <div className="p-3 bg-[#141414] border border-[#434343] rounded space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">
                          Strong Slot
                        </span>
                        <span className="text-[9px] text-[#8d8d8d]">
                          Teacher / Practice
                        </span>
                      </div>
                      <select
                        value={slots.strong.engine}
                        onChange={(e) =>
                          setSlots((prev) => ({
                            ...prev,
                            strong: {
                              ...prev.strong,
                              engine: e.target.value as EngineKind,
                            },
                          }))
                        }
                        className="w-full bg-[#1c1c1c] border border-[#434343] rounded p-1.5 text-xs text-[#e6e6e6]"
                      >
                        <option value="agy">agy (Argon)</option>
                        <option value="gemini">gemini-cli (ACP)</option>
                        <option value="sdk">google-genai SDK</option>
                      </select>
                      <div className="flex items-center justify-between text-[11px] text-[#8d8d8d] pt-1">
                        <span>Effort:</span>
                        <select
                          value={slots.strong.effort || "high"}
                          onChange={(e) =>
                            setSlots((prev) => ({
                              ...prev,
                              strong: {
                                ...prev.strong,
                                effort: e.target.value as EffortLevel,
                              },
                            }))
                          }
                          className="bg-[#1c1c1c] border border-[#434343] rounded px-2 py-0.5 text-xs text-[#e6e6e6]"
                        >
                          <option value="low">low</option>
                          <option value="medium">medium</option>
                          <option value="high">high</option>
                        </select>
                      </div>
                    </div>

                    {/* Fast Slot */}
                    <div className="p-3 bg-[#141414] border border-[#434343] rounded space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">
                          Fast Slot
                        </span>
                        <span className="text-[9px] text-[#8d8d8d]">
                          Títulos / Prober
                        </span>
                      </div>
                      <select
                        value={slots.fast.engine}
                        onChange={(e) =>
                          setSlots((prev) => ({
                            ...prev,
                            fast: {
                              ...prev.fast,
                              engine: e.target.value as EngineKind,
                            },
                          }))
                        }
                        className="w-full bg-[#1c1c1c] border border-[#434343] rounded p-1.5 text-xs text-[#e6e6e6]"
                      >
                        <option value="agy">agy (Flash)</option>
                        <option value="gemini">gemini-cli (ACP)</option>
                        <option value="sdk">google-genai SDK</option>
                      </select>
                    </div>

                    {/* Background Slot */}
                    <div className="p-3 bg-[#141414] border border-[#434343] rounded space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">
                          Background Slot
                        </span>
                        <span className="text-[9px] text-[#8d8d8d]">
                          LangGraph Pipelines
                        </span>
                      </div>
                      <select
                        value={slots.background.engine}
                        onChange={(e) =>
                          setSlots((prev) => ({
                            ...prev,
                            background: {
                              ...prev.background,
                              engine: e.target.value as EngineKind,
                            },
                          }))
                        }
                        className="w-full bg-[#1c1c1c] border border-[#434343] rounded p-1.5 text-xs text-[#e6e6e6]"
                      >
                        <option value="agy">agy (Flash)</option>
                        <option value="gemini">gemini-cli (ACP)</option>
                        <option value="sdk">google-genai SDK</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: VAULT & LANGUAGE */}
            {activeTab === "vault" && (
              <div className="space-y-6">
                <div>
                  <h2 className="font-title text-base font-bold text-white">
                    Sincronização com o Vault Obsidian (UI ⇄ Vault)
                  </h2>
                  <p className="text-xs text-[#8d8d8d] mt-0.5">
                    Garantia de integridade absoluta: suas notas manuscritas e
                    desenhos nunca são alterados ou sobrescritos.
                  </p>
                </div>

                {/* Language Switcher */}
                <div className="p-4 bg-[#1c1c1c] border border-[#434343] rounded space-y-2.5">
                  <label className="font-ui text-xs font-semibold text-white flex items-center gap-2">
                    <Globe className="w-3.5 h-3.5 text-[#8d8d8d]" />
                    Idioma do Sistema
                  </label>
                  <div className="grid grid-cols-2 gap-3 font-ui text-xs">
                    <button
                      type="button"
                      onClick={() => setLanguage("pt-br")}
                      className={`p-3 rounded border text-left cursor-pointer transition-colors ${
                        language === "pt-br"
                          ? "bg-[#2a2a2a] border-white text-white"
                          : "bg-[#141414] border-[#434343] text-[#8d8d8d] hover:text-[#e6e6e6]"
                      }`}
                    >
                      <div className="font-semibold">Português (PT-BR)</div>
                      <div className="text-[10px] text-[#8d8d8d] mt-0.5">
                        Aulas/, Conceitos/, Fontes/, 00 Mapa.md
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setLanguage("en")}
                      className={`p-3 rounded border text-left cursor-pointer transition-colors ${
                        language === "en"
                          ? "bg-[#2a2a2a] border-white text-white"
                          : "bg-[#141414] border-[#434343] text-[#8d8d8d] hover:text-[#e6e6e6]"
                      }`}
                    >
                      <div className="font-semibold">English (EN)</div>
                      <div className="text-[10px] text-[#8d8d8d] mt-0.5">
                        Lessons/, Concepts/, Sources/, 00 Map.md
                      </div>
                    </button>
                  </div>
                </div>

                {/* Vault Directory */}
                <div className="p-4 bg-[#1c1c1c] border border-[#434343] rounded space-y-3">
                  <label className="font-ui text-xs font-semibold text-white flex items-center gap-2">
                    <FolderOpen className="w-3.5 h-3.5 text-[#8d8d8d]" />
                    Diretório do Vault no Disco Local
                  </label>
                  <input
                    type="text"
                    value={vaultPath}
                    onChange={(e) => setVaultPath(e.target.value)}
                    className="w-full bg-[#141414] border border-[#434343] rounded px-3 py-2 font-ui text-xs text-[#e6e6e6]"
                  />

                  {/* Folder Mapping Spec */}
                  <div className="p-3 bg-[#141414] border border-[#434343] rounded font-ui text-[11px] space-y-1">
                    <div className="text-[#8d8d8d] uppercase text-[10px] tracking-wider mb-1">
                      Mapeamento de Pastas Ativo:
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[#e6e6e6]">
                      <div>
                        Aulas: <span className="text-[#8d8d8d]">Aulas/</span>
                      </div>
                      <div>
                        Conceitos:{" "}
                        <span className="text-[#8d8d8d]">Conceitos/</span>
                      </div>
                      <div>
                        Fontes: <span className="text-[#8d8d8d]">Fontes/</span>
                      </div>
                      <div>
                        Desenhos:{" "}
                        <span className="text-[#8d8d8d]">Desenhos/</span>
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
                  <h2 className="font-title text-base font-bold text-white">
                    Servidores MCP de Conteúdo
                  </h2>
                  <p className="text-xs text-[#8d8d8d] mt-0.5">
                    Permite ao botão &quot;↑ Import&quot; listar e ingerir aulas de
                    plataformas e repositórios externos.
                  </p>
                </div>

                {/* Praxis MCP */}
                <div className="p-4 bg-[#1c1c1c] border border-[#434343] rounded space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <Server className="w-4 h-4 text-white" />
                      <div>
                        <div className="font-ui text-xs font-semibold text-white">
                          Praxis AI Engineering MCP (mcp__praxis__*)
                        </div>
                        <div className="text-xs text-[#8d8d8d]">
                          Sincronização semanal de aulas, desafios e gabaritos
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPraxisActive((prev) => !prev)}
                      className={`px-3 py-1 rounded font-ui text-xs border cursor-pointer transition-colors ${
                        praxisActive
                          ? "bg-[#2a2a2a] border-white text-white"
                          : "bg-[#141414] border-[#434343] text-[#8d8d8d]"
                      }`}
                    >
                      {praxisActive ? "Ativado" : "Desativado"}
                    </button>
                  </div>

                  {praxisActive && (
                    <div className="space-y-1.5 pt-2 border-t border-[#434343]">
                      <label className="font-ui text-[10.5px] text-[#8d8d8d]">
                        Endpoint SSE do Servidor
                      </label>
                      <input
                        type="text"
                        value={praxisUrl}
                        onChange={(e) => setPraxisUrl(e.target.value)}
                        className="w-full bg-[#141414] border border-[#434343] rounded px-3 py-1.5 font-ui text-xs text-[#e6e6e6]"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 4: TRACK CONFIGURATION */}
            {activeTab === "track" && (
              <div className="space-y-6">
                <div>
                  <h2 className="font-title text-base font-bold text-white">
                    Trilha Pedagógica Conduzida (Track)
                  </h2>
                  <p className="text-xs text-[#8d8d8d] mt-0.5">
                    A Trilha vive no Setup e guia os estudos através de um chip
                    discreto na Home, conduzindo o roteiro no ritmo 2:1.
                  </p>
                </div>

                <div className="space-y-3">
                  {/* Repo + Binary Leveling */}
                  <div
                    onClick={() => setTrackMode("repo_binary")}
                    className={`p-4 rounded border cursor-pointer transition-all ${
                      trackMode === "repo_binary"
                        ? "bg-[#2a2a2a] border-white"
                        : "bg-[#1c1c1c] border-[#434343] hover:border-[#8d8d8d]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Route className="w-4 h-4 text-white" />
                      <span className="font-ui text-xs font-semibold text-white">
                        Opção 1 — Repositório Local + Nivelamento Adaptativo
                      </span>
                    </div>
                    <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                      Sincroniza com as semanas do curso e o arquivo{" "}
                      <code className="text-[#e6e6e6] font-ui">
                        00 Mapa.md / LEARNING.md
                      </code>
                      , integrando mentoria e teoria no ritmo 2:1.
                    </p>
                    {trackMode === "repo_binary" && (
                      <div className="mt-3 pt-2.5 border-t border-[#434343]">
                        <label className="font-ui text-[10.5px] text-[#8d8d8d] block mb-1">
                          Diretório do Curso / Repositório
                        </label>
                        <input
                          type="text"
                          value={trackRepoPath}
                          onChange={(e) => setTrackRepoPath(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full bg-[#141414] border border-[#434343] rounded px-3 py-1.5 font-ui text-xs text-[#e6e6e6]"
                        />
                      </div>
                    )}
                  </div>

                  {/* Goal Generated Track */}
                  <div
                    onClick={() => setTrackMode("goal_generated")}
                    className={`p-4 rounded border cursor-pointer transition-all ${
                      trackMode === "goal_generated"
                        ? "bg-[#2a2a2a] border-white"
                        : "bg-[#1c1c1c] border-[#434343] hover:border-[#8d8d8d]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-white" />
                      <span className="font-ui text-xs font-semibold text-white">
                        Opção 2 — Trilha Gerada por Objetivo
                      </span>
                    </div>
                    <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                      O Harness decompõe um objetivo complexo ou ementa colada em
                      etapas pedagógicas com pré-requisitos explícitos.
                    </p>
                    {trackMode === "goal_generated" && (
                      <div className="mt-3 pt-2.5 border-t border-[#434343]">
                        <label className="font-ui text-[10.5px] text-[#8d8d8d] block mb-1">
                          Descrição do Objetivo
                        </label>
                        <textarea
                          value={goalDescription}
                          onChange={(e) => setGoalDescription(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          rows={3}
                          className="w-full bg-[#141414] border border-[#434343] rounded px-3 py-1.5 font-ui text-xs text-[#e6e6e6] resize-none"
                        />
                      </div>
                    )}
                  </div>

                  {/* Free Mode */}
                  <div
                    onClick={() => setTrackMode("free")}
                    className={`p-4 rounded border cursor-pointer transition-all ${
                      trackMode === "free"
                        ? "bg-[#2a2a2a] border-white"
                        : "bg-[#1c1c1c] border-[#434343] hover:border-[#8d8d8d]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-white" />
                      <span className="font-ui text-xs font-semibold text-white">
                        Opção 3 — Sem Trilha Fixa (Modo Livre)
                      </span>
                    </div>
                    <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                      Estudo orientado exclusivamente por tópicos livres no
                      composer ou fontes importadas avulsas.
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
