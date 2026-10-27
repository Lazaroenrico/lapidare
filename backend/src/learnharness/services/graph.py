"""Knowledge-trace service (Fase 8B): extraction triggers, snapshot, deletion, context."""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from learnharness.core.contracts.graph import BatchMessage, PropositionNode
from learnharness.core.contracts.session import SessionRecord
from learnharness.core.events import SseEventType
from learnharness.core.graph_merge import (
    chain_expression,
    coverage_index,
    format_graph_context,
    select_batch,
    uncovered_messages,
)
from learnharness.vault.graph_store import (
    append_records,
    harness_owned_note,
    load_coverage,
    load_graph_chains,
    load_nodes,
    load_positions,
    raw_chain_records,
    remove_concept_section,
    save_positions,
)
from learnharness.vault.jsonl_store import list_sessions, load_chains, load_session
from learnharness.vault.markdown_ast import scan_all_concepts
from learnharness.vault.safety import folder_map, safe_path

if TYPE_CHECKING:
    from learnharness.api.state import AppState

logger = logging.getLogger(__name__)

MAX_GRAPH_CONTEXT = 64
LEGACY_CLUSTER = "legacy"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _slug(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")


class GraphService:
    def __init__(self, state: AppState):
        self.state = state
        # Merges read-then-append the whole graph: one extraction at a time keeps ids unique.
        self.lock = asyncio.Lock()

    # ------------------------------------------------------------------ extraction

    def _uncovered(self, session: SessionRecord) -> list[BatchMessage]:
        streaming = self.state.sessions.streaming.get(session.id)
        exclude = {streaming[0]} if streaming else set()
        index = coverage_index(r for r in load_coverage(self.state.vault_path) if r.session_id == session.id)
        return uncovered_messages(session.id, ((m.id, m.role, m.content) for m in session.messages),
                                  index, exclude)

    def maybe_extract(self, session: SessionRecord) -> dict[str, Any] | None:
        """End-of-run trigger: enough uncovered teacher prose, or the session is complete."""
        if session.mode != "TEACH":
            return None
        uncovered = self._uncovered(session)
        if not uncovered:
            return None
        budget = self.state.get_config().graph.extraction_chunk_tokens
        completed = session.phase == "completed"
        if completed or sum(m.tokens for m in uncovered) >= budget:
            return self.request_extraction(session, "completed" if completed else "threshold")
        return None

    def request_extraction(self, session: SessionRecord, reason: str = "manual") -> dict[str, Any]:
        """Queue (or join the queued) extraction job of ``session``.

        PRACTICE sessions never feed the trace: the graph holds true ideas, not performance.
        """
        if session.mode == "PRACTICE":
            raise ValueError("PRACTICE sessions are not extracted into the graph")
        payload = {"session_id": session.id, "topic": session.title, "reason": reason}
        return self.state.jobs.submit("extraction", payload, key=f"extract:{session.id}",
                                      dedup_statuses=("queued",))

    async def extract_session(self, session_id: str) -> dict[str, Any]:
        """Job body: drain the session's uncovered prose, batch by batch."""
        from learnharness.pipelines.extraction import run_extraction_pipeline

        config = self.state.get_config()
        budget = config.graph.extraction_chunk_tokens
        summary: dict[str, Any] = {"session_id": session_id, "batches": 0, "new_node_ids": [],
                                   "new_chain_ids": [], "notes_written": [], "note_errors": []}
        async with self.lock:
            session = self.state.sessions.get(session_id)
            if session.mode == "PRACTICE":
                return summary  # Old queued jobs of a PRACTICE session drain to nothing.
            for _ in range(max(len(session.messages), 1)):
                batch = select_batch(self._uncovered(self.state.sessions.get(session_id)), budget)
                if not batch:
                    break
                result = await run_extraction_pipeline(
                    self.state.vault_path, session_id, batch,
                    engine=self.state.engine(config.slots.background), slot=config.slots.background,
                    session_title=session.title, language=config.language,
                )
                summary["batches"] += 1
                for key in ("new_node_ids", "new_chain_ids", "notes_written", "note_errors"):
                    summary[key] += result.get(key, [])
                self.state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {"session_id": session_id})
                if result.get("notes_written"):
                    self.state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"paths": result["notes_written"]})
        if summary["note_errors"]:
            # The graph is persisted; the note mirror failure must still be visible.
            raise RuntimeError("Concept notes not written: " + "; ".join(summary["note_errors"]))
        return summary

    # ------------------------------------------------------------------ queries

    def nodes(self) -> dict[str, PropositionNode]:
        return load_nodes(self.state.vault_path)

    def validate_context(self, node_ids: list[str]) -> list[str]:
        ids = list(dict.fromkeys(node_ids))
        if len(ids) > MAX_GRAPH_CONTEXT:
            raise ValueError(f"graph_context accepts at most {MAX_GRAPH_CONTEXT} nodes")
        unknown = [i for i in ids if i not in self.nodes()]
        if unknown:
            raise ValueError(f"Unknown graph node(s): {', '.join(unknown)}")
        return ids

    def context_for(self, session: SessionRecord) -> str:
        """Prompt block for ``session.graph_context`` ("" when there is none)."""
        ids = getattr(session, "graph_context", None) or []
        if not ids:
            return ""
        nodes = self.nodes()
        selected = [nodes[i] for i in ids if i in nodes]
        chains = load_graph_chains(self.state.vault_path, set(nodes))
        return format_graph_context(selected, chains, practice=session.mode == "PRACTICE")

    def snapshot(self) -> dict[str, Any]:
        vault = self.state.vault_path
        config = self.state.get_config()
        nodes = self.nodes()
        chains = load_graph_chains(vault, set(nodes))
        positions = load_positions(vault)
        sessions = {s.id: s for s in list_sessions(vault)}
        names = {i: n.name for i, n in nodes.items()}

        def position(node_id: str) -> dict[str, float]:
            pos = positions.get(node_id)
            if isinstance(pos, dict) and isinstance(pos.get("x"), int | float) and isinstance(pos.get("y"), int | float):
                return {"x": pos["x"], "y": pos["y"]}
            return {}

        premises_of: dict[str, list[str]] = {}
        for chain in chains:
            premises_of.setdefault(chain.conclusion, []).extend(chain.premises)

        out_nodes: list[dict[str, Any]] = []
        clusters: dict[str, dict[str, Any]] = {}
        for node in nodes.values():
            birth = node.provenance[0].session_id if node.provenance else "notes"
            cluster = clusters.setdefault(birth, {
                "id": birth, "label": sessions[birth].title if birth in sessions else birth,
                "kind": "session" if birth in sessions else "notes", "size": 0,
            })
            cluster["size"] += 1
            out_nodes.append({
                "id": node.id, "name": node.name, "title": node.name,
                "statement": node.statement, "summary": node.statement, "aliases": node.aliases,
                "cluster": birth, "cluster_id": birth,
                "sessions": [{"session_id": p.session_id,
                              "title": sessions[p.session_id].title if p.session_id in sessions else "",
                              "message_id": p.message_id} for p in node.provenance],
                "vault_rel_path": node.vault_rel_path, "file_path": node.vault_rel_path,
                "status": "aprendendo", "depends_on": list(dict.fromkeys(premises_of.get(node.id, []))),
                "ghost": False, "legacy": False, "created_at": node.created_at, **position(node.id),
            })

        out_chains = [{
            "id": c.id, "chain_id": c.id, "premises": c.premises, "conclusion": c.conclusion,
            "expression": chain_expression(c, names), "formula": chain_expression(c, names),
            "created_at": c.created_at,
            "session_id": c.provenance[0].session_id if c.provenance else None,
            "source_session_id": c.provenance[0].session_id if c.provenance else None,
        } for c in chains]
        edges = []
        seen: set[tuple[str, str, str]] = set()
        for c in chains:
            for p in c.premises:
                if (p, c.conclusion, "chain") not in seen:
                    seen.add((p, c.conclusion, "chain"))
                    edges.append({"source": p, "target": c.conclusion, "kind": "chain"})

        self._legacy(nodes, out_nodes, out_chains, edges, clusters, position)

        roadmap = []
        track = config.track
        if track.queue:
            for item in track.queue:
                status = "completed" if item.completed else ("active" if item.id == track.active_item_id else "pending")
                linked = [n.id for n in nodes.values()
                          if any(p.session_id in sessions and sessions[p.session_id].track_item_id == item.id
                                 for p in n.provenance)]
                roadmap.append({"id": f"track:{item.id}", "title": item.title, "status": status,
                                "linked_node_ids": linked,
                                "depends_on": [f"track:{p}" for p in item.prerequisites]})
        return {"nodes": out_nodes, "edges": edges, "chains": out_chains,
                "clusters": list(clusters.values()), "roadmap": roadmap, "updated_at": _now()}

    def _legacy(self, nodes, out_nodes, out_chains, edges, clusters, position) -> None:
        """Old ``Conceitos/*.md`` notes (no ``harness_id``) stay visible as ``legacy`` nodes."""
        vault = self.state.vault_path
        owned_paths = {n.vault_rel_path for n in nodes.values() if n.vault_rel_path}
        legacy = [c for c in scan_all_concepts(vault)
                  if c.vault_rel_path not in owned_paths
                  and not harness_owned_note(safe_path(vault, c.vault_rel_path))]
        if not legacy:
            return
        clusters[LEGACY_CLUSTER] = {"id": LEGACY_CLUSTER, "label": folder_map(vault).concepts_dir,
                                    "kind": "legacy", "size": len(legacy)}
        ids = {c.id for c in legacy}
        titles = {c.id: c.title for c in legacy}
        for concept in legacy:
            statement = concept.unconditional_truth or concept.mechanism_summary or ""
            out_nodes.append({
                "id": concept.id, "name": concept.title, "title": concept.title,
                "statement": statement, "summary": statement, "aliases": [],
                "cluster": LEGACY_CLUSTER, "cluster_id": LEGACY_CLUSTER, "sessions": [],
                "vault_rel_path": concept.vault_rel_path, "file_path": concept.vault_rel_path,
                "status": concept.status, "depends_on": [_slug(d) for d in concept.depends_on if _slug(d) in ids],
                "ghost": False, "legacy": True, "created_at": "", **position(concept.id),
            })
            for dep in concept.depends_on:
                if _slug(dep) in ids:
                    edges.append({"source": _slug(dep), "target": concept.id, "kind": "depends_on"})
        for chain in load_chains(vault):
            premises = [_slug(p) for p in chain.premises]
            conclusion = _slug(chain.conclusion)
            if premises and {conclusion, *premises} <= ids:
                out_chains.append({
                    "id": chain.chain_id, "chain_id": chain.chain_id, "premises": premises,
                    "conclusion": conclusion,
                    "expression": f"{' ∧ '.join(titles[p] for p in premises)} ⟹ {titles[conclusion]}",
                    "formula": chain.expression, "created_at": chain.created_at,
                    "session_id": chain.source_session_id, "source_session_id": chain.source_session_id,
                })
                edges.extend({"source": p, "target": conclusion, "kind": "chain"} for p in premises)

    def note_path(self, node_id: str) -> str | None:
        node = self.nodes().get(node_id)
        if node is not None:
            return node.vault_rel_path or None
        legacy = next((c for c in scan_all_concepts(self.state.vault_path) if c.id == node_id), None)
        return legacy.vault_rel_path if legacy else None

    # ------------------------------------------------------------------ mutations

    async def delete_node(self, node_id: str) -> dict[str, Any]:
        async with self.lock:
            vault = self.state.vault_path
            nodes = self.nodes()
            node = nodes.get(node_id)
            if node is None:
                raise FileNotFoundError(f"Graph node '{node_id}' not found")
            doomed_records = [r for r in raw_chain_records(vault)
                              if isinstance(r.get("id"), str) and not r.get("deleted")
                              and (r.get("conclusion") == node_id or node_id in (r.get("premises") or []))]
            doomed = sorted({r["id"] for r in doomed_records})
            # Conclusions that lose a premise line need their notes re-rendered.
            affected = list(dict.fromkeys(r["conclusion"] for r in doomed_records
                                          if r.get("conclusion") not in (None, node_id)))
            append_records(vault, "nodes.jsonl", [{"id": node_id, "deleted": True}])
            append_records(vault, "chains.jsonl", [{"id": cid, "deleted": True} for cid in doomed])
            note_changed = remove_concept_section(vault, node)
            if affected:
                from learnharness.pipelines.extraction import refresh_notes
                refresh_notes(vault, affected, self.state.get_config().language)
        self.state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {})
        if note_changed:
            self.state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"paths": [node.vault_rel_path]})
        return {"ok": True, "id": node_id, "deleted_chain_ids": doomed}

    async def unlink_session(self, session_id: str) -> dict[str, Any]:
        """Remove ``session_id`` from the provenance of every node and chain (Fase 12).

        Nodes and chains left without provenance are tombstoned; their concept notes
        follow ``delete_node``: only the managed block goes, and the file only when the
        harness created it and nothing else remains. Surviving nodes that cited the
        session (or lost a premise line) get their notes re-rendered.
        """
        from learnharness.core.graph_merge import plan_unlink
        from learnharness.vault.graph_store import append_session_unlink, raw_node_records

        async with self.lock:
            vault = self.state.vault_path
            nodes = self.nodes()
            chains = raw_chain_records(vault)
            plan = plan_unlink(raw_node_records(vault), chains, session_id)
            if not (plan["unlink_nodes"] or plan["unlink_chains"]):
                return {"ok": True, "session_id": session_id, "unlinked_node_ids": [],
                        "deleted_node_ids": [], "deleted_chain_ids": []}
            dead_chains = set(plan["dead_chains"])
            dead_nodes = set(plan["dead_nodes"])
            # Conclusions whose premise lines change, and nodes whose origin list changes.
            affected = [r["conclusion"] for r in chains
                        if r.get("id") in dead_chains and isinstance(r.get("conclusion"), str)]
            affected += plan["unlink_nodes"]
            affected = [i for i in dict.fromkeys(affected) if i not in dead_nodes]
            append_session_unlink(vault, session_id, plan)
            changed = [nodes[i].vault_rel_path for i in plan["dead_nodes"]
                       if i in nodes and remove_concept_section(vault, nodes[i])]
            if affected:
                from learnharness.pipelines.extraction import refresh_notes
                written, _ = refresh_notes(vault, affected, self.state.get_config().language)
                changed += written
        self.state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {})
        if changed:
            self.state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"paths": changed})
        return {"ok": True, "session_id": session_id, "unlinked_node_ids": plan["unlink_nodes"],
                "deleted_node_ids": plan["dead_nodes"], "deleted_chain_ids": plan["dead_chains"]}

    def update_positions(self, positions: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
        saved = save_positions(self.state.vault_path, positions)
        self.state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {})
        return saved

    def session_or_404(self, session_id: str) -> SessionRecord:
        session = load_session(self.state.vault_path, session_id)
        if session is None:
            raise FileNotFoundError(f"Session '{session_id}' not found")
        return session
