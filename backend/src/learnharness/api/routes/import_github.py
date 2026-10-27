"""Multi-source import routes: GitHub repositories and local files (.md/.txt/.pdf).

Contract (plan "Fase 3B"):
* ``POST /api/import/github/preview``  ``{url}`` -> ``{repo, files, truncated}``
* ``POST /api/import/github/import``   ``{url, paths, start_session, use_as_track}`` (``replace_track`` accepted, ignored)
  -> ``{imported, session_id, track_job_id, track_id}`` (use_as_track adds a new track)
* ``POST /api/import/local`` multipart ``file``, ``title?``, ``start_session`` -> ``{imported, session_id}``
Everything lands read-only in ``Fontes/`` with ``^pN`` anchors and provenance frontmatter.
"""

from __future__ import annotations

import asyncio
import io
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from learnharness.api.routes.chats import CreateChatPayload, create_chat
from learnharness.api.state import get_app_state
from learnharness.core.events import SseEventType
from learnharness.services.tracks import track_job_key
from learnharness.vault import github_source
from learnharness.vault.github_source import GitHubSourceError
from learnharness.vault.transcript_importer import import_transcript_text

import_github_router = APIRouter(tags=["sources_and_import"])

MAX_LOCAL_BYTES = 20 * 1024 * 1024
LOCAL_EXTENSIONS = {".md", ".markdown", ".txt", ".pdf"}


class GitHubPreviewPayload(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    refresh: bool = False  # force a fresh clone even when the cached commit is current


class GitHubImportPayload(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    paths: list[str] = Field(default_factory=list, max_length=github_source.MAX_FILES)
    start_session: bool = False
    use_as_track: bool = False
    replace_track: bool = False  # Fase 14: accepted and ignored (a new track is created)


def _http_error(exc: GitHubSourceError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


async def _maybe_start_session(request: Request, imported: list[dict[str, Any]], start: bool) -> str | None:
    if not start or len(imported) != 1:
        return None
    chat = await create_chat(
        payload=CreateChatPayload(
            mode="TEACH", topic=imported[0]["title"], source_file=imported[0]["source_path"]
        ),
        request=request,
    )
    return chat.get("id")


def _broadcast(request: Request, imported: list[dict[str, Any]]) -> None:
    if imported:
        state = get_app_state(request.app)
        state.sse_hub.broadcast(
            SseEventType.VAULT_CHANGED, {"paths": [item["source_path"] for item in imported]}
        )


@import_github_router.post("/api/import/github/preview")
async def github_preview(payload: GitHubPreviewPayload, request: Request) -> dict[str, Any]:
    """List importable text files, re-cloning only when the remote commit changed."""
    state = get_app_state(request.app)
    try:
        clone = await github_source.ensure_clone(
            state.vault_path, payload.url, refresh=payload.refresh, revalidate=True
        )
    except GitHubSourceError as exc:
        raise _http_error(exc) from exc
    return clone.preview()


@import_github_router.post("/api/import/github/import")
async def github_import(payload: GitHubImportPayload, request: Request) -> dict[str, Any]:
    """Import selected repository files into Fontes/ and optionally drive the track from it."""
    state = get_app_state(request.app)
    if not payload.paths and not payload.use_as_track:
        raise HTTPException(status_code=422, detail="Select at least one file or use_as_track")
    try:
        github_source.parse_github_url(payload.url)
    except GitHubSourceError as exc:
        raise _http_error(exc) from exc
    try:
        clone = await github_source.ensure_clone(state.vault_path, payload.url, refresh=False)
        imported = github_source.import_repo_files(state.vault_path, clone, payload.paths)
    except GitHubSourceError as exc:
        raise _http_error(exc) from exc
    _broadcast(request, imported)

    track_job_id = track_id = None
    if payload.use_as_track:
        # Fase 14: a *new* track, in focus; the other tracks stay (replace_track is ignored).
        track = await state.tracks.create(
            source="github", title=f"{clone.owner}/{clone.repo}", repo_path=str(clone.content_root),
            github_url=payload.url, activate=True,
        )
        track_id = track.id
        job = next((j for j in reversed(state.active_jobs.values())
                    if j.get("dedup_key") == track_job_key(track.id)), None)
        track_job_id = job["job_id"] if job else None

    session_id = await _maybe_start_session(request, imported, payload.start_session)
    return {"imported": imported, "session_id": session_id, "track_job_id": track_job_id,
            "track_id": track_id}


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise HTTPException(status_code=422, detail="Encrypted PDFs are not supported")
        pages = [page.extract_text() or "" for page in reader.pages]
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=422, detail="Could not read PDF") from exc
    paragraphs: list[str] = []
    for page in pages:
        paragraphs.extend(_pdf_paragraphs(page))
    return "\n\n".join(paragraphs)


def _pdf_paragraphs(page: str) -> list[str]:
    """Rebuild paragraphs from extracted lines: blank lines and sentence ends followed by a
    new capitalized/bulleted line start a paragraph; wrapped lines are joined with a space."""
    paragraphs: list[str] = []
    current: list[str] = []
    for raw in page.splitlines():
        line = raw.strip()
        if not line:
            if current:
                paragraphs.append(" ".join(current))
                current = []
            continue
        if current and re.search(r"[.!?:;]$", current[-1]) and re.match(r"^([A-ZÀ-Ý0-9]|[-•*–]\s)", line):
            paragraphs.append(" ".join(current))
            current = []
        current.append(line)
    if current:
        paragraphs.append(" ".join(current))
    return paragraphs


async def _read_limited(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1024 * 1024):
        total += len(chunk)
        if total > MAX_LOCAL_BYTES:
            raise HTTPException(status_code=413, detail="File exceeds the 20 MB limit")
        chunks.append(chunk)
    return b"".join(chunks)


@import_github_router.post("/api/import/local")
async def import_local(
    request: Request,
    file: UploadFile = File(...),  # noqa: B008
    title: str | None = Form(None),
    start_session: bool = Form(False),
) -> dict[str, Any]:
    """Import an uploaded .md/.txt/.pdf into Fontes/Local/ with ^pN anchors."""
    state = get_app_state(request.app)
    original = Path((file.filename or "").replace("\\", "/")).name
    suffix = Path(original).suffix.lower()
    if suffix not in LOCAL_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Only .md, .txt and .pdf files are supported")
    data = await _read_limited(file)
    if suffix == ".pdf":
        text = await asyncio.to_thread(_pdf_text, data)  # Up to 20 MB of pypdf work.
    else:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("latin-1")
    if not text.strip():
        raise HTTPException(status_code=422, detail="The file has no extractable text")
    clean_title = (title or "").strip() or Path(original).stem or "Documento"
    target, count = import_transcript_text(
        state.vault_path,
        text,
        clean_title[:200],
        tipo="fonte",
        force=True,
        subdir="Local",
        provenance={"source_kind": "local", "original_filename": original, "origem": "Local"},
    )
    imported = [{
        "source_path": target.relative_to(state.vault_path).as_posix(),
        "paragraph_count": count,
        "title": clean_title[:200],
    }]
    _broadcast(request, imported)
    session_id = await _maybe_start_session(request, imported, start_session)
    return {"imported": imported, "session_id": session_id}
