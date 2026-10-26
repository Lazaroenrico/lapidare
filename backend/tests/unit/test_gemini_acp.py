"""ACP adapter against a fake stdio agent; no Google account or network involved."""

import asyncio
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from learnharness.core.contracts.config import EngineKind
from learnharness.engines import (
    AgyStreamEngine,
    GeminiAcpEngine,
    GeminiCliAcpEngine,
    GeminiHeadlessEngine,
    cli_protocol,
    get_engine,
)
from learnharness.engines.cli_protocol import EngineError
from learnharness.engines.gemini_acp import (
    AcpProcessPool,
    compose_prompt,
    handle_agent_request,
    parse_update,
    permission_response,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "acp"
FAKE_AGENT = FIXTURES / "fake_acp_agent.py"
MCP_URL = "http://127.0.0.1:1/internal/mcp/"


def lines(name):
    return [json.loads(line) for line in (FIXTURES / name).read_text().splitlines() if line]


@pytest.fixture
def pool():
    return AcpProcessPool()


@pytest.fixture
async def make_engine(tmp_path, pool):
    binary = tmp_path / "gemini"
    binary.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE_AGENT} "$@"\n')
    binary.chmod(0o700)
    log = tmp_path / "agent.ndjson"

    def factory(scenario="stream", token="tok-1", work_dir=None, **kwargs):
        env = {"FAKE_ACP_LOG": str(log), "FAKE_ACP_SCENARIO": scenario}
        env.update(kwargs.pop("env", {}))
        engine = GeminiCliAcpEngine(str(binary), pool=pool, env=env, **kwargs)
        directory = work_dir or tmp_path / "work"
        directory.mkdir(exist_ok=True)
        engine.configure_runtime(directory, MCP_URL, token)
        return engine

    factory.log = log
    yield factory
    await pool.close_all()


def records(log):
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def received(log, method=None):
    found = [r["recv"] for r in records(log) if "recv" in r]
    return [m for m in found if method is None or m.get("method") == method]


def starts(log):
    return [r["start"] for r in records(log) if "start" in r]


async def collect(engine, prompt="pergunta", session="s1", **kwargs):
    return "".join([part async for part in engine.stream_turn(prompt, session, **kwargs)])


