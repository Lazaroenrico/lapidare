"""Fase 21 (backend): extraction coverage, context meter, extraction toggle, graph unlink."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from starlette.testclient import TestClient

from learnharness.api.app import create_app
from learnharness.api.state import AppState
from learnharness.core.compaction import CompactionSummary
from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.core.graph_merge import fingerprint
from learnharness.core.model_limits import context_limit, context_window
from learnharness.engines.usage import agy_usage, genai_usage, report_usage
from learnharness.vault.bootstrap import load_config, save_config
from learnharness.vault.graph_store import append_records, load_nodes
from learnharness.vault.jsonl_store import append_session_event
from tests.conftest import FakeEngine, configure_vault, poll_until

SUMMARY = CompactionSummary(learner_understanding="a", teaching_arc="b", current_plan="c", current_moment="d")


class MeteredEngine(FakeEngine):
    """Reports provider usage per streamed turn and per structured call."""

    def __init__(self, stream_counts=None) -> None:
        super().__init__()
        self.stream_counts = stream_counts or [{"input_tokens": 1000, "output_tokens": 100}]

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None,
                          system_instruction=None):
        async for chunk in super().stream_turn(prompt, session_id, history, slot, tools, system_instruction):
            yield chunk
        for counts in self.stream_counts:
            report_usage(slot.model_id if slot else "", counts)

    async def run_structured(self, prompt, schema, slot=None, system_instruction=None):
        report_usage("summarizer", {"input_tokens": 9, "output_tokens": 1})
        return await super().run_structured(prompt, schema, slot, system_instruction)


def _teach(session_id: str, text: str = "x" * 400, **extra) -> SessionRecord:
    return SessionRecord(id=session_id, title="Atenção", phase="teaching", messages=[
        SessionMessage(id="m1", role="assistant", content=text, created_at="t")], **extra)


# ----------------------------------------------------------------- pure model limits


def test_context_window_by_family_prefix_and_unknown_is_none() -> None:
    assert context_window("gemini-2.5-pro") == 1_048_576
    assert context_window("models/gemini-3.8-flash-low") == 1_048_576
    assert context_window("gemini-2.5-flash-image") == 65_536  # longest prefix wins
    assert context_window("gemini-3.1-flash-image") == 131_072
    assert context_window("gemini-4-argon") == 1_048_576
    assert context_window("gemini-1.5-pro-002") is None  # shut down: no published page
    assert context_window("claude-opus-5-5-high") is None
    assert context_window("auto") is None and context_window(None) is None


def test_context_limit_picks_the_nearer_bound() -> None:
    assert context_limit(150_000, None) == (150_000, "compaction")
    assert context_limit(150_000, 1_048_576) == (150_000, "compaction")
    assert context_limit(150_000, 100_000) == (84_000, "window")
    assert context_limit(84_000, 100_000) == (84_000, "compaction")  # tie: the setting wins


def test_cached_tokens_adapters() -> None:
    assert agy_usage({"usage": {"input_tokens": 5, "cache_read_tokens": 3}})["cached_tokens"] == 3
    assert "cached_tokens" not in agy_usage({"usage": {"input_tokens": 5}})
    meta = SimpleNamespace(prompt_token_count=7, candidates_token_count=2, thoughts_token_count=None,
                           cached_content_token_count=4)
    assert report_usage("m", genai_usage(meta)).cached_tokens == 4
    assert report_usage("m", {"input_tokens": 1}).cached_tokens is None


# ----------------------------------------------------------------- coverage


async def test_coverage_for_states(configured_vault: Path) -> None:
    engine = FakeEngine()
    state = AppState(vault_path=configured_vault, engine_factory=lambda slot: engine)
    try:
        record = _teach("sess-cov")
        append_session_event(configured_vault, record.id, record)
        cov = state.graph.coverage_for(record)
        assert cov is not None
        assert (cov.uncovered_tokens, cov.chunk_tokens, cov.extracting, cov.enabled) == (100, 4096, False, True)

        state.jobs.submit("extraction", {"session_id": record.id, "topic": "x", "reason": "manual"},
                          key=f"extract:{record.id}")
        assert state.graph.coverage_for(record).extracting is True
        other = _teach("sess-other")
        assert state.graph.coverage_for(other).extracting is False

        config = state.get_config()
        config.graph.extraction_enabled = False
        save_config(configured_vault, config)
        assert state.graph.coverage_for(record).enabled is False

        practice = _teach("sess-p", mode="PRACTICE")
        assert state.graph.coverage_for(practice) is None
    finally:
        await state.close()


def test_chat_payload_has_coverage_and_usage_limits(tmp_path) -> None:
    engine = MeteredEngine()
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    engine.script_turn("Olá.")
    with TestClient(create_app(state=state)) as client:
        chat = client.post("/api/chats", json={"topic": "Softmax"}).json()
        data = poll_until(lambda: client.get(f"/api/chats/{chat['id']}").json(),
                          lambda s: s["usage"]["turns"] == 1)
        assert set(data["coverage"]) == {"uncovered_tokens", "chunk_tokens", "extracting", "enabled"}
        assert data["usage"]["context_tokens"] == 1100
        assert data["usage"]["last_turn"] == {"input_tokens": 1000, "output_tokens": 100,
                                              "thinking_tokens": 0, "cached_tokens": None}
        assert data["usage"]["context_limit"] == 150_000 and data["usage"]["limit_kind"] == "compaction"

        practice = client.post("/api/chats", json={"topic": "Drill", "mode": "PRACTICE"}).json()
        assert client.get(f"/api/chats/{practice['id']}").json()["coverage"] is None


def test_small_window_model_reports_window_limit(tmp_path) -> None:
    engine = MeteredEngine()
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    engine.script_turn("Olá.")
    with TestClient(create_app(state=state)) as client:
        chat = client.post("/api/chats", json={"topic": "x"}).json()
        poll_until(lambda: client.get(f"/api/chats/{chat['id']}").json(), lambda s: s["usage"]["turns"] == 1)
        client.put(f"/api/chats/{chat['id']}/settings", json={"model_id": "gemini-2.5-flash-image"})
        usage = client.get(f"/api/chats/{chat['id']}").json()["usage"]
        assert (usage["context_limit"], usage["limit_kind"]) == (65_536 - 16_000, "window")


# ----------------------------------------------------------------- context meter


async def test_last_turn_sums_reports_and_ledger_gets_turn(tmp_path) -> None:
    engine = MeteredEngine([{"input_tokens": 100, "output_tokens": 10, "thinking_tokens": 5,
                             "cached_tokens": 40},
                            {"input_tokens": 300, "output_tokens": 30, "cached_tokens": 60}])
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    try:
        session = await state.sessions.create(topic="Atenção", start=False)
        engine.script_turn("um").script_turn("dois")
        await state.sessions.run(session.id)
        usage = state.sessions.get(session.id).usage
        assert usage.context_tokens == 330  # last report only
        assert usage.last_turn.model_dump() == {"input_tokens": 400, "output_tokens": 40,
                                                "thinking_tokens": 5, "cached_tokens": 100}
        await state.sessions.run(session.id)
        assert state.sessions.get(session.id).turn_seq == 2
        rows = state.usage.rows()
        assert [r["turn"] for r in rows] == [1, 1, 2, 2]
        assert [r["cached_tokens"] for r in rows] == [40, 60, 40, 60]
    finally:
        await state.close()


async def test_compaction_resets_context_tokens(tmp_path) -> None:
    engine = MeteredEngine()
    vault = configure_vault(tmp_path / "Vault")
    config = load_config(vault)
    config.agent.compaction_tokens = 32_000
    save_config(vault, config)
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    try:
        session = await state.sessions.create(topic="Atenção", start=False)
        async with state.sessions.lock(session.id):
            current = state.sessions.get(session.id)
            current.messages = [SessionMessage(id=f"m{i}", role="user" if i % 2 else "assistant",
                                               content="x" * 16_000, created_at=f"2026-10-27T00:00:{i:02d}")
                                for i in range(10)]
            state.sessions.save(current)
        engine.program(CompactionSummary, SUMMARY)
        engine.script_turn("Seguimos.").script_turn("De novo.")
        await state.sessions.run(session.id)
        done = state.sessions.get(session.id)
        assert done.compaction is not None and done.usage.context_tokens is None
        # The summarizer's counts are charged but never become the context size or last turn.
        assert done.usage.last_turn.input_tokens == 1000 and done.usage.input_tokens == 1009
        assert state.usage.rows()[-1]["job_kind"] == "compaction"
        await state.sessions.run(session.id)
        assert state.sessions.get(session.id).usage.context_tokens == 1100
    finally:
        await state.close()


def test_old_ledger_and_session_lines_without_new_fields_still_read(tmp_path) -> None:
    vault = configure_vault(tmp_path / "Vault")
    ledger = vault / ".harness" / "usage.jsonl"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(json.dumps({"at": "2020-01-01T12:00:00+00:00", "session_id": "s", "job_kind": None,
                                  "model_id": "m", "input_tokens": 7, "output_tokens": 1,
                                  "thinking_tokens": 0}) + "\n", encoding="utf-8")
    old = json.loads(SessionRecord(id="s", title="t").model_dump_json())
    for key in ("turn_seq",):
        old.pop(key)
    for key in ("context_tokens", "last_turn", "cached_tokens"):
        old["usage"].pop(key)
    assert SessionRecord.model_validate(old).usage.context_tokens is None
    state = AppState(vault_path=vault, engine_factory=lambda slot: FakeEngine())
    summary = state.usage.summary()
    assert summary["total"]["input_tokens"] == 7 and summary["by_session"][0]["total_tokens"] == 8


# ----------------------------------------------------------------- extraction toggle


def test_settings_toggle_round_trips(api_client: TestClient) -> None:
    assert api_client.get("/api/settings/agent").json()["extraction_enabled"] is True
    response = api_client.put("/api/settings/agent", json={"extraction_enabled": False})
    assert response.status_code == 200 and response.json()["extraction_enabled"] is False
    assert api_client.get("/api/settings/agent").json()["extraction_enabled"] is False


async def test_disabled_extraction_blocks_automatic_and_manual(configured_vault: Path) -> None:
    engine = FakeEngine()
    state = AppState(vault_path=configured_vault, engine_factory=lambda slot: engine)
    try:
        record = _teach("sess-off")
        record.phase = "completed"
        append_session_event(configured_vault, record.id, record)
        config = state.get_config()
        config.graph.extraction_enabled = False
        save_config(configured_vault, config)
        assert state.graph.maybe_extract(record) is None
        with TestClient(create_app(state=state)) as client:
            response = client.post(f"/api/graph/extract/{record.id}")
            assert response.status_code == 409
            assert response.json()["detail"] == "a extração para o grafo está desligada nas configurações"
        assert not any(j["kind"] == "extraction" for j in state.active_jobs.values())
    finally:
        await state.close()


# ----------------------------------------------------------------- unlink


def _seed_graph(vault: Path) -> None:
    session = _teach("sess-u", text="x" * 40_000)
    append_session_event(vault, session.id, session)
    append_records(vault, "nodes.jsonl", [
        {"id": "n_aaaaaaaaaaaa", "name": "Soma", "statement": "a + b.", "aliases": [], "created_at": "t",
         "provenance": [{"session_id": "sess-u", "message_id": "m1"}], "vault_rel_path": ""}])
    append_records(vault, "coverage.jsonl", [{
        "session_id": "sess-u", "message_id": "m1", "fp": fingerprint(session.messages[0].content),
        "tokens": 10_000}])


def test_unlink_removes_nodes_and_resets_coverage(api_client: TestClient, app_state: AppState,
                                                  configured_vault: Path) -> None:
    _seed_graph(configured_vault)
    assert api_client.get("/api/chats/sess-u").json()["coverage"]["uncovered_tokens"] == 0
    response = api_client.post("/api/chats/sess-u/graph/unlink")
    assert response.status_code == 200
    assert response.json()["ok"] is True and response.json()["removed_nodes"] == 1
    assert load_nodes(configured_vault) == {}
    cov = api_client.get("/api/chats/sess-u").json()["coverage"]
    # maybe_extract's own test: the uncovered prose is back and over the chunk budget.
    assert cov["uncovered_tokens"] == 10_000 >= cov["chunk_tokens"]
    assert [m.message_id for m in app_state.graph._uncovered(app_state.sessions.get("sess-u"))] == ["m1"]


def test_unlink_404_and_409(api_client: TestClient, app_state: AppState, configured_vault: Path) -> None:
    record = _teach("sess-busy")
    append_session_event(configured_vault, record.id, record)
    assert api_client.post("/api/chats/sess-missing/graph/unlink").status_code == 404
    app_state.active_jobs["job-x"] = {"job_id": "job-x", "kind": "extraction", "status": "running",
                                      "payload": {"session_id": record.id}}
    try:
        assert api_client.post(f"/api/chats/{record.id}/graph/unlink").status_code == 409
    finally:
        app_state.active_jobs.pop("job-x", None)


def test_unlink_409_while_a_turn_runs(api_client: TestClient, app_state: AppState,
                                      configured_vault: Path) -> None:
    record = _teach("sess-run")
    append_session_event(configured_vault, record.id, record)
    app_state.sessions.tasks[record.id] = SimpleNamespace(done=lambda: False, cancel=lambda: None)
    try:
        assert api_client.post(f"/api/chats/{record.id}/graph/unlink").status_code == 409
    finally:
        app_state.sessions.tasks.pop(record.id, None)
