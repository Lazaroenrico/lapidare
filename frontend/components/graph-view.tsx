"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Edit3,
  Link2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  Upload,
  X,
} from "lucide-react";
import type { ConceptNode, GraphSnapshot } from "@/lib/types";
import { createChat, createDrawing, getGraphSnapshot } from "@/lib/api";
import { useEventSubscription } from "./server-events";
import { GraphCanvasEngine } from "./graph-canvas";

interface GraphViewProps {
  onOpenImport?: () => void;
  className?: string;
}

export function GraphView({ onOpenImport, className = "" }: GraphViewProps) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GraphCanvasEngine | null>(null);

  // Graph Data State
  const [snapshot, setSnapshot] = useState<GraphSnapshot>({
    nodes: [],
    edges: [],
    chains: [],
  });
  const [selectedNode, setSelectedNode] = useState<ConceptNode | null>(null);

  // Chains Drawer State
  const [isChainsOpen, setIsChainsOpen] = useState<boolean>(false);
  const [chainsSearch, setChainsSearch] = useState<string>("");

  // Search in Canvas
  const [nodeSearch, setNodeSearch] = useState<string>("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Fetch Snapshot from Backend
  const loadGraph = useCallback(async () => {
    try {
      const data = await getGraphSnapshot();
      if (data && Array.isArray(data.nodes)) {
        setSnapshot(data);
        if (engineRef.current) {
          engineRef.current.setData(data.nodes, data.edges || []);
        }
      }
    } catch (err) {
      console.error("[GraphView] Failed to fetch graph snapshot:", err);
    }
  }, []);

  // Listen for realtime SSE updates (notify -> fetch)
  useEventSubscription(["graph:updated", "vault:changed"], () => {
    void loadGraph();
  });

  // Initialize Canvas Engine
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new GraphCanvasEngine(canvas, {
      onSelectNode: (node) => {
        setSelectedNode(node);
      },
      onCanvasClick: () => {
        setSelectedNode(null);
      },
    });
    engineRef.current = engine;

    void loadGraph();

    // ResizeObserver
    const container = containerRef.current;
    let resizeObserver: ResizeObserver | null = null;
    if (container) {
      resizeObserver = new ResizeObserver(() => {
        engine.resize();
      });
      resizeObserver.observe(container);
    }

    return () => {
      if (resizeObserver) resizeObserver.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, [loadGraph]);

  // When snapshot changes after engine was initialized
  useEffect(() => {
    if (engineRef.current && snapshot.nodes.length > 0) {
      engineRef.current.setData(snapshot.nodes, snapshot.edges || []);
    }
  }, [snapshot]);

  // Filtered Chains
  const filteredChains = React.useMemo(() => {
    if (!chainsSearch.trim()) return snapshot.chains;
    const q = chainsSearch.toLowerCase();
    return snapshot.chains.filter((c) => {
      const pMatch = c.premises.some((p) => p.toLowerCase().includes(q));
      const cMatch = c.conclusion.toLowerCase().includes(q);
      const fMatch = c.formula?.toLowerCase().includes(q);
      return pMatch || cMatch || fMatch;
    });
  }, [snapshot.chains, chainsSearch]);

  // Node Search Results
  const searchResults = React.useMemo(() => {
    if (!nodeSearch.trim()) return [];
    const q = nodeSearch.toLowerCase();
    return snapshot.nodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(q) ||
          n.summary?.toLowerCase().includes(q)
      )
      .slice(0, 6);
  }, [snapshot.nodes, nodeSearch]);

  // Quick Action: Open Lesson / TEACH
  const handleOpenTeach = async (node: ConceptNode) => {
    try {
      setActionLoading("teach");
      const session = await createChat({
        mode: "TEACH",
        topic: node.name,
      });
      router.push(`/chat/${session.id}`);
    } catch (err) {
      console.error("Failed to start TEACH session:", err);
    } finally {
      setActionLoading(null);
    }
  };

  // Quick Action: Practice Concept
  const handleOpenPractice = async (node: ConceptNode) => {
    try {
      setActionLoading("practice");
      const session = await createChat({
        mode: "PRACTICE",
        topic: node.name,
      });
      router.push(`/chat/${session.id}`);
    } catch (err) {
      console.error("Failed to start PRACTICE session:", err);
    } finally {
      setActionLoading(null);
    }
  };

  // Quick Action: Memory Retrieval Drawing in Excalidraw
  const handleOpenDraw = async (node: ConceptNode) => {
    try {
      setActionLoading("draw");
      const res = await createDrawing({
        title: node.name,
        concept_ids: [node.id],
        prompt: `Desenhe de memória a arquitetura, equações e fluxo de computação de "${node.name}".`,
      });
      router.push(`/draw/${res.slug}`);
    } catch (err) {
      console.error("Failed to create drawing:", err);

    } finally {
      setActionLoading(null);
    }
  };

  // Focus a specific dependency or search result
  const handleSelectDependency = (depName: string) => {
    const found = snapshot.nodes.find(
      (n) => n.name.toLowerCase() === depName.toLowerCase() || n.id === depName
    );
    if (found) {
      setSelectedNode(found);
      engineRef.current?.focusNode(found.id);
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full overflow-hidden bg-[#141414] select-none ${className}`}
    >
      {/* 2D Canvas Target */}
      <canvas ref={canvasRef} className="w-full h-full block cursor-default" />

      {/* Top Floating Action Pills Bar */}
      <div className="absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none z-10">
        {/* Left Status Pill */}
        <div className="flex items-center gap-3 bg-[#1c1c1c]/90 backdrop-blur border border-[#434343] rounded-lg px-3.5 py-1.5 shadow-lg pointer-events-auto">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#34d399]" />
            <span className="font-ui font-semibold text-xs text-[#e6e6e6]">
              Grafo de Conhecimento
            </span>
          </div>
          <span className="text-[#434343] text-xs">|</span>
          <span className="font-ui text-[11px] text-[#8d8d8d]">
            {snapshot.nodes.length} conceitos · {snapshot.edges.length} conexões ·{" "}
            {snapshot.chains.length} chains
          </span>
        </div>

        {/* Center / Right Pills: Search, Chains, Import, Excalidraw, Zoom */}
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Node Search Bar */}
          <div className="relative">
            <div className="flex items-center bg-[#1c1c1c]/90 backdrop-blur border border-[#434343] focus-within:border-[#8d8d8d] rounded-lg px-2.5 py-1 shadow-lg transition-colors">
              <Search className="w-3.5 h-3.5 text-[#8d8d8d] mr-2 shrink-0" />
              <input
                type="text"
                placeholder="⌕ Buscar conceito..."
                value={nodeSearch}
                onChange={(e) => setNodeSearch(e.target.value)}
                className="bg-transparent text-[#e6e6e6] placeholder-[#8d8d8d] text-xs font-ui w-36 sm:w-48 outline-none border-none focus:outline-none focus:ring-0"
              />
              {nodeSearch && (
                <button
                  type="button"
                  onClick={() => setNodeSearch("")}
                  className="text-[#8d8d8d] hover:text-[#e6e6e6] p-0.5"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Search Dropdown Results */}
            {searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-[#1c1c1c] border border-[#434343] rounded-lg shadow-2xl py-1 z-30">
                {searchResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelectedNode(item);
                      engineRef.current?.focusNode(item.id);
                      setNodeSearch("");
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#2a2a2a] flex items-center justify-between text-xs font-ui text-[#e6e6e6] transition-colors"
                  >
                    <span>{item.name}</span>
                    <span className="text-[10px] text-[#8d8d8d] capitalize">
                      {item.status}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ☍ Chains Button */}
          <button
            type="button"
            onClick={() => setIsChainsOpen(true)}
            className="flex items-center gap-1.5 bg-[#1c1c1c]/90 hover:bg-[#2a2a2a] active:bg-[#333333] backdrop-blur border border-[#434343] hover:border-[#8d8d8d] text-[#e6e6e6] rounded-lg px-3 py-1.5 text-xs font-ui transition-colors shadow-lg cursor-pointer"
            title="Abrir implicações lógicas A ∧ B ⟹ C"
          >
            <Link2 className="w-3.5 h-3.5 text-[#8d8d8d]" />
            <span>☍ Chains</span>
            {snapshot.chains.length > 0 && (
              <span className="bg-[#2a2a2a] text-[#8d8d8d] text-[10px] px-1.5 py-0.2 rounded-full border border-[#434343]">
                {snapshot.chains.length}
              </span>
            )}
          </button>

          {/* ↑ Import Button */}
          <button
            type="button"
            onClick={onOpenImport}
            className="flex items-center gap-1.5 bg-[#1c1c1c]/90 hover:bg-[#2a2a2a] active:bg-[#333333] backdrop-blur border border-[#434343] hover:border-[#8d8d8d] text-[#e6e6e6] rounded-lg px-3 py-1.5 text-xs font-ui transition-colors shadow-lg cursor-pointer"
            title="Importar aulas do MCP ou notas locais"
          >
            <Upload className="w-3.5 h-3.5 text-[#8d8d8d]" />
            <span>↑ Import</span>
          </button>

          {/* ✎ Excalidraw Button */}
          <button
            type="button"
            onClick={() => router.push("/draw/new")}
            className="flex items-center gap-1.5 bg-[#1c1c1c]/90 hover:bg-[#2a2a2a] active:bg-[#333333] backdrop-blur border border-[#434343] hover:border-[#8d8d8d] text-[#e6e6e6] rounded-lg px-3 py-1.5 text-xs font-ui transition-colors shadow-lg cursor-pointer"
            title="Criar novo desenho de memória no Excalidraw"
          >
            <Edit3 className="w-3.5 h-3.5 text-[#8d8d8d]" />
            <span>✎ Excalidraw</span>
          </button>

          {/* Zoom Controls */}
          <div className="flex items-center bg-[#1c1c1c]/90 backdrop-blur border border-[#434343] rounded-lg p-0.5 shadow-lg">
            <button
              type="button"
              onClick={() => engineRef.current?.zoomIn()}
              className="p-1 text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#2a2a2a] rounded transition-colors"
              title="Aproximar (+)"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.zoomOut()}
              className="p-1 text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#2a2a2a] rounded transition-colors"
              title="Afastar (-)"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.resetView()}
              className="p-1 text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#2a2a2a] rounded transition-colors"
              title="Centralizar e ajustar visão"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Contextual Node Card */}
      {selectedNode && (
        <div className="absolute top-20 right-4 w-84 bg-[#1c1c1c] border border-[#434343] rounded-xl p-4 shadow-2xl z-20 transition-all select-text font-ui animate-in fade-in slide-in-from-right-4 duration-150">
          {/* Card Header */}
          <div className="flex items-start justify-between gap-2 border-b border-[#2a2a2a] pb-3 mb-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    selectedNode.status === "sólido"
                      ? "bg-[#34d399]"
                      : selectedNode.status === "aprendendo"
                      ? "bg-[#fbbf24]"
                      : "bg-[#f87171]"
                  }`}
                />
                <span className="text-[10px] text-[#8d8d8d] uppercase tracking-wider">
                  {selectedNode.status}
                </span>
                {selectedNode.cluster && (
                  <span className="text-[10px] text-[#8d8d8d] bg-[#2a2a2a] px-1.5 py-0.2 rounded border border-[#434343]">
                    {selectedNode.cluster}
                  </span>
                )}
              </div>
              <h3 className="font-title text-lg text-[#e6e6e6] font-bold leading-tight">
                {selectedNode.name}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setSelectedNode(null)}
              className="text-[#8d8d8d] hover:text-[#e6e6e6] p-1 rounded hover:bg-[#2a2a2a] transition-colors"
              title="Fechar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Summary / Truth */}
          <div className="mb-3">
            <p className="font-prose text-[13px] text-[#cccccc] leading-relaxed">
              {selectedNode.summary || "Nenhum resumo registrado ainda para este conceito."}
            </p>
          </div>

          {/* Dependencies */}
          {selectedNode.depends_on && selectedNode.depends_on.length > 0 && (
            <div className="mb-3">
              <span className="text-[10px] text-[#8d8d8d] block uppercase tracking-wider mb-1.5">
                Depende de:
              </span>
              <div className="flex flex-wrap gap-1.5">
                {selectedNode.depends_on.map((dep) => (
                  <button
                    key={dep}
                    type="button"
                    onClick={() => handleSelectDependency(dep)}
                    className="text-[11px] bg-[#2a2a2a] hover:bg-[#333333] text-[#e6e6e6] px-2 py-0.5 rounded border border-[#434343] transition-colors cursor-pointer"
                  >
                    [[{dep}]]
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Vault Path */}
          <div className="mb-4 text-[11px] text-[#8d8d8d] flex items-center gap-1.5 bg-[#141414] px-2 py-1 rounded border border-[#2a2a2a] truncate">
            <span className="text-[#666666]">Vault:</span>
            <span className="truncate">
              {selectedNode.file_path || `Conceitos/${selectedNode.name}.md`}
            </span>
          </div>

          {/* Quick Actions */}
          <div className="grid grid-cols-3 gap-2 pt-1 border-t border-[#2a2a2a]">
            <button
              type="button"
              disabled={actionLoading !== null}
              onClick={() => handleOpenTeach(selectedNode)}
              className="flex flex-col items-center justify-center p-2 rounded bg-[#2a2a2a] hover:bg-[#333333] text-[#e6e6e6] border border-[#434343] hover:border-[#8d8d8d] transition-colors text-[10.5px] cursor-pointer text-center"
              title="Abrir sessão de ensino para este conceito"
            >
              <BookOpen className="w-3.5 h-3.5 mb-1 text-[#34d399]" />
              <span>Aula / TEACH</span>
            </button>

            <button
              type="button"
              disabled={actionLoading !== null}
              onClick={() => handleOpenPractice(selectedNode)}
              className="flex flex-col items-center justify-center p-2 rounded bg-[#2a2a2a] hover:bg-[#333333] text-[#e6e6e6] border border-[#434343] hover:border-[#8d8d8d] transition-colors text-[10.5px] cursor-pointer text-center"
              title="Iniciar treino interativo focado neste conceito"
            >
              <Target className="w-3.5 h-3.5 mb-1 text-[#fbbf24]" />
              <span>+ Practice</span>
            </button>

            <button
              type="button"
              disabled={actionLoading !== null}
              onClick={() => handleOpenDraw(selectedNode)}
              className="flex flex-col items-center justify-center p-2 rounded bg-[#2a2a2a] hover:bg-[#333333] text-[#e6e6e6] border border-[#434343] hover:border-[#8d8d8d] transition-colors text-[10.5px] cursor-pointer text-center"
              title="Desenhar arquitetura de memória no Excalidraw"
            >
              <Edit3 className="w-3.5 h-3.5 mb-1 text-[#e6e6e6]" />
              <span>✎ Desenhar</span>
            </button>
          </div>
        </div>
      )}

      {/* Slide-over Drawer for Chains (☍ Chains) */}
      {isChainsOpen && (
        <div className="absolute top-0 right-0 bottom-0 w-96 bg-[#1c1c1c] border-l border-[#434343] shadow-2xl z-30 flex flex-col font-ui animate-in fade-in slide-in-from-right duration-200">
          {/* Drawer Header */}
          <div className="p-4 border-b border-[#2a2a2a] flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-[#8d8d8d]" />
                <h2 className="font-ui font-semibold text-sm text-[#e6e6e6]">
                  ☍ Cadeias Lógicas & Implicações
                </h2>
              </div>
              <p className="text-[11px] text-[#8d8d8d] mt-1 font-prose">
                Proposições $A \land B \implies C$ extraídas das aulas e notas.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsChainsOpen(false)}
              className="text-[#8d8d8d] hover:text-[#e6e6e6] p-1 rounded hover:bg-[#2a2a2a] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Drawer Search */}
          <div className="p-3 border-b border-[#2a2a2a]">
            <div className="flex items-center bg-[#141414] border border-[#434343] rounded px-2.5 py-1.5">
              <Search className="w-3.5 h-3.5 text-[#8d8d8d] mr-2 shrink-0" />
              <input
                type="text"
                placeholder="Filtrar premissas ou conclusões..."
                value={chainsSearch}
                onChange={(e) => setChainsSearch(e.target.value)}
                className="bg-transparent text-xs text-[#e6e6e6] placeholder-[#8d8d8d] outline-none w-full border-none focus:outline-none focus:ring-0"
              />
            </div>
          </div>

          {/* Drawer Chains List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {filteredChains.length === 0 ? (
              <div className="text-center py-12 text-[#8d8d8d]">
                <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-xs">
                  {chainsSearch
                    ? "Nenhuma cadeia lógica coincide com a busca."
                    : "Nenhuma cadeia lógica extraída ainda."}
                </p>
                <p className="text-[11px] text-[#666666] mt-1">
                  Ao concluir aulas no modo TEACH, o agente de background extrai proposições automaticamente para cá.
                </p>
              </div>
            ) : (
              filteredChains.map((chain) => (
                <div
                  key={chain.id}
                  className="bg-[#141414] border border-[#2a2a2a] hover:border-[#434343] rounded-lg p-3 transition-colors"
                >
                  <div className="flex items-center gap-1.5 flex-wrap text-xs mb-2">
                    {/* Premises */}
                    <div className="flex items-center gap-1 flex-wrap">
                      {chain.premises.map((p, idx) => (
                        <span
                          key={idx}
                          className="bg-[#2a2a2a] text-[#e6e6e6] px-1.5 py-0.5 rounded text-[11px] border border-[#434343]"
                        >
                          {p}
                        </span>
                      ))}
                    </div>

                    <span className="text-[#8d8d8d] font-bold px-1">⟹</span>

                    {/* Conclusion */}
                    <span className="bg-[#1c1c1c] text-[#34d399] font-medium px-1.5 py-0.5 rounded text-[11px] border border-[#34d399]/40">
                      {chain.conclusion}
                    </span>
                  </div>

                  {chain.formula && (
                    <div className="bg-[#1c1c1c] p-1.5 rounded text-[11px] text-[#8d8d8d] font-mono mb-2 truncate">
                      {chain.formula}
                    </div>
                  )}

                  {chain.notes && (
                    <p className="text-[11px] text-[#8d8d8d] font-prose mb-2">
                      {chain.notes}
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-1 border-t border-[#2a2a2a] text-[10.5px]">
                    <span className="text-[#666666]">
                      {chain.source_session_id ? "Da mentoria" : "Conceitual"}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        const session = await createChat({
                          mode: "PRACTICE",
                          topic: `Implicação: ${chain.premises.join(" + ")} => ${chain.conclusion}`,
                        });
                        router.push(`/chat/${session.id}`);
                      }}
                      className="text-[#e6e6e6] hover:text-[#34d399] flex items-center gap-1 transition-colors"
                    >
                      <Target className="w-3 h-3" />
                      <span>Praticar</span>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
