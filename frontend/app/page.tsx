"use client";

import { useEventSubscription } from "@/components/server-events";
import { useLocale } from "@/components/locale-provider";
import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { GraphView } from "@/components/graph-view";
import { Composer, type SelectedNodeRef } from "@/components/composer";
import { ImportDialog } from "@/components/import-dialog";
import { HomeEmptyState } from "@/components/home-empty-state";
import { openSetup } from "@/components/setup-gate";
import { getSetupStatus } from "@/lib/api";
import { pruneSelection, type Selection } from "@/lib/graph-selection";
import type { GraphSnapshot, RoadmapItem, SetupStatusResponse, SseEventType } from "@/lib/types";

const SETUP_EVENTS: SseEventType[] = ["config:updated", "vault:changed"];

/** Reports `?focus=<node_id>` (links from PRACTICE target chips). Isolated so only it needs Suspense. */
function FocusParam({ onChange }: { onChange: (id: string | null) => void }) {
  const focus = useSearchParams().get("focus");
  useEffect(() => onChange(focus || null), [focus, onChange]);
  return null;
}

/**
 * Home híbrida (Fase 8B): full-bleed graph with floating chrome on top and the
 * composer dock at the bottom. Node selection lives here because the graph
 * produces it and the composer chip consumes it.
 */
export default function HomePage() {
  const { t } = useLocale();
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [pendingTopic, setPendingTopic] = useState("");
  const [selection, setSelection] = useState<Selection>([]);
  const [nodeNames, setNodeNames] = useState<Map<string, string>>(new Map());
  const [focusId, setFocusId] = useState<string | null>(null);
  /** Graph counts for the empty Home (Fase 18); `loaded` flips on the first snapshot. */
  const [graphInfo, setGraphInfo] = useState<{ loaded: boolean; nodeCount: number; roadmap: RoadmapItem[] }>({
    loaded: false,
    nodeCount: 0,
    roadmap: [],
  });

  const refreshSetup = useCallback(() => {
    getSetupStatus()
      .then((status) => {
        setSetupStatus(status);
        setSetupError(null);
      })
      .catch((err) => setSetupError(err instanceof Error ? err.message : t.setupUnavailable));
  }, [t.setupUnavailable]);

  useEffect(() => {
    refreshSetup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEventSubscription(SETUP_EVENTS, () => refreshSetup());

  const handleSnapshot = useCallback((snapshot: GraphSnapshot) => {
    setNodeNames(new Map(snapshot.nodes.map((n) => [n.id, n.name])));
    setGraphInfo({ loaded: true, nodeCount: snapshot.nodes.length, roadmap: snapshot.roadmap });
    const valid = new Set(snapshot.nodes.map((n) => n.id));
    setSelection((prev) => pruneSelection(prev, valid));
  }, []);

  const selectedNodes = useMemo<SelectedNodeRef[]>(
    () => selection.filter((id) => nodeNames.has(id)).map((id) => ({ id, name: nodeNames.get(id) as string })),
    [selection, nodeNames],
  );

  const handleOpenSetupWithTopic = (text?: string) => {
    if (text) setPendingTopic(text);
    openSetup();
  };

  return (
    <div className="relative w-full h-full flex-1 overflow-hidden bg-background">
      {setupError && (
        <p role="alert" className="absolute top-16 left-4 z-30 p-2 font-ui text-xs text-danger bg-card border border-border rounded">
          {setupError}
        </p>
      )}

      <Suspense fallback={null}>
        <FocusParam onChange={setFocusId} />
      </Suspense>

      {/* Full-bleed graph (single unified view, no Macro/Micro toggle) */}
      <div className="absolute inset-0">
        <GraphView
          selection={selection}
          onSelectionChange={setSelection}
          onSnapshot={handleSnapshot}
          onOpenImport={() => setIsImportOpen(true)}
          focusId={focusId}
        />
      </div>

      {/* Fase 18: first steps over the empty canvas (gone once the first node arrives) */}
      <HomeEmptyState graphLoaded={graphInfo.loaded} nodeCount={graphInfo.nodeCount} roadmap={graphInfo.roadmap} />

      {/* Floating composer dock (selection chip + track chip above it) */}
      <div className="absolute bottom-4 left-0 right-0 px-4 pointer-events-none z-20">
        <div>
          <Composer
            className="pointer-events-auto"
            initialized={setupStatus?.initialized ?? false}
            trackConfig={setupStatus?.config?.track}
            strongSlot={setupStatus?.config?.slots?.strong}
            selectedNodes={selectedNodes}
            onClearSelection={() => setSelection([])}
            initialTopic={pendingTopic}
            onOpenSetup={handleOpenSetupWithTopic}
          />
        </div>
      </div>

      <ImportDialog isOpen={isImportOpen} onClose={() => setIsImportOpen(false)} />
    </div>
  );
}
