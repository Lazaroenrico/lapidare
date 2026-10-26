"use client";

import React, { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Compass,
  CornerDownRight,
  FileText,
  Info,
  Layers,
  Minimize2,
  RotateCcw,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import type { DenseBlockDimensions, PlanDag, PlanNode } from "@/lib/types";
import { useLocale } from "./locale-provider";

interface ExtendedPlanNode extends PlanNode {
  dimensions?: DenseBlockDimensions;
}

interface PlanWindowProps {
  plan?: PlanDag | null;
  activeNodeId?: string;
  sourceName?: string;
  onSelectNode?: (nodeId: string) => void;
  onSelectCitation?: (sourceName: string, paragraphId: string) => void;
  blockDimensions?: Record<number, DenseBlockDimensions>;
  className?: string;
}

export function PlanWindow({
  plan,
  activeNodeId,
  sourceName,
  onSelectNode,
  onSelectCitation,
  blockDimensions,
  className = "",
}: PlanWindowProps) {
  const { t } = useLocale();
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  if (!plan || !plan.nodes || plan.nodes.length === 0) {
    return null;
  }

  const nodes = plan.nodes as ExtendedPlanNode[];
  const masteredCount = nodes.filter((n) => n.status === "mastered").length;
  const totalCount = nodes.length;
  const progressPercent = Math.round((masteredCount / totalCount) * 100);

  // Identify root nodes (no dependencies or empty)
  const rootNodeIds = new Set(
    nodes
      .filter((n) => !n.dependencies || n.dependencies.length === 0)
      .map((n) => n.id)
  );

  // Identify goal node (last node in the plan, or sink node)
  const goalNodeId = nodes[nodes.length - 1]?.id;

  // Currently inspected node for 4-dimension drawer/modal
  const inspectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId)
    : null;

  // Retrieve dimensions either from node property or from blockDimensions map
  const getNodeDimensions = (node: ExtendedPlanNode): DenseBlockDimensions | undefined => {
    if (node.dimensions) return node.dimensions;
    if (
      blockDimensions &&
      node.source_block_idx !== undefined &&
      blockDimensions[node.source_block_idx]
    ) {
      return blockDimensions[node.source_block_idx];
    }
    return undefined;
  };

  const inspectedDimensions = inspectedNode ? getNodeDimensions(inspectedNode) : undefined;

  // Render status badge for a node
  const renderStatusIcon = (status: PlanNode["status"], isCurrent: boolean) => {
    if (status === "mastered") {
      return (
        <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
      );
    }
    if (isCurrent || status === "current") {
      return (
        <div className="relative flex items-center justify-center shrink-0">
          <span className="w-3.5 h-3.5 rounded-full bg-warning/30 animate-ping absolute" />
          <span className="w-2.5 h-2.5 rounded-full bg-warning shrink-0" />
        </div>
      );
    }
    if (status === "review") {
      return <RotateCcw className="w-3.5 h-3.5 text-warning shrink-0" />;
    }
    return <Circle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
  };

  // Minimized floating pill in bottom-right
  if (isMinimized) {
    return (
      <div className={`fixed bottom-20 right-6 z-30 ${className}`}>
        <button
          type="button"
          onClick={() => setIsMinimized(false)}
          className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-card hover:bg-accent border border-border hover:border-muted-foreground text-foreground shadow-2xl transition-all cursor-pointer font-ui text-xs active:scale-95 group"
          title={t.planExpand}
        >
          <Layers className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground" />
          <span className="font-semibold tracking-wider text-[11px]">
            {t.planPill(masteredCount, totalCount)}
          </span>
          <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
        </button>
      </div>
    );
  }

  return (
    <aside
      className={`fixed bottom-20 right-6 w-80 md:w-96 max-h-[72vh] flex flex-col z-30 shadow-2xl rounded-lg overflow-hidden bg-card border border-border transition-all font-ui text-xs ${className}`}
      aria-label={t.planAria}
    >
      {/* Top Header */}
      <div className="px-3.5 py-2.5 bg-background border-b border-border flex items-center justify-between select-none">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-muted-foreground" />
          <span className="font-bold text-foreground text-[11.5px] uppercase tracking-wider">
            {t.planHeading}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-card border border-accent">
            {masteredCount}/{totalCount} ({progressPercent}%)
          </span>
          <button
            type="button"
            onClick={() => setIsMinimized(true)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-accent"
            title={t.planMinimize}
            aria-label={t.planMinimize}
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full h-1 bg-background">
        <div
          className="h-full bg-success/70 transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Node DAG List */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 select-text">
        {nodes.map((node, idx) => {
          const isCurrent =
            node.id === (activeNodeId || plan.current_node_id);
          const isRoot = rootNodeIds.has(node.id);
          const isGoal = node.id === goalNodeId;
          const isSelected = selectedNodeId === node.id;
          const dimensions = getNodeDimensions(node);

          return (
            <div
              key={node.id}
              className={`group flex flex-col p-2.5 rounded border transition-all cursor-pointer ${
                isCurrent
                  ? "bg-accent border-warning/60 shadow-sm"
                  : isSelected
                  ? "bg-accent border-muted-foreground"
                  : "bg-background border-accent hover:border-border hover:bg-card"
              }`}
              onClick={() => {
                setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
                if (onSelectNode) onSelectNode(node.id);
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  <div className="mt-0.5">
                    {renderStatusIcon(node.status, isCurrent)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-foreground text-[12px] font-prose leading-snug">
                        {node.title}
                      </span>

                      {/* Badges */}
                      {isRoot && (
                        <span className="text-[9px] uppercase tracking-wider px-1 py-0.2 rounded bg-card border border-border text-muted-foreground">
                          {t.planBase}
                        </span>
                      )}
                      {isGoal && (
                        <span className="text-[9px] uppercase tracking-wider px-1 py-0.2 rounded bg-warning/20 border border-warning/40 text-warning">
                          {t.planGoal}
                        </span>
                      )}
                      {isCurrent && (
                        <span className="text-[9px] uppercase tracking-wider px-1 py-0.2 rounded bg-warning/20 border border-warning/40 text-warning font-bold">
                          {t.planCurrent}
                        </span>
                      )}
                    </div>

                    {node.summary && (
                      <p className="text-[11px] text-muted-foreground font-prose line-clamp-1 mt-0.5">
                        {node.summary}
                      </p>
                    )}
                  </div>
                </div>

                {/* Dimensions indicator tag */}
                {dimensions && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedNodeId((prev) =>
                        prev === node.id ? null : node.id
                      );
                    }}
                    className="px-1.5 py-0.5 rounded text-[9.5px] font-ui bg-card border border-border hover:border-muted-foreground text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                    title={t.planDimsTitle}
                  >
                    4D
                  </button>
                )}
              </div>

              {/* Dependencies hint */}
              {node.dependencies && node.dependencies.length > 0 && (
                <div className="flex items-center gap-1 mt-1.5 text-[9.5px] text-muted-foreground">
                  <CornerDownRight className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">
                    {t.planRequires(node.dependencies.join(", "))}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 4-Dimensions Drawer (When a node is inspected) */}
      {inspectedNode && inspectedDimensions && (
        <div className="border-t border-border bg-background p-3 max-h-56 overflow-y-auto flex flex-col gap-2.5 select-text">
          <div className="flex items-center justify-between pb-1 border-b border-accent">
            <span className="font-semibold text-foreground text-[11px] tracking-wide truncate">
              {t.planDimsHeading(inspectedNode.title)}
            </span>
            <button
              type="button"
              onClick={() => setSelectedNodeId(null)}
              className="text-muted-foreground hover:text-foreground p-0.5"
              title={t.close}
              aria-label={t.close}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Dito */}
          {inspectedDimensions.what_was_said && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase font-bold text-muted-foreground">
                {t.dimSaid}
              </span>
              <p className="font-prose text-[12px] text-foreground leading-relaxed">
                {inspectedDimensions.what_was_said}
              </p>
            </div>
          )}

          {/* Pressuposto */}
          {inspectedDimensions.what_was_assumed &&
            inspectedDimensions.what_was_assumed.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase font-bold text-foreground">
                  {t.dimAssumed}
                </span>
                <ul className="list-disc pl-4 font-prose text-[11.5px] text-foreground space-y-0.5">
                  {inspectedDimensions.what_was_assumed.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

          {/* Pulado */}
          {inspectedDimensions.what_was_skipped &&
            inspectedDimensions.what_was_skipped.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase font-bold text-warning">
                  {t.dimSkipped}
                </span>
                <ul className="list-disc pl-4 font-prose text-[11.5px] text-foreground space-y-0.5">
                  {inspectedDimensions.what_was_skipped.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

          {/* Simplificações */}
          {inspectedDimensions.simplifications &&
            inspectedDimensions.simplifications.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase font-bold text-muted-foreground">
                  {t.dimSimplifications}
                </span>
                <ul className="list-disc pl-4 font-prose text-[11.5px] text-foreground space-y-0.5">
                  {inspectedDimensions.simplifications.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

          {/* Source Anchors */}
          {inspectedDimensions.source_anchors &&
            inspectedDimensions.source_anchors.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-accent">
                <span className="text-[10px] text-muted-foreground">{t.dimAnchors}</span>
                {inspectedDimensions.source_anchors.map((anchor) => (
                  <button
                    key={anchor}
                    type="button"
                    onClick={() => {
                      if (onSelectCitation) {
                        onSelectCitation(
                          sourceName || t.sourceFallback,
                          anchor.replace(/^#?\^?/, "")
                        );
                      }
                    }}
                    className="px-1.5 py-0.5 rounded bg-card hover:bg-accent border border-border hover:border-muted-foreground text-foreground text-[10px] font-ui transition-colors cursor-pointer"
                  >
                    #{anchor.startsWith("^") ? anchor : `^${anchor}`}
                  </button>
                ))}
              </div>
            )}
        </div>
      )}
    </aside>
  );
}
