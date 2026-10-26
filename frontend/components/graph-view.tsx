"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Edit3,
  ExternalLink,
  Link2,
  Minus,
  NotebookText,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  Upload,
  X,
} from "lucide-react";
import type { ConceptNode, GraphSnapshot } from "@/lib/types";
import { createChat, createDrawing, getGraphSnapshot, getSetupStatus } from "@/lib/api";
import { useEventSubscription } from "./server-events";
import { GraphCanvasEngine } from "./graph-canvas";
import { ConceptNotePane } from "./concept-note-pane";
import { useLocale } from "./locale-provider";

const OBSIDIAN_PREF_KEY = "learnharness:open-notes-in-obsidian";

function readObsidianPref(): boolean {
  try {
    return window.localStorage.getItem(OBSIDIAN_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeObsidianPref(value: boolean): void {
  try {
    window.localStorage.setItem(OBSIDIAN_PREF_KEY, value ? "1" : "0");
  } catch {
    // Storage unavailable (private mode / blocked): keep the in-memory choice only.
  }
}

/** Vault folder name = last segment of the configured vault path (Obsidian vault name). */
function vaultNameFromPath(vaultPath: string): string {
  return vaultPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}

/** obsidian://open?vault=<name>&file=<vault-relative path without .md> */
function buildObsidianUri(vaultName: string, notePath: string): string {
  const file = notePath.replace(/^\/+/, "").replace(/\.md$/i, "");
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

interface GraphViewProps {
  onOpenImport?: () => void;
  className?: string;
}

export function GraphView({ onOpenImport, className = "" }: GraphViewProps) {
  const router = useRouter();
  const { t } = useLocale();
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

  // "Abrir Nota": Obsidian deep link vs. in-app read-only pane
  const [openInObsidian, setOpenInObsidian] = useState<boolean>(false);
  const [vaultName, setVaultName] = useState<string>("");
  const [noteNode, setNoteNode] = useState<ConceptNode | null>(null);

  const loadVaultName = useCallback(() => {
    getSetupStatus()
      .then((s) => setVaultName(vaultNameFromPath(s.config?.vault_path || "")))
      .catch(() => setVaultName(""));
  }, []);

  useEffect(() => {
    setOpenInObsidian(readObsidianPref());
    loadVaultName();
  }, [loadVaultName]);

  useEventSubscription("config:updated", () => {
    loadVaultName();
  });

  const toggleOpenInObsidian = () => {
    setOpenInObsidian((prev) => {
      writeObsidianPref(!prev);
      return !prev;
    });
  };

  const notePathFor = (node: ConceptNode) => node.file_path || `Conceitos/${node.name}.md`;

  const handleOpenNote = (node: ConceptNode) => {
    if (openInObsidian && vaultName) {
      window.location.href = buildObsidianUri(vaultName, notePathFor(node));
      return;
    }
    setNoteNode(node);
  };

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
        prompt: t.drawPrompt(node.name),
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
      className={`relative w-full h-full overflow-hidden bg-background select-none ${className}`}
    >
      {/* 2D Canvas Target */}
      <canvas ref={canvasRef} className="w-full h-full block cursor-default" />

      {/* Top Floating Action Pills Bar */}
      <div className="absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none z-10">
        {/* Left Status Pill */}
        <div className="flex items-center gap-3 bg-card/90 backdrop-blur border border-border rounded-lg px-3.5 py-1.5 shadow-lg pointer-events-auto">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span className="font-ui font-semibold text-xs text-foreground">
              {t.graphTitle}
            </span>
          </div>
          <span className="text-border text-xs">|</span>
          <span className="font-ui text-[11px] text-muted-foreground">
            {t.graphStats(snapshot.nodes.length, snapshot.edges.length, snapshot.chains.length)}
          </span>
        </div>

        {/* Center / Right Pills: Search, Chains, Import, Excalidraw, Zoom */}
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Node Search Bar */}
          <div className="relative">
            <div className="flex items-center bg-card/90 backdrop-blur border border-border focus-within:border-muted-foreground rounded-lg px-2.5 py-1 shadow-lg transition-colors">
              <Search className="w-3.5 h-3.5 text-muted-foreground mr-2 shrink-0" />
              <input
                type="text"
                placeholder={t.graphSearch}
                aria-label={t.graphSearch}
                value={nodeSearch}
                onChange={(e) => setNodeSearch(e.target.value)}
                className="bg-transparent text-foreground placeholder-muted-foreground text-xs font-ui w-36 sm:w-48 outline-none border-none focus:outline-none focus:ring-0"
              />
              {nodeSearch && (
                <button
                  type="button"
                  onClick={() => setNodeSearch("")}
                  className="text-muted-foreground hover:text-foreground p-0.5"
                  title={t.clearSearch}
                  aria-label={t.clearSearch}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Search Dropdown Results */}
            {searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-2xl py-1 z-30">
                {searchResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelectedNode(item);
                      engineRef.current?.focusNode(item.id);
                      setNodeSearch("");
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center justify-between text-xs font-ui text-foreground transition-colors"
                  >
                    <span>{item.name}</span>
                    <span className="text-[10px] text-muted-foreground capitalize">
                      {t.conceptStatus(item.status)}
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
            className="flex items-center gap-1.5 bg-card/90 hover:bg-accent active:bg-border backdrop-blur border border-border hover:border-muted-foreground text-foreground rounded-lg px-3 py-1.5 text-xs font-ui transition-colors shadow-lg cursor-pointer"
            title={t.chainsTitle}
          >
            <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span>☍ Chains</span>
            {snapshot.chains.length > 0 && (
              <span className="bg-accent text-muted-foreground text-[10px] px-1.5 py-0.2 rounded-full border border-border">
                {snapshot.chains.length}
              </span>
            )}
          </button>

          {/* ↑ Import Button */}
          <button
            type="button"
            onClick={onOpenImport}
            className="flex items-center gap-1.5 bg-card/90 hover:bg-accent active:bg-border backdrop-blur border border-border hover:border-muted-foreground text-foreground rounded-lg px-3 py-1.5 text-xs font-ui transition-colors shadow-lg cursor-pointer"
            title={t.importTitle}
          >
            <Upload className="w-3.5 h-3.5 text-muted-foreground" />
            <span>↑ Import</span>
          </button>

          {/* ✎ Excalidraw Button */}
          <button
            type="button"
            onClick={() => router.push("/draw/new")}
            className="flex items-center gap-1.5 bg-card/90 hover:bg-accent active:bg-border backdrop-blur border border-border hover:border-muted-foreground text-foreground rounded-lg px-3 py-1.5 text-xs font-ui transition-colors shadow-lg cursor-pointer"
            title={t.excalidrawTitle}
          >
            <Edit3 className="w-3.5 h-3.5 text-muted-foreground" />
            <span>✎ Excalidraw</span>
          </button>

          {/* Zoom Controls */}
          <div className="flex items-center bg-card/90 backdrop-blur border border-border rounded-lg p-0.5 shadow-lg">
            <button
              type="button"
              onClick={() => engineRef.current?.zoomIn()}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              title={t.zoomIn}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.zoomOut()}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              title={t.zoomOut}
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.resetView()}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              title={t.resetView}
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Contextual Node Card */}
      {selectedNode && (
        <div className="absolute top-20 right-4 w-84 bg-card border border-border rounded-xl p-4 shadow-2xl z-20 transition-all select-text font-ui animate-in fade-in slide-in-from-right-4 duration-150">
          {/* Card Header */}
          <div className="flex items-start justify-between gap-2 border-b border-accent pb-3 mb-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    selectedNode.status === "sólido"
                      ? "bg-success"
                      : selectedNode.status === "aprendendo"
                      ? "bg-warning"
                      : "bg-danger"
                  }`}
                />
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {t.conceptStatus(selectedNode.status)}
                </span>
                {selectedNode.cluster && (
                  <span className="text-[10px] text-muted-foreground bg-accent px-1.5 py-0.2 rounded border border-border">
                    {selectedNode.cluster}
                  </span>
                )}
              </div>
              <h3 className="font-title text-lg text-foreground font-bold leading-tight">
                {selectedNode.name}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setSelectedNode(null)}
              className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent transition-colors"
              title={t.close}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Summary / Truth */}
          <div className="mb-3">
            <p className="font-prose text-[13px] text-foreground leading-relaxed">
              {selectedNode.summary || t.noSummary}
            </p>
          </div>

          {/* Dependencies */}
          {selectedNode.depends_on && selectedNode.depends_on.length > 0 && (
            <div className="mb-3">
              <span className="text-[10px] text-muted-foreground block uppercase tracking-wider mb-1.5">
                {t.dependsOn}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {selectedNode.depends_on.map((dep) => (
                  <button
                    key={dep}
                    type="button"
                    onClick={() => handleSelectDependency(dep)}
                    className="text-[11px] bg-accent hover:bg-border text-foreground px-2 py-0.5 rounded border border-border transition-colors cursor-pointer"
                  >
                    [[{dep}]]
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Vault Path */}
          <div className="mb-4 text-[11px] text-muted-foreground flex items-center gap-1.5 bg-background px-2 py-1 rounded border border-accent truncate">
            <span className="text-muted-foreground">{t.vaultLabel}</span>
            <span className="truncate">
              {notePathFor(selectedNode)}
            </span>
          </div>

          {/* Quick Actions */}
          <div className="grid grid-cols-2 gap-2 pt-3 border-t border-accent">
            <button
              type="button"
              disabled={actionLoading !== null}
              onClick={() => handleOpenTeach(selectedNode)}
              className="flex flex-col items-center justify-center p-2 rounded bg-accent hover:bg-border text-foreground border border-border hover:border-muted-foreground transition-colors text-[10.5px] cursor-pointer text-center"
              title={t.nodeTeachTitle}
            >
              <BookOpen className="w-3.5 h-3.5 mb-1 text-success" />
              <span>{t.nodeTeach}</span>
            </button>

            <button
              type="button"
              disabled={actionLoading !== null}
              onClick={() => handleOpenPractice(selectedNode)}
              className="flex flex-col items-center justify-center p-2 rounded bg-accent hover:bg-border text-foreground border border-border hover:border-muted-foreground transition-colors text-[10.5px] cursor-pointer text-center"
              title={t.nodePracticeTitle}
            >
              <Target className="w-3.5 h-3.5 mb-1 text-warning" />
              <span>{t.nodePractice}</span>
            </button>

            <button
              type="button"
              disabled={actionLoading !== null}
              onClick={() => handleOpenDraw(selectedNode)}
              className="flex flex-col items-center justify-center p-2 rounded bg-accent hover:bg-border text-foreground border border-border hover:border-muted-foreground transition-colors text-[10.5px] cursor-pointer text-center"
              title={t.nodeDrawTitle}
            >
              <Edit3 className="w-3.5 h-3.5 mb-1 text-foreground" />
              <span>{t.nodeDraw}</span>
            </button>

            <button
              type="button"
              onClick={() => handleOpenNote(selectedNode)}
              className="flex flex-col items-center justify-center p-2 rounded bg-accent hover:bg-border text-foreground border border-border hover:border-muted-foreground transition-colors text-[10.5px] cursor-pointer text-center"
              title={openInObsidian && vaultName ? t.nodeNoteObsidianTitle : t.nodeNoteTitle}
            >
              {openInObsidian && vaultName ? (
                <ExternalLink className="w-3.5 h-3.5 mb-1 text-foreground" />
              ) : (
                <NotebookText className="w-3.5 h-3.5 mb-1 text-foreground" />
              )}
              <span>{t.nodeNote}</span>
            </button>
          </div>

          {/* Open-in-Obsidian preference (persisted per browser) */}
          <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-muted-foreground select-none">
            <span id="open-in-obsidian-label">{t.openInObsidian}</span>
            <button
              type="button"
              role="switch"
              aria-checked={openInObsidian}
              aria-labelledby="open-in-obsidian-label"
              onClick={toggleOpenInObsidian}
              className={`relative w-8 h-4 rounded-full border transition-colors cursor-pointer ${
                openInObsidian ? "bg-foreground border-foreground" : "bg-background border-border"
              }`}
            >
              <span
                className={`absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all ${
                  openInObsidian ? "left-4 bg-background" : "left-0.5 bg-muted-foreground"
                }`}
              />
            </button>
          </div>
          {openInObsidian && !vaultName && (
            <p className="mt-1 text-[10.5px] text-warning">{t.obsidianNoVault}</p>
          )}
        </div>
      )}

      {/* Slide-over Drawer for Chains (☍ Chains) */}
      {isChainsOpen && (
        <div className="absolute top-0 right-0 bottom-0 w-96 bg-card border-l border-border shadow-2xl z-30 flex flex-col font-ui animate-in fade-in slide-in-from-right duration-200">
          {/* Drawer Header */}
          <div className="p-4 border-b border-accent flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-ui font-semibold text-sm text-foreground">
                  {t.chainsHeading}
                </h2>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1 font-prose">
                {t.chainsSubtitle}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsChainsOpen(false)}
              className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent transition-colors"
              title={t.close}
              aria-label={t.close}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Drawer Search */}
          <div className="p-3 border-b border-accent">
            <div className="flex items-center bg-background border border-border rounded px-2.5 py-1.5">
              <Search className="w-3.5 h-3.5 text-muted-foreground mr-2 shrink-0" />
              <input
                type="text"
                placeholder={t.chainsFilter}
                aria-label={t.chainsFilter}
                value={chainsSearch}
                onChange={(e) => setChainsSearch(e.target.value)}
                className="bg-transparent text-xs text-foreground placeholder-muted-foreground outline-none w-full border-none focus:outline-none focus:ring-0"
              />
            </div>
          </div>

          {/* Drawer Chains List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {filteredChains.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-xs">
                  {chainsSearch
                    ? t.chainsNoMatch
                    : t.chainsEmpty}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t.chainsEmptyHint}
                </p>
              </div>
            ) : (
              filteredChains.map((chain) => (
                <div
                  key={chain.id}
                  className="bg-background border border-accent hover:border-border rounded-lg p-3 transition-colors"
                >
                  <div className="flex items-center gap-1.5 flex-wrap text-xs mb-2">
                    {/* Premises */}
                    <div className="flex items-center gap-1 flex-wrap">
                      {chain.premises.map((p, idx) => (
                        <span
                          key={idx}
                          className="bg-accent text-foreground px-1.5 py-0.5 rounded text-[11px] border border-border"
                        >
                          {p}
                        </span>
                      ))}
                    </div>

                    <span className="text-muted-foreground font-bold px-1">⟹</span>

                    {/* Conclusion */}
                    <span className="bg-card text-success font-medium px-1.5 py-0.5 rounded text-[11px] border border-success/40">
                      {chain.conclusion}
                    </span>
                  </div>

                  {chain.formula && (
                    <div className="bg-card p-1.5 rounded text-[11px] text-muted-foreground font-mono mb-2 truncate">
                      {chain.formula}
                    </div>
                  )}

                  {chain.notes && (
                    <p className="text-[11px] text-muted-foreground font-prose mb-2">
                      {chain.notes}
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-1 border-t border-accent text-[10.5px]">
                    <span className="text-muted-foreground">
                      {chain.source_session_id ? t.chainFromSession : t.chainConceptual}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        const session = await createChat({
                          mode: "PRACTICE",
                          topic: t.chainPracticeTopic(chain.premises.join(" + "), chain.conclusion),
                        });
                        router.push(`/chat/${session.id}`);
                      }}
                      className="text-foreground hover:text-success flex items-center gap-1 transition-colors"
                    >
                      <Target className="w-3 h-3" />
                      <span>{t.practiceAction}</span>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <ConceptNotePane
        conceptId={noteNode?.id ?? null}
        conceptName={noteNode?.name ?? ""}
        fallbackPath={noteNode ? notePathFor(noteNode) : ""}
        onClose={() => setNoteNode(null)}
      />
    </div>
  );
}
