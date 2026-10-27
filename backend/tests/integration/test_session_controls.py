"""Fase 12 session controls over the real app: 404s, rename, delete (both modes), abort,
question dismissal, Markdown export and the sidebar list fields."""

from __future__ import annotations

import json
from pathlib import Path

from starlette.testclient import TestClient

from learnharness.core.contracts.session import SessionRecord
from learnharness.pipelines.extraction import refresh_notes
from learnharness.vault.graph_store import (
    append_records,
    load_graph_chains,
    load_nodes,
    raw_chain_records,
    raw_node_records,
)
from learnharness.vault.jsonl_store import append_session_event
from learnharness.vault.markdown_ast import read_frontmatter
from tests.conftest import FakeEngine, poll_until, tool

PROBE = {
    "question": "Quanto vale (1,2)·(3,4)?",
    "options": ["11", "10", "7"],
    "explanation": "1*3 + 2*4 = 11.",
    "correct": "11",
}


def _chat(client: TestClient, session_id: str) -> dict:
    res = client.get(f"/api/chats/{session_id}")
    assert res.status_code == 200, res.text
    return res.json()


def _create(client: TestClient, topic: str = "Produto escalar") -> str:
    res = client.post("/api/chats", json={"mode": "TEACH", "topic": topic})
    assert res.status_code == 200, res.text
    return res.json()["id"]


def _idle(client: TestClient, session_id: str) -> dict:
    return poll_until(lambda: _chat(client, session_id),
                      lambda d: d["execution_status"] in ("idle", "waiting", "interrupted"))


def test_missing_session_is_404_everywhere(api_client: TestClient) -> None:
    for method, path in [("get", ""), ("put", ""), ("delete", ""), ("post", "/abort"),
                         ("post", "/questions/dismiss"), ("get", "/markdown"), ("post", "/resume")]:
        kwargs = {"json": {"title": "x"}} if method == "put" else {}
        if path == "/resume":
            kwargs = {"json": {}}
        res = getattr(api_client, method)(f"/api/chats/sess-missing{path}", **kwargs)
        assert res.status_code == 404, (method, path, res.status_code, res.text)


def test_rename_keeps_note_path_and_updates_managed_title(api_client: TestClient, configured_vault: Path) -> None:
    session_id = _create(api_client)
    before = _idle(api_client, session_id)
    note = configured_vault / before["lesson_vault_path"]
    note.write_text(note.read_text(encoding="utf-8") + "\nAnotação livre do aluno.\n", encoding="utf-8")

    res = api_client.put(f"/api/chats/{session_id}", json={"title": "Produto interno"})
    assert res.status_code == 200 and res.json()["title"] == "Produto interno"
    after = _chat(api_client, session_id)
    assert after["lesson_vault_path"] == before["lesson_vault_path"]
    text = note.read_text(encoding="utf-8")
    assert read_frontmatter(text)["topico"] == "Produto interno"
    assert "Anotação livre do aluno." in text

    assert api_client.put(f"/api/chats/{session_id}", json={"title": ""}).status_code == 422
    assert api_client.put(f"/api/chats/{session_id}", json={"title": "x" * 201}).status_code == 422
    assert api_client.put(f"/api/chats/{session_id}", json={"title": "   "}).status_code == 422


def test_list_carries_sidebar_fields(api_client: TestClient, fake_engine: FakeEngine) -> None:
    fake_engine.script_turn(tool("probe", **PROBE))
    session_id = _create(api_client)
    poll_until(lambda: _chat(api_client, session_id), lambda d: d["pending_quiz"] is not None)
    row = next(s for s in api_client.get("/api/chats").json() if s["id"] == session_id)
    assert {"title", "mode", "updated_at", "execution_status", "pending", "problem_open"} <= set(row)
    assert row["pending"] is True and row["execution_status"] == "waiting" and row["mode"] == "TEACH"
    api_client.post(f"/api/chats/{session_id}/abort")


