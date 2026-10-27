"""Fase 15: leveling a track by binary search (session, prompt, tool refusals, undo, e2e)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastmcp.exceptions import ToolError

from learnharness.api.app import create_app
from learnharness.api.state import AppState
from learnharness.core.contracts.config import TrackConfig, TrackItem
from learnharness.core.contracts.quiz import QuizSubmission
from learnharness.core.leveling import (
    LEVELED_STATUS_DETAIL,
    LevelingError,
    apply_leveling,
    leveling_context,
    undo_blocker,
    undo_leveling,
)
from learnharness.mcp.runtime_server import session_tools
from learnharness.prompts.loader import build_system_prompt, selected_segments
from learnharness.vault.bootstrap import load_config, save_config
from tests.conftest import FakeEngine, configure_vault, tool, wait_until

PROBE = {"question": "Qual é a derivada de $x^2$?", "options": ["$2x$", "$x$"], "explanation": "Regra da potência.",
         "correct": "A"}


def _track(**changes: Any) -> TrackConfig:
    queue = [
        TrackItem(id="s0", title="Conjuntos", completed=True),
        TrackItem(id="s1", title="Funções"),
        TrackItem(id="s2", title="Limites", prerequisites=["s1"]),
        TrackItem(id="s3", title="Derivadas", prerequisites=["s2", "s0"]),
        TrackItem(id="s4", title="Integrais", prerequisites=["s3"]),
        TrackItem(id="s5", title="Séries"),
    ]
    return TrackConfig(id="trk-calc", title="Cálculo I", source="manual", active_item_id="s1", queue=queue,
                       **changes)


def _save_track(vault: Path, track: TrackConfig) -> None:
    config = load_config(vault)
    config.tracks = [track]
    config.active_track_id = track.id
    save_config(vault, config)


@asynccontextmanager
async def _http(state: AppState) -> AsyncIterator[httpx.AsyncClient]:
    """The real app on the test's own event loop (the session tasks share it)."""
    app = create_app(state=state)
    transport = httpx.ASGITransport(app=app)
    async with (app.router.lifespan_context(app),
                httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as http):
        yield http


@pytest.fixture
def leveled_vault(configured_vault: Path) -> Path:
    _save_track(configured_vault, _track())
    return configured_vault


async def _answer_next(state: AppState, sid: str, **answer: Any):
    answered = set(state.sessions.get(sid).answers)
    pending = await wait_until(lambda: (q := state.sessions.get(sid).pending_quiz) and q.quiz_id not in answered and q)
    return await state.sessions.answer(QuizSubmission(quiz_id=pending.quiz_id, session_id=sid, **answer))


# ----------------------------------------------------------------- pure rules


def test_context_lists_the_pending_queue_in_order_with_pending_prerequisites() -> None:
    context = leveling_context(_track(), questions_asked=2)
    assert [i["id"] for i in context["pending_queue"]] == ["s1", "s2", "s3", "s4", "s5"]
    assert [i["position"] for i in context["pending_queue"]] == [1, 2, 3, 4, 5]
    # s0 is completed, so it is not a pending prerequisite of s3.
    assert context["pending_queue"][2]["prerequisites"] == ["s2"]
    assert (context["questions_asked"], context["max_questions"]) == (2, 12)


@pytest.mark.parametrize(("known", "start", "match"), [
    (["s1", "nope"], "s3", "Unknown item id"),
    (["s0"], "s3", "already completed"),
    (["s1"], "zzz", "Unknown start_item_id"),
    (["s1", "s2"], "s2", "also in known_item_ids"),
    (["s1", "s3"], "s4", "prerequisite"),
])
def test_invalid_leveling_calls_are_refused(known: list[str], start: str, match: str) -> None:
    with pytest.raises(LevelingError, match=match):
        apply_leveling(_track(), known, start)


def test_apply_and_undo_restore_the_flags() -> None:
    track = _track()
    track.item("s2").status_detail = "revisar"
    result = apply_leveling(track, ["s2", "s1", "s1"], "s3", "Sabe limites.")
    assert result.known_item_ids == ["s1", "s2"] and result.start_item.title == "Derivadas"
    assert all(track.item(i).completed and track.item(i).status_detail == LEVELED_STATUS_DETAIL for i in ("s1", "s2"))
    assert track.active_item_id == "s3" and result.previous_active_item_id == "s1"
    assert undo_blocker(track, result) is None
    undo_leveling(track, result)
    assert not track.item("s1").completed and track.item("s2").status_detail == "revisar"
    assert track.active_item_id == "s1"


# ----------------------------------------------------------------- loader


