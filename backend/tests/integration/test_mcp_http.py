"""Real HTTP integration tests for the per-execution MCP server mounted at /internal/mcp.

The app runs under uvicorn on an ephemeral loopback port so that the FastAPI lifespan,
the streamable-HTTP session manager, FastMCP's Host/Origin guard and the Bearer gate are
all exercised exactly as the gemini/agy CLIs would hit them in production.
"""

from __future__ import annotations

import asyncio
import socket
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.exceptions import ToolError

from learnharness.api.app import create_app
from learnharness.api.state import AppState
from learnharness.vault.bootstrap import bootstrap_vault, load_config, save_config

EXPECTED_TOOLS = {"probe", "recall", "quiz", "explain", "ask_user_question", "probe_done", "plan_init",
                  "grade_recall", "plan_advance", "track_foundation", "spawn_demo", "problem", "conclude",
                  "graph_search", "research", "read_pdf", "visual"}


class IdleEngine:
    """Engine that never speaks; sessions scheduled after an answer finish immediately."""

    tool_transport = "mcp"

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None) -> AsyncIterator[str]:
        if False:  # pragma: no cover - makes this an async generator
            yield ""

    async def run_structured(self, prompt, schema, slot=None, system_instruction=None):
        return schema.model_validate({})


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _configured_vault(root: Path) -> Path:
    vault = root / "Vault"
    vault.mkdir()
    bootstrap_vault(vault, language="pt-BR")
    config = load_config(vault)
    config.configured = True
    config.vault_path = str(vault)
    save_config(vault, config)
    return vault


async def _wait_until(predicate, timeout: float = 5.0, interval: float = 0.02):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        result = await predicate()
        if result:
            return result
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition not met within timeout")
        await asyncio.sleep(interval)


@pytest.fixture
async def server(tmp_path: Path):
    state = AppState(vault_path=_configured_vault(tmp_path), engine_factory=lambda slot: IdleEngine())
    app = create_app(state=state)
    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on")
    uv_server = uvicorn.Server(config)
    task = asyncio.create_task(uv_server.serve())
    try:
        await _wait_until(lambda: asyncio.sleep(0, uv_server.started), timeout=10)
        yield {"state": state, "base": f"http://127.0.0.1:{port}", "mcp": f"http://127.0.0.1:{port}/internal/mcp/"}
    finally:
        uv_server.should_exit = True
        await asyncio.wait_for(task, timeout=10)


def _client(url: str, token: str) -> Client:
    return Client(StreamableHttpTransport(url, headers={"Authorization": f"Bearer {token}"}), timeout=10)


async def _session_with_token(state: AppState) -> tuple[str, str]:
    session = await state.sessions.create(mode="TEACH", topic="Atenção", start=False)
    session.execution_id = "exec-1"
    state.sessions.save(session)
    return session.id, state.issue_token(session.id, "exec-1")


async def test_missing_or_unknown_token_is_rejected(server: dict[str, Any]) -> None:
    async with httpx.AsyncClient() as http:
        no_token = await http.post(server["mcp"], json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        bad_token = await http.post(server["mcp"], json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={"Authorization": "Bearer not-issued"})
    assert no_token.status_code == 401
    assert bad_token.status_code == 401


async def test_valid_token_lists_the_harness_tools(server: dict[str, Any]) -> None:
    _, token = await _session_with_token(server["state"])
    async with _client(server["mcp"], token) as client:
        tools = await client.list_tools()
    assert {t.name for t in tools} == EXPECTED_TOOLS
    from learnharness.engines.gemini_acp import HARNESS_TOOLS
    from learnharness.mcp.runtime_server import HARNESS_TOOL_NAMES
    assert HARNESS_TOOLS == HARNESS_TOOL_NAMES == EXPECTED_TOOLS  # ACP permission allow-list stays in sync.
    probe = next(t for t in tools if t.name == "probe")
    properties = list(probe.input_schema["properties"])
    assert properties.index("explanation") < properties.index("correct")  # Why before the answer.
    assert set(probe.input_schema["required"]) == {"question", "options", "explanation", "correct"}


async def test_refusal_reaches_the_model_as_a_corrective_tool_error(server: dict[str, Any]) -> None:
    _, token = await _session_with_token(server["state"])
    arguments = {"type": "check", "node_id": "x", "question": "?", "options": ["a", "b"],
                 "explanation": "e", "correct": "A"}
    async with _client(server["mcp"], token) as client:
        with pytest.raises(ToolError, match="probe/recall"):
            await client.call_tool("quiz", arguments)
        with pytest.raises(ToolError, match="probe_done before plan_init"):
            await client.call_tool("plan_init", {"mermaid": "graph TD\n  a[A]"})


async def test_stale_token_cannot_call_tools(server: dict[str, Any]) -> None:
    state = server["state"]
    session_id, token = await _session_with_token(state)
    session = state.sessions.get(session_id)
    session.execution_id = "exec-2"  # A newer execution supersedes the token's binding.
    state.sessions.save(session)
    async with _client(server["mcp"], token) as client:
        with pytest.raises(ToolError, match="stale"):
            await client.call_tool("plan_init", {"approach_prose": "x", "mermaid": "graph TD\n  a[A]"})
    assert state.sessions.get(session_id).plan.nodes == []


async def test_probe_blocks_until_rest_answer(server: dict[str, Any]) -> None:
    state = server["state"]
    session_id, token = await _session_with_token(state)
    arguments = {
        "question": "Softmax normaliza o quê?",
        # Models sometimes JSON-encode lists; the tool heals it.
        "options": '[{"value": "a", "label": "Os scores"}, {"value": "b", "label": "Os pesos de V"}]',
        "explanation": "Softmax normaliza os scores QK^T.", "correct": "Os scores",
    }
    async with _client(server["mcp"], token) as client, httpx.AsyncClient(base_url=server["base"]) as http:
        call = asyncio.create_task(client.call_tool("probe", arguments))

        async def pending():
            body = (await http.get(f"/api/chats/{session_id}")).json()
            return body["pending_quiz"]

        quiz = await _wait_until(pending)
        assert not call.done(), "probe must block until the learner answers"
        assert quiz["mode"] == "PROBE" and "explanation" not in quiz

        answer = await http.post(f"/api/chats/{session_id}/answer", json={"quiz_id": quiz["quiz_id"], "chosen_indices": [0], "confidence": 85})
        assert answer.status_code == 200
        result = (await asyncio.wait_for(call, timeout=5)).structured_content

    assert result["correct"] is True
    assert result["confidence"] == 85
    assert result["calibration_band"] == "calibrated_mastery"
    assert result["question_id"] == quiz["quiz_id"]
    assert result["answers"] == [{"index": 0, "label": "Os scores"}]
