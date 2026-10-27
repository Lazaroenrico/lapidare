"""Settings → Agente: tool toggles, compaction threshold and graph extraction batch size.

``GET``/``PUT /api/settings/agent``. The body is flat for the UI
(``{tools, compaction_tokens, extraction_chunk_tokens}``) and maps onto
``config.agent`` and ``config.graph`` in ``.harness/config.json``.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from learnharness.api.state import get_app_state
from learnharness.core.contracts.config import HarnessConfig, ToolToggles
from learnharness.core.events import SseEventType
from learnharness.vault.bootstrap import save_config

settings_agent_router = APIRouter(prefix="/api/settings/agent", tags=["settings"])

MIN_COMPACTION_TOKENS = 32_000
MIN_EXTRACTION_CHUNK_TOKENS = 500


class ToolTogglesPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    research: bool | None = None
    pdf: bool | None = None
    visual: bool | None = None
    demo: bool | None = None


class AgentSettingsPatch(BaseModel):
    """Partial update; omitted fields keep their saved value."""

    model_config = ConfigDict(extra="forbid")
    tools: ToolTogglesPatch | None = None
    compaction_tokens: int | None = Field(default=None, ge=MIN_COMPACTION_TOKENS)
    extraction_chunk_tokens: int | None = Field(default=None, ge=MIN_EXTRACTION_CHUNK_TOKENS)


def _view(config: HarnessConfig) -> dict:
    return {
        "tools": config.agent.tools.model_dump(),
        "compaction_tokens": config.agent.compaction_tokens,
        "extraction_chunk_tokens": config.graph.extraction_chunk_tokens,
    }


@settings_agent_router.get("")
async def get_agent_settings(request: Request):
    return _view(get_app_state(request.app).get_config())


@settings_agent_router.put("")
async def put_agent_settings(payload: AgentSettingsPatch, request: Request):
    state = get_app_state(request.app)
    vault = Path(state.vault_path)
    if not (vault / ".harness/config.json").is_file():
        raise HTTPException(status_code=409, detail="Complete the setup before changing agent settings")
    config = state.get_config()
    if payload.tools is not None:
        merged = config.agent.tools.model_dump() | payload.tools.model_dump(exclude_none=True)
        config.agent.tools = ToolToggles(**merged)
    if payload.compaction_tokens is not None:
        config.agent.compaction_tokens = payload.compaction_tokens
    if payload.extraction_chunk_tokens is not None:
        config.graph.extraction_chunk_tokens = payload.extraction_chunk_tokens
    save_config(vault, config)
    state.sse_hub.broadcast(SseEventType.CONFIG_UPDATED, {"section": "agent"})
    return _view(config)
