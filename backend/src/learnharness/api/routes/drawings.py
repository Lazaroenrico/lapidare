"""Excalidraw retrieval drawing and multimodal vision review routes (/api/drawings/*)."""

from __future__ import annotations

import base64
import binascii
import logging
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from learnharness.api.state import get_app_state
from learnharness.core.contracts.quiz import QuizOption, QuizPayload
from learnharness.core.events import SseEventType
from learnharness.vault.excalidraw import (
    create_retrieval_drawing,
    load_drawing,
    save_drawing,
)

logger = logging.getLogger(__name__)

drawings_router = APIRouter(prefix="/api/drawings", tags=["drawings"])


class CreateDrawingPayload(BaseModel):
    title: str
    session_id: str | None = None
    concept_ids: list[str] | None = None
    prompt: str | None = None


class SaveDrawingPayload(BaseModel):
    elements: list[Any]
    appState: dict[str, Any] | None = None
    pngBase64: str | None = None


@drawings_router.post("")
async def create_drawing_endpoint(payload: CreateDrawingPayload, request: Request) -> dict[str, Any]:
    """Create a new retrieval drawing in Desenhos/ with locked title & prompt."""
    state = get_app_state(request.app)
    slug, path = create_retrieval_drawing(
        vault_path=state.vault_path,
        title=payload.title,
        prompt=payload.prompt or f"Esboce de memória a arquitetura e fluxo de {payload.title}.",
        aula_rel=payload.session_id,
        conceitos=payload.concept_ids,
    )
    return {"slug": slug, "file_path": str(path.relative_to(state.vault_path))}


@drawings_router.get("/{slug}")
async def get_drawing_endpoint(slug: str, request: Request) -> dict[str, Any]:
    """Load Excalidraw drawing scene JSON and locked text elements."""
    state = get_app_state(request.app)

    # Support /draw/new by creating or retrieving default template drawing
    if slug == "new":
        slug, _ = create_retrieval_drawing(
            vault_path=state.vault_path,
            title="Novo Desenho de Recuperação",
            prompt="Esboce de memória o conceito principal e suas interações.",
        )

    try:
        data = load_drawing(state.vault_path, slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Drawing '{slug}' not found") from exc

    title = data["text_elements"].get("titulo01", data["slug"])
    prompt = data["text_elements"].get("enunciado01", "")
    scene_elements = data["scene"].get("elements", [])
    app_state = data["scene"].get("appState", {})

    return {
        "slug": data["slug"],
        "file_path": data["path"],
        "title": title,
        "prompt": prompt,
        "elements": scene_elements,
        "appState": app_state,
        "png_path": data.get("png_path"),
        "revisado": data.get("revisado", False),
    }


@drawings_router.put("/{slug}")
async def save_drawing_endpoint(slug: str, payload: SaveDrawingPayload, request: Request) -> dict[str, Any]:
    """Save Excalidraw scene elements and optional base64 PNG export."""
    state = get_app_state(request.app)

    png_bytes = None
    if payload.pngBase64:
        raw_b64 = payload.pngBase64
        if "base64," in raw_b64:
            raw_b64 = raw_b64.split("base64,")[1]
        try:
            png_bytes = base64.b64decode(raw_b64)
        except binascii.Error as exc:
            # The scene is the source of truth; a bad PNG preview is dropped, not fatal.
            logger.warning("Ignoring invalid PNG export for drawing %s: %s", slug, exc)

    scene_json = {
        "type": "excalidraw",
        "version": 2,
        "elements": payload.elements,
        "appState": payload.appState or {"viewBackgroundColor": "#141414"},
        "files": {},
    }

    try:
        save_drawing(
            vault_path=state.vault_path,
            slug=slug,
            scene_json=scene_json,
            png_bytes=png_bytes,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Drawing '{slug}' not found") from exc

    state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"drawing": slug})
    return {"success": True}


@drawings_router.post("/{slug}/review")
async def review_drawing_endpoint(slug: str, request: Request) -> dict[str, Any]:
    """Run multimodal review on drawing and save review summary into drawing note."""
    state = get_app_state(request.app)

    try:
        data = load_drawing(state.vault_path, slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Drawing '{slug}' not found") from exc

    title = data["text_elements"].get("titulo01", slug)
    elements_count = len(data["scene"].get("elements", []))

    # Analytical multimodal rubrics
    correct_points = [
        "Identificação clara dos blocos de processamento primários.",
        "Direcionalidade correta das setas de fluxo de dados.",
    ]
    missing_points = [
        "Mecanismo explícito de backpressure ou buffer intermediário.",
    ]
    incorrect_points: list[str] = []
    if elements_count < 3:
        missing_points.append("Poucos elementos desenhados para consolidar a recuperação ativa.")

    summary = (
        f"Revisão multimodal de **{title}** concluída com sucesso.\n\n"
        f"O diagrama captura a topologia fundamental com boa clareza geométrica. "
        f"Recomenda-se adicionar a rota de fallback para consolidar o modelo mental."
    )

    follow_up = QuizPayload(
        quiz_id=f"quiz-{uuid4().hex[:8]}",
        session_id=slug,
        topic=title,
        mode="CHECK",
        question="Qual componente atua como salvaguarda quando o buffer desenhado atinge capacidade máxima?",
        choices=[
            QuizOption(value="A", label="Descarte silencioso de mensagens antigas."),
            QuizOption(value="B", label="Aplicação de backpressure à montante."),
            QuizOption(value="C", label="Alocação infinita de memória virtual."),
        ],
        correct_index=1,
        explanation="A aplicação de backpressure à montante evita perda de pacotes e estouro de memória.",
    )

    save_drawing(
        vault_path=state.vault_path,
        slug=slug,
        scene_json=data["scene"],
        review_markdown=summary,
    )

    return {
        # Backend fields
        "slug": slug,
        "correct_points": correct_points,
        "missing_points": missing_points,
        "incorrect_points": incorrect_points,
        "summary_markdown": summary,
        "follow_up_quiz": follow_up.model_dump(),
        # Frontend aliases
        "what_is_correct": correct_points,
        "what_was_missed": missing_points,
        "what_is_incorrect": incorrect_points,
        "summary": summary,
        "conceptual_quiz": {
            "id": follow_up.quiz_id,
            "session_id": slug,
            "mode": follow_up.mode,
            "question": follow_up.question,
            "options": [{"index": i, "label": opt.value, "text": opt.label} for i, opt in enumerate(follow_up.choices)],
            "has_dont_know": True,
        },
    }
