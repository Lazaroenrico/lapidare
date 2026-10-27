"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  CheckSquare,
  Edit3,
  ExternalLink,
  Link2,
  Loader2,
  Minus,
  NotebookText,
  Plus,
  RefreshCw,
  Route,
  Search,
  Settings2,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { ConceptNode, GraphSnapshot, RoadmapItem, SseEventType } from "@/lib/types";
import {
  createChat,
  createDrawing,
  deleteGraphNode,
  getGraphSnapshot,
  getSetupStatus,
  putGraphPositions,
} from "@/lib/api";
import { EMPTY_GRAPH, sessionMessageHref, trackItemIdOf } from "@/lib/graph-wire";
import { isSelected, toggleChain, toggleId, type Selection } from "@/lib/graph-selection";
import {
  DEFAULT_GRAPH_SETTINGS,
  GRAPH_SETTINGS_KEY,
  parseGraphSettings,
  serializeGraphSettings,
  type GraphSettings,
} from "@/lib/graph-settings";
import { useEventSubscription } from "./server-events";
import { GraphCanvasEngine } from "./graph-canvas";
import { ConceptNotePane } from "./concept-note-pane";
import { ChainTable } from "./chain-table";
import { GraphSettingsPanel } from "./graph-settings-panel";
import { UsagePill } from "./usage-pill";
import { useLocale } from "./locale-provider";
import { useTracks } from "./use-tracks";
import { TrackDot } from "./tracks-ui";
import {
  filterRoadmap,
  findActiveTrack,
  roadmapLegend,
  toneForTrack,
  trackTones,
  type RoadmapScope,
} from "@/lib/tracks";
import { tracksText } from "@/lib/tracks-i18n";

const OBSIDIAN_PREF_KEY = "learnharness:open-notes-in-obsidian";
const GRAPH_EVENTS: SseEventType[] = ["graph:updated", "vault:changed"];
const POSITIONS_DEBOUNCE_MS = 600;
const ROADMAP_SCOPE_KEY = "learnharness:roadmap-scope";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode / blocked): keep the in-memory value only.
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

const chromeButton =
  "flex items-center gap-1.5 bg-card/90 hover:bg-accent active:bg-border backdrop-blur border border-border hover:border-muted-foreground text-foreground rounded-lg px-3 py-1.5 text-xs font-ui transition-colors shadow-lg cursor-pointer";

interface GraphViewProps {
  selection: Selection;
  onSelectionChange: (next: Selection) => void;
  /** Latest decoded snapshot (the Home uses it to name the selected nodes). */
  onSnapshot?: (snapshot: GraphSnapshot) => void;
  onOpenImport?: () => void;
  /** Node to focus once it exists in the snapshot (Home `/?focus=<node_id>`). */
  focusId?: string | null;
  className?: string;
}

