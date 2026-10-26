"""agy adapter against the real 1.4.7 stream-json transcript (no Google account involved)."""

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from learnharness.core.contracts.config import (
    AUTO_MODEL,
    ConnectorStatus,
    EngineKind,
    default_slots,
    recommend_engine,
)
from learnharness.engines import agy_gate, close_engine_processes, detector
from learnharness.engines.agy_engine import (
    AgyStreamEngine,
    TextAssembler,
    parse_event,
    write_agy_workspace,
)
from learnharness.engines.cli_protocol import EngineError
from learnharness.engines.gemini_acp import AcpProcessPool

FIXTURES = Path(__file__).parents[1] / "fixtures" / "agy"
REAL = FIXTURES / "agy-1.4.7-two-turns-json-schema-real.ndjson"
MCP_URL = "http://127.0.0.1:9/internal/mcp/"


def events(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


# ----------------------------------------------------------------- real transcript parsing


def test_real_transcript_two_turns_one_conversation():
    parsed = [parse_event(e) for e in events(REAL)]
    assert parsed[0] == ("init", "00000000-0000-4000-8000-000000000001")
    results = [value for kind, value in parsed if kind == "result"]
    assert len(results) == 2  # one result per stdin line: a persistent multi-turn process
    assert {r["conversation_id"] for r in results} == {"00000000-0000-4000-8000-000000000001"}
    assert results[0]["denied_actions"] == [{"action": "mcp", "display_name": "CallMcpTool"}]
    assert "structured_output" not in results[0]
    assert results[1]["structured_output"] == {"ready": False}
    texts = [value[1] for kind, value in parsed if kind == "text" and value[1]]
    assert texts == ['{"ready":false}\n']
    tools = [value for kind, value in parsed if kind == "tool"]
    assert [t["name"] for t in tools] == ["read_file", "read_file", "call_mcp_tool", "call_mcp_tool", "finish"]
    # Plugin-scoped servers are namespaced (harness_harness): only `.agents/mcp_config.json`
    # keeps the bare "harness" name the gate and the idle suspension rely on.
    assert not any(t["harness"] for t in tools)


def test_real_input_error_result_raises():
    (event,) = events(FIXTURES / "agy-1.4.7-input-error-real.ndjson")
    with pytest.raises(EngineError, match="missing the \"message\" field"):
        parse_event(event)


def test_harness_tool_step_is_flagged():
    step = {"event": "step_update", "step_update": {"step_index": 4, "state": "ACTIVE", "step_type": "tool",
            "tool_name": "call_mcp_tool", "tool_info": {"parameters": {"ServerName": "harness", "ToolName": "pose_quiz"}}}}
    kind, value = parse_event(step)
    assert kind == "tool" and value["harness"] and value["state"] == "ACTIVE"


def test_text_assembler_handles_delta_and_cumulative_updates():
    assembler = TextAssembler()
    assert assembler.feed(1, "Olá") == "Olá"
    assert assembler.feed(1, " mundo") == " mundo"
    assert assembler.feed(1, "Olá mundo") == ""  # DONE repeating the whole text
    assert assembler.feed(2, "abc") == "abc"
    assert assembler.feed(2, "abcdef") == "def"  # cumulative update


# ----------------------------------------------------------------- workspace + gate


def test_workspace_files_and_gate(tmp_path):
    write_agy_workspace(tmp_path, MCP_URL, "tok-1", python="/usr/bin/python3")
    agents = tmp_path / ".agents"
    config = json.loads((agents / "mcp_config.json").read_text())
    assert config == {"mcpServers": {"harness": {"url": MCP_URL, "headers": {"Authorization": "Bearer tok-1"}}}}
    assert (agents / "mcp_config.json").stat().st_mode & 0o777 == 0o600
    hooks = json.loads((agents / "hooks.json").read_text())
    (group,) = hooks["harness-gate"]["PreToolUse"]
    assert group["matcher"] == "*" and "harness_gate.py" in group["hooks"][0]["command"]
    assert (agents / "harness_gate.py").read_text() == Path(agy_gate.__file__).read_text()


@pytest.mark.parametrize(
    ("call", "decision"),
    [
        ({"name": "call_mcp_tool", "args": {"ServerName": "harness", "ToolName": "pose_quiz"}}, "allow"),
        ({"name": "call_mcp_tool", "args": {"ServerName": "praxis", "ToolName": "x"}}, "deny"),
        ({"name": "finish", "args": {"ready": True}}, "allow"),
        ({"name": "read_file", "args": {"Path": "SCHEMA/harness/pose_quiz.json"}}, "allow"),
        ({"name": "read_file", "args": {"Path": "SCHEMA/harness/../praxis/x.json"}}, "deny"),
        ({"name": "read_file", "args": {"Path": "/etc/passwd"}}, "deny"),
        ({"name": "run_command", "args": {"CommandLine": "rm -rf /"}}, "deny"),
        ({"name": "write_to_file", "args": {}}, "deny"),
    ],
)
def test_gate_allows_only_harness(tmp_path, call, decision):
    schema_dir = str(tmp_path / "mcp")
    args = {k: v.replace("SCHEMA", schema_dir) if isinstance(v, str) else v for k, v in call["args"].items()}
    result = agy_gate.decide({"toolCall": {**call, "args": args}}, schema_dir=schema_dir)
    assert result["decision"] == decision


def test_gate_script_runs_standalone(tmp_path):
    import subprocess

    write_agy_workspace(tmp_path)
    payload = json.dumps({"toolCall": {"name": "run_command", "args": {}}})
    out = subprocess.run(
        [sys.executable, "-I", str(tmp_path / ".agents" / "harness_gate.py")],
        input=payload, capture_output=True, text=True, check=True, cwd=tmp_path / ".agents",
    )
    assert json.loads(out.stdout)["decision"] == "deny"


# ----------------------------------------------------------------- persistent process


@pytest.fixture
def fake_binary(tmp_path):
    path = tmp_path / "agy"
    path.write_text(f"#!{sys.executable}\n" + (FIXTURES / "fake_agy.py").read_text().replace(
        'Path(__file__).with_name("agy-1.4.7-two-turns-json-schema-real.ndjson")', f"Path({str(REAL)!r})"))
    path.chmod(0o700)
    return str(path)


@pytest.fixture
async def pool():
    pool = AcpProcessPool(idle_close=None)
    yield pool
    await pool.close_all()


def read_log(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def process_gone(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


async def collect(engine, prompt, **kwargs):
    return "".join([c async for c in engine.stream_turn(prompt, "s1", **kwargs)])


def make(fake_binary, tmp_path, pool, token="tok-1", mode="replay", slot=None):
    log = tmp_path / "log.jsonl"
    engine = AgyStreamEngine(
        fake_binary, pool=pool, env={"FAKE_AGY_LOG": str(log), "FAKE_AGY_MODE": mode}, timeout=5
    )
    engine.configure_runtime(tmp_path / "work", MCP_URL, token)
    return engine, log


async def test_persistent_process_sends_only_new_content(fake_binary, tmp_path, pool):
    history = [SimpleNamespace(role="user", content="historico-antigo")]
    slot = SimpleNamespace(model_id="gemini-3.8-flash-low", effort="low")
    first, log = make(fake_binary, tmp_path, pool)
    assert await collect(first, "primeira", history=history, slot=slot, system_instruction="regras") == ""
    second, _ = make(fake_binary, tmp_path, pool)
    assert await collect(second, "segunda", history=history, slot=slot, system_instruction="regras") == '{"ready":false}\n'
    entries = read_log(log)
    starts = [e for e in entries if "start" in e]
    prompts = [e["prompt"] for e in entries if "prompt" in e]
    assert len(starts) == 1
    argv = starts[0]["argv"]
    assert argv[:5] == ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"]
    assert argv[argv.index("--model") + 1] == "gemini-3.8-flash-low"
    # The model id pins the effort; real agy rejects --effort alongside it.
    assert "--effort" not in argv
    assert starts[0]["cwd"] == str(tmp_path / "work")
    assert "regras" in prompts[0] and "historico-antigo" in prompts[0]
    assert prompts[1] == "segunda"
    assert pool.get("s1").conversation_id == "00000000-0000-4000-8000-000000000001"
    await close_engine_processes("s1")  # module pools: no-op for this injected pool
    await pool.close("s1")
    assert process_gone(starts[0]["start"])


async def test_new_token_or_auto_model_respawns(fake_binary, tmp_path, pool):
    first, log = make(fake_binary, tmp_path, pool)
    await collect(first, "a", slot=SimpleNamespace(model_id=AUTO_MODEL, effort=None))
    rotated, _ = make(fake_binary, tmp_path, pool, token="tok-2")
    await collect(rotated, "b", history=[SimpleNamespace(role="assistant", content="antes")],
                  slot=SimpleNamespace(model_id=AUTO_MODEL, effort=None), system_instruction="regras")
    entries = read_log(log)
    starts = [e for e in entries if "start" in e]
    assert len(starts) == 2 and "--model" not in starts[0]["argv"]
    assert process_gone(starts[0]["start"])
    assert "regras" in [e["prompt"] for e in entries if "prompt" in e][1]  # fresh -> rehydrated
    assert "tok-2" in (tmp_path / "work" / ".agents" / "mcp_config.json").read_text()


async def test_process_death_mid_turn_raises_and_next_turn_respawns(fake_binary, tmp_path, pool):
    dying, log = make(fake_binary, tmp_path, pool, mode="die")
    with pytest.raises(EngineError, match="exited mid-turn"):
        await collect(dying, "x")
    assert "s1" not in pool
    healthy, _ = make(fake_binary, tmp_path, pool)
    await collect(healthy, "y", history=[SimpleNamespace(role="user", content="h")], system_instruction="regras")
    starts = [e for e in read_log(log) if "start" in e]
    assert len(starts) == 2


async def test_run_structured_uses_isolated_workspace(fake_binary, tmp_path, monkeypatch):
    class Ready(BaseModel):
        ready: bool

    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_AGY_LOG", str(log))
    engine = AgyStreamEngine(fake_binary)
    # The replay answers turn 1 without structured output: a real validation failure.
    with pytest.raises(ValueError):
        await engine.run_structured("probe", Ready)
    (start,) = [e for e in read_log(log) if "start" in e]
    assert "learnharness-agy-" in start["cwd"] and "--json-schema" in start["argv"]
    assert engine.work_dir is None


# ----------------------------------------------------------------- defaults


def status(engine, available):
    return ConnectorStatus(engine=engine, available=available)


@pytest.mark.parametrize(
    ("agy", "sdk", "credentials", "expected"),
    [
        (True, True, True, EngineKind.AGY),
        (False, True, True, EngineKind.GENAI_SDK),
        (False, True, False, EngineKind.GEMINI_CLI),
        (False, False, True, EngineKind.GEMINI_CLI),
    ],
)
def test_recommend_engine(agy, sdk, credentials, expected):
    statuses = [status(EngineKind.GEMINI_CLI, True), status(EngineKind.AGY, agy), status(EngineKind.GENAI_SDK, sdk)]
    assert recommend_engine(statuses, sdk_credentials=credentials) == expected


def test_default_slots_per_engine():
    agy = default_slots(EngineKind.AGY)
    assert agy.strong.engine == EngineKind.AGY and agy.strong.model_id == AUTO_MODEL
    assert default_slots(EngineKind.GEMINI_CLI).strong.model_id == "gemini-2.5-pro"


def test_detector_marks_exactly_one_recommended(monkeypatch, tmp_path):
    monkeypatch.setattr(detector, "_find_executable", lambda name, paths: "/bin/agy" if name == "agy" else None)
    statuses = detector.detect_connectors()
    assert [s.engine for s in statuses if s.recommended] == [EngineKind.AGY]
    assert detector.get_default_engine() == EngineKind.AGY
    monkeypatch.setattr(detector, "_find_executable", lambda name, paths: None)
    monkeypatch.setattr(detector, "sdk_credentials_configured", lambda: False)
    assert detector.get_default_engine() == EngineKind.GEMINI_CLI


def test_sdk_credentials_detection(tmp_path):
    assert detector.sdk_credentials_configured({"GEMINI_API_KEY": "x"}, home=tmp_path)
    assert not detector.sdk_credentials_configured({}, home=tmp_path)
    adc = tmp_path / ".config/gcloud/application_default_credentials.json"
    adc.parent.mkdir(parents=True)
    adc.write_text("{}")
    assert detector.sdk_credentials_configured({}, home=tmp_path)