def test_leveling_prompt_replaces_the_generic_diagnosis() -> None:
    leveling = selected_segments("TEACH", "leveling", "probing")
    assert "prober/30-leveling.md" in leveling
    assert "prober/10-diagnosis.md" not in leveling and "prober/20-contexts.md" not in leveling
    for kind in ("free_topic", "dense_source", "track_step"):
        assert "prober/30-leveling.md" not in selected_segments("TEACH", kind, "probing")


# ----------------------------------------------------------------- session + tools


async def test_route_creates_a_leveling_session_and_the_prompt_has_the_queue(leveled_vault: Path) -> None:
    engine = FakeEngine()
    state = AppState(vault_path=leveled_vault, engine_factory=lambda slot: engine)
    try:
        async with _http(state) as client:
            response = await client.post("/api/tracks/trk-calc/leveling")
            assert response.status_code == 200, response.text
            data = response.json()
            assert data["context_kind"] == "leveling" and data["teach_context"] == "leveling"
            assert data["track_id"] == "trk-calc" and data["track_item_id"] is None
            assert data["title"] == "Nivelamento: Cálculo I" and data["mode"] == "TEACH"
            # An open leveling session is reused.
            assert (await client.post("/api/tracks/trk-calc/leveling")).json()["id"] == data["id"]
            assert (await client.post("/api/tracks/nope/leveling")).status_code == 404
            await wait_until(lambda: engine.stream_calls)
        prompt = engine.stream_calls[0]["prompt"]
        assert '"pending_queue"' in prompt and "leveling_done" in prompt
        order = [prompt.index(f'"id": "{i}", "title"') for i in ("s1", "s2", "s3", "s4", "s5")]
        assert order == sorted(order)
        assert '"id": "s0"' not in prompt
        assert "probe_done exactly once" not in prompt  # the generic diagnosis is not loaded
    finally:
        await state.close()


def test_short_or_archived_tracks_cannot_be_leveled(configured_vault: Path, api_client) -> None:
    track = _track()
    for item in track.queue[:3]:
        item.completed = True  # 3 pending left
    _save_track(configured_vault, track)
    response = api_client.post("/api/tracks/trk-calc/leveling")
    assert response.status_code == 409 and "4" in response.json()["detail"]
    _save_track(configured_vault, _track(archived=True))
    assert api_client.post("/api/tracks/trk-calc/leveling").status_code == 409


async def test_tool_refusals_in_a_leveling_session(leveled_vault: Path, app_state: AppState) -> None:
    session = await app_state.leveling.start("trk-calc", start=False)
    tools = {t.__name__: t for t in session_tools(app_state, session.id)}
    try:
        for name, args in (("plan_init", ("graph TD\n a[A]",)),
                           ("quiz", ("check", "a", "?", ["1", "2"], "e", "A")),
                           ("explain", ("check", "a", "?", "r")),
                           ("probe_done", ([{"strand": "x", "assessment": "y"}],))):
            with pytest.raises(ToolError, match="not available while leveling"):
                await tools[name](*args)
        with pytest.raises(ToolError, match="Unknown item id"):
            await tools["leveling_done"](["s1", "zz"], "s3", "x")
        with pytest.raises(ToolError, match="also in known_item_ids"):
            await tools["leveling_done"](["s1", "s2"], "s2", "x")

        task = asyncio.create_task(tools["probe"](**PROBE))
        await wait_until(lambda: app_state.sessions.get(session.id).pending_quiz)
        with pytest.raises(ToolError, match="still pending"):
            await tools["leveling_done"](["s1"], "s2", "x")
        await _answer_next(app_state, session.id, chosen_index=0, confidence=90)
        await asyncio.wait_for(task, 3)

        result = await tools["leveling_done"]('["s1"]', "s2", "Sabe funções.")
        assert result["ok"] and result["known"] == 1
        with pytest.raises(ToolError, match="already called"):
            await tools["leveling_done"](["s1"], "s2", "x")

        # leveling_done does not exist outside a leveling session.
        other = await app_state.sessions.create("TEACH", topic="Outro", start=False)
        other_tools = {t.__name__: t for t in session_tools(app_state, other.id)}
        with pytest.raises(ToolError, match="only exists in a track leveling"):
            await other_tools["leveling_done"](["s1"], "s2", "x")
    finally:
        await app_state.close()


async def test_question_budget_is_enforced(leveled_vault: Path, app_state: AppState, monkeypatch) -> None:
    monkeypatch.setattr("learnharness.mcp.runtime_server.MAX_LEVELING_QUESTIONS", 1)
    session = await app_state.leveling.start("trk-calc", start=False)
    tools = {t.__name__: t for t in session_tools(app_state, session.id)}
    try:
        task = asyncio.create_task(tools["probe"](**PROBE))
        await _answer_next(app_state, session.id, chosen_index=0, confidence=90)
        await asyncio.wait_for(task, 3)
        with pytest.raises(ToolError, match="budget"):
            await tools["recall"]("Defina limite.", "Resposta completa.")
    finally:
        await app_state.close()


