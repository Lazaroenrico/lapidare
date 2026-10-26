"""Unit tests for Google ecosystem engines, FastMCP server, PendingDock, and pedagogical prompts."""

import asyncio
from typing import Any

import pytest

from learnharness.core.contracts.config import (
    ConnectorStatus,
    EffortLevel,
    EngineKind,
    ModelSlotConfig,
)
from learnharness.core.contracts.quiz import QuizSubmission
from learnharness.engines import GeminiAcpEngine, GenAiSdkEngine, get_engine
from learnharness.engines.detector import detect_connectors
from learnharness.mcp.pending_dock import PendingDockRegistry
from learnharness.mcp.server import (
    get_active_plan,
    plan_advance,
    plan_init,
    pose_quiz,
)
from learnharness.prompts.loader import build_system_prompt


def test_detect_connectors() -> None:
    """Verifies scanner inspects agy, gemini-cli, and genai-sdk with supported model lists."""
    statuses = detect_connectors()
    assert isinstance(statuses, list)
    assert len(statuses) == 3

    kinds = {s.engine for s in statuses}
    assert kinds == {EngineKind.AGY, EngineKind.GEMINI_CLI, EngineKind.GENAI_SDK}

    for status in statuses:
        assert isinstance(status, ConnectorStatus)
        if status.available:
            assert len(status.models) > 0
            assert "gemini-4-argon-medium" in status.models


@pytest.mark.asyncio
async def test_pending_dock_registry_calibrated_mastery() -> None:
    """Verifies QuestionDock pause and resolution with calibrated mastery (Correct + High Conf)."""
    registry = PendingDockRegistry()
    session_id = "test-session-mastery"

    choices = [
        {"value": "a", "label": "Output dimension is independent of query dimension"},
        {"value": "b", "label": "Output dimension matches value dimension $d_v$"},
        {"value": "c", "label": "Output dimension matches key dimension $d_k$"},
    ]

    async def _run_agent_turn() -> dict[str, Any]:
        return await pose_quiz(
            session_id=session_id,
            mode="CHECK",
            topic="self-attention-output-dimension",
            question="What determines the final feature dimension of scaled dot-product attention?",
            choices=choices,
            correct_index=1,
            explanation=r"Attention multiplies attention weights $(N \times N)$ by Value matrix $(N \times d_v)$, yielding $(N \times d_v)$.",
            registry=registry,
        )

    task = asyncio.create_task(_run_agent_turn())
    await asyncio.sleep(0.01)

    # Agent must be suspended waiting for QuestionDock
    assert not task.done()
    pending = registry.get_pending_quiz(session_id)
    assert pending is not None
    assert pending.mode == "CHECK"

    # Learner submits correct answer with high confidence (85%)
    submission = QuizSubmission(
        quiz_id=pending.quiz_id,
        session_id=session_id,
        chosen_index=1,
        confidence=85,
        learner_thinking="Value matrix projected rows define the token representation space.",
    )
    result = registry.resolve_dock(session_id, submission)
    assert result.calibration_band == "calibrated_mastery"
    assert result.correct is True
    assert result.confidence == 85

    # Agent resumes and receives result payload
    agent_output = await task
    assert agent_output["calibration_band"] == "calibrated_mastery"
    assert agent_output["correct"] is True
    assert "advance to next node" in agent_output["pedagogical_directive"].lower()


@pytest.mark.asyncio
async def test_pending_dock_registry_illusion_of_competence() -> None:
    """Verifies high-priority alert when learner is wrong with high confidence."""
    registry = PendingDockRegistry()
    session_id = "test-session-illusion"

    choices = [
        {"value": "a", "label": r"Softmax temperature $\sqrt{d_k}$ speeds up training convergence"},
        {"value": "b", "label": r"Softmax temperature $\sqrt{d_k}$ prevents vanishing gradients"},
        {"value": "c", "label": r"Softmax temperature $\sqrt{d_k}$ normalizes sequence length $N$"},
    ]

    task = asyncio.create_task(
        pose_quiz(
            session_id=session_id,
            mode="PREDICTION",
            topic="attention-scaling-factor",
            question=r"Why divide the dot products $Q K^T$ by $\sqrt{d_k}$?",
            choices=choices,
            correct_index=1,
            explanation="Large dot products push softmax into regions with near-zero gradients.",
            registry=registry,
        )
    )
    await asyncio.sleep(0.01)

    pending = registry.get_pending_quiz(session_id)
    assert pending is not None

    # Learner picks option 0 with 90% confidence (Illusion of competence)
    submission = QuizSubmission(
        quiz_id=pending.quiz_id,
        session_id=session_id,
        chosen_index=0,
        confidence=90,
        learner_thinking="I remember dividing by root dimension made the loss drop faster.",
    )
    result = registry.resolve_dock(session_id, submission)
    assert result.calibration_band == "illusion_of_competence"
    assert result.correct is False
    assert "counterexample" in result.pedagogical_directive.lower()

    agent_output = await task
    assert agent_output["calibration_band"] == "illusion_of_competence"


@pytest.mark.asyncio
async def test_plan_init_and_advance() -> None:
    """Verifies PlanDag initialization and live node status progression."""
    session_id = "test-session-plan"
    approach = "Establish dot product as similarity measure before matrix formulation."
    nodes = [
        {
            "id": "node-truth",
            "label": "Inner product measures directional alignment",
            "kind": "unconditional_truth",
            "depends_on": [],
        },
        {
            "id": "node-attn",
            "label": "Softmax maps similarities to convex combination weights",
            "kind": "derived_step",
            "depends_on": ["node-truth"],
        },
        {
            "id": "node-goal",
            "label": "Self-attention layer equation",
            "kind": "goal",
            "depends_on": ["node-attn"],
        },
    ]

    res_init = await plan_init(session_id, approach, nodes)
    assert len(res_init["nodes"]) == 3
    assert res_init["approach_prose"] == approach

    # Advance node-truth to current then mastered
    res_adv1 = await plan_advance(session_id, "node-truth", "current")
    assert res_adv1["nodes"][0]["status"] == "current"

    res_adv2 = await plan_advance(session_id, "node-truth", "mastered")
    assert res_adv2["nodes"][0]["status"] == "mastered"

    # Verify global active plan query
    plan = get_active_plan(session_id)
    assert plan is not None
    assert plan.nodes[0].status == "mastered"


def test_build_system_prompt() -> None:
    """Verifies modular prompt assembly preserves pedagogical invariants."""
    # 1. TEACH mode - Free Topic
    prompt_free = build_system_prompt(
        mode="TEACH",
        context_kind="free_topic",
        language="pt-BR",
        phase="probing",
    )
    assert "Principle i" in prompt_free
    assert "Verdades Incondicionais" in prompt_free
    assert "Principle ii" in prompt_free
    assert "QuestionDock" in prompt_free
    assert "PREDICTION" in prompt_free
    assert "CHECK" in prompt_free

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
