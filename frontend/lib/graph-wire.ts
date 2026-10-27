/**
 * Pure decoder for GET /api/graph. Accepts the Fase 8B snapshot
 * (propositions, chains with ids, clusters[], roadmap[]) and the older shape
 * (nodes with title/summary/cluster/file_path, chains whose premises are names).
 */

import type {
  ConceptNode,
  ConceptStatus,
  GraphCluster,
  GraphClusterKind,
  GraphEdge,
  GraphSnapshot,
  LogicalChain,
  NodeSessionRef,
  RoadmapItem,
} from "./types";
import { decodeNodeSources } from "./notes-import";

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const STATUSES: readonly ConceptStatus[] = ["aprendendo", "sólido", "revisar"];
const CLUSTER_KINDS: readonly GraphClusterKind[] = ["session", "notes", "legacy"];
/** Roadmap statuses that mean "already done" (never drawn as ghosts). */
const DONE_STATUSES = new Set(["completed", "done", "mastered", "concluded"]);

export const EMPTY_GRAPH: GraphSnapshot = { nodes: [], edges: [], chains: [], clusters: [], roadmap: [] };

function decodeSessions(raw: unknown): NodeSessionRef[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeSessionRef[] = [];
  for (const s of raw) {
    if (typeof s === "string" && s) {
      out.push({ session_id: s, title: s, message_id: null });
      continue;
    }
    if (!isObj(s)) continue;
    const id = str(s.session_id ?? s.id);
    if (!id) continue;
    out.push({ session_id: id, title: str(s.title) || id, message_id: str(s.message_id) || null });
  }
  return out;
}

export function decodeNode(raw: unknown): ConceptNode | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.name) || str(raw.title) || id;
  if (!id || !name) return null;
  const statement = str(raw.statement) || str(raw.summary);
  const status = STATUSES.find((s) => s === raw.status);
  const filePath = str(raw.vault_rel_path) || str(raw.file_path);
  return {
    id,
    name,
    statement,
    summary: statement,
    ...(status ? { status } : {}),
    file_path: filePath,
    depends_on: strList(raw.depends_on),
    aliases: strList(raw.aliases),
    sessions: decodeSessions(raw.sessions),
    sources: decodeNodeSources(raw.sources),
    cluster: str(raw.cluster) || undefined,
    x: num(raw.x),
    y: num(raw.y),
  };
}

/** Resolves a chain endpoint (id or legacy name) to a node id when possible. */
function resolver(nodes: ConceptNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byName = new Map<string, ConceptNode>();
  for (const n of nodes) {
    byName.set(n.name.toLowerCase(), n);
    for (const a of n.aliases) if (!byName.has(a.toLowerCase())) byName.set(a.toLowerCase(), n);
  }
  return (ref: string): ConceptNode | null => byId.get(ref) ?? byName.get(ref.toLowerCase()) ?? null;
}

export const chainExpression = (premises: string[], conclusion: string) =>
  `${premises.join(" ∧ ")} ⟹ ${conclusion}`;

function decodeChains(raw: unknown, nodes: ConceptNode[]): LogicalChain[] {
  if (!Array.isArray(raw)) return [];
  const resolve = resolver(nodes);
  const out: LogicalChain[] = [];
  raw.forEach((c, i) => {
    if (!isObj(c)) return;
    const rawPremises = strList(c.premises);
    const rawConclusion = str(c.conclusion);
    if (!rawConclusion) return;
    const premiseNodes = rawPremises.map(resolve);
    const conclusionNode = resolve(rawConclusion);
    const premises = rawPremises.map((p, k) => premiseNodes[k]?.id ?? p);
    const premiseNames = rawPremises.map((p, k) => premiseNodes[k]?.name ?? p);
    const conclusionName = conclusionNode?.name ?? rawConclusion;
    out.push({
      id: str(c.id) || `chain-${i}`,
      premises,
      conclusion: conclusionNode?.id ?? rawConclusion,
      premise_names: premiseNames,
      conclusion_name: conclusionName,
      expression: str(c.expression) || str(c.formula) || chainExpression(premiseNames, conclusionName),
      created_at: str(c.created_at) || undefined,
      session_id: str(c.session_id) || str(c.source_session_id) || undefined,
      notes: str(c.notes) || undefined,
    });
  });
  return out;
}

