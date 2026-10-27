"""Learning tracks (Fase 14): several side by side, one in focus.

* ``GET    /api/tracks``                   -> ``[{id, title, source, mode, archived, active, created_at,
  progress: {done, total}, next_item: {id, title} | null, generating, error}]``
* ``POST   /api/tracks``                   ``{title, source, repo_path?, github_url?, goal_description?,
  items?, activate}`` -> the track
* ``PUT    /api/tracks/{id}``              ``{title?, archived?, goal_description?}`` -> the track
* ``POST   /api/tracks/{id}/activate``     -> the track
* ``DELETE /api/tracks/{id}``              -> ``{deleted, active_track_id}`` (Vault untouched)
* ``POST   /api/tracks/{id}/regenerate``   -> the track (``generating: true``)
* ``POST   /api/tracks/{id}/leveling``     -> the leveling TEACH session (Fase 15; reuses an open one)
* ``POST   /api/tracks/{id}/leveling/{session_id}/undo`` -> ``{ok, session_id, track}``; 409 once a
  leveled step changed
Every change emits ``config:updated``; job progress arrives as ``jobs:updated``.
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from learnharness.api.routes.chats import _with_slot
from learnharness.api.state import get_app_state
from learnharness.vault import github_source
from learnharness.vault.github_source import GitHubSourceError

tracks_router = APIRouter(prefix="/api/tracks", tags=["tracks"])

GOAL_MAX_CHARS = 20_000


class CreateTrackPayload(BaseModel):
    title: str = Field(default="", max_length=200)
    source: Literal["repo", "github", "goal", "manual"]
    repo_path: str | None = Field(default=None, max_length=4096)
    github_url: str | None = Field(default=None, max_length=2048)
    # A goal or a whole course syllabus ("ementa").
    goal_description: str | None = Field(default=None, max_length=GOAL_MAX_CHARS)
    items: list[str] = Field(default_factory=list, max_length=500)
    activate: bool = True


class UpdateTrackPayload(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    archived: bool | None = None
    goal_description: str | None = Field(default=None, max_length=GOAL_MAX_CHARS)


def _one(state, track_id: str) -> dict[str, Any]:
    config = state.get_config()
    track = config.find_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Unknown track")
    return state.tracks.serialize(track, config)


@tracks_router.get("")
async def list_tracks(request: Request) -> list[dict[str, Any]]:
    return get_app_state(request.app).tracks.list_tracks()


@tracks_router.post("")
async def create_track(payload: CreateTrackPayload, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    if not state.get_config().configured:
        raise HTTPException(status_code=409, detail="Complete setup before creating a track")
    repo_path, title = payload.repo_path, payload.title
    if payload.source == "github":
        if not payload.github_url:
            raise HTTPException(status_code=422, detail="github_url is required")
        try:
            clone = await github_source.ensure_clone(state.vault_path, payload.github_url, refresh=False)
        except GitHubSourceError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        repo_path = str(clone.content_root)
        title = title or f"{clone.owner}/{clone.repo}"
    track = await state.tracks.create(
        source=payload.source, title=title, repo_path=repo_path,
        github_url=payload.github_url if payload.source == "github" else None,
        goal_description=payload.goal_description, items=payload.items, activate=payload.activate,
    )
    return _one(state, track.id)


@tracks_router.put("/{track_id}")
async def update_track(track_id: str, payload: UpdateTrackPayload, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    await state.tracks.update(track_id, title=payload.title, archived=payload.archived,
                              goal_description=payload.goal_description)
    return _one(state, track_id)


@tracks_router.post("/{track_id}/activate")
async def activate_track(track_id: str, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    await state.tracks.activate(track_id)
    return _one(state, track_id)


@tracks_router.delete("/{track_id}")
async def delete_track(track_id: str, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    active = await state.tracks.delete(track_id)
    return {"deleted": track_id, "active_track_id": active}


@tracks_router.post("/{track_id}/regenerate")
async def regenerate_track(track_id: str, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    await state.tracks.regenerate(track_id)
    return _one(state, track_id)


@tracks_router.post("/{track_id}/leveling")
async def start_leveling(track_id: str, request: Request) -> dict[str, Any]:
    """Fase 15: open a TEACH session (``context_kind="leveling"``) that finds where to start."""
    state = get_app_state(request.app)
    session = await state.leveling.start(track_id)
    return _with_slot(state, session)


@tracks_router.post("/{track_id}/leveling/{session_id}/undo")
async def undo_leveling(track_id: str, session_id: str, request: Request) -> dict[str, Any]:
    return await get_app_state(request.app).leveling.undo(track_id, session_id)
