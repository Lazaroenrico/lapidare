"""End-to-end TEACH flow over the real FastAPI app with a scripted in-process engine.

Covers: probe_done -> plan_init -> quiz (blocks) -> REST answer -> quiz-log -> plan_advance(mastered)
-> extraction job -> Conceitos/ note, while Fontes/ stays byte-identical. Also covers the
HTTP error mapping for an unconfigured vault and redaction of provider secrets.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx

from learnharness.api.app import create_app
from learnharness.api.state import AppState
from learnharness.engines.cli_protocol import EngineError
from learnharness.vault.bootstrap import bootstrap_vault, load_config, save_config

CONCEPT_TITLE = "Produto Escalar"


class ScriptedTeachEngine:
    """Inline engine that drives the pedagogical tools like a well-behaved teacher model."""

    tool_transport = "inline"

    def __init__(self) -> None:
        self.turns = 0
        self.tool_results: dict[str, Any] = {}
        self.structured_calls: list[str] = []

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None) -> AsyncIterator[str]:
        self.turns += 1
        if self.turns > 1:  # Sessions rescheduled after the scripted turn have nothing to add.
            return
        assert tools is not None, "inline engines must receive the bound tool callables"
        by_name = {t.__name__: t for t in tools}
        yield "## Produto Escalar\n\nDefinição: soma dos produtos coordenada a coordenada.\n"
        self.tool_results["probe_done"] = await by_name["probe_done"](
            [{"strand": "álgebra linear", "assessment": "Piso: vetores. Teto: produto escalar."}])
        self.tool_results["plan"] = await by_name["plan_init"](
            f"graph TD\n  dot[{CONCEPT_TITLE}] --> attn[Atenção]",
            "Primeiro o produto escalar, depois a atenção.",
        )
        self.tool_results["quiz"] = await by_name["quiz"](
            "check", "dot", "Quanto vale (1,2)·(3,4)?",
            [{"value": "a", "label": "11"}, {"value": "b", "label": "10"}],
            "1*3 + 2*4 = 11.", "a",
        )
        self.tool_results["advance"] = await by_name["plan_advance"]("dot", "mastered")
        yield "Ótimo, você dominou o produto escalar.\n"

    async def run_structured(self, prompt, schema, slot=None, system_instruction=None):
        self.structured_calls.append(schema.__name__)
        return schema.model_validate({
            "concepts": [{"title": CONCEPT_TITLE, "unconditional_truth": "Soma dos produtos coordenada a coordenada.", "cluster_id": "algebra"}],
            "chains": [],
        })


class FailingEngine:
    tool_transport = "inline"

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None) -> AsyncIterator[str]:
        raise EngineError("secret-key-123 boom")
        yield ""  # pragma: no cover - makes this an async generator

    async def run_structured(self, prompt, schema, slot=None, system_instruction=None):
        raise EngineError("unused")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _configured_vault(root: Path) -> Path:
    vault = root / "Vault"
    vault.mkdir()
    bootstrap_vault(vault, language="pt-BR")
    config = load_config(vault)
    config.configured = True
    config.vault_path = str(vault)
    save_config(vault, config)
    return vault


@asynccontextmanager
async def _running_app(state: AppState):
    app = create_app(state=state)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as http:
            yield http


async def _wait_until(predicate, timeout: float = 5.0, interval: float = 0.02):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        result = await predicate()
        if result:
            return result
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition not met within timeout")
        await asyncio.sleep(interval)


async def _run_teach_flow(tmp_path: Path) -> dict[str, Any]:
    vault = _configured_vault(tmp_path)
    config = load_config(vault)
    source = vault / config.folders.sources_dir / "Aula Original.md"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("# Aula\n\nTexto do autor. ^p1\n", encoding="utf-8")
    source_hash = _sha256(source)

    engine = ScriptedTeachEngine()
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    async with _running_app(state) as http:
        created = await http.post("/api/chats", json={"mode": "TEACH", "topic": "Mecanismo de atenção"})
        assert created.status_code == 200, created.text
        chat_id = created.json()["id"]
        assert created.json()["teach_context"] == "free_topic"

        async def pending_quiz():
            return (await http.get(f"/api/chats/{chat_id}")).json()["pending_quiz"]

        quiz = await _wait_until(pending_quiz)
        assert quiz["mode"] == "CHECK"
        assert quiz["plan_node_id"] == "dot"
        chat = (await http.get(f"/api/chats/{chat_id}")).json()
        assert chat["status"] == "waiting_quiz"
        assert [n["id"] for n in chat["plan"]["nodes"]] == ["dot", "attn"]
        assert chat["plan"]["nodes"][1]["dependencies"] == ["dot"]

        answer = await http.post(f"/api/chats/{chat_id}/answer", json={"quiz_id": quiz["quiz_id"], "chosen_index": 0, "confidence": 85})
        assert answer.status_code == 200, answer.text
        assert answer.json()["calibration_band"] == "calibrated_mastery"

        quiz_log = vault / ".harness/quiz-log.jsonl"
        assert len(quiz_log.read_text(encoding="utf-8").splitlines()) == 1

        async def extraction_done():
            jobs = (await http.get("/api/jobs")).json()
            done = [j for j in jobs if j["kind"] == "extraction" and j["status"] in ("completed", "failed")]
            return done[0] if done else None

        job = await _wait_until(extraction_done)
        assert job["status"] == "completed", job["error"]
        assert job["dedup_key"] == f"extract:{chat_id}:dot"

        async def turn_finished():
            return not state.sessions.is_running(chat_id)

        await _wait_until(turn_finished)
        final = (await http.get(f"/api/chats/{chat_id}")).json()

    assert engine.tool_results["quiz"]["correct"] is True
    assert engine.tool_results["quiz"]["confidence"] == 85
    assert {n["id"]: n["status"] for n in engine.tool_results["advance"]["plan"]} == {"dot": "mastered", "attn": "pending"}
    assert final["error"] is None
    assert final["pending_quiz"] is None
    assert len(quiz_log.read_text(encoding="utf-8").splitlines()) == 1

    concept = vault / config.folders.concepts_dir / f"{CONCEPT_TITLE}.md"
    assert concept.is_file(), sorted(p.name for p in concept.parent.iterdir())
    lesson = vault / final["lesson_vault_path"]
    assert lesson.is_file()
    assert lesson.parent == vault / config.folders.lessons_dir
    assert "Ótimo, você dominou o produto escalar." in lesson.read_text(encoding="utf-8")
    assert _sha256(source) == source_hash
    return {"engine": engine, "vault": vault}


async def test_teach_free_topic_end_to_end(tmp_path: Path) -> None:
    await _run_teach_flow(tmp_path)


async def test_extraction_job_uses_engine_structured_output(tmp_path: Path) -> None:
    flow = await _run_teach_flow(tmp_path)
    assert "_ExtractionStructuredPayload" in flow["engine"].structured_calls


async def test_creating_chat_on_unconfigured_vault_is_conflict(tmp_path: Path) -> None:
    state = AppState(vault_path=tmp_path / "Empty", engine_factory=lambda slot: ScriptedTeachEngine())
    async with _running_app(state) as http:
        response = await http.post("/api/chats", json={"mode": "TEACH", "topic": "Qualquer"})
    assert response.status_code == 409
    assert "setup" in response.json()["detail"].lower()


async def test_engine_error_is_redacted_in_session(tmp_path: Path) -> None:
    state = AppState(vault_path=_configured_vault(tmp_path), engine_factory=lambda slot: FailingEngine())
    async with _running_app(state) as http:
        state.api_key = "secret-key-123"
        created = await http.post("/api/chats", json={"mode": "TEACH", "topic": "Falha"})
        assert created.status_code == 200, created.text
        chat_id = created.json()["id"]

        async def failed():
            session = state.sessions.get(chat_id)
            return session if session.execution_status == "failed" else None

        session = await _wait_until(failed)
        served = (await http.get(f"/api/chats/{chat_id}")).json()

    assert "[redacted]" in session.error
    assert "secret-key-123" not in session.error
    assert served["execution_status"] == "failed"
    assert "secret-key-123" not in served["error"]