def test_dismiss_resolves_pose_without_grade_or_quiz_log(api_client: TestClient, fake_engine: FakeEngine,
                                                         configured_vault: Path) -> None:
    fake_engine.script_turn("Vamos diagnosticar.", tool("probe", **PROBE), "Tudo bem, seguimos.")
    session_id = _create(api_client)
    pending = poll_until(lambda: _chat(api_client, session_id), lambda d: d["pending_quiz"] is not None)
    quiz_id = pending["pending_quiz"]["id"]

    res = api_client.post(f"/api/chats/{session_id}/questions/dismiss")
    assert res.status_code == 200, res.text
    answer = res.json()["answer"]
    assert answer["dismissed"] is True and answer["correct"] is None and answer["quiz_id"] == quiz_id

    after = poll_until(lambda: _chat(api_client, session_id),
                       lambda d: d["execution_status"] == "idle" and d["pending_quiz"] is None)
    # The blocked tool call returned the dismissal to the model.
    name, result = fake_engine.tool_results[-1]
    assert name == "probe" and result["dismissed"] is True and "Do not ask it again" in result["directive"]
    stored = next(a for a in after["answers"] if a["quiz_id"] == quiz_id)
    assert stored["dismissed"] is True and stored["calibration_band"] is None
    message = next(m for m in after["messages"] if m.get("quiz_id") == quiz_id)
    assert json.loads(message["content"])["dismissed"] is True
    assert any("seguimos" in m["content"] for m in after["messages"] if m["role"] == "assistant")
    log = configured_vault / ".harness/quiz-log.jsonl"
    assert not log.exists() or quiz_id not in log.read_text(encoding="utf-8")
    assert "**Resposta:** _dispensada_" in api_client.get(f"/api/chats/{session_id}/markdown").text
    # Nothing left to dismiss.
    assert api_client.post(f"/api/chats/{session_id}/questions/dismiss").status_code == 409


def test_abort_with_pending_question_interrupts_and_dismisses(api_client: TestClient,
                                                              fake_engine: FakeEngine) -> None:
    fake_engine.script_turn(tool("probe", **PROBE), "nunca chega aqui")
    session_id = _create(api_client)
    pending = poll_until(lambda: _chat(api_client, session_id), lambda d: d["pending_quiz"] is not None)
    quiz_id = pending["pending_quiz"]["id"]
    # A running turn refuses deletion.
    assert api_client.delete(f"/api/chats/{session_id}").status_code == 409

    res = api_client.post(f"/api/chats/{session_id}/abort")
    assert res.status_code == 200, res.text
    data = res.json()["session"]
    assert data["execution_status"] == "interrupted" and data["pending_quiz"] is None
    assert data["pending"] is False
    assert next(a for a in data["answers"] if a["quiz_id"] == quiz_id)["dismissed"] is True
    assert not any("nunca chega" in m["content"] for m in data["messages"])
    # Idle now: deletion goes through.
    assert api_client.delete(f"/api/chats/{session_id}").status_code == 200


def test_delete_preserve_graph_moves_jsonl_to_trash_and_keeps_note(api_client: TestClient,
                                                                   configured_vault: Path) -> None:
    session_id = _create(api_client)
    data = _idle(api_client, session_id)
    note = configured_vault / data["lesson_vault_path"]
    assert note.exists()

    res = api_client.delete(f"/api/chats/{session_id}")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["mode"] == "preserve-graph" and body["graph"] is None
    assert body["trash_path"] == f".harness/trash/{session_id}.jsonl"
    assert (configured_vault / body["trash_path"]).exists()
    assert not (configured_vault / f".harness/sessions/{session_id}.jsonl").exists()
    assert note.exists()  # Aulas/ is the learner's file.
    assert session_id not in {s["id"] for s in api_client.get("/api/chats").json()}
    assert api_client.get(f"/api/chats/{session_id}").status_code == 404
    assert api_client.delete(f"/api/chats/{session_id}?mode=bogus").status_code == 422


A, B, C, D = "n_aaaaaaaaaaaa", "n_bbbbbbbbbbbb", "n_cccccccccccc", "n_dddddddddddd"


def _seed_graph(vault: Path) -> None:
    """sess-1 alone taught A and B; C came from sess-2; D from both. Chain A∧B⟹C from sess-2,
    chain D⟹C only from sess-1."""
    append_session_event(vault, "sess-1", SessionRecord(id="sess-1", title="Álgebra",
                                                         lesson_vault_path="Aulas/2026-10-27 Álgebra.md"))
    append_session_event(vault, "sess-2", SessionRecord(id="sess-2", title="Atenção"))
    p1 = [{"session_id": "sess-1", "message_id": "m1"}]
    p2 = [{"session_id": "sess-2", "message_id": "m2"}]
    append_records(vault, "nodes.jsonl", [
        {"id": A, "name": "Produto escalar", "statement": "Soma dos produtos.", "provenance": p1},
        {"id": B, "name": "Softmax", "statement": "Normaliza escores.", "provenance": p1},
        {"id": C, "name": "Atenção", "statement": "Pondera valores.", "provenance": p2},
        {"id": D, "name": "Escala", "statement": "Divide por raiz de d.", "provenance": p1 + p2},
    ])
    append_records(vault, "chains.jsonl", [
        {"id": "arg_000000000001", "premises": [A, B], "conclusion": C, "provenance": p2},
        {"id": "arg_000000000002", "premises": [D], "conclusion": C, "provenance": p1},
    ])
    refresh_notes(vault, [A, B, C, D], "pt-BR")


