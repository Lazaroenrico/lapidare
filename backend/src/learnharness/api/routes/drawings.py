"""Excalidraw retrieval drawing and multimodal vision review routes (/api/drawings/*)."""

from __future__ import annotations

import base64
import binascii
import logging
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError

from learnharness.api.routes.chats import _serialize_quiz
from learnharness.api.state import get_app_state
from learnharness.core.contracts.practice import DrawingReviewResult
from learnharness.core.contracts.quiz import QuizOption, QuizPayload
from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.core.events import SseEventType
from learnharness.engines.cli_protocol import EngineError
from learnharness.services.sessions import now
from learnharness.vault.excalidraw import (
    create_retrieval_drawing,
    load_drawing,
    save_drawing,
)
from learnharness.vault.jsonl_store import load_session
from learnharness.vault.safety import safe_path

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


_NOTE_CHAR_LIMIT = 12000


def _note_candidates(ref: str, folder: str) -> list[str]:
    """Turn a frontmatter link (path, ``[[wikilink|alias]]`` or bare name) into vault paths."""
    ref = ref.strip().removeprefix("[[").removesuffix("]]").split("|")[0].split("#")[0].strip()
    if not ref:
        return []
    names = [ref] if ref.endswith(".md") else [ref, f"{ref}.md"]
    return names + [f"{folder}/{name}" for name in names if not name.startswith(f"{folder}/")]


def _read_linked_note(vault_path: Path, folder: str, ref: str) -> tuple[str, str] | None:
    """Read a lesson/concept note confined to ``folder``; missing or unsafe links are skipped."""
    try:
        root = safe_path(vault_path, folder).resolve()
    except PermissionError:
        return None
    for candidate in _note_candidates(ref, folder):
        try:
            path = safe_path(vault_path, candidate)
            if path.is_file() and path.resolve().is_relative_to(root):
                text = path.read_text(encoding="utf-8")
                return str(path.relative_to(vault_path)), text[:_NOTE_CHAR_LIMIT]
        except (PermissionError, ValueError, OSError):
            continue
    return None


def _drawing_context(state: Any, frontmatter: dict[str, Any], prompt: str) -> str:
    """Collect the drawing prompt plus linked lesson and concept notes as plain data."""
    folders = state.get_config().folders
    vault_path = state.vault_path
    notes: list[tuple[str, str]] = []
    lesson_ref = str(frontmatter.get("aula") or "").strip()
    if lesson_ref:
        note = _read_linked_note(vault_path, folders.lessons_dir, lesson_ref)
        if note is None:
            # Drawings created from a session store its id; follow it to the lesson note.
            try:
                session = load_session(vault_path, lesson_ref)
            except (PermissionError, ValueError, OSError):
                session = None
            if session and session.lesson_vault_path:
                note = _read_linked_note(vault_path, folders.lessons_dir, session.lesson_vault_path)
        if note:
            notes.append(note)
    concepts = frontmatter.get("conceitos") or []
    if isinstance(concepts, str):
        concepts = [concepts]
    for ref in concepts:
        note = _read_linked_note(vault_path, folders.concepts_dir, str(ref))
        if note and note not in notes:
            notes.append(note)
    parts = [f"Drawing prompt: {prompt}"] if prompt else []
    parts += [f'<note path="{path}">\n{text}\n</note>' for path, text in notes]
    return "\n\n".join(parts) or "(no linked notes)"


def _review_markdown(review: DrawingReviewResult) -> str:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"**Revisão de {stamp}**", "", review.summary_markdown.strip()]
    for label, items in (
        ("O que está correto", review.correct_points),
        ("O que faltou", review.missing_points),
        ("O que está incorreto", review.incorrect_points),
    ):
        if items:
            lines += ["", f"*{label}:*", *(f"- {item}" for item in items)]
    return "\n".join(lines)


def _review_session_id(slug: str) -> str:
    return f"sess-drawing-{slug}"