function decodeEdges(raw: unknown, chains: LogicalChain[], nodeIds: Set<string>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (e: GraphEdge) => {
    const key = `${e.source}->${e.target}`;
    if (e.source === e.target || seen.has(key) || !nodeIds.has(e.source) || !nodeIds.has(e.target)) return;
    seen.add(key);
    edges.push(e);
  };
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (!isObj(e)) continue;
      const kind = str(e.kind);
      push({
        source: str(e.source),
        target: str(e.target),
        kind: (["dependency", "implication", "reinforces", "chain"] as const).find((k) => k === kind) ?? "dependency",
      });
    }
  }
  // Older snapshots may omit derived chain edges: premise → conclusion.
  for (const c of chains) for (const p of c.premises) push({ source: p, target: c.conclusion, kind: "chain" });
  return edges;
}

/** clusters[] from the server, or grouped from `node.cluster` (label = birth-session title when known). */
export function deriveClusters(rawClusters: unknown, nodes: ConceptNode[]): GraphCluster[] {
  const counts = new Map<string, number>();
  for (const n of nodes) if (n.cluster) counts.set(n.cluster, (counts.get(n.cluster) ?? 0) + 1);
  const fromServer: GraphCluster[] = [];
  if (Array.isArray(rawClusters)) {
    for (const c of rawClusters) {
      if (!isObj(c)) continue;
      const id = str(c.id);
      if (!id) continue;
      const kind = CLUSTER_KINDS.find((k) => k === c.kind) ?? "session";
      const path = str(c.path);
      fromServer.push({ id, label: str(c.label) || id, kind, size: num(c.size) ?? counts.get(id) ?? 0, ...(path ? { path } : {}) });
    }
  }
  if (fromServer.length > 0) return fromServer;
  const out: GraphCluster[] = [];
  for (const [id, size] of counts) {
    const titled = nodes.find((n) => n.cluster === id)?.sessions.find((s) => s.session_id === id);
    out.push({
      id,
      label: titled?.title || id,
      kind: id === "legacy" ? "legacy" : titled ? "session" : "notes",
      size,
    });
  }
  return out;
}

/** Every step of every track (done ones too: the ⇶ Roteiro draws the whole constellation). */
function decodeRoadmap(raw: unknown): RoadmapItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RoadmapItem[] = [];
  const seen = new Set<string>();
  const queueIndex = new Map<string, number>();
  for (const r of raw) {
    if (!isObj(r)) continue;
    const id = str(r.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawStatus = str(r.status, "pending");
    const status = DONE_STATUSES.has(rawStatus) || r.completed === true ? "completed" : rawStatus === "active" ? "active" : "pending";
    const trackId = str(r.track_id) || null;
    const nth = queueIndex.get(trackId ?? "") ?? 0;
    queueIndex.set(trackId ?? "", nth + 1);
    const mod = isObj(r.module) ? r.module : null;
    const sub = isObj(r.submodule) && str(r.submodule.id) ? r.submodule : null;
    out.push({
      id,
      title: str(r.title) || id,
      status,
      linked_node_ids: strList(r.linked_node_ids),
      depends_on: strList(r.depends_on),
      track_id: trackId,
      track_title: str(r.track_title) || null,
      order: num(r.order) ?? nth,
      kind: str(r.kind, "mentoria"),
      status_detail: str(r.status_detail),
      stage_label: str(r.stage_label),
      source_ref: str(r.source_ref) || null,
      module: mod && str(mod.id)
        ? { id: str(mod.id), title: str(mod.title), order: num(mod.order) ?? 0 }
        : { id: "track", title: "", order: 0 },
      submodule: sub ? { id: str(sub.id), title: str(sub.title) || str(sub.id) } : null,
    });
  }
  return out;
}

export const isRoadmapDone = (item: Pick<RoadmapItem, "status">) => item.status === "completed";

export function decodeGraph(raw: unknown): GraphSnapshot {
  if (!isObj(raw)) return EMPTY_GRAPH;
  const nodes: ConceptNode[] = [];
  const ids = new Set<string>();
  if (Array.isArray(raw.nodes)) {
    for (const n of raw.nodes) {
      if (isObj(n) && n.ghost === true) continue;
      const node = decodeNode(n);
      if (node && !ids.has(node.id)) {
        ids.add(node.id);
        nodes.push(node);
      }
    }
  }
  const chains = decodeChains(raw.chains, nodes);
  return {
    nodes,
    edges: decodeEdges(raw.edges, chains, ids),
    chains,
    clusters: deriveClusters(raw.clusters, nodes),
    roadmap: decodeRoadmap(raw.roadmap),
    updated_at: str(raw.updated_at) || undefined,
  };
}