def test_delete_nodes_unlinks_session_and_tombstones_orphans(api_client: TestClient,
                                                             configured_vault: Path) -> None:
    vault = configured_vault
    _seed_graph(vault)
    a_note = vault / "Conceitos" / "Produto escalar.md"
    a_note.write_text(a_note.read_text(encoding="utf-8") + "\nMinha anotação.\n", encoding="utf-8")
    assert "sess-1" in read_frontmatter((vault / "Conceitos" / "Escala.md").read_text(encoding="utf-8"))["sessions"]

    res = api_client.delete("/api/chats/sess-1?mode=delete-nodes")
    assert res.status_code == 200, res.text
    graph = res.json()["graph"]
    assert graph["unlinked_node_ids"] == [A, B, D]
    assert graph["deleted_node_ids"] == [A, B]
    assert graph["deleted_chain_ids"] == ["arg_000000000001", "arg_000000000002"]

    # Append-only: unlink lines precede the tombstones, nothing was rewritten.
    raw = raw_node_records(vault)
    assert {"id": D, "unlink_session": "sess-1"} in raw and {"id": A, "deleted": True} in raw
    assert {"id": "arg_000000000002", "unlink_session": "sess-1"} in raw_chain_records(vault)
    nodes = load_nodes(vault)
    assert set(nodes) == {C, D}
    assert [p.session_id for p in nodes[D].provenance] == ["sess-2"]
    assert load_graph_chains(vault, set(nodes)) == []

    # Concept notes follow the delete rules: user text keeps the file, harness-only notes go.
    assert a_note.exists() and "Minha anotação." in a_note.read_text(encoding="utf-8")
    assert "Soma dos produtos." not in a_note.read_text(encoding="utf-8")
    assert not (vault / "Conceitos" / "Softmax.md").exists()
    escala = read_frontmatter((vault / "Conceitos" / "Escala.md").read_text(encoding="utf-8"))
    assert escala["sessions"] == ["sess-2"]
    assert "Premissas" not in (vault / "Conceitos" / "Atenção.md").read_text(encoding="utf-8")
    assert (vault / ".harness/trash/sess-1.jsonl").exists()


def test_markdown_export(api_client: TestClient, fake_engine: FakeEngine) -> None:
    fake_engine.script_turn(
        "## Produto escalar\n\nSoma dos produtos coordenada a coordenada.",
        tool("probe", **PROBE),
        "Exato.",
    )
    session_id = _create(api_client, "Produto escalar: revisão")
    pending = poll_until(lambda: _chat(api_client, session_id), lambda d: d["pending_quiz"] is not None)
    api_client.post(f"/api/chats/{session_id}/answer", json={
        "quiz_id": pending["pending_quiz"]["id"], "chosen_index": 0, "confidence": 80,
        "learner_thinking": "1·3 + 2·4"})
    poll_until(lambda: _chat(api_client, session_id), lambda d: d["execution_status"] == "idle")

    res = api_client.get(f"/api/chats/{session_id}/markdown")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/markdown")
    disposition = res.headers["content-disposition"]
    assert disposition.startswith("attachment;") and "filename*=UTF-8''Produto%20escalar%20revis%C3%A3o.md" in disposition
    text = res.text
    assert text.startswith("# Produto escalar: revisão\n")
    assert "Soma dos produtos coordenada a coordenada." in text
    assert "**Pergunta:** Quanto vale (1,2)·(3,4)?" in text
    assert "- [x] 11" in text and "**Confiança:** 80%" in text and "**Raciocínio:** 1·3 + 2·4" in text
    assert "Exato." in text


def test_restarted_diagnosis_can_close_with_probe_done_again(api_client: TestClient, app_state) -> None:
    from learnharness.core.contracts.session import ProbeAssessment, ProbeStrand

    session_id = _create(api_client)
    _idle(api_client, session_id)
    session = app_state.sessions.get(session_id)
    session.assessment = ProbeAssessment(strands=[ProbeStrand(strand="s", assessment="a")], created_at="t")
    session.handoff_pending, session.recovery_required, session.phase = True, True, "teaching"
    app_state.sessions.save(session)
    res = api_client.post(f"/api/chats/{session_id}/resume", json={"restart_diagnostic": True})
    assert res.status_code == 200, res.text
    restarted = app_state.sessions.get(session_id)
    assert restarted.phase == "probing" and restarted.assessment is None and not restarted.handoff_pending
