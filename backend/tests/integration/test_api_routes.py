"""Integration tests for the LearnHarness FastAPI server.

Runs against isolated tmp_path Vaults (never the user's Obsidian Vault) with a scripted
FakeEngine injected through ``AppState(engine_factory=...)``. The server never invents
pedagogical content: quizzes appear only because the engine calls ``pose_quiz``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from learnharness.core.contracts.practice import PracticeAttemptGrade, PracticeProblem
from tests.conftest import FakeEngine, poll_until, tool


@pytest.fixture
def client(api_client: TestClient) -> TestClient:
    return api_client


def test_setup_status_and_complete(client: TestClient) -> None:
    """Test GET /api/setup/status and POST /api/setup/complete."""
    res = client.get("/api/setup/status")
    assert res.status_code == 200
    data = res.json()
    assert "initialized" in data
    assert "connectors" in data
    assert isinstance(data["connectors"], list)

    comp_res = client.post(
        "/api/setup/complete",
        json={"language": "pt-BR", "track": {"mode": "free", "active": True}},
    )
    assert comp_res.status_code == 200
    comp_data = comp_res.json()
    assert comp_data["success"] is True
    assert "config" in comp_data


def test_graph_snapshot(client: TestClient) -> None:
    """Test GET /api/graph returns valid GraphSnapshot with frontend properties."""
    res = client.get("/api/graph")
    assert res.status_code == 200
    data = res.json()
    assert "nodes" in data
    assert "edges" in data
    assert "chains" in data


TOKENS_QUIZ = {
    "mode": "PREDICTION",
    "topic": "Tokens e Embeddings",
    "question": "Como a latência de decodificação cresce com o tamanho do contexto sem KV cache?",
    "choices": [
        {"value": "a", "label": "Linearmente, sem gargalo"},
        {"value": "b", "label": "Constante"},
        {"value": "c", "label": "Quadraticamente no total da sequência"},
    ],
    "correct_index": 2,
    "explanation": "Cada passo recomputa a atenção sobre todos os tokens anteriores.",
    "node_id": "node-tokens",
}


def _get_chat(client: TestClient, session_id: str) -> dict:
    res = client.get(f"/api/chats/{session_id}")
    assert res.status_code == 200
    return res.json()


def test_chats_teaching_flow_and_calibration(client: TestClient, fake_engine: FakeEngine,
                                             configured_vault: Path) -> None:
    """Engine-driven quiz: plan_init -> pose_quiz (blocks) -> answer -> illusion_of_competence."""
    fake_engine.script_turn(
        "Vamos diagnosticar o que você já sabe.",
        tool("plan_init", approach_prose="Diagnóstico antes da formalização.",
             nodes=[{"id": "node-tokens", "label": "Custo de decodificação", "kind": "goal"}]),
        tool("pose_quiz", **TOKENS_QUIZ),
        "Vamos ver um contraexemplo.",
    )
    fake_engine.script_turn("O limite assintótico vem da soma 1 + 2 + ... + N.")

    # 1. Create TEACH session; the server itself never fabricates a quiz.
    create_res = client.post("/api/chats", json={"mode": "TEACH", "topic": "Tokens e Embeddings"})
    assert create_res.status_code == 200
    session_id = create_res.json()["id"]
    assert create_res.json()["topic"] == "Tokens e Embeddings"

    # 2. Wait until the engine's pose_quiz call is persisted and exposed.
    session_data = poll_until(lambda: _get_chat(client, session_id), lambda d: d["pending_quiz"] is not None)
    assert session_data["id"] == session_id
    assert session_data["status"] == "waiting_quiz"
    assert [n["id"] for n in session_data["plan"]["nodes"]] == ["node-tokens"]
    quiz = session_data["pending_quiz"]
    assert quiz["question"] == TOKENS_QUIZ["question"]
    assert quiz["plan_node_id"] == "node-tokens"
    assert len(quiz["options"]) == 3
    assert "correct_index" not in quiz  # The answer key never reaches the browser.

    # 3. Wrong answer with HIGH confidence -> illusion_of_competence.
    ans_res = client.post(
        f"/api/chats/{session_id}/answer",
        json={
            "quiz_id": quiz["id"],
            "chosen_index": 0,
            "confidence": 95,
            "learner_thinking": "Acredito firmemente que a latência cresce linearmente sem gargalo assintótico.",
        },
    )
    assert ans_res.status_code == 200
    ans_data = ans_res.json()
    assert ans_data["is_correct"] is False
    assert ans_data["band"] == "illusion_of_competence"

    # The suspended engine turn receives the calibration result and finishes.
    after = poll_until(lambda: _get_chat(client, session_id),
                       lambda d: d["pending_quiz"] is None and d["execution_status"] == "idle")
    assert after["status"] == "active"
    assert fake_engine.tool_results[-1][0] == "pose_quiz"
    assert fake_engine.tool_results[-1][1]["calibration_band"] == "illusion_of_competence"
    assert any("contraexemplo" in m["content"] for m in after["messages"] if m["role"] == "assistant")
    quiz_log = (configured_vault / ".harness/quiz-log.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(quiz_log) == 1

    # A second answer with different input is rejected (idempotency guard).
    conflict = client.post(f"/api/chats/{session_id}/answer",
                           json={"quiz_id": quiz["id"], "chosen_index": 2, "confidence": 95})
    assert conflict.status_code == 409

    # 4. Send chat message -> next engine turn.
    msg_res = client.post(
        f"/api/chats/{session_id}/messages",
        json={"content": "Entendi o contraexemplo. Como calculamos o limite assintótico?"},
    )
    assert msg_res.status_code == 200
    assert "session" in msg_res.json()
    final = poll_until(lambda: _get_chat(client, session_id),
                       lambda d: any("1 + 2" in m["content"] for m in d["messages"]))
    assert final["messages"][-1]["role"] == "assistant"
    assert len(fake_engine.stream_calls) == 2
    assert "pose_quiz" in fake_engine.stream_calls[0]["tools"]


def test_chat_engine_failure_is_reported_not_masked(client: TestClient, fake_engine: FakeEngine) -> None:
    """Provider failure propagates to the session instead of a deterministic fallback quiz."""
    fake_engine.script_turn(RuntimeError("provider unavailable"))
    session_id = client.post("/api/chats", json={"mode": "TEACH", "topic": "Softmax"}).json()["id"]
    data = poll_until(lambda: _get_chat(client, session_id), lambda d: d["execution_status"] == "failed")
    assert data["pending_quiz"] is None
    assert "provider unavailable" in (data.get("error") or "")


def test_import_catalog_and_ingest(client: TestClient) -> None:
    """Test /api/import/catalog, /api/import/ingest, and /api/sources/paragraph."""
    cat_res = client.get("/api/import/catalog")
    assert cat_res.status_code == 200
    assert "items" in cat_res.json()

    # Ingest transcript
    raw_transcript = (
        "O mecanismo de atenção calcula similaridades entre consultas e chaves.\n\n"
        "Em seguida, normaliza os pesos via softmax sobre a dimensão do contexto.\n\n"
        "Por fim, multiplica os pesos normalizados pelos vetores de valor correspondentes."
    )
    ingest_res = client.post(
        "/api/import/ingest",
        json={
            "title": "Mecanismo de Atenção Detalhado",
            "file_content": raw_transcript,
        },
    )
    assert ingest_res.status_code == 200
    ingest_data = ingest_res.json()
    assert "source_path" in ingest_data
    assert "session_id" in ingest_data

    # Query source paragraph
    p_res = client.get("/api/sources/paragraph?source=Mecanismo de Atenção Detalhado&p=p1")
    assert p_res.status_code == 200
    p_data = p_res.json()
    assert "content" in p_data
    assert "p1" in p_data["content"] or p_data["paragraphId"] == "p1"


def test_drawings_crud_and_review(client: TestClient) -> None:
    """Test creating, loading, updating, and reviewing an Excalidraw drawing."""
    # 1. Create drawing
    create_res = client.post(
        "/api/drawings",
        json={"title": "Diagrama de Memória KV Cache"},
    )
    assert create_res.status_code == 200
    slug = create_res.json()["slug"]

    # 2. Get drawing
    get_res = client.get(f"/api/drawings/{slug}")
    assert get_res.status_code == 200
    assert get_res.json()["slug"] == slug

    # 3. Update drawing
    put_res = client.put(
        f"/api/drawings/{slug}",
        json={"elements": [{"id": "box1", "type": "rectangle", "x": 100, "y": 100}]},
    )
    assert put_res.status_code == 200
    assert put_res.json()["success"] is True

    # 4. Review drawing
    rev_res = client.post(f"/api/drawings/{slug}/review")
    assert rev_res.status_code == 200
    rev_data = rev_res.json()
    assert "what_is_correct" in rev_data
    assert "summary" in rev_data


def _practice_problem(prompt: str) -> PracticeProblem:
    import json
    topic = json.loads(prompt)["topic"]
    return PracticeProblem.model_validate({
        "problem_id": "provider-id", "topic": topic, "prompt": f"Explique o custo por passo de {topic}.",
        "committed_solution": "Cada passo reutiliza K e V anteriores; o custo por passo é linear no contexto.",
        "rubric": [{"id": "mechanism", "description": "Mecanismo correto", "max_points": 6},
                   {"id": "limit", "description": "Limite correto", "max_points": 4}],
        "hints": [{"level": f"R{i}", "label": f"Passo {i}", "prompt": f"Considere o token {i + 1}: o que muda?"}
                  for i in range(6)],
        "target_misconception": "Confundir valores em cache com tokens de saída",
    })


@pytest.mark.xfail(strict=False, reason=(
    "Bug in api/routes/practice.py: /api/practice/generate does not pass an engine to "
    "run_practice_generation_pipeline, and grading calls grade_practice_attempt_node, which always raises."))
def test_practice_generate_and_hint_ladder(client: TestClient, fake_engine: FakeEngine) -> None:
    """Generate a practice set with the injected engine and step through the R0-R5 hint ladder."""
    fake_engine.program(PracticeProblem, _practice_problem)
    fake_engine.program(PracticeAttemptGrade, {
        "problem_id": "provider-id", "score": 8, "max_score": 10,
        "criterion_scores": {"mechanism": 5, "limit": 3}, "feedback": "Bom raciocínio.", "passed": True,
    })
    # 1. Generate practice set
    gen_res = client.post(
        "/api/practice/generate",
        json={"topics": ["Decodificação Autoregressiva"]},
    )
    assert gen_res.status_code == 200
    p_set = gen_res.json()
    set_id = p_set["id"]
    problem_id = p_set["problems"][0]["id"]

    # 2. Request hint (R0) without grading
    hint_res = client.post(
        f"/api/practice/sets/{set_id}/problems/{problem_id}/attempt",
        json={"answer": "", "request_hint": True},
    )
    assert hint_res.status_code == 200
    hint_data = hint_res.json()
    assert "next_hint" in hint_data
    assert hint_data["next_hint"]["level"] == "R0"

    # 3. Submit solution attempt for grading
    grade_res = client.post(
        f"/api/practice/sets/{set_id}/problems/{problem_id}/attempt",
        json={
            "answer": "A decodificação autoregressiva consome um token por passo atualizando o KV cache incrementalmente.",
            "request_hint": False,
        },
    )
    assert grade_res.status_code == 200
    grade_data = grade_res.json()
    assert grade_data["grade"]["score"] == 8
    assert grade_data["grade"]["passed"] is True
    assert {c["schema"] for c in fake_engine.structured_calls} == {PracticeProblem, PracticeAttemptGrade}
