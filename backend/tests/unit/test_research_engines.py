"""Web research per engine (Fase 10): agy (real fixture), google-genai grounding, gemini CLI."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from learnharness.core.contracts.jobs import ResearchResult
from learnharness.engines import agy_gate
from learnharness.engines.agy_engine import AgyStreamEngine, write_agy_workspace
from learnharness.engines.cli_protocol import EngineError
from learnharness.engines.gemini_acp import GeminiCliAcpEngine
from learnharness.engines.gemini_engine import WEB_SEARCH_TOOL, write_research_settings
from learnharness.engines.genai_sdk_engine import GenAiSdkEngine

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "agy"
RESEARCH = FIXTURES / "agy-1.4.8-research-search-web-real.ndjson"


# ----------------------------------------------------------------- agy: real capture + gate


def test_real_agy_init_exposes_the_web_read_tools():
    init = json.loads(RESEARCH.read_text(encoding="utf-8").splitlines()[0])
    tools = set(init["init"]["tools"])
    assert tools >= agy_gate.WEB_READ_TOOLS
    steps = [json.loads(line) for line in RESEARCH.read_text(encoding="utf-8").splitlines()]
    used = {s["step_update"].get("tool_name") for s in steps if s["event"] == "step_update"}
    assert "search_web" in used and not (used - {None, "search_web", "finish"})


@pytest.mark.parametrize(
    ("name", "args", "decision"),
    [
        ("search_web", {"query": "x"}, "allow"),
        ("read_url_content", {"Url": "https://example.org"}, "allow"),
        ("finish", {}, "allow"),
        ("call_mcp_tool", {"ServerName": "harness"}, "deny"),
        ("open_browser_url", {"Url": "https://example.org"}, "deny"),
        ("run_command", {"CommandLine": "ls"}, "deny"),
        ("write_to_file", {"TargetFile": "/tmp/x"}, "deny"),
        ("view_file", {"AbsolutePath": "/etc/passwd"}, "deny"),
    ],
)
def test_research_gate_allows_only_web_reads(name, args, decision):
    payload = {"toolCall": {"name": name, "args": args}}
    assert agy_gate.decide(payload, policy="research")["decision"] == decision


def test_harness_gate_still_denies_web_tools():
    assert agy_gate.decide({"toolCall": {"name": "search_web", "args": {}}})["decision"] == "deny"


def test_research_workspace_gate_runs_standalone(tmp_path):
    write_agy_workspace(tmp_path, policy="research")
    agents = tmp_path / ".agents"
    assert json.loads((agents / "mcp_config.json").read_text()) == {"mcpServers": {}}

    def run(name):
        out = subprocess.run(
            [sys.executable, "-I", str(agents / "harness_gate.py")],
            input=json.dumps({"toolCall": {"name": name, "args": {}}}),
            capture_output=True, text=True, check=True,
        )
        return json.loads(out.stdout)["decision"]

    assert run("search_web") == "allow" and run("run_command") == "deny"
    # The session workspace keeps the strict default.
    write_agy_workspace(tmp_path / "session", "http://127.0.0.1:1/mcp", "tok")
    assert json.loads((tmp_path / "session/.agents/gate_policy.json").read_text()) == {"policy": "harness"}
    with pytest.raises(ValueError):
        write_agy_workspace(tmp_path / "bad", "http://127.0.0.1:1/mcp", policy="research")


FAKE_AGY = """
import json, os, sys
from pathlib import Path
log = Path(os.environ["FAKE_AGY_LOG"])
policy = json.loads((Path.cwd() / ".agents" / "gate_policy.json").read_text())["policy"]
log.write_text(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "policy": policy}))
request = json.loads(sys.stdin.readline())
assert request["event"] == "user"
lines = Path(os.environ["FAKE_AGY_FIXTURE"]).read_text().splitlines()
mode = os.environ.get("FAKE_AGY_MODE", "replay")
for line in lines:
    event = json.loads(line)
    if mode == "no_search" and event.get("step_update", {}).get("tool_name") == "search_web":
        continue
    print(json.dumps(event), flush=True)
