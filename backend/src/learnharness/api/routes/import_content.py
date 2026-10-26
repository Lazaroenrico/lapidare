"""Source paragraphs and MCP content ingestion routes (/api/sources/* & /api/import/*)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from learnharness.api.routes.chats import CreateChatPayload, create_chat
from learnharness.api.state import get_app_state
from learnharness.vault.transcript_importer import (
    get_source_paragraph,
    import_transcript_text,
)

import_router = APIRouter(tags=["sources_and_import"])


class IngestPayload(BaseModel):
    item_id: str | None = None
    file_content: str | None = None
    file_name: str | None = None
    title: str


@import_router.get("/api/sources/paragraph")
@import_router.get("/api/sources/{source_name}/paragraph/{paragraph_id}")
async def get_paragraph(
    request: Request,
    source: str | None = Query(None),
    p: str | None = Query(None),
    source_name: str | None = None,
    paragraph_id: str | None = None,
) -> dict[str, Any]:
    """Retrieve an anchored paragraph (^pN) with context for citation drawers."""
    state = get_app_state(request.app)
    src = source or source_name
    pid = p or paragraph_id

    if not src or not pid:
        raise HTTPException(status_code=400, detail="Missing source or paragraph identifier")

    try:
        data = get_source_paragraph(state.vault_path, src, pid)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))

    ctx_before = "\n\n".join(data.get("context_before", []))
    ctx_after = "\n\n".join(data.get("context_after", []))

    return {
        # Frontend keys
        "sourceName": data.get("source", src),
        "paragraphId": data.get("target_paragraph_id", pid),
        "content": data.get("target_text", ""),
        "context_before": ctx_before,
        "context_after": ctx_after,
        "paragraphs": data.get("total_paragraphs"),
        # Backend keys
        "source": data.get("source", src),
        "target_text": data.get("target_text", ""),
        "full_context": data.get("full_context", ""),
    }


@import_router.get("/api/import/catalog")
async def get_catalog(request: Request) -> dict[str, Any]:
    """List available Praxis or external MCP lessons."""
    state = get_app_state(request.app)
    lessons = await state.content_mcp_client.list_available_lessons()

    items = []
    for l in lessons:
        items.append(
            {
                "id": l["id"],
                "title": l["title"],
                "week": int(l["week"].replace("S", "")) if l.get("week", "").startswith("S") and l["week"][1:].isdigit() else None,
                "category": l.get("kind", "aula"),
                "source_mcp": l.get("source_mcp", "praxis"),
                "has_transcript": True,
                "has_code": True,
                "imported": not l.get("is_new", True),
                "local_source_path": l.get("imported_note"),
            }
        )

    return {"mcp_connected": True, "items": items}


@import_router.post("/api/import/ingest")
@import_router.post("/api/import/source")
async def ingest_source(payload: IngestPayload, request: Request) -> dict[str, Any]:
    """Import transcript into Fontes/ with ^pN anchors and start a TEACH session."""
    state = get_app_state(request.app)

    content = payload.file_content
    if not content and payload.item_id:
        content = await state.content_mcp_client.fetch_lesson_content(payload.item_id, state.vault_path)

    if not content:
        raise HTTPException(status_code=400, detail="No content provided for ingestion")

    target_file, p_count = import_transcript_text(
        vault_path=state.vault_path,
        raw_text=content,
        title=payload.title,
        praxis_id=payload.item_id,
        force=True,
    )

    # Invariant 1: Ingesting dense source automatically sets up TEACH session anchored on it
    chat_resp = await create_chat(
        payload=CreateChatPayload(
            mode="TEACH",
            topic=payload.title,
            source_file=str(target_file.name),
        ),
        request=request,
    )

    return {
        "source_path": str(target_file.relative_to(state.vault_path)),
        "session_id": chat_resp.get("id"),
        "paragraph_count": p_count,
    }