/**
 * Track item id behind a roadmap ghost: "track:<track_id>:<item_id>" (Fase 14,
 * pass the item's `track_id`) or legacy "track:<item_id>" → "<item_id>".
 */
export const trackItemIdOf = (roadmapId: string, trackId?: string | null) => {
  const rest = roadmapId.replace(/^track:/, "");
  return trackId && rest.startsWith(`${trackId}:`) ? rest.slice(trackId.length + 1) : rest;
};

/** Chat link that scrolls to the message where a node was born. */
export const sessionMessageHref = (ref: NodeSessionRef) =>
  `/chat/${encodeURIComponent(ref.session_id)}${ref.message_id ? `#message-${encodeURIComponent(ref.message_id)}` : ""}`;

// --- Constellation wiring (Home canvas) --------------------------------------

/** Prefix of the virtual implication-junction ids (never a real node id). */
export const JUNCTION_PREFIX = "junction:";
export const isJunctionId = (id: string) => id.startsWith(JUNCTION_PREFIX);

/** Virtual point where the premises of a ≥2-premise chain meet before the conclusion. */
export interface ConstellationJunction {
  id: string;
  chainId: string;
  premises: string[];
  conclusion: string;
  /** Cluster of the conclusion (the junction is pulled into its region). */
  cluster?: string;
}

/** A drawn line: premise→junction, junction→conclusion, or a direct node→node link. */
export interface ConstellationLink {
  source: string;
  target: string;
  kind: "premise" | "conclusion" | "direct";
}

export interface ConstellationWiring {
  junctions: ConstellationJunction[];
  links: ConstellationLink[];
}

/**
 * Builds the drawn structure of the constellation graph: every chain with ≥ 2
 * distinct resolvable premises gets one junction (premises → junction →
 * conclusion); single-premise chains, server edges and legacy `depends_on`
 * become direct lines. Premise→conclusion pairs routed through a junction are
 * not drawn again as direct lines. Junctions are virtual: callers must not count,
 * select or label them.
 */
export function buildConstellation(
  nodes: readonly ConceptNode[],
  edges: readonly GraphEdge[],
  chains: readonly LogicalChain[],
): ConstellationWiring {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byName = new Map<string, ConceptNode>();
  for (const n of nodes) {
    for (const key of [n.name, ...n.aliases]) {
      if (!byName.has(key.toLowerCase())) byName.set(key.toLowerCase(), n);
    }
  }
  const resolve = (ref: string) => byId.get(ref) ?? byName.get(ref.toLowerCase()) ?? null;

  const junctions: ConstellationJunction[] = [];
  const links: ConstellationLink[] = [];
  const routed = new Set<string>();
  const direct = new Set<string>();
  const junctionIds = new Set<string>();
  const pair = (a: string, b: string) => `${a}\u0000${b}`;
  const addDirect = (source: string, target: string) => {
    const key = pair(source, target);
    if (source === target || routed.has(key) || direct.has(key)) return;
    direct.add(key);
    links.push({ source, target, kind: "direct" });
  };

  const singles: [string, string][] = [];
  chains.forEach((chain, idx) => {
    const conclusion = resolve(chain.conclusion);
    if (!conclusion) return;
    const premises = [
      ...new Set(chain.premises.map((p) => resolve(p)?.id).filter((p): p is string => !!p && p !== conclusion.id)),
    ];
    if (premises.length === 0) return;
    if (premises.length === 1) {
      singles.push([premises[0], conclusion.id]);
      return;
    }
    let id = `${JUNCTION_PREFIX}${chain.id || idx}`;
    if (junctionIds.has(id)) id = `${id}#${idx}`;
    junctionIds.add(id);
    junctions.push({ id, chainId: chain.id, premises, conclusion: conclusion.id, cluster: conclusion.cluster });
    for (const p of premises) {
      routed.add(pair(p, conclusion.id));
      links.push({ source: p, target: id, kind: "premise" });
    }
    links.push({ source: id, target: conclusion.id, kind: "conclusion" });
  });

  for (const [s, t] of singles) addDirect(s, t);
  for (const e of edges) if (byId.has(e.source) && byId.has(e.target)) addDirect(e.source, e.target);
  for (const n of nodes) {
    for (const dep of n.depends_on) {
      const target = resolve(dep);
      if (target) addDirect(target.id, n.id);
    }
  }
  return { junctions, links };
}