def process_gone(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


# ----------------------------------------------------------------- recorded transcripts


def test_real_handshake_transcript_matches_adapter():
    exchange = lines("gemini-0.62.0-handshake-real.ndjson")
    init_request, init_reply, new_request, new_reply = (entry["msg"] for entry in exchange)
    assert init_request["method"] == "initialize"
    assert init_request["params"]["clientCapabilities"]["fs"] == {
        "readTextFile": False,
        "writeTextFile": False,
    }
    result = init_reply["result"]
    assert result["protocolVersion"] == 1
    assert result["agentInfo"]["version"] == "0.62.0"
    assert result["agentCapabilities"]["loadSession"] is True
    assert result["agentCapabilities"]["mcpCapabilities"] == {"http": True, "sse": True}
    assert new_request["method"] == "session/new"
    server = new_request["params"]["mcpServers"][0]
    engine = GeminiCliAcpEngine("/bin/false")
    engine.mcp_url, engine.mcp_token = server["url"], "REDACTED"
    assert engine._mcp_servers() == [server]
    # Account-level failure is reported by session/new, never by initialize.
    assert new_reply["error"]["code"] == -32000
    assert "Antigravity" in new_reply["error"]["message"]


def test_synthetic_turn_parser_and_permission_policy():
    messages = [entry["msg"] for entry in lines("gemini-0.62.0-turn-synthetic.ndjson")]
    texts = [
        payload
        for message in messages
        if message.get("method") == "session/update"
        for kind, payload in [parse_update(message)]
        if kind == "text"
    ]
    assert texts == ["Olá, ", "mundo"]
    tools = [parse_update(m)[1] for m in messages if m.get("method") == "session/update"]
    harness = {t["id"]: t["harness"] for t in tools if isinstance(t, dict) and "harness" in t}
    assert harness == {
        "mcp_harness_plan_init-1761480000000-1": True,
        "run_shell_command-1761480000001-2": False,
    }
    requests = [m for m in messages if "id" in m and "method" in m]
    allow, deny, fs_read = requests
    assert permission_response(allow["params"])["outcome"] == {
        "outcome": "selected",
        "optionId": "proceed_once",
    }
    assert permission_response(deny["params"])["outcome"] == {
        "outcome": "selected",
        "optionId": "cancel",
    }
    result, error = handle_agent_request(fs_read["method"], fs_read["params"])
    assert result is None and error["code"] == -32601
    assert handle_agent_request("terminal/create", {})[1]["code"] == -32601
    # A lookalike title from another source is not trusted without an allow option.
    assert permission_response({"toolCall": {"toolCallId": "x"}, "options": []}) == {
        "outcome": {"outcome": "cancelled"}
    }


def test_compose_prompt_fresh_vs_live():
    history = [SimpleNamespace(role="user", content="antes"), {"role": "assistant", "content": "x"}]
    fresh = compose_prompt("agora", history, "regras", fresh=True)
    assert "regras" in fresh and "user: antes" in fresh and fresh.endswith("agora")
    assert compose_prompt("agora", history, "regras", fresh=False) == "agora"
    assert not compose_prompt("/quit", fresh=False).startswith("/")


def test_engine_selection_and_aliases():
    slot = SimpleNamespace(engine=EngineKind.GEMINI_CLI, model_id="m", effort=None)
    assert isinstance(get_engine(slot), GeminiCliAcpEngine)
    assert GeminiAcpEngine is GeminiCliAcpEngine
    assert issubclass(AgyStreamEngine, GeminiHeadlessEngine)
    from learnharness.engines.gemini_engine import GeminiAcpEngine as legacy

    assert legacy is GeminiCliAcpEngine


# ----------------------------------------------------------------- live fake agent


async def test_handshake_streaming_and_permissions(make_engine, pool, tmp_path):
    engine = make_engine("stream")
    assert await collect(engine) == "Olá, mundo"
    log = make_engine.log
    (start,) = starts(log)
    assert start["argv"][:3] == ["--acp", "--allowed-mcp-server-names", "harness"]
    assert start["trust"] == "true"
    assert start["cwd"] == str(tmp_path / "work")
    (init,) = received(log, "initialize")
    assert init["params"]["clientCapabilities"] == {
        "fs": {"readTextFile": False, "writeTextFile": False},
        "terminal": False,
    }
    (new,) = received(log, "session/new")
    assert new["params"]["cwd"] == str(tmp_path / "work")
    assert new["params"]["mcpServers"] == [
        {
            "type": "http",
            "name": "harness",
            "url": MCP_URL,
            "headers": [{"name": "Authorization", "value": "Bearer tok-1"}],
        }
    ]
    replies = {m["id"]: m for m in received(log) if "method" not in m}
    assert replies[0]["result"]["outcome"]["optionId"] == "proceed_once"
    assert replies[1]["result"]["outcome"]["optionId"] == "cancel"
    assert replies[2]["error"]["code"] == -32601
    settings = (tmp_path / "work" / ".gemini" / "settings.json").read_text()
    assert "tok-1" not in settings and "run_shell_command" in settings
    assert "s1" in pool
    await pool.close_all()
    assert process_gone(start["pid"])


async def test_live_process_sends_only_new_content_and_rebinds_token(make_engine, pool):
    history = [SimpleNamespace(role="user", content="historico-antigo")]
    first = make_engine("echo")
    assert await collect(first, "primeira", history=history, system_instruction="regras") == "ok"
    second = make_engine("echo")
    assert await collect(second, "segunda", history=history, system_instruction="regras") == "ok"
    third = make_engine("echo", token="tok-2")
    assert await collect(third, "terceira", history=history) == "ok"
    log = make_engine.log
    assert len(starts(log)) == 1
    prompts = [m["params"]["prompt"][0]["text"] for m in received(log, "session/prompt")]
    assert "historico-antigo" in prompts[0] and "regras" in prompts[0]
    assert prompts[1:] == ["segunda", "terceira"]
    (load,) = received(log, "session/load")
    assert load["params"]["mcpServers"][0]["headers"][0]["value"] == "Bearer tok-2"
    assert len({m["params"]["sessionId"] for m in received(log, "session/prompt")}) == 1


async def test_harness_tool_call_suspends_idle_timeout(make_engine, monkeypatch):
    monkeypatch.setattr(cli_protocol, "SUSPEND_POLL_SECONDS", 0.05)
    engine = make_engine("suspend", timeout=0.3, env={"FAKE_ACP_SLEEP": "1.0"})
    assert await collect(engine) == "depois"


async def test_learner_callback_suspends_then_idle_timeout_fires(make_engine, pool, monkeypatch):
    monkeypatch.setattr(cli_protocol, "SUSPEND_POLL_SECONDS", 0.05)
    loop = asyncio.get_running_loop()
    release_at = loop.time() + 0.8
    calls = []

    def waiting(session_id):
        calls.append(session_id)
        return loop.time() < release_at

    engine = make_engine("hang", timeout=0.3, is_waiting_on_learner=waiting)
    with pytest.raises(EngineError, match="idle"):
        await collect(engine)
    assert loop.time() >= release_at + 0.25
    assert set(calls) == {"s1"}
    (start,) = starts(make_engine.log)
    assert "s1" not in pool
    assert process_gone(start["pid"])


async def test_process_death_raises_then_rehydrates(make_engine, pool, tmp_path):
    marker = tmp_path / "died"
    history = [SimpleNamespace(role="assistant", content="explicacao-previa")]
    engine = make_engine("die_once", env={"FAKE_ACP_MARKER": str(marker)})
    with pytest.raises(EngineError, match="exited"):
        await collect(engine, "primeira", history=history)
    assert "s1" not in pool
    engine = make_engine("die_once", env={"FAKE_ACP_MARKER": str(marker)})
    assert await collect(engine, "segunda", history=history) == "recuperado"
    assert len(starts(make_engine.log)) == 2
    last = received(make_engine.log, "session/prompt")[-1]["params"]["prompt"][0]["text"]
    assert "CONVERSATION SO FAR" in last and "explicacao-previa" in last
    assert last.endswith("segunda")


async def test_cancellation_sends_session_cancel(make_engine, pool):
    engine = make_engine("cancel")
    first_chunk = asyncio.Event()

    async def consume():
        async for _ in engine.stream_turn("pergunta", "s1"):
            first_chunk.set()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(first_chunk.wait(), 10)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    (cancel,) = received(make_engine.log, "session/cancel")
    (prompt,) = received(make_engine.log, "session/prompt")
    assert cancel["params"]["sessionId"] == prompt["params"]["sessionId"]
    assert "id" not in cancel  # notification
    # The agent acknowledged with stopReason=cancelled, so the process stays reusable.
    assert "s1" in pool


async def test_auth_error_surfaces_as_engine_error(make_engine, pool):
    engine = make_engine("stream", env={"FAKE_ACP_AUTH_ERROR": "1"})
    with pytest.raises(EngineError, match="no longer supported"):
        await collect(engine)
    assert "s1" not in pool
    (start,) = starts(make_engine.log)
    assert process_gone(start["pid"])


async def test_idle_close_reaps_process(make_engine):
    engine = make_engine("echo")
    engine.pool.idle_close = 0.1
    assert await collect(engine) == "ok"
    (start,) = starts(make_engine.log)
    for _ in range(100):
        if "s1" not in engine.pool and process_gone(start["pid"]):
            break
        await asyncio.sleep(0.05)
    assert "s1" not in engine.pool
    assert process_gone(start["pid"])
