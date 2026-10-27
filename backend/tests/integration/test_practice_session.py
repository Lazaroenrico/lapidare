"""Fase 9: PRACTICE as a session (problem / conclude / graph_search, attempts, dismissal).

Runs the real app with the scripted FakeEngine. Prompt wording belongs to the prompt
fragments; these tests only assert the mechanics and the session-state blocks.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastmcp.exceptions import ToolError
from starlette.testclient import TestClient

from learnharness.api.state import AppState
from learnharness.core.contracts.practice import PracticeLogEntry
from learnharness.core.contracts.session import SessionRecord
from learnharness.core.practice import graph_search, resolve_targets, retest_queue
from learnharness.mcp.runtime_server import session_tools
from learnharness.services.practice import DISMISS_NOTE
from learnharness.vault.graph_store import append_records, load_nodes
from learnharness.vault.jsonl_store import (
    append_practice_log,
    append_session_event,
    load_practice_log,
)
from tests.conftest import FakeEngine, poll_until, tool

A = "n_aaaaaaaaaaaa"
B = "n_bbbbbbbbbbbb"
SOLUTION = "Como $q \\cdot k$ cresce com $d_k$, dividimos por $\\sqrt{d_k}$."


def _seed_graph(vault: Path) -> None:
    append_session_event(vault, "sess-teach", SessionRecord(id="sess-teach", title="Atenção",
                                                            updated_at="2026-10-01T00:00:00+00:00"))
    append_records(vault, "nodes.jsonl", [
        {"id": A, "name": "Produto escalar", "statement": "Soma dos produtos das coordenadas.",
         "aliases": ["Dot product"], "created_at": "t1",
         "provenance": [{"session_id": "sess-teach", "message_id": "m1"}]},
        {"id": B, "name": "Escala da atenção", "statement": "Dividir os escores por raiz de d_k estabiliza o softmax.",
         "aliases": [], "created_at": "t2", "provenance": [{"session_id": "sess-teach", "message_id": "m2"}]},
    ])


def _problem(**overrides):
    return tool("problem", **{"statement": "Por que dividir os escores por $\\\\sqrt{d_k}$?",
                              "mode": "recall", "model_solution": SOLUTION, "target": ["Escala da atenção"],
                              **overrides})


def _settled(client: TestClient, chat_id: str, engine: FakeEngine, turns: int) -> dict:
    return poll_until(lambda: client.get(f"/api/chats/{chat_id}").json(),
                      lambda s: len(engine.stream_calls) >= turns and s["execution_status"] in ("idle", "failed"))


# --------------------------------------------------------------------------- pure helpers


def test_resolve_targets_and_graph_search(configured_vault: Path) -> None:
    _seed_graph(configured_vault)
    nodes = load_nodes(configured_vault)
    assert resolve_targets(nodes, [A, "escala da atencao", "DOT PRODUCT", A]) == [A, B]
    with pytest.raises(ValueError, match="Unknown target 'Softmax'"):
        resolve_targets(nodes, ["Softmax"])
    hits = graph_search(nodes, {"sess-teach": "Atenção"}, "raiz de d_k na atenção")
    assert hits[0] == {"id": B, "name": "Escala da atenção",
                       "statement": "Dividir os escores por raiz de d_k estabiliza o softmax.",
                       "session_title": "Atenção"}
    assert graph_search(nodes, {}, "zzz") == [] and len(graph_search(nodes, {}, "produtos", limit=1)) == 1


def test_retest_queue_clears_on_a_later_solved_of_the_same_targets() -> None:
    def entry(at, target, outcome, retest):
        return PracticeLogEntry(at=at, session_id="s", problem_id=at, mode="recall", target=target,
                                outcome=outcome, retest=retest)
    queue = retest_queue([
        entry("3", [A], "solved", False),          # clears the retest of A at "1"
        entry("1", [A], "surrendered", True),
        entry("2", [B], "solvedWithHints", True),  # stays: no later solved on B
        entry("4", [A, B], "solvedWithHints", False),
        entry("5", [], "movedOn", True),
    ])
    assert [e.problem_id for e in queue] == ["2", "5"]


# --------------------------------------------------------------------------- tools


@pytest.fixture
async def practice_tools(app_state: AppState):
    _seed_graph(app_state.vault_path)
    practice = await app_state.sessions.create(mode="PRACTICE", topic="Atenção", start=False)
    teach = await app_state.sessions.create(mode="TEACH", topic="Atenção", start=False)
    try:
        yield (app_state, practice.id, {t.__name__: t for t in session_tools(app_state, practice.id)},
               {t.__name__: t for t in session_tools(app_state, teach.id)})
    finally:
        await app_state.close()


async def test_practice_tool_refusals_and_resolution(practice_tools) -> None:
    state, sid, tools, teach_tools = practice_tools
    assert state.sessions.get(sid).phase == "teaching"
    with pytest.raises(ToolError, match="no active problem"):
        await tools["conclude"]("solved", "ok")
    with pytest.raises(ToolError, match="Unknown target 'Softmax'"):
        await tools["problem"]("?", "recall", SOLUTION, ["Softmax"])
    with pytest.raises(ToolError, match="model_solution"):
        await tools["problem"]("?", "recall", "  ")

    result = await tools["problem"]("Por que $\\\\sqrt{d_k}$?", "recall", SOLUTION, json.dumps(["escala da atenção"]))
    assert result["ok"] and result["target"] == [B] and "End your turn" in result["next"]
    problem = state.sessions.get(sid).practice.problems[0]
    assert problem.target == [B] and problem.statement == "Por que $\\sqrt{d_k}$?"  # LaTeX healed
    with pytest.raises(ToolError, match="still active"):
        await tools["problem"]("Outro?", "composition", SOLUTION)

    for name, args in [("probe", ("?", ["a", "b"], "e", "A")), ("quiz", ("check", "x", "?", ["a", "b"], "e", "A")),
                       ("plan_init", ("graph TD\n  a[A]",)), ("probe_done", ([{"strand": "s", "assessment": "a"}],))]:
        with pytest.raises(ToolError, match=f"{name} is a TEACH tool and this is a PRACTICE session"):
            await tools[name](*args)
    with pytest.raises(ToolError, match="PRACTICE tool and this is a TEACH session"):
        await teach_tools["problem"]("?", "recall", SOLUTION)
    with pytest.raises(ToolError, match="PRACTICE tool"):
        await teach_tools["conclude"]("solved", "ok")

    for search in (tools["graph_search"], teach_tools["graph_search"]):
        hits = await search("produto escalar", 5)
        assert hits[0]["id"] == A and hits[0]["session_title"] == "Atenção"

    with pytest.raises(ToolError, match="outcome must be one of"):
        await tools["conclude"]("great", "ok")
    with pytest.raises(ToolError, match="rung"):
        await tools["conclude"]("solved", "ok", rung="R9")
    done = await tools["conclude"]("solved_with_hints", "Bom.", rung="2", miss_class="Cue", retest="true")
    assert done["ok"] and done["outcome"] == "solvedWithHints" and "closing words" in done["next"]
    closed = state.sessions.get(sid).practice.problems[0]
    assert (closed.outcome, closed.rung, closed.miss_class, closed.retest) == ("solvedWithHints", "R2", "cue", True)
    assert state.sessions.get(sid).practice.active_problem_id is None
    [logged] = load_practice_log(state.vault_path)
    assert logged.problem_id == closed.id and logged.target == [B] and logged.rung == "R2"


# --------------------------------------------------------------------------- flow


def test_practice_flow_attempts_conclude_and_next(api_client: TestClient, fake_engine: FakeEngine,
                                                   configured_vault: Path) -> None:
    client = api_client
    _seed_graph(configured_vault)
    fake_engine.script_turn("Vamos ao primeiro.", _problem())
    created = client.post("/api/chats", json={"mode": "PRACTICE", "topic": "Atenção", "graph_context": [B]}).json()
    chat_id = created["id"]
    assert created["phase"] == "teaching" and created["practice"] == {"active_problem_id": None, "problems": []}
    assert "Prática — Atenção" in created["lesson_vault_path"]

    session = _settled(client, chat_id, fake_engine, 1)
    practice = session["practice"]
    problem_id = practice["active_problem_id"]
    assert problem_id and practice["problems"][0]["id"] == problem_id
    assert "model_solution" not in practice["problems"][0]
    assert "dividimos por" not in json.dumps(session)  # hidden while active
    assert practice["problems"][0]["target"] == [B] and practice["problems"][0]["mode"] == "recall"
    first_prompt = fake_engine.stream_calls[0]["prompt"]
    assert "PRACTICE MATERIAL" in first_prompt and "problem(statement" in first_prompt  # practice turn rules
    assert "Open directly with the first problem" in first_prompt

    # next is refused while a problem is active; text and attempts need content.
    assert client.post(f"/api/chats/{chat_id}/messages", json={"kind": "next"}).status_code == 409
    assert client.post(f"/api/chats/{chat_id}/messages", json={"kind": "attempt", "content": " "}).status_code == 422

    fake_engine.script_turn("Dica (R2): pense na variância de uma soma de $d_k$ termos.")
    res = client.post(f"/api/chats/{chat_id}/messages", json={"kind": "attempt", "content": "Para normalizar?"})
    assert res.status_code == 200
    _settled(client, chat_id, fake_engine, 2)
    assert "Tentativa:\nPara normalizar?" in fake_engine.stream_calls[1]["prompt"]

    fake_engine.script_turn("A variância cresce com $d_k$; certo.",
                            tool("conclude", outcome="solved", verdict="Reconstruiu a escala.", rung="R2",
                                 miss_class="cue", retest=False),
                            "Bem feito. Quando quiser, peça o próximo.")
    client.post(f"/api/chats/{chat_id}/messages", json={"kind": "attempt", "content": "A variância cresce com d_k."})
    session = _settled(client, chat_id, fake_engine, 3)

    concluded = session["practice"]["problems"][0]
    assert session["practice"]["active_problem_id"] is None
    assert concluded["outcome"] == "solved" and concluded["rung"] == "R2" and concluded["model_solution"] == SOLUTION
    assert [a["text"] for a in concluded["attempts"]] == ["Para normalizar?", "A variância cresce com d_k."]
    attempts = [m for m in session["messages"] if m["practice_kind"] == "attempt"]
    assert len(attempts) == 2 and all(m["problem_id"] == problem_id for m in attempts)
    # The conclude splits the turn: analysis before the card, closing words after it.
    assistant = [m["content"] for m in session["messages"] if m["role"] == "assistant"]
    assert assistant[-2:] == ["A variância cresce com $d_k$; certo.", "Bem feito. Quando quiser, peça o próximo."]
    closing = next(m for m in session["messages"] if m["content"].startswith("Bem feito"))
    assert closing["created_at"] >= concluded["concluded_at"]

    [logged] = load_practice_log(configured_vault)
    assert (logged.session_id, logged.problem_id, logged.outcome, logged.rung, logged.miss_class,
            logged.retest, logged.target) == (chat_id, problem_id, "solved", "R2", "cue", False, [B])

    note = (configured_vault / session["lesson_vault_path"]).read_text(encoding="utf-8")
    assert "## Problema 1 — evocação" in note and "Por que dividir os escores por $\\sqrt{d_k}$?" in note
    assert "- Para normalizar?" in note and "**Degrau:** R2" in note and SOLUTION in note
    assert "prática" in note.split("---")[1]

    fake_engine.script_turn(_problem(statement="Em que caso $d_k$ grande não satura o softmax?",
                                     mode="discrimination", target=[A]))
    assert client.post(f"/api/chats/{chat_id}/messages", json={"kind": "next"}).status_code == 200
    session = _settled(client, chat_id, fake_engine, 4)
    assert "Próximo problema, por favor." in fake_engine.stream_calls[3]["prompt"]
    assert len(session["practice"]["problems"]) == 2
    assert session["practice"]["active_problem_id"] == session["practice"]["problems"][1]["id"]
    assert "model_solution" not in session["practice"]["problems"][1]
    assert "model_solution" in session["practice"]["problems"][0]

    # PRACTICE never feeds the trace: no extraction job, and a manual one is refused.
    assert not any(j["kind"] == "extraction" for j in client.get("/api/jobs").json())
    assert client.post(f"/api/graph/extract/{chat_id}").status_code == 422


def test_dismiss_closes_without_log_or_turn(api_client: TestClient, fake_engine: FakeEngine,
                                            configured_vault: Path) -> None:
    client = api_client
    fake_engine.script_turn(_problem(target=[]))
    chat_id = client.post("/api/chats", json={"mode": "PRACTICE", "topic": "Atenção"}).json()["id"]
    _settled(client, chat_id, fake_engine, 1)

    res = client.post(f"/api/chats/{chat_id}/practice/dismiss")
    assert res.status_code == 200
    session = res.json()["session"]
    problem = session["practice"]["problems"][0]
    assert session["practice"]["active_problem_id"] is None and problem["outcome"] == "dismissed"
    assert problem["model_solution"] == SOLUTION
    assert session["messages"][-1]["role"] == "system" and session["messages"][-1]["practice_kind"] == "dismiss"
    assert load_practice_log(configured_vault) == []
    assert client.get(f"/api/chats/{chat_id}").json()["execution_status"] == "idle"
    assert len(fake_engine.stream_calls) == 1  # no run was triggered
    assert client.post(f"/api/chats/{chat_id}/practice/dismiss").status_code == 409

    # The next turn sees the dismissal; conclude on it is refused, so it cannot be reopened.
    fake_engine.script_turn("Certo, outro.", tool("conclude", outcome="movedOn", verdict="x"))
    client.post(f"/api/chats/{chat_id}/messages", json={"kind": "next"})
    session = _settled(client, chat_id, fake_engine, 2)
    assert DISMISS_NOTE in fake_engine.stream_calls[1]["prompt"]
    assert session["execution_status"] == "failed" and "no active problem" in session["error"]
    assert session["practice"]["problems"][0]["outcome"] == "dismissed"
    assert load_practice_log(configured_vault) == []


def test_retest_queue_and_suggested_material_reach_the_prompt(api_client: TestClient, fake_engine: FakeEngine,
                                                             configured_vault: Path) -> None:
    client = api_client
    _seed_graph(configured_vault)
    append_practice_log(configured_vault, PracticeLogEntry(
        at="2026-10-20T10:00:00+00:00", session_id="old", problem_id="p-old", mode="composition",
        target=[A], outcome="surrendered", rung="R4", miss_class="structural", retest=True))
    fake_engine.script_turn("Olá.")
    chat_id = client.post("/api/chats", json={"mode": "PRACTICE", "topic": "o que eu estudei"}).json()["id"]
    _settled(client, chat_id, fake_engine, 1)
    prompt = fake_engine.stream_calls[0]["prompt"]
    retest = prompt[prompt.index("RETEST QUEUE"):]
    first = retest.splitlines()[1]
    assert f"[{A}] Produto escalar" in first and "surrendered" in first and "R4" in first
    assert "structural" in first and "2026-10-20" in first
    suggested = prompt[prompt.index("SUGGESTED MATERIAL"):]
    assert f"[{B}] Escala da atenção" in suggested and "(session: Atenção)" in suggested
    assert "PRACTICE MATERIAL" not in prompt

    # With graph context the suggestion gives way to the picked material.
    fake_engine.script_turn("Olá.")
    other = client.post("/api/chats", json={"mode": "PRACTICE", "topic": "x", "graph_context": [A]}).json()["id"]
    _settled(client, other, fake_engine, 2)
    prompt = fake_engine.stream_calls[1]["prompt"]
    assert "PRACTICE MATERIAL" in prompt and "SUGGESTED MATERIAL" not in prompt and "RETEST QUEUE" in prompt
