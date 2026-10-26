"""Knowledge graph and logical chains routes (/api/graph)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from learnharness.api.state import get_app_state
from learnharness.vault.jsonl_store import build_graph_snapshot
from learnharness.vault.markdown_ast import scan_all_concepts
from learnharness.vault.safety import folder_map, safe_path

graph_router = APIRouter(prefix="/api/graph", tags=["graph"])


@graph_router.get("")
async def get_graph(request: Request) -> dict[str, Any]:
    """Return single central 2D knowledge graph snapshot with enriched frontend aliases."""
    state = get_app_state(request.app)
    snapshot = build_graph_snapshot(state.vault_path)

    # Enrich nodes with both backend and frontend properties
    enriched_nodes = []
    for n in snapshot.nodes:
        enriched_nodes.append(
            {
                # Backend fields
                "id": n.id,
                "title": n.title,
                "status": n.status,
                "unconditional_truth": n.unconditional_truth,
                "depends_on": n.depends_on,
                "used_in": n.used_in,
                "sources": n.sources,
                "vault_rel_path": n.vault_rel_path,
                "cluster_id": n.cluster_id,
                "x": n.x,
                "y": n.y,
                "mistake_count": n.mistake_count,
                "mechanism_summary": n.mechanism_summary,
                "practice_summary": n.practice_summary,
                # Frontend aliases
                "name": n.title,
                "summary": n.unconditional_truth or n.mechanism_summary or "",
                "file_path": n.vault_rel_path,
                "cluster": n.cluster_id,
            }
        )

    # Enrich chains with both backend and frontend properties
    enriched_chains = []
    for c in snapshot.chains:
        enriched_chains.append(
            {
                # Backend fields
                "chain_id": c.chain_id,
                "premises": c.premises,
                "conclusion": c.conclusion,
                "expression": c.expression,
                "topic": c.topic,
                "source_session_id": c.source_session_id,
                "created_at": c.created_at,
                # Frontend aliases
                "id": c.chain_id,
                "formula": c.expression,
                "notes": c.topic,
            }
        )

    edges_data = [
        {
            "source": e.source,
            "target": e.target,
            "kind": e.kind,
        }
        for e in snapshot.edges
    ]

    return {
        "nodes": enriched_nodes,
        "edges": edges_data,
        "chains": enriched_chains,
        "updated_at": snapshot.updated_at,
    }


@graph_router.get("/concepts/{concept_id}/note")
async def get_concept_note(concept_id: str, request: Request) -> dict[str, Any]:
    """Read-only markdown of a concept note (for the in-app "Abrir Nota" pane)."""
    state = get_app_state(request.app)
    node = next((n for n in scan_all_concepts(state.vault_path) if n.id == concept_id), None)
    if node is None or not node.vault_rel_path:
        raise HTTPException(status_code=404, detail=f"Concept '{concept_id}' has no note")
    note = safe_path(state.vault_path, node.vault_rel_path)
    concepts_root = safe_path(state.vault_path, folder_map(state.vault_path).concepts_dir)
    # Only concept notes are served, never arbitrary vault files.
    if not note.is_file() or not note.resolve().is_relative_to(concepts_root.resolve()):
        raise HTTPException(status_code=404, detail=f"Concept '{concept_id}' has no note")
    return {"path": node.vault_rel_path, "markdown": note.read_text(encoding="utf-8")}