async def test_leveling_done_marks_snapshots_and_undo(leveled_vault: Path, app_state: AppState) -> None:
    session = await app_state.leveling.start("trk-calc", start=False)
    tools = {t.__name__: t for t in session_tools(app_state, session.id)}
    try:
        await tools["leveling_done"](["s1", "s2"], "s3", "Domina funções e limites.")
        record = app_state.sessions.get(session.id)
        assert record.phase == "completed" and record.execution_status == "completed"
        assert record.leveling.known_item_ids == ["s1", "s2"]
        assert [(f.id, f.completed) for f in record.leveling.snapshot] == [("s1", False), ("s2", False)]
        track = load_config(leveled_vault).find_track("trk-calc")
        assert track.item("s1").completed and track.item("s2").status_detail == "nivelado"
        assert track.active_item_id == "s3"

        async with _http(app_state) as client:
            chat = (await client.get(f"/api/chats/{session.id}")).json()
            assert chat["leveling"]["start_item"] == {"id": "s3", "title": "Derivadas"}
            assert chat["leveling"]["summary"] == "Domina funções e limites."
            undo = await client.post(f"/api/tracks/trk-calc/leveling/{session.id}/undo")
            assert undo.status_code == 200, undo.text
            assert undo.json()["track"]["next_item"] == {"id": "s1", "title": "Funções"}
            track = load_config(leveled_vault).find_track("trk-calc")
            assert not track.item("s1").completed and track.item("s2").status_detail == ""
            assert track.active_item_id == "s1"
            assert (await client.get(f"/api/chats/{session.id}")).json()["leveling"]["undone_at"]
            assert (await client.post(f"/api/tracks/trk-calc/leveling/{session.id}/undo")).status_code == 409
            assert (await client.post(f"/api/tracks/other/leveling/{session.id}/undo")).status_code == 404
    finally:
        await app_state.close()


async def test_undo_is_blocked_once_a_leveled_step_changed(leveled_vault: Path, app_state: AppState) -> None:
    session = await app_state.leveling.start("trk-calc", start=False)
    tools = {t.__name__: t for t in session_tools(app_state, session.id)}
    try:
        await tools["leveling_done"](["s1"], "s2", "Sabe funções.")
        await app_state.tracks.complete("trk-calc", "s2")  # the learner moved on
        async with _http(app_state) as client:
            blocked = await client.post(f"/api/tracks/trk-calc/leveling/{session.id}/undo")
            assert blocked.status_code == 409 and "changed" in blocked.json()["detail"]
        assert load_config(leveled_vault).find_track("trk-calc").item("s1").completed
    finally:
        await app_state.close()


async def test_end_to_end_probe_probe_leveling_done(tmp_path: Path) -> None:
    vault = configure_vault(tmp_path / "Vault")
    _save_track(vault, _track())
    engine = FakeEngine()
    engine.script_turn(
        "Vamos achar onde começar.\n",
        tool("probe", **PROBE, details="Meio da trilha."),
        tool("probe", question="Quanto vale $\\lim_{x\\to 0} \\sin x / x$?", options=["1", "0"],
             explanation="Limite fundamental.", correct="1"),
        tool("leveling_done", known_item_ids=["s1", "s2"], start_item_id="s3", summary="Funções e limites ok."),
        "Marquei 2 passos; a trilha segue em Derivadas.",
    )
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    try:
        session = await state.leveling.start("trk-calc")
        await _answer_next(state, session.id, chosen_index=0, confidence=90, learner_thinking="regra da potência")
        await _answer_next(state, session.id, chosen_index=0, confidence=90)
        await wait_until(lambda: not state.sessions.is_running(session.id))
        final = state.sessions.get(session.id)
        assert final.phase == "completed" and final.leveling is not None
        assert [name for name, _ in engine.tool_results] == ["probe", "probe", "leveling_done"]
        assert len(engine.stream_calls) == 1
        prose = [m.content for m in final.messages if m.role == "assistant"]
        assert prose and prose[-1].endswith("Derivadas.")  # the closing words are kept
        track = load_config(vault).find_track("trk-calc")
        assert [i.id for i in track.queue if i.completed] == ["s0", "s1", "s2"]
        assert track.active_item_id == "s3"
        prompt = build_system_prompt("TEACH", "leveling", "pt-BR", "probing")
        assert "leveling_done" in prompt
    finally:
        await state.close()