"""


def _fake_agy(tmp_path, mode="replay"):
    path = tmp_path / "agy"
    path.write_text(f"#!{sys.executable}\n{FAKE_AGY}")
    path.chmod(0o700)
    log = tmp_path / "agy-log.json"
    env = {"FAKE_AGY_LOG": str(log), "FAKE_AGY_FIXTURE": str(RESEARCH), "FAKE_AGY_MODE": mode}
    return AgyStreamEngine(str(path), env=env, timeout=5), log


async def test_agy_research_replays_the_real_capture(tmp_path):
    engine, log = _fake_agy(tmp_path)
    result = await engine.research("When was Python 1.0 released?")
    assert isinstance(result, ResearchResult)
    assert "1994" in result.brief and "## Lacunas" in result.brief
    assert result.sources and result.sources[0].url.startswith("https://")
    started = json.loads(log.read_text())
    assert started["policy"] == "research" and "learnharness-agy-research-" in started["cwd"]
    assert "--json-schema" in started["argv"]
    assert engine.work_dir is None  # the session workspace is untouched


async def test_agy_research_without_a_web_step_fails(tmp_path):
    engine, _ = _fake_agy(tmp_path, mode="no_search")
    with pytest.raises(EngineError, match="without consulting the web"):
        await engine.research("q")


# ----------------------------------------------------------------- google-genai grounding


def _sdk(response):
    engine = GenAiSdkEngine(api_key="test-key")
    calls = []

    async def generate_content(**kwargs):
        calls.append(kwargs)
        return response

    engine.client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)))
    return engine, calls


def _grounded(text, chunks):
    metadata = SimpleNamespace(grounding_chunks=[SimpleNamespace(web=SimpleNamespace(uri=u, title=t))
                                                 for t, u in chunks])
    return SimpleNamespace(text=text, usage_metadata=None,
                           candidates=[SimpleNamespace(grounding_metadata=metadata)])


async def test_sdk_research_takes_sources_from_grounding():
    engine, calls = _sdk(_grounded("## Resumo\n1994.", [("python.org", "https://python.org/a"),
                                                        ("dup", "https://python.org/a")]))
    assert engine.research_ready()
    result = await engine.research("q", slot=SimpleNamespace(model_id="gemini-2.5-flash"))
    assert result.brief.startswith("## Resumo")
    assert [s.url for s in result.sources] == ["https://python.org/a"]
    (tool,) = calls[0]["config"].tools
    assert tool.google_search is not None


async def test_sdk_research_without_grounding_fails():
    engine, _ = _sdk(_grounded("from memory", []))
    with pytest.raises(EngineError, match="no sources"):
        await engine.research("q")


# ----------------------------------------------------------------- gemini CLI allow-list


FAKE_GEMINI = """
import json, os, sys
from pathlib import Path
settings = json.loads((Path.cwd() / ".gemini" / "settings.json").read_text())
Path(os.environ["FAKE_GEMINI_LOG"]).write_text(json.dumps({"argv": sys.argv[1:], "settings": settings}))
search = os.environ.get("FAKE_GEMINI_MODE") != "no_search"
answer = {"brief": "## Resumo\\n1994", "sources": [{"title": "Python", "url": "https://python.org"}]}
events = [{"type": "init", "session_id": "s"}]
if search:
    events += [{"type": "tool_use", "tool_name": "google_web_search", "tool_id": "t1", "parameters": {"query": "python"}},
               {"type": "tool_result", "tool_id": "t1", "status": "success", "output": "results"}]
events += [{"type": "message", "role": "assistant", "content": json.dumps(answer), "delta": True},
           {"type": "result", "status": "success", "stats": {"input_tokens": 10, "output_tokens": 5}}]
for event in events:
    print(json.dumps(event), flush=True)
"""


def _fake_gemini(tmp_path, monkeypatch, mode="replay"):
    path = tmp_path / "gemini"
    path.write_text(f"#!{sys.executable}\n{FAKE_GEMINI}")
    path.chmod(0o700)
    log = tmp_path / "gemini-log.json"
    monkeypatch.setenv("FAKE_GEMINI_LOG", str(log))
    monkeypatch.setenv("FAKE_GEMINI_MODE", mode)
    return GeminiCliAcpEngine(str(path), timeout=5), log


async def test_gemini_cli_research_runs_in_an_allow_list_workspace(tmp_path, monkeypatch):
    engine, log = _fake_gemini(tmp_path, monkeypatch)
    assert engine.research_ready()
    result = await engine.research("q")
    assert result.sources[0].url == "https://python.org"
    settings = json.loads(log.read_text())["settings"]["tools"]
    assert settings["core"] == [WEB_SEARCH_TOOL] and settings["allowed"] == [WEB_SEARCH_TOOL]
    assert WEB_SEARCH_TOOL not in settings["exclude"] and "run_shell_command" in settings["exclude"]


async def test_gemini_cli_research_without_search_fails(tmp_path, monkeypatch):
    engine, _ = _fake_gemini(tmp_path, monkeypatch, mode="no_search")
    with pytest.raises(EngineError, match="google_web_search"):
        await engine.research("q")


def test_research_settings_have_no_mcp_server(tmp_path):
    path = write_research_settings(tmp_path)
    assert "mcpServers" not in json.loads(path.read_text())
