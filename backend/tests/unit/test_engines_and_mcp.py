"""Unit tests for Google ecosystem engines, runtime MCP session tools and pedagogical prompts."""

import asyncio
from pathlib import Path
from typing import Any

import pytest

from learnharness.api.state import AppState
from learnharness.core.contracts.config import (
    ConnectorStatus,
    EffortLevel,
    EngineKind,
    ModelSlotConfig,
)
from learnharness.core.contracts.quiz import CalibrationResult, QuizSubmission
from learnharness.engines import GeminiAcpEngine, GenAiSdkEngine, get_engine
from learnharness.engines.detector import detect_connectors
from learnharness.mcp.runtime_server import session_tools
from learnharness.prompts.loader import build_system_prompt
from learnharness.services.sessions import SessionConflict
from learnharness.vault.jsonl_store import append_session_event
from tests.conftest import FakeEngine, wait_until


def test_detect_connectors() -> None:
    """Discovery inspects agy, gemini-cli and genai-sdk without probing auth or listing models."""
    statuses = detect_connectors()
    assert isinstance(statuses, list)
    assert len(statuses) == 3

    kinds = {s.engine for s in statuses}
    assert kinds == {EngineKind.AGY, EngineKind.GEMINI_CLI, EngineKind.GENAI_SDK}

    for status in statuses:
        assert isinstance(status, ConnectorStatus)
        assert isinstance(status.available, bool)
        # Discovery never spends quota: auth is unverified and models are user-supplied.
        assert status.authenticated is False
        assert status.models == []
        assert status.detail
        if status.engine != EngineKind.GENAI_SDK:
            assert bool(status.binary_path) == status.available
            assert ("installed" in status.detail) == status.available


@pytest.fixture
async def runtime(app_state: AppState, fake_engine: FakeEngine):
    """A real AppState on a configured tmp Vault with one idle TEACH session."""
    session = await app_state.sessions.create(mode="TEACH", topic="Self-Attention", start=False)
    try:
        yield app_state, session.id, {t.__name__: t for t in session_tools(app_state, session.id)}
    finally:
        await app_state.close()


async def _pose_and_answer(state: AppState, session_id: str, tools: dict[str, Any], quiz: dict[str, Any],
                           *, chosen_index: int, confidence: int, thinking: str) -> tuple[Any, dict[str, Any]]:
    task = asyncio.create_task(tools["pose_quiz"](**quiz))
    pending = await wait_until(lambda: state.sessions.get(session_id).pending_quiz)
    # The agent turn stays suspended until the learner answers.
    assert not task.done()
    assert pending.mode == quiz["mode"]
    result = await state.sessions.answer(QuizSubmission(
        quiz_id=pending.quiz_id, session_id=session_id, chosen_index=chosen_index,
        confidence=confidence, learner_thinking=thinking,
    ))
    agent_output = await asyncio.wait_for(task, 3)
    return result, agent_output


