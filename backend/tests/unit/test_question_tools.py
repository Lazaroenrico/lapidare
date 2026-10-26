"""Fase 8 question tools: phase machine, refusals, grading, handoff and serialization."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from fastmcp.exceptions import ToolError

from learnharness.api.routes.chats import _serialize_session
from learnharness.api.state import AppState
from learnharness.core.calibration import compact_answer, evaluate_calibration
from learnharness.core.contracts.quiz import (
    CalibrationResult,
    QuizOption,
    QuizPayload,
    QuizSubmission,
)
from learnharness.core.contracts.session import ProbeAssessment, SessionMessage, SessionRecord
from learnharness.mcp.runtime_server import session_tools
from learnharness.prompts.loader import build_handoff_prompt
from tests.conftest import FakeEngine, configure_vault, tool, wait_until

STRANDS = [{"strand": "vetores", "assessment": "Piso: soma de vetores. Teto: produto escalar."}]
MERMAID = "graph TD\n  dot[Produto escalar] --> attn[Atenção]"
CHECK_DOT = {"type": "check", "node_id": "dot", "question": "(1,2)·(3,4)?", "options": ["11", "10"],
             "explanation": "3 + 8.", "correct": "11"}


@pytest.fixture
async def runtime(app_state: AppState):
    session = await app_state.sessions.create(mode="TEACH", topic="Atenção", start=False)
    try:
        yield app_state, session.id, {t.__name__: t for t in session_tools(app_state, session.id)}
    finally:
        await app_state.close()


async def _ask(state: AppState, session_id: str, call, **answer: Any) -> tuple[CalibrationResult, dict[str, Any]]:
    """Run a blocking question tool and answer it like the QuestionDock would."""
    before = set(state.sessions.get(session_id).answers)
    task = asyncio.create_task(call)
    pending = await wait_until(lambda: (q := state.sessions.get(session_id).pending_quiz) and q.quiz_id not in before and q)
    assert not task.done()
    result = await state.sessions.answer(QuizSubmission(quiz_id=pending.quiz_id, session_id=session_id, **answer))
    return result, await asyncio.wait_for(task, 3)


async def _to_planning(tools: dict[str, Any]) -> None:
    await tools["probe_done"](STRANDS)
    await tools["plan_init"](MERMAID, "Do produto escalar à atenção.")


# --------------------------------------------------------------------------- refusals


async def test_phase_refusals_teach_the_model(runtime) -> None:
    state, sid, tools = runtime
    with pytest.raises(ToolError, match="probe/recall"):
        await tools["quiz"](**CHECK_DOT)
    with pytest.raises(ToolError, match="probe_done before plan_init"):
        await tools["plan_init"](MERMAID)
    with pytest.raises(ToolError, match="teaching"):
        await tools["plan_advance"]("dot", "mastered")
    with pytest.raises(ToolError, match="strands"):
        await tools["probe_done"]([])

    await tools["probe_done"](STRANDS)
    session = state.sessions.get(sid)
    assert session.phase == "planning" and session.handoff_pending
    assert session.assessment.strands[0].strand == "vetores"
    with pytest.raises(ToolError, match="probe_done was already called"):
        await tools["probe_done"](STRANDS)
    with pytest.raises(ToolError, match="diagnosis"):
        await tools["probe"]("?", ["a", "b"], "e", "A")
    with pytest.raises(ToolError, match="diagnosis"):
        await tools["recall"]("?", "answer")
    with pytest.raises(ToolError, match="Call plan_init before teaching questions"):
        await tools["quiz"](**CHECK_DOT)

    with pytest.raises(ToolError, match=r"line 2: node id `Dot`"):
        await tools["plan_init"]("graph TD\n  Dot[Produto]")
    await tools["plan_init"](MERMAID)
    assert not state.sessions.get(sid).handoff_pending
    with pytest.raises(ToolError, match="Unknown node_id 'nope'; use one of: dot, attn"):
        await tools["quiz"](**{**CHECK_DOT, "node_id": "nope"})
    with pytest.raises(ToolError, match="matches no option"):
        await tools["quiz"](**{**CHECK_DOT, "correct": "12"})
    with pytest.raises(ToolError, match="multi_select"):
        await tools["quiz"](**{**CHECK_DOT, "correct": ["11", "10"]})
    with pytest.raises(ToolError, match="2 to 6 options"):
        await tools["quiz"](**{**CHECK_DOT, "options": ["11"], "correct": "11"})
    with pytest.raises(ToolError, match="'current' is derived"):
        await tools["plan_advance"]("dot", "current")
    assert state.sessions.get(sid).pending_quiz is None  # No refused call left a question behind.


async def test_probe_done_refused_while_a_question_is_pending(runtime) -> None:
    state, sid, tools = runtime
    task = asyncio.create_task(tools["probe"]("?", ["a", "b"], "e", "A"))
    await wait_until(lambda: state.sessions.get(sid).pending_quiz)
    with pytest.raises(ToolError, match="still pending"):
        await tools["probe_done"](STRANDS)
    with pytest.raises(ToolError, match="still pending"):
        await tools["probe"]("other?", ["a", "b"], "e", "A")
    task.cancel()


async def test_tolerant_inputs_are_healed(runtime) -> None:
    state, sid, tools = runtime
    result, output = await _ask(
        state, sid,
        tools["probe"]("Quais são primos?", json.dumps(["2", {"text": "4"}, {"label": "5", "value": "x"}]),
                       "2 e 5 só têm dois divisores.", json.dumps(["A", "5"]), multi_select="true"),
        chosen_indices=[2, 0], confidence=70,
    )
    assert result.correct is True and result.correct_indices == [0, 2]
    assert output["answers"] == [{"index": 2, "label": "5"}, {"index": 0, "label": "2"}]
    await tools["probe_done"](json.dumps(STRANDS))
    await tools["plan_init"](MERMAID, node_details=json.dumps({"dot": {"source_paragraphs": []}}))
    assert [n.id for n in state.sessions.get(sid).plan.nodes] == ["dot", "attn"]


# --------------------------------------------------------------------------- phase machine


async def test_first_node_question_enters_teaching_and_replan_keeps_mastery(runtime) -> None:
    state, sid, tools = runtime
    await _to_planning(tools)
    result, _ = await _ask(state, sid, tools["quiz"](**{**CHECK_DOT, "type": "predict"}), chosen_index=0, confidence=90)
    session = state.sessions.get(sid)
    assert session.phase == "teaching" and result.mode == "PREDICTION"
    assert {n.id: n.status for n in session.plan.nodes} == {"dot": "current", "attn": "pending"}

    await _ask(state, sid, tools["quiz"](**CHECK_DOT), chosen_index=0, confidence=90)
    advanced = await tools["plan_advance"]("dot", "mastered")
    assert advanced["plan"] == [{"id": "dot", "status": "mastered"}, {"id": "attn", "status": "pending"}]

    # A revealed gap: re-plan with a new foundation; the permanent id keeps its mastery.
    replanned = await tools["plan_init"]("graph TD\n  vec[Vetores] --> dot[Produto escalar] --> attn[Atenção]")
    assert replanned["node_ids"] == ["vec", "dot", "attn"]
    session = state.sessions.get(sid)
    assert session.phase == "teaching"
    assert {n.id: n.status for n in session.plan.nodes} == {"vec": "pending", "dot": "mastered", "attn": "pending"}


async def test_recall_and_explain_are_graded_by_the_model(runtime) -> None:
    state, sid, tools = runtime
    result, output = await _ask(state, sid, tools["recall"]("Defina produto escalar.", "Soma dos produtos coordenada a coordenada."),
                                text="multiplica e soma", learner_thinking="lembro da fórmula")
    assert result.correct is None and result.kind == "explain" and result.mode == "PROBE"
    assert output["committed_answer"] == "Soma dos produtos coordenada a coordenada."
    assert "grade_recall" in output["directive"] and output["text"] == "multiplica e soma"
    assert not (Path(state.vault_path) / ".harness/quiz-log.jsonl").exists()  # Ungraded: no evidence yet.

    graded = await tools["grade_recall"](result.quiz_id, "partial", "Faltou dizer coordenada a coordenada.")
    assert graded == {"ok": True, "question_id": result.quiz_id, "grade": "partial"}
    stored = state.sessions.get(sid).answers[result.quiz_id]
    assert (stored.grade, stored.correct) == ("partial", False)
    assert len((Path(state.vault_path) / ".harness/quiz-log.jsonl").read_text().splitlines()) == 1
    with pytest.raises(ToolError, match="already graded"):
        await tools["grade_recall"](result.quiz_id, "correct", "ok")
    with pytest.raises(ToolError, match="Unknown question_id"):
        await tools["grade_recall"]("quiz-nope", "correct", "ok")

    await _to_planning(tools)
    check, _ = await _ask(state, sid, tools["explain"]("check", "dot", "Por que (1,2)·(3,4) = 11?", "1·3 + 2·4 = 11."),
                          text="3 + 8", reading_thinking="soma termo a termo")
    assert check.reading_thinking == "soma termo a termo"
    with pytest.raises(ToolError, match="calibrated check"):
        await tools["plan_advance"]("dot", "mastered")
    quiz_result, _ = await _ask(state, sid, tools["quiz"](**CHECK_DOT), chosen_index=1, confidence=40)
    with pytest.raises(ToolError, match="quiz answers are graded automatically"):
        await tools["grade_recall"](quiz_result.quiz_id, "correct", "x")
    await tools["grade_recall"](check.quiz_id, "correct", "Exato.")
    # A CHECK explain graded correct is mastery evidence (auto-applied, prerequisites permitting).
    assert state.sessions.get(sid).plan.nodes[0].status == "mastered"
    assert (await tools["plan_advance"]("dot", "mastered"))["status"] == "mastered"


async def test_ask_user_question_is_never_graded(runtime) -> None:
    state, sid, tools = runtime
    result, output = await _ask(
        state, sid,
        tools["ask_user_question"]("Qual objetivo?", [{"label": "Entender transformers (Recomendado)", "description": "base"}, "Passar na prova"]),
        other_text="Implementar atenção do zero",
    )
    assert result.kind == "ask" and result.correct is None and result.confidence is None
    assert output == {"question_id": result.quiz_id, "kind": "ask", "other": "Implementar atenção do zero"}
    assert state.sessions.get(sid).phase == "probing"
    assert not (Path(state.vault_path) / ".harness/quiz-log.jsonl").exists()
    with pytest.raises(ValueError, match="Choose an option"):
        await _ask(state, sid, tools["ask_user_question"]("Outra?"))


# --------------------------------------------------------------------------- contracts


def test_evaluation_rules_per_kind() -> None:
    base = dict(quiz_id="q", session_id="s", question="?")
    multi = QuizPayload(**base, choices=[QuizOption(value=v, label=v) for v in "abc"], correct_indices=[0, 2], multi_select=True, mode="CHECK")
    sub = dict(quiz_id="q", session_id="s")
    assert evaluate_calibration(QuizSubmission(**sub, chosen_indices=[2, 0], confidence=90), multi).correct is True
    assert evaluate_calibration(QuizSubmission(**sub, chosen_indices=[0], confidence=90), multi).correct is False
    with pytest.raises(ValueError, match="Confidence is required"):
        evaluate_calibration(QuizSubmission(**sub, chosen_indices=[0]), multi)
    dont_know = evaluate_calibration(QuizSubmission(**sub, is_dont_know=True), multi)
    assert (dont_know.correct, dont_know.confidence, dont_know.calibration_band) == (False, None, "conscious_gap")
    assert compact_answer(dont_know)["dont_know"] is True
    single = QuizPayload(**base, choices=multi.choices, correct_index=1)
    assert single.correct_indices == [1] and single.correct_index == 1
    with pytest.raises(ValueError, match="single choice"):
        evaluate_calibration(QuizSubmission(**sub, chosen_indices=[0, 1], confidence=50), single)
    with pytest.raises(ValueError, match="multi_select"):
        QuizPayload(**base, choices=multi.choices, correct_indices=[0, 1])
    with pytest.raises(ValueError, match="committed_answer"):
        QuizPayload(**base, kind="explain")
    chance = evaluate_calibration(QuizSubmission(**sub, chosen_indices=[1], confidence=30), single)
    assert "chance" in chance.pedagogical_directive


def test_legacy_records_still_load(tmp_path: Path) -> None:
    legacy_answer = {
        "quiz_id": "q1", "session_id": "s1", "topic": "t", "node_id": "n1", "correct": True,
        "is_dont_know": False, "chosen_index": 1, "correct_index": 1, "confidence": 90,
        "confidence_band": "high", "calibration_band": "calibrated_mastery", "mode": "CHECK",
        "learner_thinking": "", "pedagogical_directive": "", "explanation": "", "timestamp": "",
    }
    restored = CalibrationResult.model_validate(legacy_answer)
    assert restored.chosen_indices == [1] and restored.correct_indices == [1] and restored.kind == "quiz"
    assert CalibrationResult.model_validate(restored.model_dump(mode="json")) == restored
    legacy_quiz = {"quiz_id": "q2", "session_id": "s1", "topic": "t", "mode": "PREDICTION", "question": "?",
                   "details": None, "choices": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}],
                   "correct_index": 0, "explanation": "e", "created_at": "", "node_id": None}
    record = SessionRecord.model_validate({
        "id": "s1", "title": "Velha", "phase": "awaiting_answer", "pending_quiz": legacy_quiz,
        "pending_quiz_id": "q2", "answers": {"q1": legacy_answer},
        "plan": {"nodes": [{"id": "n1", "label": "N", "status": "current"}]},
    })
    assert record.pending_quiz.correct_indices == [0] and record.assessment is None
    legacy_submission = QuizSubmission.model_validate({"quiz_id": "q", "session_id": "s", "chosen_index": 2, "confidence": 10})
    assert legacy_submission.chosen_indices == [2]


async def test_legacy_phases_are_normalized_on_load(app_state: AppState) -> None:
    session = await app_state.sessions.create(mode="TEACH", topic="Velha", start=False)
    session.phase = "awaiting_answer"
    app_state.sessions.save(session)
    assert app_state.sessions.get(session.id).phase == "probing"  # No plan yet: still diagnosing.
    session.phase = "consolidating"
    session.plan.nodes = []
    app_state.sessions.save(session)
    assert app_state.sessions.get(session.id).phase == "probing"


# --------------------------------------------------------------------------- API serialization


async def test_pending_question_never_leaks_the_answer_key(runtime) -> None:
    state, sid, tools = runtime
    task = asyncio.create_task(tools["recall"]("Defina softmax.", "exp normalizado pela soma.", details="contexto"))
    await wait_until(lambda: state.sessions.get(sid).pending_quiz)
    data = _serialize_session(state.sessions.get(sid))
    pending = data["pending_quiz"]
    assert not {"correct_indices", "correct_index", "committed_answer", "explanation"} & set(pending)
    assert "exp normalizado" not in json.dumps(pending)
    assert (pending["kind"], pending["mode"], pending["has_confidence"], pending["has_dont_know"]) == ("explain", "PROBE", False, True)
    task.cancel()

    session = state.sessions.get(sid)
    session.pending_quiz = QuizPayload(quiz_id="q-check", session_id=sid, mode="CHECK", question="?",
                                       choices=[QuizOption(value="A", label="sim"), QuizOption(value="B", label="não")],
                                       correct_indices=[1], explanation="porque não")
    pending = _serialize_session(session)["pending_quiz"]
    assert pending["collapsed"] is True and "porque não" not in json.dumps(pending)
    assert not {"correct_indices", "correct_index", "committed_answer", "explanation"} & set(pending)


# --------------------------------------------------------------------------- end to end


async def test_full_cycle_probe_handoff_plan_predict_check_mastered(tmp_path: Path) -> None:
    """probe -> probe_done -> automatic handoff turn -> plan_init -> predict -> check -> mastered."""
    vault = configure_vault(tmp_path / "Vault")
    engine = FakeEngine()
    engine.script_turn(
        "Vamos ver de onde partir.\n",
        tool("probe", question="(1,0)·(0,1)?", options=["0", "1"], explanation="Ortogonais.", correct="0"),
        tool("probe_done", strands=STRANDS, summary="Construir a partir de vetores."),
        "Diagnóstico encerrado.",
    )
    engine.script_turn(  # The handoff turn, scheduled by the backend itself.
        tool("plan_init", mermaid=MERMAID, approach_prose="Do produto escalar à atenção."),
        "Plano: primeiro o produto escalar, depois a atenção.",
    )
    engine.script_turn(
        tool("quiz", **{**CHECK_DOT, "type": "predict"}),
        "Ensinando o produto escalar.",
        tool("quiz", **CHECK_DOT, details="Agora aplique."),
        tool("plan_advance", node_id="dot", status="mastered"),
    )
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    service = state.sessions
    try:
        session = await service.create(mode="TEACH", topic="Atenção")
        sid = session.id

        async def answer_next(**kwargs: Any) -> CalibrationResult:
            answered = set(service.get(sid).answers)
            pending = await wait_until(lambda: (q := service.get(sid).pending_quiz) and q.quiz_id not in answered and q)
            return await service.answer(QuizSubmission(quiz_id=pending.quiz_id, session_id=sid, **kwargs))

        probe = await answer_next(chosen_index=0, confidence=90)
        assert probe.mode == "PROBE" and probe.correct
        # probe_done -> planning; the run ends and the handoff turn starts on its own.
        await wait_until(lambda: len(engine.stream_calls) == 2 and not service.is_running(sid))
        assert build_handoff_prompt("pt-BR") in engine.stream_calls[1]["prompt"]
        session = service.get(sid)
        assert session.phase == "planning" and not session.handoff_pending
        assert [n.id for n in session.plan.nodes] == ["dot", "attn"]
        assert session.execution_status == "idle"

        # The learner accepts the plan; teaching begins with the first node-tagged question.
        session.messages.append(SessionMessage(id="msg-ok", role="user", content="Pode seguir.", created_at="t"))
        service.save(session)
        service.schedule(sid)
        predict = await answer_next(chosen_index=1, confidence=50, learner_thinking="chute")
        assert service.get(sid).phase == "teaching"
        assert predict.mode == "PREDICTION" and predict.correct is False
        check = await answer_next(chosen_index=0, confidence=85, reading_thinking="soma termo a termo")
        assert check.mode == "CHECK" and check.calibration_band == "calibrated_mastery"
        await wait_until(lambda: not service.is_running(sid))
        final = service.get(sid)
        assert final.plan.nodes[0].status == "mastered"
        assert engine.tool_results[-1][0] == "plan_advance"
        assert len(engine.stream_calls) == 3
        log = (vault / ".harness/quiz-log.jsonl").read_text(encoding="utf-8").splitlines()
        assert len(log) == 3
        data = _serialize_session(final)
        assert data["assessment"]["summary"] == "Construir a partir de vetores."
        assert [a["mode"] for a in data["answers"]] == ["PROBE", "PREDICTION", "CHECK"]
        assert {n["id"]: n["status"] for n in data["plan"]["nodes"]} == {"dot": "mastered", "attn": "pending"}
    finally:
        await state.close()


class PersistentEngine:
    tool_transport = "mcp"
    session_persistent = True

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        pass

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None):
        self.calls.append({"prompt": prompt, "system": system_instruction})
        yield "ok"


async def test_persistent_process_gets_teacher_instructions_after_probe_done(tmp_path: Path) -> None:
    engine = PersistentEngine()
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    service = state.sessions
    session = await service.create(topic="Atenção", start=False)
    assert await service.run(session.id) is False
    assert service.get(session.id).prompt_phase == "prober"
    assert "UPDATED INSTRUCTIONS" not in engine.calls[0]["prompt"]

    await service.probe_done(session.id, ProbeAssessment.model_validate({"strands": STRANDS}))
    # The handoff turn: the live process still holds prober rules, so the turn carries the teacher prompt.
    assert await service.run(session.id) is False
    handoff = engine.calls[1]["prompt"]
    assert handoff.startswith("UPDATED INSTRUCTIONS")
    assert build_handoff_prompt("pt-BR") in handoff
    current = service.get(session.id)
    assert current.prompt_phase == "teacher" and not current.handoff_pending
    await service.run(session.id)
    assert "UPDATED INSTRUCTIONS" not in engine.calls[2]["prompt"]
    await state.close()


async def test_question_text_double_escaped_latex_is_healed(runtime) -> None:
    state, sid, tools = runtime
    call = tools["probe"](r"Quanto vale $\\sqrt{4}$?", [r"$\\sqrt{4} = 2$", "3"], r"Pois $2 \\cdot 2 = 4$.", "A")
    result, _ = await _ask(state, sid, call, chosen_indices=[0], confidence=90)
    assert result.question == r"Quanto vale $\sqrt{4}$?"
    assert result.choices[0].label == r"$\sqrt{4} = 2$" and result.explanation == r"Pois $2 \cdot 2 = 4$."
