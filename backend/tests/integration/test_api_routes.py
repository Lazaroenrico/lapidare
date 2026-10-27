"""Integration tests for the Lapidare FastAPI server.

Runs against isolated tmp_path Vaults (never the user's Obsidian Vault) with a scripted
FakeEngine injected through ``AppState(engine_factory=...)``. The server never invents
pedagogical content: quizzes appear only because the engine calls ``quiz``/``probe``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

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
    "type": "predict",
    "question": "Como a latência de decodificação cresce com o tamanho do contexto sem KV cache?",
    "options": [
        {"value": "a", "label": "Linearmente, sem gargalo"},
        {"value": "b", "label": "Constante"},
        {"value": "c", "label": "Quadraticamente no total da sequência"},
    ],
    "explanation": "Cada passo recomputa a atenção sobre todos os tokens anteriores.",
    "correct": "c",
    "node_id": "node-tokens",
}


def _get_chat(client: TestClient, session_id: str) -> dict:
    res = client.get(f"/api/chats/{session_id}")
    assert res.status_code == 200
    return res.json()


def test_chats_teaching_flow_and_calibration(client: TestClient, fake_engine: FakeEngine,
                                             configured_vault: Path) -> None:
    """Engine-driven quiz: probe_done -> plan_init -> quiz (blocks) -> answer -> illusion_of_competence."""
    fake_engine.script_turn(
        "Vamos diagnosticar o que você já sabe.",
        tool("probe_done", strands=[{"strand": "atenção", "assessment": "Sabe o que é um token; não sabe o custo."}]),
        tool("plan_init", approach_prose="Diagnóstico antes da formalização.",
             mermaid="graph TD\n  node-tokens[Custo de decodificação]"),
        tool("quiz", **TOKENS_QUIZ),
        "Vamos ver um contraexemplo.",
    )
    fake_engine.script_turn("O limite assintótico vem da soma 1 + 2 + ... + N.")

    # 1. Create TEACH session; the server itself never fabricates a quiz.
    create_res = client.post("/api/chats", json={"mode": "TEACH", "topic": "Tokens e Embeddings"})
    assert create_res.status_code == 200
    session_id = create_res.json()["id"]
    assert create_res.json()["topic"] == "Tokens e Embeddings"

    # 2. Wait until the engine's quiz call is persisted and exposed.
    session_data = poll_until(lambda: _get_chat(client, session_id), lambda d: d["pending_quiz"] is not None)
    assert session_data["id"] == session_id
    assert session_data["status"] == "waiting_quiz"
    assert [n["id"] for n in session_data["plan"]["nodes"]] == ["node-tokens"]
    quiz = session_data["pending_quiz"]
    assert quiz["question"] == TOKENS_QUIZ["question"]
    assert quiz["plan_node_id"] == "node-tokens"
    assert len(quiz["options"]) == 3
    # The answer key never reaches the browser.
    assert not {"correct_index", "correct_indices", "committed_answer", "explanation"} & set(quiz)
    assert (quiz["kind"], quiz["mode"], quiz["collapsed"]) == ("quiz", "PREDICTION", False)
    assert session_data["phase"] == "teaching"
    assert session_data["assessment"]["strands"][0]["strand"] == "atenção"
    assert session_data["plan"]["nodes"][0]["status"] == "current"

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
    assert fake_engine.tool_results[-1][0] == "quiz"
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
    assert {"probe", "recall", "quiz", "explain", "probe_done"} <= set(fake_engine.stream_calls[0]["tools"])
    answers = final["answers"]
    assert answers[0]["chosen_indices"] == [0] and answers[0]["correct_indices"] == [2]
    assert answers[0]["question"] == TOKENS_QUIZ["question"] and len(answers[0]["choices"]) == 3


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


def test_batch_problem_set_routes_are_gone(client: TestClient) -> None:
    """Fase 9 replaced batch problem sets with PRACTICE sessions; demos/jobs routes stay."""
    assert client.get("/api/practice/sets").status_code in (404, 405)
    assert client.post("/api/practice/generate", json={"topics": ["x"]}).status_code in (404, 405)
    assert client.post("/api/practice/sets/s/problems/p/attempt",
                       json={"answer": "x"}).status_code in (404, 405)
    assert client.get("/api/jobs").status_code == 200
    assert client.get("/api/demos/nope").status_code == 404


def test_extract_route_queues_engine_backed_job(client: TestClient, fake_engine: FakeEngine, app_state) -> None:
    """POST /api/graph/extract/{id} (and its legacy alias /api/jobs/extract) queue the session's
    extraction job, which reads only uncovered teacher prose through the background engine."""
    from learnharness.core.contracts.graph import ExtractionPayload
    from learnharness.core.contracts.session import SessionMessage, SessionRecord
    from learnharness.vault.jsonl_store import append_session_event

    append_session_event(app_state.vault_path, "chat-1", SessionRecord(id="chat-1", title="Atenção", messages=[
        SessionMessage(id="m1", role="assistant", content="A atenção pondera valores.", created_at="t")]))
    fake_engine.program(ExtractionPayload, {"propositions": [
        {"key": "p1", "name": "Atenção", "statement": "A atenção pondera valores pelo softmax.", "message_id": "m1"}]})

    def finished(job_id):
        jobs = poll_until(lambda: client.get("/api/jobs").json(),
                          lambda js: any(j["job_id"] == job_id and j["status"] in ("completed", "failed") for j in js))
        return next(j for j in jobs if j["job_id"] == job_id)

    res = client.post("/api/jobs/extract", json={"session_id": "chat-1", "topic": "x", "messages_text": "ignored"})
    assert res.status_code == 202
    job = res.json()
    assert job["kind"] == "extraction" and job["payload"] == {"session_id": "chat-1", "topic": "Atenção", "reason": "manual"}
    done = finished(job["job_id"])
    assert done["status"] == "completed", done["error"]
    assert len(fake_engine.structured_calls) == 1
    assert [n["name"] for n in client.get("/api/graph").json()["nodes"]] == ["Atenção"]

    again = client.post("/api/graph/extract/chat-1")
    assert again.status_code == 202 and again.json()["job_id"] != job["job_id"]
    assert finished(again.json()["job_id"])["result"]["batches"] == 0  # nothing new to read
    assert len(fake_engine.structured_calls) == 1
    assert client.post("/api/graph/extract/nope").status_code == 404


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


def test_health_is_cheap_and_open(tmp_path):
    from starlette.testclient import TestClient

    from learnharness.api.app import create_app

    assert TestClient(create_app(vault_path=tmp_path)).get("/api/health").json() == {"status": "ok"}


def test_setup_status_reports_vault_warning(tmp_path):
    from starlette.testclient import TestClient

    from learnharness.api.app import create_app

    synced = tmp_path / "Dropbox" / "vault"
    body = TestClient(create_app(vault_path=synced)).get("/api/setup/status").json()
    assert "synced folder" in body["vault_warning"]
    plain = TestClient(create_app(vault_path=tmp_path / "plain")).get("/api/setup/status").json()
    assert plain["vault_warning"] is None
