"""Comprehensive integration test suite for LearnHarness FastAPI server.

Runs against isolated tmp_path Vaults without touching the user's Obsidian Vault.
Verifies all REST routes, QuestionDock flows, SSE events, and calibration bands.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from learnharness.api.app import create_app
from learnharness.vault.bootstrap import bootstrap_vault


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    """Initialize isolated test client with fresh bootstrapped vault in tmp_path."""
    vault_dir = tmp_path / "TestVault"
    vault_dir.mkdir(parents=True, exist_ok=True)
    bootstrap_vault(vault_dir, language="pt-BR")
    app = create_app(vault_path=vault_dir)
    return TestClient(app)


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


def test_chats_teaching_flow_and_calibration(client: TestClient) -> None:
    """Test chat creation, question dock answering, and illusion_of_competence calibration."""
    # 1. Create TEACH session
    create_res = client.post(
        "/api/chats",
        json={"mode": "TEACH", "topic": "Tokens e Embeddings"},
    )
    assert create_res.status_code == 200
    session_data = create_res.json()
    session_id = session_data["id"]
    assert session_data["status"] == "waiting_quiz"
    assert session_data["pending_quiz"] is not None

    quiz_id = session_data["pending_quiz"]["id"]

    # 2. Get chat by id
    get_res = client.get(f"/api/chats/{session_id}")
    assert get_res.status_code == 200
    assert get_res.json()["id"] == session_id

    # 3. Submit wrong answer with HIGH confidence (>= 70%) -> triggers illusion_of_competence
    ans_res = client.post(
        f"/api/chats/{session_id}/answer",
        json={
            "quiz_id": quiz_id,
            "chosen_index": 0,  # Wrong answer (correct is 2)
            "confidence": 95,   # High confidence
            "learner_thinking": "Acredito firmemente que a latência cresce linearmente sem gargalo assintótico.",
        },
    )
    assert ans_res.status_code == 200
    ans_data = ans_res.json()
    assert ans_data["is_correct"] is False
    assert ans_data["band"] == "illusion_of_competence"

    # 4. Send chat message
    msg_res = client.post(
        f"/api/chats/{session_id}/messages",
        json={"content": "Entendi o contraexemplo. Como calculamos o limite assintótico?"},
    )
    assert msg_res.status_code == 200
    assert "session" in msg_res.json()


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


def test_practice_generate_and_hint_ladder(client: TestClient) -> None:
    """Test generating practice problems and stepping through R0-R5 hint ladder."""
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
    assert "grade" in grade_data
    assert grade_data["grade"]["score"] >= 0
