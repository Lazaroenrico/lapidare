"""Knowledge graph routes (/api/graph): snapshot, notes, deletion, positions, extraction."""

from __future__ import annotations

import math
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, RootModel, field_validator

from learnharness.api.state import get_app_state
from learnharness.vault.safety import folder_map, safe_path

graph_router = APIRouter(prefix="/api/graph", tags=["graph"])


class Point(BaseModel):
    x: float
    y: float

    @field_validator("x", "y")
    @classmethod
    def finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("Positions must be finite numbers")
        return value


class PositionsPayload(RootModel[dict[str, Point]]):
    pass


@graph_router.get("")
async def get_graph(request: Request) -> dict[str, Any]:
    """Snapshot: nodes (+ legacy notes), chains, edges, clusters, roadmap (with a track)."""
    return get_app_state(request.app).graph.snapshot()


@graph_router.get("/concepts/{concept_id}/note")
async def get_concept_note(concept_id: str, request: Request) -> dict[str, Any]:
    """Read-only markdown of a concept note (for the in-app "Abrir Nota" pane)."""
    state = get_app_state(request.app)
    rel_path = state.graph.note_path(concept_id)
    if not rel_path:
        raise HTTPException(status_code=404, detail=f"Concept '{concept_id}' has no note")
    note = safe_path(state.vault_path, rel_path)
    concepts_root = safe_path(state.vault_path, folder_map(state.vault_path).concepts_dir)
    # Only concept notes are served, never arbitrary vault files.
    if not note.is_file() or not note.resolve().is_relative_to(concepts_root.resolve()):
        raise HTTPException(status_code=404, detail=f"Concept '{concept_id}' has no note")
    return {"path": rel_path, "markdown": note.read_text(encoding="utf-8")}


@graph_router.delete("/nodes/{node_id}")
async def delete_node(node_id: str, request: Request) -> dict[str, Any]:
    """Tombstone the node and its chains; only the managed section of its note goes away."""
    return await get_app_state(request.app).graph.delete_node(node_id)


@graph_router.put("/positions")
async def put_positions(payload: PositionsPayload, request: Request) -> dict[str, Any]:
    positions = {node_id: point.model_dump() for node_id, point in payload.root.items()}
    return {"positions": get_app_state(request.app).graph.update_positions(positions)}


@graph_router.post("/extract/{session_id}", status_code=202)
async def extract_session(session_id: str, request: Request) -> dict[str, Any]:
    """Manually queue the session's extraction job (uncovered prose only)."""
    state = get_app_state(request.app)
    return state.graph.request_extraction(state.graph.session_or_404(session_id), "manual")
