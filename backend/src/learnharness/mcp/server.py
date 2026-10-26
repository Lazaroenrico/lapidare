"""FastMCP server and pedagogical tool implementations for LearnHarness.

Exposes:
1. pose_quiz: pauses agent turn via QuestionDock until answered by learner.
2. plan_init: constructs and broadcasts pedagogical PlanDag (PlanWindow).
3. plan_advance: advances PlanNode state as the learner masters concepts.
"""

import logging
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

try:
    from fastmcp import FastMCP
except ImportError:
    # Resilient fallback if dependencies have not yet been synced by Reviewer
    class FastMCP:  # type: ignore[no-redef]
        def __init__(self, name: str) -> None:
            self.name = name

        def tool(self, *args: Any, **kwargs: Any) -> Any:
            def decorator(fn: Any) -> Any:
                return fn
            return decorator

from learnharness.core.calibration import validate_quiz_options_evenness
from learnharness.core.contracts.quiz import (
    QuizOption,
    QuizPayload,
)
from learnharness.core.contracts.session import (
    DenseBlockDimensions,
    PlanDag,
    PlanNode,
)
from learnharness.mcp.pending_dock import PendingDockRegistry, default_dock_registry

logger = logging.getLogger(__name__)

# FastMCP instance
mcp_server = FastMCP("learnharness-pedagogy")

# Active in-memory session plans (session_id -> PlanDag)
_active_plans: dict[str, PlanDag] = {}

# Callback registries for orchestrator and SSE broadcast
_dock_opened_callbacks: list[Callable[[QuizPayload], Coroutine[Any, Any, None] | None]] = []
_plan_updated_callbacks: list[
    Callable[[str, PlanDag], Coroutine[Any, Any, None] | None]
] = []


def register_dock_opened_callback(
    cb: Callable[[QuizPayload], Coroutine[Any, Any, None] | None],
) -> None:
    """Register callback invoked whenever QuestionDock opens."""
    _dock_opened_callbacks.append(cb)


def register_plan_updated_callback(
    cb: Callable[[str, PlanDag], Coroutine[Any, Any, None] | None],
) -> None:
    """Register callback invoked whenever PlanDag is initialized or advanced."""
    _plan_updated_callbacks.append(cb)


def get_active_plan(session_id: str) -> PlanDag | None:
    """Retrieve current PlanDag for an active session."""
    return _active_plans.get(session_id)


async def _notify_dock_opened(payload: QuizPayload) -> None:
    for cb in _dock_opened_callbacks:
        try:
            res = cb(payload)
            if asyncio_iscoroutine(res):
                await res
        except Exception as err:
            logger.warning("Error in dock_opened callback: %s", err)


async def _notify_plan_updated(session_id: str, plan: PlanDag) -> None:
    for cb in _plan_updated_callbacks:
        try:
            res = cb(session_id, plan)
            if asyncio_iscoroutine(res):
                await res
        except Exception as err:
            logger.warning("Error in plan_updated callback: %s", err)


def asyncio_iscoroutine(obj: Any) -> bool:
    import inspect
    return inspect.iscoroutine(obj)


async def pose_quiz(
    session_id: str,
    mode: Literal["PREDICTION", "CHECK"],
    topic: str,
    question: str,
    choices: list[dict[str, str]],
    correct_index: int,
    explanation: str,
    node_id: str | None = None,
    details: str | None = None,
    registry: PendingDockRegistry | None = None,
) -> dict[str, Any]:
    """Pose a prediction or check question via QuestionDock and await user answer.

    Blocks until learner submits answer, confidence (0-100%), and reasoning.
    Returns CalibrationResult dictionary with calibration_band and pedagogical_directive.
    """
    dock_registry = registry or default_dock_registry

    # Convert choice dicts to QuizOption models
    quiz_options = [
        QuizOption(
            value=c.get("value") or chr(ord("a") + idx),
            label=c.get("label", ""),
        )
        for idx, c in enumerate(choices)
    ]

    # Validate option evenness and log warnings if asymmetric
    issues = validate_quiz_options_evenness(quiz_options, correct_index)
    if issues:
        logger.warning(
            "Quiz option evenness warnings for topic '%s': %s",
            topic,
            "; ".join(issues),
        )

    quiz_payload = QuizPayload(
        quiz_id=f"quiz-{uuid4().hex[:8]}",
        session_id=session_id,
        node_id=node_id,
        topic=topic,
        mode=mode,
        question=question,
        details=details,
        choices=quiz_options,
        correct_index=correct_index,
        explanation=explanation,
        created_at=datetime.now(UTC).isoformat(),
    )

    # Broadcast event to UI
    await _notify_dock_opened(quiz_payload)

    # Pause turn until learner answers
    future = dock_registry.open_dock(session_id, quiz_payload)
    calibration_result = await future

    return calibration_result.model_dump()


@mcp_server.tool(name="pose_quiz")
async def _mcp_pose_quiz(
    session_id: str,
    mode: Literal["PREDICTION", "CHECK"],
    topic: str,
    question: str,
    choices: list[dict[str, str]],
    correct_index: int,
    explanation: str,
    node_id: str | None = None,
    details: str | None = None,
) -> dict[str, Any]:
    """Pose a prediction or check question via QuestionDock and await user answer."""
    return await pose_quiz(
        session_id=session_id,
        mode=mode,
        topic=topic,
        question=question,
        choices=choices,
        correct_index=correct_index,
        explanation=explanation,
        node_id=node_id,
        details=details,
    )


@mcp_server.tool()
async def plan_init(
    session_id: str,
    approach_prose: str,
    nodes: list[dict[str, Any]],
) -> dict[str, Any]:
    """Initialize pedagogical dependency DAG for a lesson session."""
    plan_nodes: list[PlanNode] = []
    for raw in nodes:
        dim_data = raw.get("four_dimensions")
        dims = DenseBlockDimensions(**dim_data) if dim_data else None

        plan_nodes.append(
            PlanNode(
                id=raw["id"],
                label=raw["label"],
                kind=raw.get("kind", "derived_step"),
                depends_on=raw.get("depends_on", []),
                status=raw.get("status", "pending"),
                source_paragraphs=raw.get("source_paragraphs", []),
                four_dimensions=dims,
            )
        )

    plan_dag = PlanDag(
        approach_prose=approach_prose,
        nodes=plan_nodes,
        updated_at=datetime.now(UTC).isoformat(),
    )

    _active_plans[session_id] = plan_dag
    await _notify_plan_updated(session_id, plan_dag)
    logger.info("Initialized PlanDag for session %s with %d nodes", session_id, len(plan_nodes))
    return plan_dag.model_dump()


@mcp_server.tool()
async def plan_advance(
    session_id: str,
    node_id: str,
    status: Literal["current", "mastered", "needs_review"],
) -> dict[str, Any]:
    """Update status of a specific node in the active lesson PlanDag."""
    plan = _active_plans.get(session_id)
    if not plan:
        raise KeyError(f"No active plan found for session {session_id}")

    target_node = None
    for node in plan.nodes:
        if node.id == node_id:
            node.status = status
            target_node = node
            break

    if not target_node:
        raise KeyError(f"Node id {node_id} not found in plan for session {session_id}")

    plan.updated_at = datetime.now(UTC).isoformat()
    await _notify_plan_updated(session_id, plan)
    logger.info("Advanced node %s in session %s to %s", node_id, session_id, status)
    return plan.model_dump()
