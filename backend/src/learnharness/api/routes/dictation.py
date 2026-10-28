"""Settings -> Ditado and the short-lived Deepgram token endpoints.

``GET``/``PUT /api/settings/dictation`` (key never returned) and ``POST /api/dictation/token|test``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, field_validator

from learnharness.api.state import AppState, get_app_state
from learnharness.core.contracts.config import DICTATION_LANGUAGES
from learnharness.core.events import SseEventType
from learnharness.services import dictation
from learnharness.vault.bootstrap import save_config

dictation_router = APIRouter(tags=["dictation"])

NOT_CONFIGURED = "ditado não configurado"


class DictationPatch(BaseModel):
    """Partial update. ``api_key: null`` deletes the key; an empty string is invalid."""

    model_config = ConfigDict(extra="forbid")
    api_key: str | None = None
    language: str | None = None

    @field_validator("api_key")
    @classmethod
    def non_empty(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("api_key must not be empty; send null to remove it")
        return value.strip() if value is not None else None

    @field_validator("language")
    @classmethod
    def known_language(cls, value: str | None) -> str | None:
        if value is not None and value not in DICTATION_LANGUAGES:
            raise ValueError(f"language must be one of {', '.join(DICTATION_LANGUAGES)}")
        return value


def _view(state: AppState) -> dict[str, Any]:
    return {
        "configured": dictation.get_key() is not None,
        "language": state.get_config().dictation.language,
    }


def http_client(request: Request) -> httpx.AsyncClient | None:
    """Injection point for tests: ``app.state.dictation_http`` (default: a fresh client)."""
    return getattr(request.app.state, "dictation_http", None)


@dictation_router.get("/api/settings/dictation")
async def get_dictation_settings(request: Request):
    return _view(get_app_state(request.app))


@dictation_router.put("/api/settings/dictation")
async def put_dictation_settings(payload: DictationPatch, request: Request):
    state = get_app_state(request.app)
    fields = payload.model_fields_set
    if "language" in fields and payload.language is not None:
        vault = Path(state.vault_path)
        if not (vault / ".harness/config.json").is_file():
            raise HTTPException(status_code=409, detail="Complete the setup before changing dictation settings")
        config = state.get_config()
        config.dictation.language = payload.language
        save_config(vault, config)
    if "api_key" in fields:
        dictation.set_key(payload.api_key)
    state.sse_hub.broadcast(SseEventType.CONFIG_UPDATED, {"section": "dictation"})
    return _view(state)


async def _mint(request: Request) -> dict[str, Any]:
    key = dictation.get_key()
    if key is None:
        raise HTTPException(status_code=409, detail=NOT_CONFIGURED)
    state = get_app_state(request.app)
    try:
        return await dictation.mint_token(key, http_client(request))
    except dictation.DictationKeyInvalid:
        raise HTTPException(status_code=401, detail="chave do Deepgram inválida") from None
    except dictation.DictationRoleInsufficient:
        raise HTTPException(
            status_code=403, detail="a chave do Deepgram precisa de papel Member ou superior"
        ) from None
    except dictation.DictationUnavailable as exc:
        raise HTTPException(
            status_code=502, detail=state.redact(f"Deepgram indisponível: {exc}")
        ) from None


@dictation_router.post("/api/dictation/token")
async def dictation_token(request: Request):
    return await _mint(request)


@dictation_router.post("/api/dictation/test")
async def dictation_test(request: Request):
    await _mint(request)
    return {"ok": True}
