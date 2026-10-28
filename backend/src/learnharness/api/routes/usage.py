"""Token usage aggregates for the Home usage indicator (notify ``usage:updated`` -> fetch)."""
from __future__ import annotations

from fastapi import APIRouter, Request

from learnharness.api.state import get_app_state

usage_router = APIRouter(prefix="/api/usage", tags=["usage"])


@usage_router.get("")
async def get_usage(request: Request):
    """``{today: {input_tokens, output_tokens, thinking_tokens, turns}, total: {...},
    by_session: [{session_id, title, total_tokens}]}`` (top 10 by tokens)."""
    return get_app_state(request.app).usage.summary()


@usage_router.get("/sessions/{session_id}")
async def get_session_usage(session_id: str, request: Request):
    """Per-turn usage of one session: ``{session_id, turns: [{turn, at, input_tokens,
    output_tokens, thinking_tokens, cached_tokens, calls}], background: [{job_kind, ...}],
    untracked?}``. 404 when the session does not exist."""
    state = get_app_state(request.app)
    state.sessions.get(session_id)  # SessionNotFound -> 404
    return state.usage.session_turns(session_id)
