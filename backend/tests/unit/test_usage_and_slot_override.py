"""Fase 8B: per-session model/effort override and provider token usage accounting."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

import learnharness.engines as engines
from learnharness.api.app import create_app
from learnharness.api.state import AppState
from learnharness.core.contracts.config import EffortLevel, EngineKind, ModelSlotConfig
from learnharness.core.contracts.session import SessionRecord, slot_override_for
from learnharness.engines.agy_engine import AgyStreamEngine
from learnharness.engines.gemini_acp import AcpProcessPool
from learnharness.engines.usage import acp_usage, genai_usage, report_usage, usage_sink
from learnharness.vault.bootstrap import load_config, save_config
from tests.conftest import FakeEngine, configure_vault, poll_until

AGY_FIXTURES = Path(__file__).parents[1] / "fixtures" / "agy"
AGY_REAL = AGY_FIXTURES / "agy-1.4.7-two-turns-json-schema-real.ndjson"
ACP_SYNTHETIC = Path(__file__).parents[1] / "fixtures" / "acp" / "gemini-0.62.0-turn-synthetic.ndjson"


class MeteredEngine(FakeEngine):
    """FakeEngine that reports provider usage after each streamed turn, like real engines."""

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None,
                          system_instruction=None):
        async for chunk in super().stream_turn(prompt, session_id, history, slot, tools,
                                               system_instruction):
            yield chunk
        report_usage(slot.model_id if slot else "", {"input_tokens": 100, "output_tokens": 10,
                                                     "thinking_tokens": 5})


@pytest.fixture
def closed(monkeypatch):
    calls = []

    async def record(session_id=None):
        calls.append(session_id)

    monkeypatch.setattr(engines, "close_engine_processes", record)
    return calls


# ----------------------------------------------------------------- contracts


def test_teaching_slot_keeps_the_strong_engine():
    strong = ModelSlotConfig(engine=EngineKind.AGY, model_id="auto", effort=EffortLevel.MEDIUM)
    assert slot_override_for(strong) is None
    override = slot_override_for(strong, "gemini-3-pro", "high")
    session = SessionRecord(id="s", title="t", slot_override=override.model_copy(
        update={"engine": EngineKind.GENAI_SDK}))
    slot = session.teaching_slot(strong)
    assert (slot.engine, slot.model_id, slot.effort) == (EngineKind.AGY, "gemini-3-pro", EffortLevel.HIGH)
    assert SessionRecord(id="s", title="t").teaching_slot(strong) is strong


# ----------------------------------------------------------------- provider shapes


@pytest.fixture
def fake_agy(tmp_path):
    path = tmp_path / "agy"
    path.write_text(f"#!{sys.executable}\n" + (AGY_FIXTURES / "fake_agy.py").read_text().replace(
        'Path(__file__).with_name("agy-1.4.7-two-turns-json-schema-real.ndjson")', f"Path({str(AGY_REAL)!r})"))
    path.chmod(0o700)
    return str(path)


async def test_agy_reports_per_turn_usage_from_real_transcript(fake_agy, tmp_path):
    pool = AcpProcessPool(idle_close=None)
    engine = AgyStreamEngine(fake_agy, pool=pool, env={"FAKE_AGY_LOG": str(tmp_path / "log")}, timeout=5)
    engine.configure_runtime(tmp_path / "work", "http://127.0.0.1:9/internal/mcp/", "tok")
    slot = SimpleNamespace(model_id="gemini-3.8-flash-low", effort="low")
    reports = []
    try:
        with usage_sink(reports.append):
            for prompt in ("primeira", "segunda"):
                [c async for c in engine.stream_turn(prompt, "s1", slot=slot)]
    finally:
        await pool.close_all()
    assert [(r.model_id, r.input_tokens, r.output_tokens, r.thinking_tokens) for r in reports] == [
        ("gemini-3.8-flash-low", 9835, 83, 0),
        ("gemini-3.8-flash-low", 12081, 101, 0),
    ]


def test_acp_and_genai_usage_shapes():
    reply = next(json.loads(line)["msg"]["result"] for line in ACP_SYNTHETIC.read_text().splitlines()
                 if "stopReason" in line and '"result"' in line)
    assert acp_usage(reply) == {"input_tokens": 12, "output_tokens": 3}
    assert acp_usage({"stopReason": "end_turn"}) is None
    meta = SimpleNamespace(prompt_token_count=7, candidates_token_count=2, thoughts_token_count=None)
    assert report_usage("m", genai_usage(meta)).model_dump() == {
        "input_tokens": 7, "output_tokens": 2, "thinking_tokens": 0, "model_id": "m"}
    assert genai_usage(None) is None and report_usage("m", None) is None  # no sink, no counts: no-op


# ----------------------------------------------------------------- sessions, jobs, ledger


@pytest.fixture
def metered(tmp_path):
    engine = MeteredEngine()
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    return state, engine


async def test_session_usage_accumulates_and_jobs_feed_the_ledger(metered, monkeypatch):
    state, _ = metered
    session = await state.sessions.create(topic="Atenção", start=False)
    await state.sessions.run(session.id)
    await state.sessions.run(session.id)
    usage = state.sessions.get(session.id).usage
    assert (usage.input_tokens, usage.output_tokens, usage.thinking_tokens, usage.turns) == (200, 20, 10, 2)

    async def generate(track_id=None, *, regenerate=False):
        report_usage("bg-model", {"input_tokens": 50, "output_tokens": 5})

    monkeypatch.setattr(state.tracks, "generate", generate)
    record = state.jobs.submit("track_gen", {"topic": "x"})
    await state.jobs.tasks[record["job_id"]]
    assert state.active_jobs[record["job_id"]]["status"] == "completed"

    rows = state.usage.rows()
    assert [(r["session_id"], r["job_kind"]) for r in rows] == [
        (session.id, None), (session.id, None), (None, "track_gen")]
    assert rows[-1]["model_id"] == "bg-model"
    summary = state.usage.summary()
    assert summary["total"] == {"input_tokens": 250, "output_tokens": 25, "thinking_tokens": 10, "turns": 3}
    assert summary["by_session"] == [{"session_id": session.id, "title": "Atenção", "total_tokens": 230}]


def test_usage_route_splits_today_from_total(tmp_path):
    engine = MeteredEngine()
    vault = configure_vault(tmp_path / "Vault")
    ledger = vault / ".harness" / "usage.jsonl"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(json.dumps({"at": "2020-01-01T12:00:00+00:00", "session_id": "sess-old", "job_kind": None,
                                  "model_id": "m", "input_tokens": 1000, "output_tokens": 0,
                                  "thinking_tokens": 0}) + "\n", encoding="utf-8")
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    with TestClient(create_app(state=state)) as client:
        chat = client.post("/api/chats", json={"topic": "Softmax"}).json()
        poll_until(lambda: client.get(f"/api/chats/{chat['id']}").json(),
                   lambda s: s["usage"]["turns"] == 1)
        data = client.get("/api/usage").json()
    assert data["today"] == {"input_tokens": 100, "output_tokens": 10, "thinking_tokens": 5, "turns": 1}
    assert data["total"] == {"input_tokens": 1100, "output_tokens": 10, "thinking_tokens": 5, "turns": 2}
    assert [s["session_id"] for s in data["by_session"]] == ["sess-old", chat["id"]]
    assert data["by_session"][1] == {"session_id": chat["id"], "title": "Softmax", "total_tokens": 115}


# ----------------------------------------------------------------- per-session model


def test_session_model_override_and_settings_route(tmp_path, closed):
    engine = MeteredEngine()
    vault = configure_vault(tmp_path / "Vault")
    config = load_config(vault)
    config.slots.strong = ModelSlotConfig(engine=EngineKind.AGY, model_id="auto", effort=EffortLevel.MEDIUM)
    save_config(vault, config)
    factory_slots = []

    def factory(slot):
        factory_slots.append(slot)
        return engine

    state = AppState(vault_path=vault, engine_factory=factory)
    with TestClient(create_app(state=state)) as client:
        chat = client.post("/api/chats", json={"topic": "KV cache", "model_id": "gemini-3-pro",
                                               "effort": "high"}).json()
        assert chat["slot_override"]["model_id"] == "gemini-3-pro"
        assert chat["effective_slot"] == {"engine": "agy", "model_id": "gemini-3-pro", "effort": "high"}
        done = poll_until(lambda: client.get(f"/api/chats/{chat['id']}").json(),
                          lambda s: s["execution_status"] == "idle")
        assert done["usage"]["turns"] == 1
        assert (factory_slots[0].engine, factory_slots[0].model_id) == (EngineKind.AGY, "gemini-3-pro")
        assert engine.stream_calls[0]["slot"].effort == EffortLevel.HIGH
        assert state.usage.rows()[0]["model_id"] == "gemini-3-pro"

        updated = client.put(f"/api/chats/{chat['id']}/settings", json={"model_id": "gemini-3-flash",
                                                                         "effort": "low"})
        assert updated.status_code == 200
        assert updated.json()["effective_slot"]["model_id"] == "gemini-3-flash"
        assert closed == [chat["id"]]  # idle session: the persistent process is closed now
        # The same settings again change nothing and keep the process.
        client.put(f"/api/chats/{chat['id']}/settings", json={"model_id": "gemini-3-flash", "effort": "low"})
        assert closed == [chat["id"]]

        client.post(f"/api/chats/{chat['id']}/messages", json={"content": "continue"})
        poll_until(lambda: len(engine.stream_calls), lambda n: n == 2)
        assert engine.stream_calls[1]["slot"].model_id == "gemini-3-flash"

        cleared = client.put(f"/api/chats/{chat['id']}/settings", json={}).json()
        assert cleared["slot_override"] is None and cleared["effective_slot"]["model_id"] == "auto"
        assert client.put(f"/api/chats/{chat['id']}/settings", json={"effort": "extreme"}).status_code == 422
        assert client.put("/api/chats/sess-missing/settings", json={}).status_code == 404