async def test_pose_quiz_blocks_until_calibrated_mastery(runtime) -> None:
    """pose_quiz suspends the agent until the answer; correct + high confidence is calibrated mastery."""
    state, session_id, tools = runtime
    quiz = {
        "mode": "CHECK",
        "topic": "self-attention-output-dimension",
        "question": "What determines the final feature dimension of scaled dot-product attention?",
        "choices": [
            {"value": "a", "label": "Output dimension is independent of query dimension"},
            {"value": "b", "label": "Output dimension matches value dimension $d_v$"},
            {"value": "c", "label": "Output dimension matches key dimension $d_k$"},
        ],
        "correct_index": 1,
        "explanation": r"Attention multiplies weights $(N \times N)$ by values $(N \times d_v)$.",
    }
    result, agent_output = await _pose_and_answer(
        state, session_id, tools, quiz, chosen_index=1, confidence=85,
        thinking="Value matrix projected rows define the token representation space.",
    )
    assert result.calibration_band == "calibrated_mastery"
    assert result.correct is True
    assert result.confidence == 85

    assert agent_output["calibration_band"] == "calibrated_mastery"
    assert agent_output["correct"] is True
    assert "advance to next node" in agent_output["pedagogical_directive"].lower()

    session = state.sessions.get(session_id)
    assert session.pending_quiz is None
    assert result.quiz_id in session.answers
    log = (Path(state.vault_path) / ".harness/quiz-log.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(log) == 1


async def test_pose_quiz_illusion_of_competence(runtime) -> None:
    """Wrong answer with high confidence is flagged as illusion of competence."""
    state, session_id, tools = runtime
    quiz = {
        "mode": "PREDICTION",
        "topic": "attention-scaling-factor",
        "question": r"Why divide the dot products $Q K^T$ by $\sqrt{d_k}$?",
        "choices": [
            {"value": "a", "label": r"Softmax temperature $\sqrt{d_k}$ speeds up training convergence"},
            {"value": "b", "label": r"Softmax temperature $\sqrt{d_k}$ prevents vanishing gradients"},
            {"value": "c", "label": r"Softmax temperature $\sqrt{d_k}$ normalizes sequence length $N$"},
        ],
        "correct_index": 1,
        "explanation": "Large dot products push softmax into regions with near-zero gradients.",
    }
    result, agent_output = await _pose_and_answer(
        state, session_id, tools, quiz, chosen_index=0, confidence=90,
        thinking="I remember dividing by root dimension made the loss drop faster.",
    )
    assert result.calibration_band == "illusion_of_competence"
    assert result.correct is False
    assert "counterexample" in result.pedagogical_directive.lower()
    assert agent_output["calibration_band"] == "illusion_of_competence"


INNER_PRODUCT_CHECK = {
    "topic": "inner-product", "question": "What does a large positive inner product indicate?",
    "choices": [{"label": "Orthogonal vectors"}, {"label": "Aligned directions"}],
    "correct_index": 1, "explanation": "cos(theta) near 1.", "node_id": "node-truth",
}

PLAN_NODES = [
    {"id": "node-truth", "label": "Inner product measures directional alignment",
     "kind": "unconditional_truth", "depends_on": []},
    {"id": "node-attn", "label": "Softmax maps similarities to convex combination weights",
     "kind": "derived_step", "depends_on": ["node-truth"]},
    {"id": "node-goal", "label": "Self-attention layer equation", "kind": "goal",
     "depends_on": ["node-attn"]},
]


async def test_prediction_answer_is_not_mastery_evidence(runtime) -> None:
    """A calibrated PREDICTION (asked before teaching) never proves mastery; only a CHECK does."""
    state, session_id, tools = runtime
    await tools["plan_init"]("Approach", PLAN_NODES)
    result, _ = await _pose_and_answer(state, session_id, tools, {"mode": "PREDICTION", **INNER_PRODUCT_CHECK},
                                       chosen_index=1, confidence=90, thinking="Cosine similarity.")
    assert result.mode == "PREDICTION"
    assert result.calibration_band == "calibrated_mastery"
    with pytest.raises(SessionConflict, match="calibrated check"):
        await tools["plan_advance"]("node-truth", "mastered")


async def _strip_answer_modes(state: AppState, session_id: str) -> None:
    """Simulate a legacy session: append a snapshot whose answers predate the `mode` field."""
    session = state.sessions.get(session_id)
    data = session.model_dump(mode="json")
    for answer in data["answers"].values():
        answer.pop("mode")
    append_session_event(state.vault_path, session_id, data)
    assert all(a.mode is None for a in state.sessions.get(session_id).answers.values())


async def test_legacy_answer_mode_is_recovered_from_session_history(runtime) -> None:
    """Legacy answers without `mode` recover it from the posed quiz persisted in the session history."""
    state, session_id, tools = runtime
    await tools["plan_init"]("Approach", PLAN_NODES)
    await _pose_and_answer(state, session_id, tools, {"mode": "PREDICTION", **INNER_PRODUCT_CHECK},
                           chosen_index=1, confidence=90, thinking="Cosine similarity.")
    await _strip_answer_modes(state, session_id)
    with pytest.raises(SessionConflict, match="calibrated check"):
        await tools["plan_advance"]("node-truth", "mastered")

    await _pose_and_answer(state, session_id, tools,
                           {"mode": "CHECK", **INNER_PRODUCT_CHECK, "question": "Check: " + INNER_PRODUCT_CHECK["question"]},
                           chosen_index=1, confidence=90, thinking="Aligned vectors.")
    await _strip_answer_modes(state, session_id)
    res = await tools["plan_advance"]("node-truth", "mastered")
    assert res["nodes"][0]["status"] == "mastered"
    modes = sorted(a.mode for a in state.sessions.get(session_id).answers.values())
    assert modes == ["CHECK", "PREDICTION"]  # Recovered modes are persisted by the next save.


async def test_unrecoverable_legacy_answer_is_not_mastery_evidence(runtime) -> None:
    """A legacy answer whose quiz is absent from history keeps mode=None and is rejected."""
    state, session_id, tools = runtime
    await tools["plan_init"]("Approach", PLAN_NODES)
    session = state.sessions.get(session_id)
    session.answers["ghost"] = CalibrationResult(
        quiz_id="ghost", session_id=session_id, topic="inner-product", node_id="node-truth",
        correct=True, is_dont_know=False, chosen_index=1, correct_index=1, confidence=90,
        confidence_band="high", calibration_band="calibrated_mastery", learner_thinking="",
        pedagogical_directive="", explanation="",
    )
    state.sessions.save(session)
    with pytest.raises(SessionConflict, match="calibrated check"):
        await tools["plan_advance"]("node-truth", "mastered")


async def test_plan_init_and_advance_requires_calibrated_check(runtime) -> None:
    """Plan DAG initializes once; mastery requires prerequisites and a calibrated CHECK with node_id."""
    state, session_id, tools = runtime
    approach = "Establish dot product as similarity measure before matrix formulation."
    nodes = PLAN_NODES

    res_init = await tools["plan_init"](approach, nodes)
    assert len(res_init["nodes"]) == 3
    assert res_init["approach_prose"] == approach
    # An initialized plan cannot be silently replaced.
    with pytest.raises(SessionConflict):
        await tools["plan_init"]("Another approach", nodes[:1])

    res_adv1 = await tools["plan_advance"]("node-truth", "current")
    assert res_adv1["nodes"][0]["status"] == "current"

    # Prerequisites gate progression.
    with pytest.raises(SessionConflict, match="Prerequisites"):
        await tools["plan_advance"]("node-attn", "current")

    # Without a calibrated CHECK answer bound to this node, mastery is refused.
    with pytest.raises(SessionConflict, match="calibrated check"):
        await tools["plan_advance"]("node-truth", "mastered")

    # A calibrated answer to a CHECK bound to a different node is not evidence for this one.
    await _pose_and_answer(state, session_id, tools, {"mode": "CHECK", **INNER_PRODUCT_CHECK, "node_id": "node-goal"},
                           chosen_index=1, confidence=90, thinking="Cosine similarity.")
    with pytest.raises(SessionConflict, match="calibrated check"):
        await tools["plan_advance"]("node-truth", "mastered")

    result, _ = await _pose_and_answer(
        state, session_id, tools,
        {"mode": "CHECK", **INNER_PRODUCT_CHECK, "question": "Check: " + INNER_PRODUCT_CHECK["question"]},
        chosen_index=1, confidence=90, thinking="Aligned vectors.")
    assert result.calibration_band == "calibrated_mastery"

    res_adv2 = await tools["plan_advance"]("node-truth", "mastered")
    assert res_adv2["nodes"][0]["status"] == "mastered"
    assert state.sessions.get(session_id).plan.nodes[0].status == "mastered"
    # Mastery enqueues the extraction job for the node.
    assert any(job["kind"] == "extraction" for job in state.active_jobs.values())


def test_build_system_prompt() -> None:
    """Verifies modular prompt assembly preserves pedagogical invariants."""
    # 1. TEACH mode - Free Topic
    prompt_free = build_system_prompt(
        mode="TEACH",
        context_kind="free_topic",
        language="pt-BR",
        phase="probing",
    )
    assert "probe_done" in prompt_free
    assert "floor" in prompt_free and "ceiling" in prompt_free
    assert "one question per turn" in prompt_free.lower()

    # 2. TEACH mode - Dense Source Ingestion
    prompt_dense = build_system_prompt(
        mode="TEACH",
        context_kind="dense_source",
        language="pt-BR",
        phase="teaching",
    )
    assert "Dito" in prompt_dense or "said" in prompt_dense
    assert "Pressuposto" in prompt_dense
    assert "Pulado" in prompt_dense
    assert "Simplificações" in prompt_dense
    assert "[[Fonte#^pN]]" in prompt_dense

    # 3. TEACH mode - Track step
    prompt_track = build_system_prompt(
        mode="TEACH",
        context_kind="track_step",
        language="pt-BR",
        phase="teaching",
    )
    assert "2:1" in prompt_track

    # 4. PRACTICE mode
    prompt_practice = build_system_prompt(
        mode="PRACTICE",
        context_kind="free_topic",
        language="pt-BR",
        phase="teaching",
    )
    assert "R0" in prompt_practice
    assert "R5" in prompt_practice
    assert "Commit-Before-Pose" in prompt_practice
    assert "Ilusão de Competência" in prompt_practice


def test_engine_factory() -> None:
    """Verifies factory instantiation of engine connectors."""
    gemini_slot = ModelSlotConfig(
        engine=EngineKind.GEMINI_CLI,
        model_id="gemini-4-argon-medium",
        effort=EffortLevel.MEDIUM,
    )
    gemini_eng = get_engine(gemini_slot)
    assert isinstance(gemini_eng, GeminiAcpEngine)

    sdk_slot = ModelSlotConfig(
        engine=EngineKind.GENAI_SDK,
        model_id="gemini-3.8-flash-medium",
        effort=EffortLevel.LOW,
    )
    sdk_eng = get_engine(sdk_slot)
    assert isinstance(sdk_eng, GenAiSdkEngine)


def test_pose_quiz_accepts_the_choice_shapes_models_send():
    from learnharness.mcp.runtime_server import QuizChoiceIn, _normalize_choices

    options = _normalize_choices(["Um escalar", {"text": "Um vetor"}, {"label": "Uma matriz", "value": "z"},
                                  QuizChoiceIn(label="Nada")])
    assert [(o.value, o.label) for o in options] == [("A", "Um escalar"), ("B", "Um vetor"), ("z", "Uma matriz"), ("D", "Nada")]
