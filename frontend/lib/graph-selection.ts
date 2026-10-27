/**
 * Pure node-selection set operations. A selection is an order-preserving list
 * of unique node ids (insertion order = the order the learner picked them).
 */

import type { LogicalChain } from "./types";

export type Selection = readonly string[];

/** Backend limit for `graph_context` in POST /api/chats. */
export const MAX_GRAPH_CONTEXT = 64;

export const isSelected = (sel: Selection, id: string) => sel.includes(id);

export function addIds(sel: Selection, ids: readonly string[]): string[] {
  const out = [...sel];
  for (const id of ids) if (id && !out.includes(id)) out.push(id);
  return out;
}

export function removeIds(sel: Selection, ids: readonly string[]): string[] {
  const drop = new Set(ids);
  return sel.filter((id) => !drop.has(id));
}

export const toggleId = (sel: Selection, id: string): string[] =>
  isSelected(sel, id) ? removeIds(sel, [id]) : addIds(sel, [id]);

/** Drops ids that no longer exist in the graph (e.g. after a delete). Same reference when unchanged. */
export function pruneSelection(sel: Selection, validIds: ReadonlySet<string>): Selection {
  const kept = sel.filter((id) => validIds.has(id));
  return kept.length === sel.length ? sel : kept;
}

/** Node ids a chain touches (premises + conclusion), unique. */
export const chainNodeIds = (chain: Pick<LogicalChain, "premises" | "conclusion">): string[] =>
  addIds([], [...chain.premises, chain.conclusion]);

export type ChainSelectionState = "all" | "some" | "none";

export function chainSelectionState(
  sel: Selection,
  chain: Pick<LogicalChain, "premises" | "conclusion">,
  validIds?: ReadonlySet<string>,
): ChainSelectionState {
  const ids = chainNodeIds(chain).filter((id) => !validIds || validIds.has(id));
  if (ids.length === 0) return "none";
  const hits = ids.filter((id) => sel.includes(id)).length;
  return hits === 0 ? "none" : hits === ids.length ? "all" : "some";
}

/** Checkbox semantics: a fully selected chain is removed, otherwise all of its nodes are added. */
export function toggleChain(
  sel: Selection,
  chain: Pick<LogicalChain, "premises" | "conclusion">,
  validIds?: ReadonlySet<string>,
): string[] {
  const ids = chainNodeIds(chain).filter((id) => !validIds || validIds.has(id));
  return chainSelectionState(sel, chain, validIds) === "all" ? removeIds(sel, ids) : addIds(sel, ids);
}

/** `graph_context` payload: unique ids, capped at the backend limit. */
export const graphContextPayload = (sel: Selection): string[] => addIds([], sel).slice(0, MAX_GRAPH_CONTEXT);
