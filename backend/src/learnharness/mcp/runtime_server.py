"""Authenticated MCP tools bound to an application and execution, never global state."""
from __future__ import annotations

from typing import Any, Literal
from uuid import uuid4

from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_request
from pydantic import AliasChoices, BaseModel, Field

from learnharness.core.contracts.quiz import QuizOption, QuizPayload
from learnharness.core.contracts.session import PlanDag, PlanNode
from learnharness.services.sessions import now


class QuizChoiceIn(BaseModel):
    """One answer option. ``label`` is the option text (KaTeX allowed)."""

    label: str = Field(validation_alias=AliasChoices("label", "text", "content"))
    value: str | None = None


def _normalize_choices(choices: list[QuizChoiceIn | str | dict[str, Any]]) -> list[QuizOption]:
    """Accept the shapes models actually send: objects ({label|text|content}) or bare strings.

    A real agy turn first sent options without ``label``; failing loudly there cost a turn.
    """
    options = []
    for i, choice in enumerate(choices):
        if isinstance(choice, str):
            choice = QuizChoiceIn(label=choice)
        elif isinstance(choice, dict):
            choice = QuizChoiceIn.model_validate(choice)
        options.append(QuizOption(value=choice.value or chr(65 + i), label=choice.label))
    return options


def session_tools(state, session_id):
    async def pose_quiz(mode: Literal["PREDICTION", "CHECK"], topic: str, question: str, choices: list[QuizChoiceIn | str], correct_index: int, explanation: str, node_id: str | None = None, details: str | None = None) -> dict[str, Any]:
        """Present a graded question and await the learner's answer, confidence and thinking."""
        quiz = QuizPayload(quiz_id=f"quiz-{uuid4().hex}", session_id=session_id, topic=topic, mode=mode, question=question, choices=_normalize_choices(choices), correct_index=correct_index, explanation=explanation, node_id=node_id, details=details, created_at=now())
        return await state.sessions.pose(session_id, quiz)

    async def plan_init(approach_prose: str, nodes: list[dict[str, Any]]) -> dict[str, Any]:
        """Initialize a dependency DAG after diagnosing learner prerequisites.

        Each node: {"id": str, "label": str (becomes the "## <label>" section of the lesson
        note), "kind": "unconditional_truth" | "derived_step" | "goal", "depends_on": [ids],
        "source_paragraphs": ["pN", ...] (dense sources only), "four_dimensions": {"said": str,
        "assumed": [str], "skipped": [str], "simplifications": [str], "paragraph_refs": ["pN"]}
        (dense sources only: Dito / Pressuposto / Pulado / Simplificações)}. Every ^pN cited
        must exist in the source or the plan is rejected.
        """
        return await state.sessions.set_plan(session_id, PlanDag(approach_prose=approach_prose, nodes=[PlanNode.model_validate(n) for n in nodes], updated_at=now()))

    async def plan_advance(node_id: str, status: Literal["current", "mastered", "needs_review"]) -> dict[str, Any]:
        """Advance a plan node; mastery requires persisted calibrated-check evidence."""
        return await state.sessions.advance(session_id, node_id, status)

    async def track_foundation(title: str, prerequisite: str) -> dict[str, Any]:
        """Insert a prerequisite lesson only when diagnostic evidence identifies a gap."""
        return await state.tracks.foundation(session_id, title, prerequisite)

    async def spawn_demo(title: str, topic: str, description: str = "") -> dict[str, Any]:
        """Queue a lesson-specific interactive simulator; returns immediately with the job id."""
        from learnharness.services.demos import submit_demo
        record = submit_demo(state, title, topic, description, session_id=session_id)
        return {"job_id": record["job_id"], "status": record["status"]}

    return [pose_quiz, plan_init, plan_advance, track_foundation, spawn_demo]


def create_runtime_mcp(state):
    server = FastMCP("learnharness")
    def bound():
        request = get_http_request()
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            raise PermissionError("Execution authentication required")
        return state.tool_functions(state.bound_session(authorization[7:]))

    @server.tool()
    async def pose_quiz(mode: Literal["PREDICTION", "CHECK"], topic: str, question: str, choices: list[QuizChoiceIn | str], correct_index: int, explanation: str, node_id: str | None = None, details: str | None = None) -> dict[str, Any]:
        """Pose a graded question; wait for confidence and learner thinking."""
        return await bound()[0](mode, topic, question, choices, correct_index, explanation, node_id, details)

    @server.tool()
    async def plan_init(approach_prose: str, nodes: list[dict[str, Any]]) -> dict[str, Any]:
        """Initialize the diagnosed learning plan (a DAG).

        Each node: {"id": str, "label": str (becomes the "## <label>" section of the lesson
        note), "kind": "unconditional_truth" | "derived_step" | "goal", "depends_on": [ids],
        "source_paragraphs": ["pN", ...] (dense sources only), "four_dimensions": {"said": str,
        "assumed": [str], "skipped": [str], "simplifications": [str], "paragraph_refs": ["pN"]}
        (dense sources only: Dito / Pressuposto / Pulado / Simplificações)}. Every ^pN cited
        must exist in the source or the plan is rejected.
        """
        return await bound()[1](approach_prose, nodes)

    @server.tool()
    async def plan_advance(node_id: str, status: Literal["current", "mastered", "needs_review"]) -> dict[str, Any]:
        """Advance a node only when its prerequisites and evidence permit it."""
        return await bound()[2](node_id, status)

    @server.tool()
    async def track_foundation(title: str, prerequisite: str) -> dict[str, Any]:
        """Insert a diagnosed prerequisite into the active track."""
        return await bound()[3](title, prerequisite)

    @server.tool()
    async def spawn_demo(title: str, topic: str, description: str = "") -> dict[str, Any]:
        """Queue a lesson-specific simulator in the background (non-blocking); it is linked into the lesson note when ready."""
        return await bound()[4](title, topic, description)

    return server
