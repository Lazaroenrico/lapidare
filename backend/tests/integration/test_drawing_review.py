"""Drawing review through the engine: PNG gate, persistence, follow-up quiz via QuestionDock."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from learnharness.api.app import create_app
from learnharness.api.state import AppState
from learnharness.engines.cli_protocol import EngineError
from learnharness.vault.jsonl_store import load_quiz_logs
from learnharness.vault.safety import safe_path
from tests.conftest import FakeEngine

PNG = b"\x89PNG\r\n\x1a\nfake-image"

CLEAN_REVIEW = {
    "correct_points": ["Setas de K e V reutilizadas a cada passo."],
    "missing_points": ["Limite de memória do cache."],
    "incorrect_points": [],
    "summary_markdown": "Diagrama **correto** no essencial.",
    "follow_up_quiz": None,
}

ERROR_REVIEW = {
    "correct_points": ["Blocos de atenção identificados."],
    "missing_points": [],
    "incorrect_points": ["O cache guarda Q em vez de K e V."],
    "summary_markdown": "Há um erro conceitual sobre o que é armazenado.",
    "follow_up_quiz": {
        "question": "O que o KV cache armazena entre passos de decodificação?",
        "choices": ["Queries anteriores", "Keys e Values anteriores", "Logits"],
        "correct_index": 1,
        "explanation": "Q é recalculada a cada passo; K e V passados são reutilizados.",
        "topic": "KV Cache",
    },
}


class VisionFakeEngine(FakeEngine):
    """FakeEngine plus a scripted ``review_drawing_multimodal``."""

    def __init__(self) -> None:
        super().__init__()
        self.reviews: list[Any] = []
        self.review_calls: list[dict[str, Any]] = []

    async def review_drawing_multimodal(self, png_bytes, drawing_title, context_notes=""):
        self.review_calls.append({"png": png_bytes, "title": drawing_title, "context": context_notes})
        if not self.reviews:
            raise LookupError("No programmed drawing review")
        response = self.reviews.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


@pytest.fixture
def vision_engine() -> VisionFakeEngine:
    return VisionFakeEngine()


@pytest.fixture
def state(configured_vault: Path, vision_engine: VisionFakeEngine) -> AppState:
    return AppState(vault_path=configured_vault, engine_factory=lambda slot: vision_engine)


@pytest.fixture
def client(state: AppState):
    with TestClient(create_app(state=state)) as test_client:
        yield test_client


def _make_drawing(client: TestClient, state: AppState, *, with_png: bool = True) -> str:
    folders = state.get_config().folders
    lesson = safe_path(state.vault_path, f"{folders.lessons_dir}/kv-cache.md")
    lesson.write_text("# KV Cache\nO cache guarda K e V de cada passo.\n", encoding="utf-8")
    concept = safe_path(state.vault_path, f"{folders.concepts_dir}/Atenção.md")
    concept.write_text("# Atenção\nsoftmax(QK^T / sqrt(d_k)) V\n", encoding="utf-8")
    res = client.post("/api/drawings", json={
        "title": "KV Cache", "session_id": f"{folders.lessons_dir}/kv-cache.md",
        "concept_ids": ["[[Atenção]]"], "prompt": "Desenhe o KV cache de memória.",
    })
    assert res.status_code == 200
    slug = res.json()["slug"]
    elements = client.get(f"/api/drawings/{slug}").json()["elements"]  # locked title + prompt
    payload: dict[str, Any] = {"elements": [*elements, {"id": "box1", "type": "rectangle", "x": 1, "y": 1}]}
    if with_png:
        payload["pngBase64"] = "data:image/png;base64," + base64.b64encode(PNG).decode()
    assert client.put(f"/api/drawings/{slug}", json=payload).status_code == 200
    return slug


def _note(state: AppState, slug: str) -> str:
    folders = state.get_config().folders
    return safe_path(state.vault_path, f"{folders.drawings_dir}/{slug}.excalidraw.md").read_text("utf-8")


def test_review_without_png_is_conflict(client, state, vision_engine):
    slug = _make_drawing(client, state, with_png=False)
    res = client.post(f"/api/drawings/{slug}/review")
    assert res.status_code == 409
    assert "salve o desenho" in res.json()["detail"].lower()
    assert vision_engine.review_calls == []


def test_clean_review_persists_and_poses_no_quiz(client, state, vision_engine):
    slug = _make_drawing(client, state)
    vision_engine.reviews.append(CLEAN_REVIEW)
    res = client.post(f"/api/drawings/{slug}/review")
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["correct_points"] == CLEAN_REVIEW["correct_points"]
    assert data["summary_markdown"] == CLEAN_REVIEW["summary_markdown"]
    assert data["session_id"] is None and data["pending_quiz"] is None

    call = vision_engine.review_calls[0]
    assert call["png"] == PNG and call["title"] == "KV Cache"
    assert "O cache guarda K e V" in call["context"]  # lesson note
    assert "sqrt(d_k)" in call["context"]  # concept note
    assert "Desenhe o KV cache" in call["context"]  # prompt

    note = _note(state, slug)
    assert "## Revisão" in note and "Diagrama **correto**" in note
    assert "revisado: true" in note


def test_reviews_append_and_preserve_user_text(client, state, vision_engine):
    slug = _make_drawing(client, state)
    path = safe_path(state.vault_path, f"{state.get_config().folders.drawings_dir}/{slug}.excalidraw.md")
    path.write_text(path.read_text("utf-8") + "\nMinha anotação livre.\n", encoding="utf-8")
    vision_engine.reviews += [CLEAN_REVIEW, {**CLEAN_REVIEW, "summary_markdown": "Segunda revisão."}]
    assert client.post(f"/api/drawings/{slug}/review").status_code == 200
    assert client.post(f"/api/drawings/{slug}/review").status_code == 200
    note = _note(state, slug)
    assert "Diagrama **correto**" in note and "Segunda revisão." in note
    assert note.count("## Revisão") == 1
    assert "Minha anotação livre." in note


def test_erroneous_review_opens_quiz_answered_via_rest(client, state, vision_engine):
    slug = _make_drawing(client, state)
    vision_engine.reviews.append(ERROR_REVIEW)
    res = client.post(f"/api/drawings/{slug}/review")
    assert res.status_code == 200, res.text
    data = res.json()
    session_id = data["session_id"]
    quiz = data["pending_quiz"]
    assert session_id and quiz
    assert quiz["question"] == ERROR_REVIEW["follow_up_quiz"]["question"]
    assert len(quiz["options"]) == 3 and quiz["has_dont_know"] is True

    chat = client.get(f"/api/chats/{session_id}").json()
    assert chat["mode"] == "TEACH" and chat["context_kind"] == "drawing_review"
    assert chat["pending_quiz"]["id"] == quiz["id"]

    answer = client.post(f"/api/chats/{session_id}/answer", json={
        "quiz_id": quiz["id"], "chosen_index": 0, "confidence": 90, "learner_thinking": "Q é reaproveitada",
    })
    assert answer.status_code == 200, answer.text
    assert answer.json()["band"] == "illusion_of_competence"
    logs = [q for q in load_quiz_logs(state.vault_path) if q.session_id == session_id]
    assert len(logs) == 1 and logs[0].quiz_id == quiz["id"] and logs[0].mode == "CHECK"

    # A second erroneous review reuses the same session keyed by the drawing slug.
    vision_engine.reviews.append(ERROR_REVIEW)
    again = client.post(f"/api/drawings/{slug}/review").json()
    assert again["session_id"] == session_id
    assert again["pending_quiz"]["id"] != quiz["id"]


@pytest.mark.parametrize("bad", [
    {**ERROR_REVIEW, "follow_up_quiz": {**ERROR_REVIEW["follow_up_quiz"], "correct_index": 7}},
    {**ERROR_REVIEW, "follow_up_quiz": {**ERROR_REVIEW["follow_up_quiz"], "choices": ["só uma"]}},
    {"correct_points": "not-a-list", "summary_markdown": "x"},
])
def test_invalid_model_output_is_bad_gateway(client, state, vision_engine, bad):
    slug = _make_drawing(client, state)
    vision_engine.reviews.append(bad)
    res = client.post(f"/api/drawings/{slug}/review")
    assert res.status_code == 502
    assert "## Revisão" not in _note(state, slug)


def test_engine_error_surfaces_with_vision_hint(client, state, vision_engine):
    slug = _make_drawing(client, state)
    vision_engine.reviews.append(EngineError("Image review requires the google-genai SDK connector"))
    res = client.post(f"/api/drawings/{slug}/review")
    assert res.status_code == 502
    detail = res.json()["detail"]
    assert "google-genai" in detail and "visão" in detail
