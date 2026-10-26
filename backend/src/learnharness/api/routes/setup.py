"""Validated setup, provider probes and canonical configuration responses."""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field, SecretStr, field_validator

from learnharness.api.state import get_app_state
from learnharness.core.contracts.config import (
    EngineKind,
    HarnessConfig,
    McpServerConfig,
    ModelSlotConfig,
    ModelSlots,
    TrackConfig,
    TrackMode,
    VaultFolderMap,
    default_slots,
)
from learnharness.core.events import SseEventType
from learnharness.engines.cli_protocol import EngineError
from learnharness.engines.detector import detect_connectors, get_default_engine
from learnharness.vault.bootstrap import bootstrap_vault, save_config
from learnharness.vault.safety import atomic_write, safe_path, validate_folders

CONNECTOR_TEST_TIMEOUT = 90.0

setup_router = APIRouter(prefix="/api/setup", tags=["setup"])


class SetupCompletePayload(BaseModel):
    language: str = "pt-BR"
    vault_path: str | None = None
    repo_path: str | None = None
    folders: VaultFolderMap | None = None
    vault_folders: VaultFolderMap | None = None
    slots: ModelSlots | None = None
    track: TrackConfig | None = None
    content_mcps: list[McpServerConfig] | None = None
    api_key: SecretStr | None = Field(default=None, json_schema_extra={"writeOnly": True})

    @field_validator("language")
    @classmethod
    def supported_language(cls, value):
        if value.lower() not in ("pt-br", "en"):
            raise ValueError("Supported languages are pt-BR and en")
        return "pt-BR" if value.lower() == "pt-br" else "en"


class ConnectorProbePayload(BaseModel):
    slot: ModelSlotConfig
    api_key: SecretStr | None = Field(default=None, json_schema_extra={"writeOnly": True})


class ProbeResult(BaseModel):
    ready: bool


def _serialize_config_for_frontend(config: HarnessConfig) -> dict[str, Any]:
    data = config.model_dump(mode="json")
    data["initialized"] = config.configured
    data["vault_folders"] = {"aulas": config.folders.lessons_dir, "conceitos": config.folders.concepts_dir, "fontes": config.folders.sources_dir, "desenhos": config.folders.drawings_dir, "viz": config.folders.viz_dir, "templates": config.folders.templates_dir}
    data["track"].update({"active": bool(config.track.active_item_id or config.track.queue), "current_step_id": config.track.active_item_id, "items": [{**it.model_dump(mode="json"), "source_path": it.source_ref} for it in config.track.queue]})
    return data


@setup_router.get("/status")
async def get_setup_status(request: Request):
    state = get_app_state(request.app)
    config = state.get_config()
    connectors = [{**c.model_dump(mode="json"), "name": c.engine.value.upper(), "details": c.detail, "available_models": c.models} for c in detect_connectors()]
    return {"initialized": config.configured, "configured": config.configured, "config": _serialize_config_for_frontend(config) if config.configured else None, "connectors": connectors}


@setup_router.get("/models")
async def get_models(engine: EngineKind, request: Request):
    """Models the connector actually offers this account (``agy models``, the SDK list, or static)."""
    from learnharness.engines.models import list_models

    state = get_app_state(request.app)
    return await list_models(engine, api_key=state.api_key)


@setup_router.post("/connectors/test")
async def test_connector(payload: ConnectorProbePayload, request: Request):
    """Spend one tiny structured prompt to prove auth + model + output parsing end to end."""
    state = get_app_state(request.app)
    if payload.api_key:
        state.api_key = payload.api_key.get_secret_value()
    engine = state.engine(payload.slot)
    started = time.monotonic()
    try:
        await asyncio.wait_for(
            engine.run_structured(
                prompt='Responda somente com o JSON {"ready": true}.', schema=ProbeResult, slot=payload.slot
            ),
            CONNECTOR_TEST_TIMEOUT,
        )
    except TimeoutError as exc:
        raise EngineError(f"Sem resposta em {CONNECTOR_TEST_TIMEOUT:g} s") from exc
    # Any schema-valid answer proves the connection; the boolean's value is the model's whim.
    return {
        "ok": True,
        "engine": payload.slot.engine,
        "model_id": payload.slot.model_id,
        "latency_ms": round((time.monotonic() - started) * 1000),
        "authenticated": True,
    }


@setup_router.post("/complete")
async def complete_setup(payload: SetupCompletePayload, request: Request):
    state = get_app_state(request.app)
    target = Path(payload.vault_path or state.vault_path).expanduser().resolve()
    track = payload.track
    repo = payload.repo_path or (track.repo_path if track else None)
    repo_path = Path(repo).expanduser().resolve() if repo else None
    if repo_path and not repo_path.is_dir():
        raise ValueError("Curriculum repository does not exist")
    requested_folders = payload.folders or payload.vault_folders
    if requested_folders:
        validate_folders(target, requested_folders)
    first_setup = not (target / ".harness" / "config.json").is_file()
    config = bootstrap_vault(target, language=payload.language, repo_path=repo_path)
    config.language = payload.language
    if requested_folders:
        config.folders = requested_folders
    if payload.slots:
        config.slots = payload.slots
    elif first_setup:
        # First setup without explicit slots: use the connector that actually works here
        # (agy before gemini CLI, whose individual accounts are blocked since 0.62).
        config.slots = default_slots(get_default_engine())
    if track:
        # Adopt parsed queues unless an explicit replacement queue was provided.
        if "queue" not in track.model_fields_set and config.track.queue:
            track.queue = config.track.queue
            track.active_item_id = config.track.active_item_id
        config.track = track
    if payload.content_mcps is not None:
        config.content_mcps = payload.content_mcps
    config.vault_path = str(target)
    config.configured = True
    save_config(target, config)
    for name in (config.folders.lessons_dir, config.folders.concepts_dir, config.folders.sources_dir, config.folders.drawings_dir, config.folders.viz_dir, config.folders.templates_dir):
        safe_path(target, name).mkdir(parents=True, exist_ok=True)
    api_key = payload.api_key.get_secret_value() if payload.api_key else state.api_key
    await state.switch_vault(target, api_key)
    if not state.explicit_vault:
        registry = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "learnharness" / "active-vault"
        atomic_write(registry, str(target))
    if config.track.mode != TrackMode.FREE and not config.track.queue:
        state.jobs.submit("track_gen", {"topic": config.track.goal_description or "Curriculum"}, key="track:initial")
    state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"vault_path": str(target)})
    state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {})
    return {"success": True, "config": _serialize_config_for_frontend(config)}


class AgyPermissionPayload(BaseModel):
    consent: bool = False


@setup_router.get("/agy-permission")
async def get_agy_permission():
    """Whether the user's global agy settings allow the harness MCP tools."""
    from learnharness.services import agy_permissions

    return agy_permissions.status()


@setup_router.post("/agy-permission")
async def grant_agy_permission(payload: AgyPermissionPayload):
    """Add ``mcp(harness/*)`` to the global agy allow-list, only with explicit consent."""
    from learnharness.services import agy_permissions

    if not payload.consent:
        raise ValueError("Explicit consent is required to edit the agy settings")
    try:
        return agy_permissions.grant()
    except agy_permissions.AgySettingsError as exc:
        raise ValueError(str(exc)) from exc
