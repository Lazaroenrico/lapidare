"use client";

import React, { useMemo, useState } from "react";
import { ChevronRight, Layers, Minimize2, X } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { DEFAULT_LAYOUT, layoutDag, wrapLabel } from "@/lib/plan-layout";
import type { PlanDag, PlanNode, PlanNodeStatus } from "@/lib/types";

interface PlanWindowProps {
  plan?: PlanDag | null;
  sourceName?: string;
  onSelectCitation?: (sourceName: string, paragraphId: string) => void;
  className?: string;
}

const STATUS_ORDER: PlanNodeStatus[] = ["current", "visited", "mastered", "needs_review", "pending"];

/** Token-only SVG classes per node status. */
const NODE_STYLE: Record<PlanNodeStatus, { box: string; text: string; dash?: string; width: number; glyph?: string; glyphClass?: string }> = {
  current: { box: "fill-accent stroke-warning", text: "fill-foreground", width: 2, glyph: "●", glyphClass: "fill-warning" },
  visited: { box: "fill-card stroke-muted-foreground", text: "fill-foreground", width: 1 },
  mastered: { box: "fill-card stroke-success", text: "fill-foreground", width: 1.5, glyph: "✓", glyphClass: "fill-success" },
  needs_review: { box: "fill-card stroke-danger", text: "fill-foreground", width: 1.5, dash: "5 3", glyph: "↺", glyphClass: "fill-danger" },
  pending: { box: "fill-background stroke-border", text: "fill-muted-foreground", width: 1, dash: "4 3" },
};

const SWATCH: Record<PlanNodeStatus, string> = {
  current: "border-warning bg-accent",
  visited: "border-muted-foreground bg-card",
  mastered: "border-success bg-card",
  needs_review: "border-danger border-dashed bg-card",
  pending: "border-border border-dashed bg-background",
};

const LINE_CHARS = 19;
const LINE_HEIGHT = 13;

