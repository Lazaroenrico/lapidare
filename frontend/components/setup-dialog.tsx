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
  EffortLevel,
  EngineKind,
  HarnessConfig,
  McpServerConfig,
  ModelSlots,
  TrackConfig,
  TrackMode,
} from "@/lib/types";
import { completeSetup, getSetupStatus } from "@/lib/api";

interface SetupDialogProps {
  isOpen: boolean;
  onClose?: () => void;
  onComplete?: (config: HarnessConfig) => void;
}

const DEFAULT_VAULT_PATH = "~/Documents/StudyVault";
const DEFAULT_REPO_PATH = "";

export function SetupDialog({ isOpen, onClose, onComplete }: SetupDialogProps) {
  const {t} = useLocale();
  const [step, setStep] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Connectors detected from backend
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);

  // Step 1: Engines & Model Slots
  const [apiKey, setApiKey] = useState<string>("");
  const [slots, setSlots] = useState<ModelSlots>({
    strong: { engine: "agy", model: "gemini-2.5-pro", effort: "high" },
    fast: { engine: "agy", model: "gemini-2.5-flash", effort: "low" },
    background: { engine: "agy", model: "gemini-2.5-flash", effort: "medium" },
  });

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
          // Auto-select preferred available engine
          const hasAgy = res.connectors.some(
            (c) => c.engine === "agy" && c.available
          );
          const hasGemini = res.connectors.some(
            (c) => c.engine === "gemini" && c.available
          );

          const defaultEngine: EngineKind = hasAgy
            ? "agy"
            : hasGemini
            ? "gemini"
            : "sdk";

          setSlots({
            strong: {
              engine: defaultEngine,
              model: "gemini-2.5-pro",
              effort: "high",
            },
            fast: {
              engine: defaultEngine,
              model: "gemini-2.5-flash",
              effort: "low",
            },
            background: {
              engine: defaultEngine,
              model: "gemini-2.5-flash",
              effort: "medium",
            },
          });
        }
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
        }
      })
      .catch((err) => {
        setErrorMsg(err instanceof Error ? err.message : "Failed to load setup.");
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
        setErrorMsg("Failed to persist setup configuration.");
      }
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Error saving configuration."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-2xl bg-[#1c1c1c] border border-[#434343] rounded shadow-2xl flex flex-col max-h-[90vh] overflow-hidden text-[#e6e6e6]">
        {/* Modal Header */}
        <div className="p-4 border-b border-[#434343] flex items-center justify-between bg-[#141414]">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#e6e6e6]" />
            <span className="font-title text-base font-bold text-white tracking-wide">
              {t.setup}
            </span>
            <span className="text-xs font-ui text-[#8d8d8d] ml-2">
              Passo {step} de 4
            </span>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-[#8d8d8d] hover:text-[#e6e6e6] p-1 rounded hover:bg-[#2a2a2a] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Progress Rail */}
        <div className="grid grid-cols-4 gap-1 px-4 py-2 bg-[#141414] border-b border-[#434343] text-[10px] font-ui">
          <div
            className={`py-1 text-center rounded border ${
              step >= 1
                ? "bg-[#2a2a2a] border-[#e6e6e6] text-white"
                : "border-[#434343] text-[#8d8d8d]"
            }`}
          >
            1. Conector Google
          </div>
          <div
            className={`py-1 text-center rounded border ${
              step >= 2
                ? "bg-[#2a2a2a] border-[#e6e6e6] text-white"
                : "border-[#434343] text-[#8d8d8d]"
            }`}
          >
            2. Idioma & Vault
          </div>
          <div
            className={`py-1 text-center rounded border ${
              step >= 3
                ? "bg-[#2a2a2a] border-[#e6e6e6] text-white"
                : "border-[#434343] text-[#8d8d8d]"
            }`}
          >
            3. MCP de Conteúdo
          </div>
          <div
            className={`py-1 text-center rounded border ${
              step >= 4
                ? "bg-[#2a2a2a] border-[#e6e6e6] text-white"
                : "border-[#434343] text-[#8d8d8d]"
            }`}
          >
            4. Trilha Inicial
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 font-prose text-sm space-y-6">
          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center gap-3 text-[#8d8d8d]">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="font-ui text-xs">
                Inspecionando conectores e ambiente local...
              </p>
            </div>
          ) : (
            <>
              {errorMsg && (
                <div className="p-3 bg-red-950/40 border border-red-800 text-red-200 rounded text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* STEP 1: CONECTOR GOOGLE & SLOTS */}
              {step === 1 && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-title text-base font-bold text-white">
                      Etapa 1 — Conector do Ecossistema Google & Slots
                    </h3>
                    <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                      O harness utiliza a sua assinatura Google existente sem
                      necessidade de intermediários corporativos.
                    </p>
                  </div>

                  {/* Connectors Status Cards */}
                  <div className="space-y-2">
                    {/* Agy Stream Engine */}
                    <div className="p-3 bg-[#141414] border border-[#434343] rounded flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Terminal className="w-4 h-4 text-[#e6e6e6]" />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-ui text-xs font-semibold text-white">
                              Google Antigravity CLI (agy)
                            </span>
                            <span className="text-[9px] px-1.5 py-0.2 bg-[#2a2a2a] text-[#8d8d8d] rounded font-ui">
                              stream-json
                            </span>
                          </div>
                          <p className="text-[11px] text-[#8d8d8d]">
                            Gemini 4 Argon & Gemini 3.8 Flash nativos no terminal
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 font-ui text-[11px] text-green-400">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Detectado</span>
                      </div>
                    </div>

                    {/* Gemini ACP Engine */}
                    <div className="p-3 bg-[#141414] border border-[#434343] rounded flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Cpu className="w-4 h-4 text-[#e6e6e6]" />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-ui text-xs font-semibold text-white">
                              @google/gemini-cli (ACP)
                            </span>
                            <span className="text-[9px] px-1.5 py-0.2 bg-[#2a2a2a] text-[#8d8d8d] rounded font-ui">
                              Login with Google
                            </span>
                          </div>
                          <p className="text-[11px] text-[#8d8d8d]">
                            Google One AI Pro, AI Ultra ou Workspace Code Assist
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 font-ui text-[11px] text-[#8d8d8d]">
                        <span>Ativo</span>
                      </div>
                    </div>

                    {/* GenAI SDK fallback */}
                    <div className="p-3 bg-[#141414] border border-[#434343] rounded flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Key className="w-4 h-4 text-[#8d8d8d]" />
                          <div>
                            <span className="font-ui text-xs font-semibold text-white">
                              Google AI Studio (google-genai SDK Fallback)
                            </span>
                            <p className="text-[11px] text-[#8d8d8d]">
                              Fallback via chave de API padrão (opcional)
                            </p>
                          </div>
                        </div>
                      </div>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="GEMINI_API_KEY (opcional se agy/gemini estiver ativo)"
                        className="w-full bg-[#1c1c1c] border border-[#434343] rounded px-3 py-1.5 font-ui text-xs text-[#e6e6e6] placeholder-[#8d8d8d] mt-1"
                      />
                    </div>
                  </div>

                  {/* Model Slots & Reasoning Effort */}
                  <div className="p-3.5 bg-[#141414] border border-[#434343] rounded space-y-3">
                    <span className="font-ui text-xs font-semibold text-white block uppercase tracking-wider">
                      Alocação dos Slots de Modelo
                    </span>

                    <div className="grid grid-cols-3 gap-2 font-ui text-xs">
                      {/* Strong Slot */}
                      <div className="p-2.5 bg-[#1c1c1c] border border-[#434343] rounded flex flex-col gap-1.5">
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
                          className="bg-[#141414] border border-[#434343] rounded p-1 text-[11px] text-[#e6e6e6]"
                        >
                          <option value="agy">agy (Argon)</option>
                          <option value="gemini">gemini-cli (ACP)</option>
                          <option value="sdk">google-genai SDK</option>
                        </select>
                        <div className="flex items-center justify-between text-[10px] text-[#8d8d8d] mt-1">
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
                            className="bg-[#141414] border border-[#434343] rounded px-1 text-[10px] text-[#e6e6e6]"
                          >
                            <option value="low">low</option>
                            <option value="medium">medium</option>
                            <option value="high">high</option>
                          </select>
                        </div>
                      </div>

                      {/* Fast Slot */}
                      <div className="p-2.5 bg-[#1c1c1c] border border-[#434343] rounded flex flex-col gap-1.5">
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
                          className="bg-[#141414] border border-[#434343] rounded p-1 text-[11px] text-[#e6e6e6]"
                        >
                          <option value="agy">agy (Flash)</option>
                          <option value="gemini">gemini-cli (ACP)</option>
                          <option value="sdk">google-genai SDK</option>
                        </select>
                      </div>

                      {/* Background Slot */}
                      <div className="p-2.5 bg-[#1c1c1c] border border-[#434343] rounded flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-white">
                            Background
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
                          className="bg-[#141414] border border-[#434343] rounded p-1 text-[11px] text-[#e6e6e6]"
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

              {/* STEP 2: IDIOMA & VAULT OBSIDIAN */}
              {step === 2 && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-title text-base font-bold text-white">
                      Etapa 2 — Idioma & Pasta do Vault (UI ⇄ Vault)
                    </h3>
                    <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                      Sincronização bidirecional completa: edite notas ou desenhos no
                      Obsidian ou na UI sem atrito.
                    </p>
                  </div>

                  {/* Language Selection */}
                  <div className="p-3.5 bg-[#141414] border border-[#434343] rounded space-y-2">
                    <label className="font-ui text-xs font-semibold text-white flex items-center gap-2">
                      <Globe className="w-3.5 h-3.5 text-[#8d8d8d]" />
                      Idioma Padrão da Plataforma e das Aulas
                    </label>
                    <div className="grid grid-cols-2 gap-2 font-ui text-xs">
                      <button
                        type="button"
                        onClick={() => setLanguage("pt-br")}
                        className={`p-2.5 rounded border text-left transition-colors cursor-pointer ${
                          language === "pt-br"
                            ? "bg-[#2a2a2a] border-[#e6e6e6] text-white"
                            : "bg-[#1c1c1c] border-[#434343] text-[#8d8d8d] hover:text-[#e6e6e6]"
                        }`}
                      >
                        <div className="font-semibold">Português (PT-BR)</div>
                        <div className="text-[10px] text-[#8d8d8d] mt-0.5">
                          Aulas, Conceitos, Fontes, 00 Mapa.md
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setLanguage("en")}
                        className={`p-2.5 rounded border text-left transition-colors cursor-pointer ${
                          language === "en"
                            ? "bg-[#2a2a2a] border-[#e6e6e6] text-white"
                            : "bg-[#1c1c1c] border-[#434343] text-[#8d8d8d] hover:text-[#e6e6e6]"
                        }`}
                      >
                        <div className="font-semibold">English (EN)</div>
                        <div className="text-[10px] text-[#8d8d8d] mt-0.5">
                          Lessons, Concepts, Sources, 00 Map.md
                        </div>
                      </button>
                    </div>
                  </div>

                  {/* Vault Directory Path */}
                  <div className="p-3.5 bg-[#141414] border border-[#434343] rounded space-y-2.5">
                    <label className="font-ui text-xs font-semibold text-white flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 text-[#8d8d8d]" />
                      Caminho do Vault no Disco
                    </label>
                    <input
                      type="text"
                      value={vaultPath}
                      onChange={(e) => setVaultPath(e.target.value)}
                      className="w-full bg-[#1c1c1c] border border-[#434343] rounded px-3 py-2 font-ui text-xs text-[#e6e6e6]"
                    />

                    {/* Non-destructive adoption callout */}
                    <div className="p-3 bg-[#1c1c1c] border border-[#434343] rounded text-xs space-y-1">
                      <div className="flex items-center gap-1.5 text-green-400 font-ui text-[11px] font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Adoção Não-Destrutiva Ativa</span>
                      </div>
                      <p className="text-[#8d8d8d] text-[11px] leading-relaxed">
                        Seu Vault existente (incluindo todas as notas em{" "}
                        <code className="text-[#e6e6e6] font-ui">Aulas/</code> e{" "}
                        <code className="text-[#e6e6e6] font-ui">Conceitos/</code>)
                        será adotado sem que nenhum arquivo seja apagado ou
                        sobrescrito. Dados do harness são mantidos estritamente em{" "}
                        <code className="text-[#e6e6e6] font-ui">.harness/</code>.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 3: CONECTORES MCP DE CONTEÚDO */}
              {step === 3 && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-title text-base font-bold text-white">
                      Etapa 3 — Conectores MCP de Conteúdo
                    </h3>
                    <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                      Conecte servidores MCP de conteúdo para importar transcrições e
                      aulas densas diretamente para o Vault.
                    </p>
                  </div>

                  {/* Praxis MCP Toggle Card */}
                  <div className="p-3.5 bg-[#141414] border border-[#434343] rounded space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <Server className="w-4 h-4 text-[#e6e6e6]" />
                        <div>
                          <div className="font-ui text-xs font-semibold text-white">
                            Praxis AI Engineering MCP (mcp__praxis__*)
                          </div>
                          <div className="text-[11px] text-[#8d8d8d]">
                            Catálogo de aulas semanais, desafios e gabaritos
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPraxisActive((prev) => !prev)}
                        className={`px-3 py-1 rounded font-ui text-xs border cursor-pointer transition-colors ${
                          praxisActive
                            ? "bg-[#2a2a2a] border-[#e6e6e6] text-white"
                            : "bg-[#1c1c1c] border-[#434343] text-[#8d8d8d]"
                        }`}
                      >
                        {praxisActive ? "Ativado" : "Desativado"}
                      </button>
                    </div>

                    {praxisActive && (
                      <div className="space-y-1.5 pt-2 border-t border-[#434343]">
                        <label className="font-ui text-[10.5px] text-[#8d8d8d]">
                          URL SSE do Servidor Praxis MCP
                        </label>
                        <input
                          type="text"
                          value={praxisUrl}
                          onChange={(e) => setPraxisUrl(e.target.value)}
                          className="w-full bg-[#1c1c1c] border border-[#434343] rounded px-2.5 py-1.5 font-ui text-xs text-[#e6e6e6]"
                        />
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-[#8d8d8d] italic">
                    Nota: O botão &quot;↑ Import&quot; na Home usará estes servidores
                    automaticamente. Se nenhum MCP estiver ativo, ele permitirá
                    importar notas locais ou arquivos `.md`.
                  </p>
                </div>
              )}

              {/* STEP 4: TRILHA INICIAL (TRACK) */}
              {step === 4 && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-title text-base font-bold text-white">
                      Etapa 4 — Configuração da Trilha Inicial (Track)
                    </h3>
                    <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                      A trilha define a sequência pedagógica conduzida pelo Harness
                      no ritmo integrado 2:1.
                    </p>
                  </div>

                  {/* 3 Track Options */}
                  <div className="space-y-2.5">
                    {/* Option 1: Local Repo & Binary Leveling */}
                    <div
                      onClick={() => setTrackMode("repo_binary")}
                      className={`p-3.5 rounded border cursor-pointer transition-all ${
                        trackMode === "repo_binary"
                          ? "bg-[#2a2a2a] border-[#e6e6e6]"
                          : "bg-[#141414] border-[#434343] hover:border-[#8d8d8d]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Route className="w-4 h-4 text-[#e6e6e6]" />
                        <span className="font-ui text-xs font-semibold text-white">
                          Opção 1 — Repositório Local + Nivelamento Adaptativo
                        </span>
                      </div>
                      <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                        Adota a fila do seu curso local (ex.:{" "}
                        <code className="text-[#e6e6e6] font-ui">
                          00 Mapa.md / LEARNING.md
                        </code>
                        ) integrando etapas teóricas e práticas no ritmo 2:1.
                      </p>
                      {trackMode === "repo_binary" && (
                        <div className="mt-2.5 pt-2 border-t border-[#434343]">
                          <label className="font-ui text-[10.5px] text-[#8d8d8d] block mb-1">
                            Caminho do Repositório do Curso
                          </label>
                          <input
                            type="text"
                            value={trackRepoPath}
                            onChange={(e) => setTrackRepoPath(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full bg-[#1c1c1c] border border-[#434343] rounded px-2.5 py-1.5 font-ui text-xs text-[#e6e6e6]"
                          />
                        </div>
                      )}
                    </div>

                    {/* Option 2: Goal Generated Track */}
                    <div
                      onClick={() => setTrackMode("goal_generated")}
                      className={`p-3.5 rounded border cursor-pointer transition-all ${
                        trackMode === "goal_generated"
                          ? "bg-[#2a2a2a] border-[#e6e6e6]"
                          : "bg-[#141414] border-[#434343] hover:border-[#8d8d8d]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-[#e6e6e6]" />
                        <span className="font-ui text-xs font-semibold text-white">
                          Opção 2 — Trilha Gerada por Objetivo
                        </span>
                      </div>
                      <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                        Estrutura um currículo de aprendizagem sob medida baseado no
                        seu objetivo ou ementa colada.
                      </p>
                      {trackMode === "goal_generated" && (
                        <div className="mt-2.5 pt-2 border-t border-[#434343]">
                          <label className="font-ui text-[10.5px] text-[#8d8d8d] block mb-1">
                            Descrição do Objetivo / Ementa
                          </label>
                          <textarea
                            value={goalDescription}
                            onChange={(e) => setGoalDescription(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            rows={2}
                            className="w-full bg-[#1c1c1c] border border-[#434343] rounded px-2.5 py-1.5 font-ui text-xs text-[#e6e6e6] resize-none"
                          />
                        </div>
                      )}
                    </div>

                    {/* Option 3: Free Study Mode */}
                    <div
                      onClick={() => setTrackMode("free")}
                      className={`p-3.5 rounded border cursor-pointer transition-all ${
                        trackMode === "free"
                          ? "bg-[#2a2a2a] border-[#e6e6e6]"
                          : "bg-[#141414] border-[#434343] hover:border-[#8d8d8d]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <HardDrive className="w-4 h-4 text-[#e6e6e6]" />
                        <span className="font-ui text-xs font-semibold text-white">
                          Opção 3 — Sem Trilha Fixa (Modo Livre)
                        </span>
                      </div>
                      <p className="text-xs text-[#8d8d8d] mt-1 font-prose">
                        Estudo livre por tópicos avulsos ou fontes importadas. A
                        trilha pode ser ativada futuramente nas Configurações.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="p-4 border-t border-[#434343] flex items-center justify-between bg-[#141414] font-ui text-xs">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              disabled={submitting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#434343] bg-[#1c1c1c] text-[#e6e6e6] hover:bg-[#2a2a2a] cursor-pointer transition-colors"
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
              className="flex items-center gap-1.5 px-4 py-1.5 rounded border border-[#e6e6e6] bg-[#2a2a2a] text-white hover:bg-[#383838] cursor-pointer transition-colors font-medium"
            >
              <span>{t.next}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleFinishSetup}
              disabled={submitting}
              className="flex items-center gap-1.5 px-5 py-2 rounded bg-white text-black hover:bg-[#e6e6e6] cursor-pointer transition-colors font-semibold"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Salvando no Vault...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-black" />
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
