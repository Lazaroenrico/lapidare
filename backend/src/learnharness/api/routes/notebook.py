"""Gemini Notebook catalog and read-only source imports."""
from __future__ import annotations

import hashlib
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from learnharness.api.routes.import_content import _clean_title, _teach_session
from learnharness.api.state import get_app_state
from learnharness.core.events import SseEventType
from learnharness.vault.transcript_importer import import_transcript_text

notebook_router = APIRouter(prefix="/api/import/notebook", tags=["notebook"])


class ImportPayload(BaseModel):
    notebook_id: str = Field(min_length=1, max_length=256)
    source_ids: list[str] = Field(min_length=1, max_length=200)
    start_session: bool = False


def _error(exc: Exception) -> HTTPException:
    # Upstream errors can contain cookies or source contents; never expose them.
    if isinstance(exc, PermissionError):
        return HTTPException(401, "Connect Gemini Notebook first.")
    return HTTPException(502, "Gemini Notebook is unavailable or the session has expired. Reconnect and try again.")


@notebook_router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    return get_app_state(request.app).notebook.status()


@notebook_router.post("/login")
async def login(request: Request) -> dict[str, Any]:
    service = get_app_state(request.app).notebook
    try:
        await service.login()
    except Exception as exc:  # noqa: BLE001 - upstream errors must not leak credentials
        raise _error(exc) from None
    return service.status()


@notebook_router.post("/logout")
async def logout(request: Request) -> dict[str, Any]:
    service = get_app_state(request.app).notebook
    await service.logout()
    return service.status()


@notebook_router.get("/notebooks")
async def notebooks(request: Request) -> list[dict[str, str]]:
    try:
        return await get_app_state(request.app).notebook.notebooks()
    except Exception as exc:  # noqa: BLE001 - upstream errors must not leak credentials
        raise _error(exc) from None


@notebook_router.get("/notebooks/{notebook_id}/sources")
async def sources(notebook_id: str, request: Request) -> list[dict[str, str]]:
    try:
        return await get_app_state(request.app).notebook.sources(notebook_id)
    except Exception as exc:  # noqa: BLE001 - upstream errors must not leak credentials
        raise _error(exc) from None


@notebook_router.post("/import")
async def import_sources(payload: ImportPayload, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    if not state.get_config().configured:
        raise HTTPException(409, "Complete setup before importing sources.")
    try:
        catalog = await state.notebook.sources(payload.notebook_id)
    except Exception as exc:  # noqa: BLE001 - upstream errors must not leak credentials
        raise _error(exc) from None
    by_id = {row["id"]: row for row in catalog}
    imported: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for source_id in dict.fromkeys(payload.source_ids):
        source = by_id.get(source_id)
        if source is None:
            errors.append({"id": source_id, "reason": "unavailable"})
            continue
        try:
            content = await state.notebook.fulltext(payload.notebook_id, source_id)
            if not content or not content.strip():
                errors.append({"id": source_id, "reason": "empty"})
                continue
            title = _clean_title(source["title"], source_id)
            identity = hashlib.sha256(f"{payload.notebook_id}\0{source_id}".encode()).hexdigest()[:16]
            path, count = import_transcript_text(
                state.vault_path, content, title, tipo="documento", subdir="Gemini Notebook",
                filename=f"Notebook--{identity}", force=True,
                provenance={"source_kind": "gemini_notebook", "notebook_id": payload.notebook_id,
                            "notebook_source_id": source_id, "origem": "Gemini Notebook"},
            )
            imported.append({"title": title, "source_path": str(path.relative_to(state.vault_path)), "paragraph_count": count})
        except Exception:  # noqa: BLE001 - isolate failures and redact upstream details
            errors.append({"id": source_id, "reason": "unavailable"})
    if imported:
        state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"paths": [item["source_path"] for item in imported]})
    session_id = None
    if payload.start_session and len(imported) == 1 and not errors:
        session_id = await _teach_session(request, imported[0]["title"], imported[0]["source_path"])
    return {"imported": imported, "errors": errors, "session_id": session_id}
