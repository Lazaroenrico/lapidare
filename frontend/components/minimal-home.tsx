"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getGraphSnapshot } from "@/lib/api";
import { EMPTY_GRAPH } from "@/lib/graph-wire";
import { toggleChain, type Selection } from "@/lib/graph-selection";
import { homeCounts } from "@/lib/home-counts";
import { metersText } from "@/lib/meters-i18n";
import type { GraphSnapshot, SseEventType } from "@/lib/types";
import { ChainTable } from "./chain-table";
import { useLocale } from "./locale-provider";
import { NavDrawerButton } from "./nav-drawer";
import { useEventSubscription } from "./server-events";
import { UsagePill } from "./usage-pill";

const GRAPH_EVENTS: SseEventType[] = ["graph:updated", "vault:changed"];

const chromeButton =
  "flex items-center gap-1.5 bg-card/85 hover:bg-accent active:bg-border backdrop-blur border border-border hover:border-muted-foreground text-muted-foreground hover:text-foreground rounded-full px-3 py-1.5 text-[12.5px] font-ui transition-colors cursor-pointer";

interface MinimalHomeProps {
  selection: Selection;
  onSelectionChange: (next: Selection) => void;
  onSnapshot?: (snapshot: GraphSnapshot) => void;
  onOpenImport?: () => void;
}

/**
 * Fase 21: Home without the Canvas (Settings → Grafo → "Mostrar o grafo na Home" off).
 * Same snapshot fetch and `graph:updated` refetch as GraphView; shows one line of counts,
 * ☍ Chains, ↑ Import and the usage pill. Composer, track chip and empty state live in the page.
 */
export function MinimalHome({ selection, onSelectionChange, onSnapshot, onOpenImport }: MinimalHomeProps) {
  const { locale, t } = useLocale();
  const m = metersText(locale);
  const [snapshot, setSnapshot] = useState<GraphSnapshot>(EMPTY_GRAPH);
  const [isChainsOpen, setIsChainsOpen] = useState(false);
  const fingerprintRef = useRef("");
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

  const loadGraph = useCallback(async () => {
    try {
      const data = await getGraphSnapshot();
      const fingerprint = JSON.stringify({ ...data, updated_at: null });
      if (fingerprint === fingerprintRef.current) return;
      fingerprintRef.current = fingerprint;
      setSnapshot(data);
      onSnapshotRef.current?.(data);
    } catch (err) {
      console.error("[MinimalHome] Failed to fetch graph snapshot:", err);
    }
  }, []);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  // notify -> fetch
  useEventSubscription(GRAPH_EVENTS, () => {
    void loadGraph();
  });

  const counts = useMemo(() => homeCounts(snapshot), [snapshot]);
  const validIds = useMemo(() => new Set(snapshot.nodes.map((n) => n.id)), [snapshot.nodes]);
  const sessionTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of snapshot.clusters) if (c.kind === "session" || c.kind === "notes") map.set(c.id, c.label);
    for (const n of snapshot.nodes) for (const s of n.sessions) if (!map.has(s.session_id)) map.set(s.session_id, s.title);
    return map;
  }, [snapshot]);

  return (
    <div className="relative w-full h-full overflow-hidden bg-background">
      <div className="absolute top-4 left-4 right-4 flex items-start justify-between gap-2 pointer-events-none z-10">
        <div className="pointer-events-auto">
          <NavDrawerButton className="bg-card/85 backdrop-blur border border-border" />
        </div>
        <div className="flex flex-col items-end gap-1.5 min-w-0">
          <div className="flex flex-wrap items-center justify-end gap-2 pointer-events-auto">
            <button type="button" onClick={() => setIsChainsOpen((o) => !o)} className={chromeButton} title={t.tipChains} aria-pressed={isChainsOpen}>
              <span>☍ Chains</span>
              {snapshot.chains.length > 0 && (
                <span className="bg-accent text-muted-foreground text-[10px] px-1.5 rounded-full border border-border">
                  {snapshot.chains.length}
                </span>
              )}
            </button>
            <button type="button" onClick={onOpenImport} className={chromeButton} title={t.tipImport}>
              <span>{t.importPill}</span>
            </button>
          </div>
          <UsagePill className="pointer-events-auto" />
        </div>
      </div>

      <p
        role="status"
        aria-label={m.minimalHome}
        className="absolute inset-x-0 top-[84px] text-center font-ui text-[12.5px] text-muted-foreground tabular-nums px-4"
      >
        {[m.countNodes(counts.nodes), m.countChains(counts.chains), m.countSessions(counts.sessions), m.countSources(counts.sources)].join(" · ")}
      </p>

      {isChainsOpen && (
        <ChainTable
          chains={snapshot.chains}
          selection={selection}
          validIds={validIds}
          sessionTitles={sessionTitles}
          onToggleChain={(c) => onSelectionChange(toggleChain(selection, c, validIds))}
          onFocusNode={() => setIsChainsOpen(false)}
          onClose={() => setIsChainsOpen(false)}
        />
      )}
    </div>
  );
}
