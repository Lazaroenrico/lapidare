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

    # 4. Review requires an exported PNG (full flow in test_drawing_review.py)
    rev_res = client.post(f"/api/drawings/{slug}/review")
    assert rev_res.status_code == 409


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


def _generate_set(client: TestClient, topics: list[str]) -> dict:
    gen_res = client.post("/api/practice/generate", json={"topics": topics})
    assert gen_res.status_code == 202
    job = gen_res.json()
    assert job["kind"] == "practice_gen" and job["payload"]["topics"] == topics
    jobs = poll_until(lambda: client.get("/api/jobs").json(),
                      lambda js: any(j["job_id"] == job["job_id"] and j["status"] in ("completed", "failed")
                                     for j in js))
    done = next(j for j in jobs if j["job_id"] == job["job_id"])
    assert done["status"] == "completed", done["error"]
    sets = client.get("/api/practice/sets").json()
    return next(s for s in sets if s["id"] == done["result_id"])


def test_practice_generate_and_hint_ladder(client: TestClient, fake_engine: FakeEngine) -> None:
    """Generate via the background job, climb R0..R5 one rung at a time, then grade with the engine."""
    fake_engine.program(PracticeProblem, _practice_problem)
    fake_engine.program(PracticeAttemptGrade, {
        "problem_id": "provider-id", "score": 8, "max_score": 10,
        "criterion_scores": {"mechanism": 5, "limit": 3}, "feedback": "Bom raciocínio.", "passed": True,
    })
    p_set = _generate_set(client, ["Decodificação Autoregressiva"])
    set_id = p_set["id"]
    problem = p_set["problems"][0]
    problem_id = problem["id"]
    assert problem["hints"] == []  # Nothing revealed before the learner asks.
    assert "committed_solution" not in str(p_set) and "K e V anteriores" not in str(p_set)

    url = f"/api/practice/sets/{set_id}/problems/{problem_id}/attempt"
    for i in range(6):
        hint_res = client.post(url, json={"answer": "", "request_hint": True})
        assert hint_res.status_code == 200
        hint = hint_res.json()["next_hint"]
        assert hint["level"] == f"R{i}"
        assert "K e V anteriores" not in str(hint)
        revealed = next(s for s in client.get("/api/practice/sets").json() if s["id"] == set_id)
        assert [h["level"] for h in revealed["problems"][0]["hints"]] == [f"R{j}" for j in range(i + 1)]
    assert client.post(url, json={"answer": "", "request_hint": True}).status_code == 409

    answer = "A decodificação autoregressiva consome um token por passo atualizando o KV cache incrementalmente."
    grade_res = client.post(url, json={"answer": answer, "request_hint": False})
    assert grade_res.status_code == 200
    grade_data = grade_res.json()
    assert grade_data["grade"]["score"] == 8
    assert grade_data["grade"]["passed"] is True
    assert grade_data["grade"]["rubric_scores"] == {"mechanism": 5, "limit": 3}
    assert grade_data["next_hint"] is None
    assert {c["schema"] for c in fake_engine.structured_calls} == {PracticeProblem, PracticeAttemptGrade}

    # Hint progress and grade persist append-only under .harness/practice/.
    persisted = next(s for s in client.get("/api/practice/sets").json() if s["id"] == set_id)
    assert persisted["problems"][0]["grade"]["score"] == 8
    assert persisted["completed"] is True


def test_practice_grade_rejects_inconsistent_provider_output(client: TestClient, fake_engine: FakeEngine) -> None:
    """A grade whose total disagrees with its criteria is a provider failure (502), never stored."""
    fake_engine.program(PracticeProblem, _practice_problem)
    fake_engine.program(PracticeAttemptGrade, [
        {"problem_id": "x", "score": 10, "criterion_scores": {"mechanism": 5, "limit": 3},
         "feedback": "x", "passed": True},
        {"problem_id": "x", "score": 9, "criterion_scores": {"mechanism": 7, "limit": 2},
         "feedback": "x", "passed": True},
    ])
    p_set = _generate_set(client, ["Atenção"])
    url = f"/api/practice/sets/{p_set['id']}/problems/{p_set['problems'][0]['id']}/attempt"
    assert client.post(url, json={"answer": "", "request_hint": False}).status_code == 422
    for _ in range(2):
        assert client.post(url, json={"answer": "minha resposta", "request_hint": False}).status_code == 502
    stored = next(s for s in client.get("/api/practice/sets").json() if s["id"] == p_set["id"])
    assert stored["problems"][0]["grade"] is None


def test_practice_generation_provider_failure_marks_job_failed(client: TestClient, fake_engine: FakeEngine) -> None:
    fake_engine.program(PracticeProblem, RuntimeError("provider unavailable"))
    job = client.post("/api/practice/generate", json={"topics": ["Atenção"]}).json()
    jobs = poll_until(lambda: client.get("/api/jobs").json(),
                      lambda js: any(j["job_id"] == job["job_id"] and j["status"] == "failed" for j in js))
    failed = next(j for j in jobs if j["job_id"] == job["job_id"])
    assert "provider unavailable" in failed["error"]
    assert client.get("/api/practice/sets").json() == []


def test_extract_route_queues_engine_backed_job(client: TestClient, fake_engine: FakeEngine) -> None:
    """POST /api/jobs/extract goes through the JobManager, which supplies the background engine."""
    payload = {"session_id": "chat-1", "topic": "Atenção", "messages_text": "A atenção pondera valores."}
    res = client.post("/api/jobs/extract", json=payload)
    assert res.status_code == 202
    job = res.json()
    assert job["kind"] == "extraction" and job["payload"]["session_id"] == "chat-1"
    assert client.post("/api/jobs/extract", json=payload).json()["job_id"] == job["job_id"]  # dedup
    jobs = poll_until(lambda: client.get("/api/jobs").json(),
                      lambda js: any(j["job_id"] == job["job_id"] and j["status"] in ("completed", "failed")
                                     for j in js))
    done = next(j for j in jobs if j["job_id"] == job["job_id"])
    # The engine was actually invoked (no "requires a configured engine" error).
    assert fake_engine.structured_calls
    assert "configured engine" not in (done["error"] or "")


def test_first_setup_without_slots_uses_recommended_connector(tmp_path, monkeypatch):
    from starlette.testclient import TestClient

    from learnharness.api.app import create_app
    from learnharness.api.routes import setup as setup_routes
    from learnharness.core.contracts.config import EngineKind

    monkeypatch.setattr(setup_routes, "get_default_engine", lambda: EngineKind.AGY)
    client = TestClient(create_app(vault_path=tmp_path / "Fresh"))
    res = client.post("/api/setup/complete", json={"language": "pt-BR", "track": {"mode": "free"}})
    assert res.status_code == 200
    assert res.json()["config"]["slots"]["strong"]["engine"] == "agy"