async def _review_session(state: Any, slug: str, title: str, review_md: str) -> SessionRecord:
    """Create or reuse the TEACH session (keyed by drawing slug) that hosts follow-up quizzes."""
    session_id = _review_session_id(slug)
    async with state.sessions.lock(session_id):
        try:
            session = state.sessions.get(session_id)
        except KeyError:
            session = SessionRecord(
                id=session_id, title=f"Revisão do desenho: {title}"[:240], mode="TEACH",
                context_kind="drawing_review", phase="teaching",
                created_at=now(), updated_at=now(),
            )
        session.messages.append(SessionMessage(
            id=f"review-{uuid4().hex}", role="assistant", content=review_md, created_at=now(),
        ))
        state.sessions.save(session)
    return session


@drawings_router.post("/{slug}/review")
async def review_drawing_endpoint(slug: str, request: Request) -> dict[str, Any]:
    """Review the exported PNG with the strong engine, persist it, and pose a follow-up quiz.

    The follow-up quiz goes through the normal session pipeline (QuestionDock +
    POST /api/chats/{id}/answer), so its calibration lands in ``.harness/quiz-log.jsonl``.
    """
    state = get_app_state(request.app)

    try:
        data = load_drawing(state.vault_path, slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Drawing '{slug}' not found") from exc
    slug = data["slug"]
    png_path = data.get("png_path")
    png_bytes = Path(png_path).read_bytes() if png_path else b""
    if not png_bytes:
        raise HTTPException(
            status_code=409, detail="Salve o desenho antes de revisar (nenhum PNG exportado)."
        )

    title = data["text_elements"].get("titulo01", slug)
    prompt = data["text_elements"].get("enunciado01", "")
    context = _drawing_context(state, data.get("frontmatter") or {}, prompt)

    engine = state.engine(state.get_config().slots.strong)
    try:
        raw = await engine.review_drawing_multimodal(png_bytes, title, context)
    except (EngineError, TimeoutError, NotImplementedError, AttributeError) as exc:
        raise EngineError(
            f"A revisão por visão falhou: {str(exc) or type(exc).__name__}. "
            "O engine do slot forte precisa aceitar imagens; se o CLI atual não suportar, "
            "configure o SDK google-genai (slot de visão)."
        ) from exc
    try:
        review = DrawingReviewResult.model_validate(
            raw.model_dump() if isinstance(raw, BaseModel) else raw
        )
    except ValidationError as exc:
        raise EngineError(f"O modelo devolveu uma revisão inválida: {exc}") from exc
    review.slug = slug

    review_md = _review_markdown(review)
    save_drawing(vault_path=state.vault_path, slug=slug, scene_json={}, review_markdown=review_md)
    state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"drawing": slug})

    session_id: str | None = None
    pending: QuizPayload | None = None
    follow_up = review.follow_up_quiz if review.incorrect_points else None
    if follow_up is not None:
        session = await _review_session(state, slug, title, review_md)
        quiz = QuizPayload(
            quiz_id=f"quiz-{uuid4().hex[:12]}", session_id=session.id, topic=follow_up.topic,
            mode="CHECK", question=follow_up.question,
            choices=[QuizOption(value=chr(ord("a") + i), label=c) for i, c in enumerate(follow_up.choices)],
            correct_index=follow_up.correct_index, explanation=follow_up.explanation,
        )
        pending = await state.sessions.open_quiz(session.id, quiz, replace_pending=True)
        session_id = session.id
    else:
        # A previous review's unanswered quiz stays answerable instead of being orphaned.
        try:
            existing = state.sessions.get(_review_session_id(slug))
        except KeyError:
            existing = None
        if existing and existing.pending_quiz:
            session_id, pending = existing.id, existing.pending_quiz

    return {
        "slug": slug,
        "correct_points": review.correct_points,
        "missing_points": review.missing_points,
        "incorrect_points": review.incorrect_points,
        "summary_markdown": review.summary_markdown,
        "session_id": session_id,
        "pending_quiz": _serialize_quiz(pending) if pending else None,
    }
