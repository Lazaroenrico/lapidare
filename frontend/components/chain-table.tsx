"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Link2, Search, Sparkles, X } from "lucide-react";
import type { LogicalChain } from "@/lib/types";
import { chainSelectionState, type Selection } from "@/lib/graph-selection";
import { useLocale } from "./locale-provider";

type SortKey = "recent" | "conclusion" | "premises";

interface ChainTableProps {
  chains: LogicalChain[];
  selection: Selection;
  validIds: ReadonlySet<string>;
  sessionTitles: ReadonlyMap<string, string>;
  onToggleChain: (chain: LogicalChain) => void;
  onFocusNode: (id: string) => void;
  onClose: () => void;
}

/** ☍ Chains overlay: filter, sort, `A ∧ B ⟹ C` rows, checkbox → node selection. */
export function ChainTable({ chains, selection, validIds, sessionTitles, onToggleChain, onFocusNode, onClose }: ChainTableProps) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? chains.filter((c) =>
          [c.expression, c.conclusion_name, ...c.premise_names].some((s) => s.toLowerCase().includes(q)),
        )
      : chains;
    const sorted = [...filtered];
    if (sort === "recent") sorted.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    if (sort === "conclusion") sorted.sort((a, b) => a.conclusion_name.localeCompare(b.conclusion_name));
    if (sort === "premises") sorted.sort((a, b) => b.premises.length - a.premises.length);
    return sorted;
  }, [chains, query, sort]);

  const nodeChip = (id: string, name: string, conclusion = false) =>
    validIds.has(id) ? (
      <button
        type="button"
        onClick={() => onFocusNode(id)}
        className={`px-1.5 py-0.5 rounded border text-[11px] cursor-pointer transition-colors hover:bg-border ${
          conclusion ? "border-success/40 text-success bg-card" : "border-border bg-accent text-foreground"
        }`}
      >
        {name}
      </button>
    ) : (
      <span className="px-1.5 py-0.5 rounded border border-accent text-[11px] text-muted-foreground">{name}</span>
    );

  return (
    <div
      role="dialog"
      aria-label={t.chainsHeading}
      className="absolute top-16 bottom-4 right-4 w-[min(720px,calc(100%-2rem))] bg-card border border-border rounded-xl shadow-2xl z-30 flex flex-col font-ui"
    >
      <div className="p-4 border-b border-accent flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm text-foreground">{t.chainsHeading}</h2>
            <span className="text-[11px] text-muted-foreground">{t.chainsCount(chains.length)}</span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 font-prose">
            {t.chainsSubtitle} {t.chainsSelectionHint}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent transition-colors cursor-pointer"
          title={t.close}
          aria-label={t.close}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3 border-b border-accent flex items-center gap-2">
        <div className="flex-1 flex items-center bg-background border border-border rounded px-2.5 py-1.5">
          <Search className="w-3.5 h-3.5 text-muted-foreground mr-2 shrink-0" />
          <input
            type="text"
            placeholder={t.chainsFilter}
            aria-label={t.chainsFilter}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="bg-transparent text-xs text-foreground placeholder-muted-foreground w-full border-none"
          />
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {t.chainsSortLabel}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="bg-background border border-border rounded px-2 py-1.5 text-foreground text-[11px] cursor-pointer"
          >
            <option value="recent">{t.chainsSortRecent}</option>
            <option value="conclusion">{t.chainsSortConclusion}</option>
            <option value="premises">{t.chainsSortPremises}</option>
          </select>
        </label>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-xs">{query ? t.chainsNoMatch : t.chainsEmpty}</p>
            {!query && <p className="text-[11px] mt-1">{t.chainsEmptyHint}</p>}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-accent">
                <th className="w-8 p-2" />
                <th className="p-2 text-left font-normal">{t.chainsColChain}</th>
                <th className="p-2 text-left font-normal w-40">{t.chainsColSession}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const state = chainSelectionState(selection, c, validIds);
                const selectable = [...c.premises, c.conclusion].some((id) => validIds.has(id));
                return (
                  <tr key={c.id} className={`border-b border-accent ${state !== "none" ? "bg-accent/40" : ""}`}>
                    <td className="p-2 align-top">
                      <input
                        type="checkbox"
                        disabled={!selectable}
                        checked={state === "all"}
                        ref={(el) => {
                          if (el) el.indeterminate = state === "some";
                        }}
                        onChange={() => onToggleChain(c)}
                        aria-label={t.chainsSelectRow(c.expression)}
                        className="accent-foreground cursor-pointer"
                      />
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        {c.premises.map((id, i) => (
                          <React.Fragment key={`${id}-${i}`}>
                            {i > 0 && <span className="text-muted-foreground">∧</span>}
                            {nodeChip(id, c.premise_names[i] ?? id)}
                          </React.Fragment>
                        ))}
                        <span className="text-muted-foreground font-bold px-1">⟹</span>
                        {nodeChip(c.conclusion, c.conclusion_name, true)}
                      </div>
                    </td>
                    <td className="p-2 align-top text-[11px] text-muted-foreground">
                      {c.session_id ? (
                        <Link href={`/chat/${encodeURIComponent(c.session_id)}`} className="hover:text-foreground underline-offset-2 hover:underline truncate block max-w-40">
                          {sessionTitles.get(c.session_id) ?? c.session_id}
                        </Link>
                      ) : (
                        t.chainConceptual
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
