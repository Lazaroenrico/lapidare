"""Knowledge graph routes (/api/graph): snapshot, notes, deletion, positions, extraction."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, RootModel, field_validator

from learnharness.api.state import get_app_state
from learnharness.core.events import SseEventType
from learnharness.services import graph_notes
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


# ---------------------------------------------------------------------------- Fase 16: notes


class ImportVaultPayload(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=graph_notes.MAX_NOTES_PER_IMPORT)


def _notes_subdir(state: Any) -> str:
    return "Notes" if folder_map(state.vault_path).sources_dir == "Sources" else "Notas"


async def _upload_text(upload: Any) -> tuple[str, str]:
    """(original filename, decoded text) of one uploaded .md/.txt/.pdf; HTTPException on refusal."""
    from learnharness.api.routes.import_github import LOCAL_EXTENSIONS, _pdf_text, _read_limited

    original = Path((getattr(upload, "filename", "") or "").replace("\\", "/")).name
    suffix = Path(original).suffix.lower()
    if suffix not in LOCAL_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Only .md, .txt and .pdf files are supported")
    data = await _read_limited(upload)
    if suffix == ".pdf":
        text = _pdf_text(data)
    else:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("latin-1")
    if not text.strip():
        raise HTTPException(status_code=422, detail="The file has no extractable text")
    return original, text


@graph_router.post("/import", status_code=202)
async def import_note_files(request: Request) -> dict[str, Any]:
    """Multipart ``files[]`` (or ``files``): each file goes to ``Fontes/Notas/`` (read-only,
    ``^pN``) and is extracted into the graph by one ``notes_import`` job.

    Returns ``{job, files: [{filename, status: queued|rejected, source_id?, path?, title?, error?}]}``.
    """
    from learnharness.vault.transcript_importer import import_transcript_text

    state = get_app_state(request.app)
    form = await request.form()
    uploads = [u for u in [*form.getlist("files[]"), *form.getlist("files")] if not isinstance(u, str)]
    if not uploads:
        raise HTTPException(status_code=422, detail="No files were sent")
    if len(uploads) > graph_notes.MAX_NOTES_PER_IMPORT:
        raise HTTPException(status_code=422, detail="Too many files in one import")
    results: list[dict[str, Any]] = []
    records = []
    for upload in uploads:
        name = getattr(upload, "filename", "") or ""
        try:
            original, text = await _upload_text(upload)
            title = (Path(original).stem or "Nota")[:200]
            target, _count = import_transcript_text(
                state.vault_path, text, title, tipo="nota", force=True, subdir=_notes_subdir(state),
                provenance={"source_kind": "notes", "original_filename": original, "origem": "Import"},
            )
            rel = target.relative_to(state.vault_path.resolve()).as_posix()
            record = graph_notes.register_source(state, rel, title)
        except HTTPException as exc:
            results.append({"filename": name, "status": "rejected", "error": str(exc.detail)})
            continue
        except (OSError, ValueError) as exc:  # PermissionError is an OSError
            results.append({"filename": name, "status": "rejected", "error": state.redact(str(exc))})
            continue
        records.append(record)
        results.append({"filename": name, "status": "queued", "source_id": record.id,
                        "path": record.path, "title": record.title})
    if records:
        state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"paths": [r.path for r in records]})
    job = graph_notes.request_import(state, records) if records else None
    return {"job": job, "files": results}


@graph_router.post("/import-vault", status_code=202)
async def import_vault_notes(payload: ImportVaultPayload, request: Request) -> dict[str, Any]:
    """Extract notes already in the vault (never copied nor changed). Same response as ``/import``."""
    state = get_app_state(request.app)
    results: list[dict[str, Any]] = []
    records = []
    for raw in dict.fromkeys(payload.paths):
        try:
            record = graph_notes.register_vault_note(state, raw)
        except (OSError, ValueError) as exc:
            results.append({"filename": raw, "status": "rejected", "error": state.redact(str(exc))})
            continue
        records.append(record)
        results.append({"filename": raw, "status": "queued", "source_id": record.id,
                        "path": record.path, "title": record.title})
    job = graph_notes.request_import(state, records) if records else None
    return {"job": job, "files": results}


@graph_router.get("/importable-notes")
async def get_importable_notes(request: Request) -> dict[str, Any]:
    """Vault ``.md`` files that ``/import-vault`` accepts (no hidden folders, no concepts folder)."""
    return graph_notes.importable_notes(get_app_state(request.app))


@graph_router.get("/sources")
async def get_sources(request: Request) -> list[dict[str, Any]]:
    """Registered note sources with how many live nodes cite each one."""
    return graph_notes.list_sources(get_app_state(request.app))


@graph_router.get("/sources/{source_id}/note")
async def get_source_note(source_id: str, request: Request) -> dict[str, Any]:
    """Read-only markdown of a registered source note."""
    return graph_notes.source_note(get_app_state(request.app), source_id)


@graph_router.delete("/sources/{source_id}")
async def delete_source(source_id: str, request: Request,
                        mode: Literal["preserve-graph", "delete-nodes"] = "preserve-graph") -> dict[str, Any]:
    """Forget a source; ``delete-nodes`` unlinks it from the graph. The note is never deleted."""
    return await graph_notes.delete_source(get_app_state(request.app), source_id, mode)