export function PlanWindow({ plan, sourceName, onSelectCitation, className = "" }: PlanWindowProps) {
  const { t } = useLocale();
  const [isMinimized, setIsMinimized] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nodes = useMemo(() => plan?.nodes ?? [], [plan]);
  const layout = useMemo(() => layoutDag(nodes), [nodes]);

  if (nodes.length === 0) return null;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const mastered = nodes.filter((n) => n.status === "mastered").length;
  const progress = Math.round((mastered / nodes.length) * 100);
  const current = nodes.find((n) => n.status === "current");
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const { nodeWidth: w, nodeHeight: h } = DEFAULT_LAYOUT;

  if (isMinimized) {
    return (
      <div className={`fixed bottom-36 right-6 z-30 ${className}`}>
        <button
          type="button"
          onClick={() => setIsMinimized(false)}
          className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-card hover:bg-accent border border-border hover:border-muted-foreground text-foreground shadow-2xl transition-colors cursor-pointer font-ui text-xs group"
          title={t.planExpand}
          aria-label={t.planExpand}
        >
          <Layers className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground" />
          <span className="font-semibold tracking-wider text-[11px]">{t.planPill(mastered, nodes.length)}</span>
          {current && <span className="w-2 h-2 rounded-full bg-warning" />}
        </button>
      </div>
    );
  }

  const nodeAria = (n: PlanNode) => `${n.label} · ${t.planStatus(n.status)}`;

  return (
    <aside
      className={`fixed bottom-36 right-6 w-[calc(100vw-48px)] max-w-md max-h-[min(72vh,calc(100vh-230px))] flex flex-col z-30 shadow-2xl rounded-lg overflow-hidden bg-card border border-border font-ui text-xs ${className}`}
      aria-label={t.planAria}
    >
      <div className="px-3.5 py-2.5 bg-background border-b border-border flex items-center justify-between select-none">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-foreground text-[11.5px] uppercase tracking-wider">{t.planHeading}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] text-muted-foreground px-1.5 py-0.5 rounded bg-card border border-accent">
            {mastered}/{nodes.length} ({progress}%)
          </span>
          <button
            type="button"
            onClick={() => setIsMinimized(true)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-accent cursor-pointer"
            title={t.planMinimize}
            aria-label={t.planMinimize}
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="w-full h-1 bg-background">
        <div className="h-full bg-success/70 transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col">
        {plan?.approach_prose && (
          <details className="group border-b border-accent px-3.5 py-2">
            <summary className="cursor-pointer list-none flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
              <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
              {t.planApproach}
            </summary>
            <p className="mt-2 font-prose text-[13px] leading-relaxed text-foreground whitespace-pre-wrap select-text">
              {plan.approach_prose}
            </p>
          </details>
        )}

        <div className="overflow-x-auto px-1 py-2">
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="group"
            aria-label={t.planDagAria}
            className="mx-auto block"
          >
            <defs>
              <marker id="plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground" />
              </marker>
            </defs>
            {layout.edges.map((edge) => {
              const lit = byId.get(edge.to)?.status === "current" || edge.from === selectedId || edge.to === selectedId;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  d={edge.d}
                  fill="none"
                  strokeWidth={lit ? 1.5 : 1}
                  className={lit ? "stroke-muted-foreground" : "stroke-border"}
                  markerEnd="url(#plan-arrow)"
                />
              );
            })}
            {nodes.map((node) => {
              const pos = layout.positions[node.id];
              if (!pos) return null;
              const style = NODE_STYLE[node.status] ?? NODE_STYLE.pending;
              const lines = wrapLabel(node.label, LINE_CHARS, 2);
              const textTop = pos.y + h / 2 - ((lines.length - 1) * LINE_HEIGHT) / 2;
              const isSelected = node.id === selectedId;
              return (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={nodeAria(node)}
                  aria-pressed={isSelected}
                  className="cursor-pointer"
                  onClick={() => setSelectedId((prev) => (prev === node.id ? null : node.id))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedId((prev) => (prev === node.id ? null : node.id));
                    }
                  }}
                >
                  <title>{nodeAria(node)}</title>
                  <rect
                    x={pos.x}
                    y={pos.y}
                    width={w}
                    height={h}
                    rx={6}
                    strokeWidth={isSelected ? style.width + 1 : style.width}
                    strokeDasharray={style.dash}
                    className={style.box}
                  />
                  <text textAnchor="middle" fontSize={10.5} className={`font-ui ${style.text}`}>
                    {lines.map((line, i) => (
                      <tspan key={i} x={pos.x + w / 2} y={textTop + i * LINE_HEIGHT} dominantBaseline="middle">
                        {line}
                      </tspan>
                    ))}
                  </text>
                  {style.glyph && (
                    <text x={pos.x + w - 8} y={pos.y + 11} textAnchor="middle" fontSize={10} className={`font-ui ${style.glyphClass}`}>
                      {style.glyph}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-1 px-3.5 pb-2 text-[10px] text-muted-foreground">
          {STATUS_ORDER.map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span className={`w-2.5 h-2.5 rounded-sm border ${SWATCH[s]}`} />
              {t.planStatus(s)}
            </span>
          ))}
        </div>

        {!selected && <p className="px-3.5 pb-3 text-[10.5px] text-muted-foreground">{t.planNodeHint}</p>}

        {selected && (
          <div className="border-t border-border bg-background p-3 flex flex-col gap-2.5 select-text">
            <div className="flex items-start justify-between gap-2 pb-1 border-b border-accent">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="font-prose text-[13.5px] text-foreground leading-snug">{selected.label}</span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t.planStatus(selected.status)}
                  {selected.kind === "goal" && ` · ${t.planGoal}`}
                  {selected.kind === "unconditional_truth" && ` · ${t.planBase}`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="text-muted-foreground hover:text-foreground p-0.5 cursor-pointer"
                title={t.close}
                aria-label={t.close}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {selected.depends_on.length > 0 && (
              <span className="text-[10.5px] text-muted-foreground">
                {t.planRequires(selected.depends_on.map((d) => byId.get(d)?.label ?? d).join(", "))}
              </span>
            )}

            {selected.dimensions && (
              <div className="flex flex-col gap-2">
                <span className="text-[10.5px] text-muted-foreground">{t.planDimsTitle}</span>
                {selected.dimensions.what_was_said && (
                  <DimBlock title={t.dimSaid}>
                    <p>{selected.dimensions.what_was_said}</p>
                  </DimBlock>
                )}
                <DimList title={t.dimAssumed} items={selected.dimensions.what_was_assumed} />
                <DimList title={t.dimSkipped} items={selected.dimensions.what_was_skipped} />
                <DimList title={t.dimSimplifications} items={selected.dimensions.simplifications} />
                {selected.dimensions.source_anchors.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-accent">
                    <span className="text-[10px] text-muted-foreground">{t.dimAnchors}</span>
                    {selected.dimensions.source_anchors.map((anchor) => (
                      <button
                        key={anchor}
                        type="button"
                        onClick={() => onSelectCitation?.(sourceName || t.sourceFallback, anchor.replace(/^#?\^?/, ""))}
                        className="px-1.5 py-0.5 rounded bg-card hover:bg-accent border border-border hover:border-muted-foreground text-foreground text-[10px] transition-colors cursor-pointer"
                      >
                        #{anchor.startsWith("^") ? anchor : `^${anchor}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function DimBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase font-semibold text-muted-foreground">{title}</span>
      <div className="font-prose text-[12px] text-foreground leading-relaxed">{children}</div>
    </div>
  );
}

function DimList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <DimBlock title={title}>
      <ul className="list-disc pl-4 space-y-0.5">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </DimBlock>
  );
}
