"""Settings routes for viewing and overriding the bundled prompt fragments.

Overrides live in ``<vault>/.harness/prompts/<segment path>``; whether each one is
active is a boolean in ``HarnessConfig.prompt_overrides`` (or, until that field
exists, in ``.harness/prompt-overrides.json``).
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from learnharness.api.state import get_app_state
from learnharness.prompts.loader import (
    OVERRIDE_FLAGS_FALLBACK,
    list_prompt_segments,
    load_override_flags,
    override_file,
    segment_paths,
)
from learnharness.vault.bootstrap import save_config
from learnharness.vault.safety import atomic_write, locked_path, safe_path

prompts_router = APIRouter(prefix="/api/settings/prompts", tags=["settings"])

MAX_OVERRIDE_CHARS = 200_000


class PromptOverridePayload(BaseModel):
    text: str = Field(max_length=MAX_OVERRIDE_CHARS)
    enabled: bool = True


def _known(path: str) -> str:
    if path not in segment_paths():
        raise HTTPException(status_code=404, detail=f"Unknown prompt segment: {path}")
    return path


def _save_flag(vault: Path, config, path: str, enabled: bool | None) -> None:
    """Set (or with ``None`` remove) one enabled flag."""
    if "prompt_overrides" in type(config).model_fields and (vault / ".harness/config.json").is_file():
        flags = dict(getattr(config, "prompt_overrides", {}) or {})
        _apply(flags, path, enabled)
        config.prompt_overrides = flags
        save_config(vault, config)
    fallback = safe_path(vault, OVERRIDE_FLAGS_FALLBACK)
    with locked_path(fallback):
        flags = json.loads(fallback.read_text(encoding="utf-8")) if fallback.is_file() else {}
        _apply(flags, path, enabled)
        atomic_write(fallback, json.dumps(flags, indent=2, sort_keys=True))


def _apply(flags: dict, path: str, enabled: bool | None) -> None:
    if enabled is None:
        flags.pop(path, None)
    else:
        flags[path] = enabled


def _override_text(vault: Path, path: str) -> str | None:
    target = override_file(vault, path)
    return target.read_text(encoding="utf-8") if target.is_file() else None


def _entry(vault: Path, flags: dict[str, bool], segment: dict[str, str]) -> dict:
    path = segment["path"]
    override = _override_text(vault, path)
    return {
        "path": path,
        "source": segment["source"],
        "override": override,
        "enabled": bool(flags.get(path)) and override is not None,
    }


@prompts_router.get("")
async def list_prompts(request: Request):
    state = get_app_state(request.app)
    vault = Path(state.vault_path)
    flags = load_override_flags(vault, state.get_config())
    return [_entry(vault, flags, segment) for segment in list_prompt_segments()]


@prompts_router.put("/{path:path}")
async def put_prompt_override(path: str, payload: PromptOverridePayload, request: Request):
    path = _known(path)
    state = get_app_state(request.app)
    vault = Path(state.vault_path)
    target = override_file(vault, path)
    with locked_path(target):
        atomic_write(target, payload.text)
    config = state.get_config()
    _save_flag(vault, config, path, payload.enabled)
    segment = next(s for s in list_prompt_segments() if s["path"] == path)
    return _entry(vault, load_override_flags(vault, state.get_config()), segment)


@prompts_router.delete("/{path:path}")
async def delete_prompt_override(path: str, request: Request):
    path = _known(path)
    state = get_app_state(request.app)
    vault = Path(state.vault_path)
    target = override_file(vault, path)
    with locked_path(target):
        target.unlink(missing_ok=True)
    _save_flag(vault, state.get_config(), path, None)
    segment = next(s for s in list_prompt_segments() if s["path"] == path)
    return _entry(vault, load_override_flags(vault, state.get_config()), segment)
