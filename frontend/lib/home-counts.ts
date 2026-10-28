/** Counts line of the minimal Home (Fase 21), taken from the graph snapshot the Home already fetches. */
import type { GraphSnapshot } from "./types";

export interface HomeCounts {
  nodes: number;
  chains: number;
  sessions: number;
  sources: number;
}

export function homeCounts(snapshot: Pick<GraphSnapshot, "nodes" | "chains" | "clusters">): HomeCounts {
  const sources = new Set<string>();
  let nodes = 0;
  for (const n of snapshot.nodes) {
    nodes += 1;
    for (const s of n.sources ?? []) if (!s.deleted && s.source_id) sources.add(s.source_id);
  }
  return {
    nodes,
    chains: snapshot.chains.length,
    sessions: snapshot.clusters.filter((c) => c.kind === "session").length,
    sources: sources.size,
  };
}