export function GraphView({ selection, onSelectionChange, onSnapshot, onOpenImport, focusId = null, className = "" }: GraphViewProps) {
  const router = useRouter();
  const { t, locale } = useLocale();
  const tt = tracksText(locale);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GraphCanvasEngine | null>(null);
  const fittedRef = useRef(false);
  /** True once the one-shot initial fit has run. */
  const fitDoneRef = useRef(false);

  const [snapshot, setSnapshot] = useState<GraphSnapshot>(EMPTY_GRAPH);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [focused, setFocused] = useState<ConceptNode | null>(null);
  const [ghost, setGhost] = useState<RoadmapItem | null>(null);
  const [isChainsOpen, setIsChainsOpen] = useState(false);
  const [nodeSearch, setNodeSearch] = useState("");
  const [settings, setSettings] = useState<GraphSettings>(DEFAULT_GRAPH_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [roadmapOn, setRoadmapOn] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConceptNode | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // "Abrir nota": Obsidian deep link vs. in-app read-only pane
  const [openInObsidian, setOpenInObsidian] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [noteNode, setNoteNode] = useState<ConceptNode | null>(null);

  // Latest selection for engine callbacks (bound once).
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  // `?focus=` target: applied once per id, after the initial fit (so the fit does not undo it).
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;
  const appliedFocusRef = useRef<string | null>(null);

  // Dragged positions are batched and sent after the last drag ends.
  const pendingPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const positionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPositions = useCallback(() => {
    positionsTimerRef.current = null;
    const batch = pendingPositionsRef.current;
    pendingPositionsRef.current = {};
    if (Object.keys(batch).length === 0) return;
    putGraphPositions(batch).catch((err) => console.error("[GraphView] Failed to save positions:", err));
  }, []);

  const loadVaultName = useCallback(() => {
    getSetupStatus()
      .then((s) => setVaultName(vaultNameFromPath(s.config?.vault_path || "")))
      .catch(() => setVaultName(""));
  }, []);

  useEffect(() => {
    setOpenInObsidian(readStorage(OBSIDIAN_PREF_KEY) === "1");
    setSettings(parseGraphSettings(readStorage(GRAPH_SETTINGS_KEY)));
    loadVaultName();
  }, [loadVaultName]);

  useEventSubscription("config:updated", () => {
    loadVaultName();
  });

  const updateSettings = (next: GraphSettings) => {
    setSettings(next);
    writeStorage(GRAPH_SETTINGS_KEY, serializeGraphSettings(next));
  };

  const toggleOpenInObsidian = () => {
    setOpenInObsidian((prev) => {
      writeStorage(OBSIDIAN_PREF_KEY, prev ? "0" : "1");
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

  const loadGraph = useCallback(async () => {
    try {
      const data = await getGraphSnapshot();
      setSnapshot(data);
      onSnapshotRef.current?.(data);
      setFocused((prev) => (prev ? data.nodes.find((n) => n.id === prev.id) ?? null : null));
    } catch (err) {
      console.error("[GraphView] Failed to fetch graph snapshot:", err);
    }
  }, []);

  // notify -> fetch
  useEventSubscription(GRAPH_EVENTS, () => {
    void loadGraph();
  });

  // Canvas engine lifecycle
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new GraphCanvasEngine(canvas, {
      onNodeClick: (node, additive) => {
        if (additive) {
          onSelectionChangeRef.current(toggleId(selectionRef.current, node.id));
          return;
        }
        setGhost(null);
        setFocused(node);
      },
      onGhostClick: (item) => {
        setFocused(null);
        setGhost(item);
      },
      onCanvasClick: () => {
        setFocused(null);
        setGhost(null);
      },
      onNodeMoved: (id, pos) => {
        pendingPositionsRef.current[id] = { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10 };
        if (positionsTimerRef.current) clearTimeout(positionsTimerRef.current);
        positionsTimerRef.current = setTimeout(flushPositions, POSITIONS_DEBOUNCE_MS);
      },
    });
    engineRef.current = engine;
    void loadGraph();

    const container = containerRef.current;
    const observer = container ? new ResizeObserver(() => engine.resize()) : null;
    if (container && observer) observer.observe(container);

    return () => {
      observer?.disconnect();
      if (positionsTimerRef.current) {
        clearTimeout(positionsTimerRef.current);
        flushPositions();
      }
      engine.destroy();
      engineRef.current = null;
    };
  }, [loadGraph, flushPositions]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setData(snapshot.nodes, snapshot.edges, snapshot.clusters, snapshot.chains);
    if (!fittedRef.current && snapshot.nodes.length > 0) {
      fittedRef.current = true;
      // One-shot fit once the first layout has spread out (not polling); a `?focus=`
      // target replaces the fit with centring on that node.
      setTimeout(() => {
        fitDoneRef.current = true;
        if (!applyFocusParam()) engineRef.current?.resetView();
      }, 700);
      return;
    }
    if (fitDoneRef.current) applyFocusParam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  // A new `?focus=` while the graph is already laid out.
  useEffect(() => {
    if (fitDoneRef.current) applyFocusParam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  // ⇶ Roteiro (Fase 14): one colour per track; "Só a trilha em foco" or "Todas".
  const { tracks } = useTracks();
  const activeTrackId = findActiveTrack(tracks)?.id ?? null;
  const tones = useMemo(() => trackTones(tracks), [tracks]);
  const [roadmapScope, setRoadmapScope] = useState<RoadmapScope>("focus");
  useEffect(() => {
    const saved = readStorage(ROADMAP_SCOPE_KEY);
    if (saved === "focus" || saved === "all") setRoadmapScope(saved);
  }, []);
  const changeRoadmapScope = (scope: RoadmapScope) => {
    setRoadmapScope(scope);
    writeStorage(ROADMAP_SCOPE_KEY, scope);
  };
  const roadmapTrackCount = useMemo(
    () => new Set(snapshot.roadmap.map((r) => r.track_id).filter(Boolean)).size,
    [snapshot.roadmap],
  );
  const visibleRoadmap = useMemo(
    () => filterRoadmap(snapshot.roadmap, roadmapScope, activeTrackId),
    [snapshot.roadmap, roadmapScope, activeTrackId],
  );
  const legend = useMemo(() => roadmapLegend(visibleRoadmap, tones), [visibleRoadmap, tones]);

  const hasRoadmap = snapshot.roadmap.length > 0;
  useEffect(() => {
    engineRef.current?.setGhosts(roadmapOn && hasRoadmap ? visibleRoadmap : null, (item) =>
      item.track_id ? toneForTrack(item.track_id, tones) : null,
    );
    if (!roadmapOn) setGhost(null);
  }, [roadmapOn, hasRoadmap, visibleRoadmap, tones]);

  // A ghost hidden by the scope toggle closes its card.
  useEffect(() => {
    if (ghost && !visibleRoadmap.some((r) => r.id === ghost.id)) setGhost(null);
  }, [ghost, visibleRoadmap]);

  useEffect(() => {
    engineRef.current?.setSettings(settings);
  }, [settings]);

  useEffect(() => {
    engineRef.current?.setSelection(selection);
  }, [selection]);

  useEffect(() => {
    engineRef.current?.setFocused(focused?.id ?? null);
  }, [focused]);

  const validIds = useMemo(() => new Set(snapshot.nodes.map((n) => n.id)), [snapshot.nodes]);
  const sessionTitles = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of snapshot.clusters) if (c.kind === "session") m.set(c.id, c.label);
    for (const n of snapshot.nodes) for (const s of n.sessions) if (!m.has(s.session_id)) m.set(s.session_id, s.title);
    return m;
  }, [snapshot]);

  const searchResults = useMemo(() => {
    const q = nodeSearch.trim().toLowerCase();
    if (!q) return [];
    return snapshot.nodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(q) ||
          n.statement.toLowerCase().includes(q) ||
          n.aliases.some((a) => a.toLowerCase().includes(q)),
      )
      .slice(0, 8);
  }, [snapshot.nodes, nodeSearch]);

  function applyFocusParam(): boolean {
    const id = focusIdRef.current;
    if (!id || appliedFocusRef.current === id) return false;
    const node = snapshotRef.current.nodes.find((n) => n.id === id);
    if (!node) return false;
    appliedFocusRef.current = id;
    setGhost(null);
    setFocused(node);
    engineRef.current?.focusNode(id);
    return true;
  }

  const focusNode = (id: string) => {
    const node = snapshot.nodes.find((n) => n.id === id);
    if (!node) return;
    setGhost(null);
    setFocused(node);
    engineRef.current?.focusNode(id);
  };

  const handleDraw = async (node: ConceptNode) => {
    try {
      setActionLoading("draw");
      const res = await createDrawing({ title: node.name, concept_ids: [node.id], prompt: t.drawPrompt(node.name) });
      router.push(`/draw/${res.slug}`);
    } catch (err) {
      console.error("Failed to create drawing:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleStartGhost = async (item: RoadmapItem) => {
    try {
      setActionLoading("ghost");
      const session = await createChat({
        mode: "TEACH",
        topic: item.title,
        track_item_id: trackItemIdOf(item.id, item.track_id),
        ...(item.track_id ? { track_id: item.track_id } : {}),
      });
      router.push(`/chat/${session.id}`);
    } catch (err) {
      console.error("Failed to start track item:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setActionLoading("delete");
    setDeleteError(null);
    try {
      await deleteGraphNode(deleteTarget.id);
      const id = deleteTarget.id;
      setDeleteTarget(null);
      setFocused(null);
      if (isSelected(selection, id)) onSelectionChange(selection.filter((s) => s !== id));
      void loadGraph();
    } catch (err) {
      setDeleteError(`${t.deleteFailed} ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setActionLoading(null);
    }
  };

  const focusedSelected = focused ? isSelected(selection, focused.id) : false;

  return (
    <div ref={containerRef} className={`relative w-full h-full overflow-hidden bg-background select-none ${className}`}>
      <canvas ref={canvasRef} className="w-full h-full block cursor-default" />

      {/* Floating top chrome */}
      <div className="absolute top-4 left-4 right-4 flex flex-wrap items-start justify-between gap-2 pointer-events-none z-10">
        <div className="flex items-center gap-2 pointer-events-auto">
          <div className="flex items-center gap-3 bg-card/90 backdrop-blur border border-border rounded-lg px-3.5 py-1.5 shadow-lg">
            <span className="font-ui font-semibold text-xs text-foreground">{t.graphTitle}</span>
            <span className="text-border text-xs">|</span>
            <span className="font-ui text-[11px] text-muted-foreground">
              {t.graphStats(snapshot.nodes.length, snapshot.edges.length, snapshot.chains.length)}
            </span>
          </div>
          <UsagePill />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 pointer-events-auto">
          <div className="relative">
            <div className="flex items-center bg-card/90 backdrop-blur border border-border focus-within:border-muted-foreground rounded-lg px-2.5 py-1 shadow-lg transition-colors">
              <Search className="w-3.5 h-3.5 text-muted-foreground mr-2 shrink-0" />
              <input
                type="text"
                placeholder={t.graphNodeSearch}
                aria-label={t.graphNodeSearch}
                value={nodeSearch}
                onChange={(e) => setNodeSearch(e.target.value)}
                className="bg-transparent text-foreground placeholder-muted-foreground text-xs font-ui w-36 sm:w-48 border-none"
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
            {searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-2xl py-1 z-30">
                {searchResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={(e) => {
                      if (e.shiftKey || e.metaKey || e.ctrlKey) onSelectionChange(toggleId(selection, item.id));
                      else focusNode(item.id);
                      setNodeSearch("");
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center justify-between gap-2 text-xs font-ui text-foreground transition-colors"
                  >
                    <span className="truncate">{item.name}</span>
                    {isSelected(selection, item.id) && <CheckSquare className="w-3 h-3 text-success shrink-0" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button type="button" onClick={() => setIsChainsOpen((o) => !o)} className={chromeButton} title={t.chainsTitle} aria-pressed={isChainsOpen}>
            <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span>☍ Chains</span>
            {snapshot.chains.length > 0 && (
              <span className="bg-accent text-muted-foreground text-[10px] px-1.5 rounded-full border border-border">
                {snapshot.chains.length}
              </span>
            )}
          </button>

          <button type="button" onClick={onOpenImport} className={chromeButton} title={t.importTitle}>
            <Upload className="w-3.5 h-3.5 text-muted-foreground" />
            <span>↑ Import</span>
          </button>

          {hasRoadmap && (
            <button
              type="button"
              onClick={() => setRoadmapOn((o) => !o)}
              aria-pressed={roadmapOn}
              title={t.roadmapTitle}
              className={`${chromeButton} ${roadmapOn ? "bg-accent border-muted-foreground" : ""}`}
            >
              <Route className={`w-3.5 h-3.5 ${roadmapOn ? "text-success" : "text-muted-foreground"}`} />
              <span>{t.roadmapToggle}</span>
            </button>
          )}

          <div className="flex items-center bg-card/90 backdrop-blur border border-border rounded-lg p-0.5 shadow-lg">
            <button type="button" onClick={() => engineRef.current?.zoomIn()} className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors" title={t.zoomIn} aria-label={t.zoomIn}>
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => engineRef.current?.zoomOut()} className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors" title={t.zoomOut} aria-label={t.zoomOut}>
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => engineRef.current?.resetView()} className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors" title={t.resetView} aria-label={t.resetView}>
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setSettingsOpen((o) => !o)}
              aria-expanded={settingsOpen}
              title={t.graphSettingsTitle}
              aria-label={t.graphSettingsTitle}
              className={`${chromeButton} px-2`}
            >
              <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            {settingsOpen && (
              <GraphSettingsPanel settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(false)} />
            )}
          </div>
        </div>
      </div>

      {/* ⇶ Roteiro legend + scope toggle */}
      {roadmapOn && hasRoadmap && (legend.length > 0 || roadmapTrackCount > 1) && (
        <div
          role="group"
          aria-label={tt.legend}
          className="absolute top-20 left-4 z-10 w-60 max-w-[calc(100%-32px)] bg-card/90 backdrop-blur border border-border rounded-lg p-2.5 shadow-lg font-ui space-y-2"
        >
          {roadmapTrackCount > 1 && activeTrackId && (
            <div role="group" aria-label={tt.roadmapScope} className="grid grid-cols-2 bg-background p-0.5 border border-border rounded text-[10.5px]">
              {(["focus", "all"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => changeRoadmapScope(scope)}
                  aria-pressed={roadmapScope === scope}
                  className={`py-1 px-1 rounded cursor-pointer transition-colors truncate ${
                    roadmapScope === scope ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {scope === "focus" ? tt.roadmapFocus : tt.roadmapAll}
                </button>
              ))}
            </div>
          )}
          {legend.length > 0 && (
            <ul className="space-y-1">
              {legend.map((entry) => (
                <li key={entry.trackId} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <TrackDot tone={entry.tone} />
                  <span className={`flex-1 min-w-0 truncate ${entry.trackId === activeTrackId ? "text-foreground" : ""}`} title={entry.title}>
                    {entry.title}
                  </span>
                  <span className="tabular-nums text-[10.5px]">{entry.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Node card */}
      {focused && !isChainsOpen && (
        <div className="absolute top-20 right-4 w-80 max-h-[calc(100%-14rem)] overflow-y-auto bg-card border border-border rounded-xl p-4 shadow-2xl z-20 select-text font-ui">
          <div className="flex items-start justify-between gap-2 border-b border-accent pb-3 mb-3">
            <div className="min-w-0">
              {(focused.status || focused.cluster) && (
                <div className="flex items-center gap-2 mb-1 text-[10px] text-muted-foreground">
                  {focused.status && <span className="uppercase tracking-wider">{t.conceptStatus(focused.status)}</span>}
                  {focused.cluster && (
                    <span className="bg-accent px-1.5 rounded border border-border truncate max-w-48">
                      {sessionTitles.get(focused.cluster) ?? focused.cluster}
                    </span>
                  )}
                </div>
              )}
              <h3 className="font-title text-lg text-foreground font-bold leading-tight break-words">{focused.name}</h3>
              {focused.aliases.length > 0 && (
                <p className="text-[10.5px] text-muted-foreground mt-1">
                  {t.nodeAliases} {focused.aliases.join(", ")}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setFocused(null)}
              className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent transition-colors"
              title={t.close}
              aria-label={t.close}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="font-prose text-[13px] text-foreground leading-relaxed mb-3">{focused.statement || t.noSummary}</p>

          <div className="mb-3">
            <span className="text-[10px] text-muted-foreground block uppercase tracking-wider mb-1.5">{t.nodeSessions}</span>
            {focused.sessions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t.nodeNoSessions}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {focused.sessions.map((s) => (
                  <li key={`${s.session_id}-${s.message_id ?? ""}`}>
                    <Link
                      href={sessionMessageHref(s)}
                      title={t.nodeOpenSession(s.title)}
                      className="flex items-center gap-1.5 text-[11px] text-foreground hover:bg-accent rounded px-1.5 py-1 border border-accent hover:border-border transition-colors"
                    >
                      <BookOpen className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="truncate">{s.title}</span>
                      {s.message_id && <span className="ml-auto text-muted-foreground shrink-0">#</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mb-3 text-[11px] text-muted-foreground flex items-center gap-1.5 bg-background px-2 py-1 rounded border border-accent">
            <span>{t.vaultLabel}</span>
            <span className="truncate">{notePathFor(focused)}</span>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-3 border-t border-accent">
            <button
              type="button"
              onClick={() => handleOpenNote(focused)}
              className="flex flex-col items-center justify-center p-2 rounded bg-accent hover:bg-border text-foreground border border-border transition-colors text-[10.5px] cursor-pointer"
              title={openInObsidian && vaultName ? t.nodeNoteObsidianTitle : t.nodeNoteTitle}
            >
              {openInObsidian && vaultName ? <ExternalLink className="w-3.5 h-3.5 mb-1" /> : <NotebookText className="w-3.5 h-3.5 mb-1" />}
              <span>{t.nodeNote}</span>
            </button>
            <button
              type="button"
              onClick={() => onSelectionChange(toggleId(selection, focused.id))}
              aria-pressed={focusedSelected}
              title={t.nodeSelectHint}
              className={`flex flex-col items-center justify-center p-2 rounded border transition-colors text-[10.5px] cursor-pointer ${
                focusedSelected ? "bg-border border-success/60 text-foreground" : "bg-accent hover:bg-border border-border text-foreground"
              }`}
            >
              {focusedSelected ? <CheckSquare className="w-3.5 h-3.5 mb-1 text-success" /> : <Square className="w-3.5 h-3.5 mb-1" />}
              <span>{focusedSelected ? t.nodeDeselect : t.nodeSelect}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setDeleteError(null);
                setDeleteTarget(focused);
              }}
              className="flex flex-col items-center justify-center p-2 rounded bg-accent hover:bg-border text-danger border border-border hover:border-danger/60 transition-colors text-[10.5px] cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5 mb-1" />
              <span>{t.nodeDelete}</span>
            </button>
          </div>
          <button
            type="button"
            disabled={actionLoading !== null}
            onClick={() => void handleDraw(focused)}
            className="mt-2 w-full flex items-center justify-center gap-1.5 p-1.5 rounded text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            title={t.nodeDrawTitle}
          >
            <Edit3 className="w-3 h-3" />
            {t.nodeDraw}
          </button>

          <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground select-none">
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
          {openInObsidian && !vaultName && <p className="mt-1 text-[10.5px] text-warning">{t.obsidianNoVault}</p>}
        </div>
      )}

      {/* Ghost (pending track item) card */}
      {ghost && !isChainsOpen && (
        <div className="absolute top-20 right-4 w-72 bg-card border border-dashed border-muted-foreground rounded-xl p-4 shadow-2xl z-20 font-ui">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="min-w-0">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{t.ghostLabel}</span>
              {ghost.track_title && (
                <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground mt-0.5">
                  {ghost.track_id && <TrackDot tone={toneForTrack(ghost.track_id, tones)} />}
                  <span className="truncate">{ghost.track_title}</span>
                </span>
              )}
              <h3 className="font-title text-base text-foreground font-bold leading-tight break-words">{ghost.title}</h3>
            </div>
            <button type="button" onClick={() => setGhost(null)} className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent" title={t.close} aria-label={t.close}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground mb-3">{t.ghostLinked(ghost.linked_node_ids.filter((id) => validIds.has(id)).length)}</p>
          <button
            type="button"
            disabled={actionLoading !== null}
            onClick={() => void handleStartGhost(ghost)}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-foreground text-background text-xs font-semibold hover:bg-foreground/90 cursor-pointer disabled:opacity-60"
          >
            {actionLoading === "ghost" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookOpen className="w-3.5 h-3.5" />}
            {t.ghostStart}
          </button>
        </div>
      )}

      {isChainsOpen && (
        <ChainTable
          chains={snapshot.chains}
          selection={selection}
          validIds={validIds}
          sessionTitles={sessionTitles}
          onToggleChain={(c) => onSelectionChange(toggleChain(selection, c, validIds))}
          onFocusNode={(id) => {
            setIsChainsOpen(false);
            focusNode(id);
          }}
          onClose={() => setIsChainsOpen(false)}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4" role="presentation">
          <div role="alertdialog" aria-modal="true" aria-labelledby="delete-node-title" className="w-full max-w-sm bg-card border border-border rounded-xl p-5 shadow-2xl font-ui">
            <h3 id="delete-node-title" className="font-title text-base font-bold text-foreground mb-2">
              {t.deleteNodeTitle}
            </h3>
            <p className="font-prose text-[13px] text-muted-foreground mb-4">{t.deleteNodeBody(deleteTarget.name)}</p>
            {deleteError && <p role="alert" className="text-[11px] text-danger mb-3">{deleteError}</p>}
            <div className="flex justify-end gap-2 text-xs">
              <button
                type="button"
                autoFocus
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-1.5 rounded border border-border bg-background hover:bg-accent text-foreground cursor-pointer"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                disabled={actionLoading === "delete"}
                onClick={() => void confirmDelete()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-danger/60 bg-accent hover:bg-border text-danger font-semibold cursor-pointer disabled:opacity-60"
              >
                {actionLoading === "delete" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {actionLoading === "delete" ? t.deleting : t.deleteConfirm}
              </button>
            </div>
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
