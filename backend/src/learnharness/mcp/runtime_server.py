"""Authenticated MCP tools bound to an application and execution, never global state.

``session_tools`` builds the tool callables for one session (in-process engines receive
them directly); ``create_runtime_mcp`` exposes the same callables, by name, on the
FastMCP server that CLI engines reach with a per-execution Bearer token.

Inputs are tolerant (models send options as strings or objects, lists JSON-encoded as
strings, ``correct`` as value or label); refusals raise with corrective text so the
model can fix the call and retry within the same turn.
"""
from __future__ import annotations

import functools
from collections.abc import Awaitable, Callable
from typing import Any

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_request

from learnharness.core.leveling import MAX_LEVELING_QUESTIONS
from learnharness.core.plan_mermaid import PlanSyntaxError
from learnharness.mcp.tools.inputs import QuizChoiceIn, _normalize_choices  # noqa: F401 (re-export)
from learnharness.services.sessions import SessionConflict

TEACH_ONLY = frozenset({"probe", "recall", "quiz", "explain", "probe_done", "plan_init", "grade_recall",
                        "plan_advance", "track_foundation", "spawn_demo", "visual", "leveling_done"})
# Fase 15: a leveling session only diagnoses (probe/recall) and closes with leveling_done.
NOT_IN_LEVELING = frozenset({"plan_init", "quiz", "explain", "probe_done", "plan_advance"})
PRACTICE_ONLY = frozenset({"problem", "conclude"})

# Background-job tools: toggle in config.agent.tools -> refusal when it is off.
_TOOL_OFF = {
    "research": "a pesquisa está desativada nas Configurações; siga sem ela.",
    "pdf": "a leitura de PDF está desativada nas Configurações; siga sem ela.",
    "visual": "os visuais estão desativados nas Configurações; siga sem eles, em prosa.",
    "demo": "as demos interativas estão desativadas nas Configurações; siga sem elas.",
}


def _require_tool(state, toggle: str) -> None:
    if not getattr(state.get_config().agent.tools, toggle):
        raise ToolError(_TOOL_OFF[toggle])




def _dispatched(record: dict[str, Any]) -> dict[str, Any]:
    from learnharness.services.jobs import DISPATCH_NOTE
    return {"ok": True, "job_id": record["job_id"], "status": record["status"], "note": DISPATCH_NOTE}


def _mode_guard(state, session_id, fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    """Refuse TEACH tools in PRACTICE sessions (and vice versa), and teaching tools in a track
    leveling session (Fase 15), with corrective text."""
    name = fn.__name__
    if name not in TEACH_ONLY and name not in PRACTICE_ONLY:
        return fn

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        session = state.sessions.get(session_id)
        mode = session.mode
        if mode == "PRACTICE" and name in TEACH_ONLY:
            raise ToolError(
                f"{name} is a TEACH tool and this is a PRACTICE session. Use problem to pose one problem, "
                "conclude to close it, graph_search to look up propositions and ask_user_question for "
                "anything ungraded; hints go in prose."
            )
        if mode != "PRACTICE" and name in PRACTICE_ONLY:
            raise ToolError(f"{name} is a PRACTICE tool and this is a TEACH session; teach with quiz/explain.")
        leveling = session.context_kind == "leveling"
        if leveling and name in NOT_IN_LEVELING:
            raise ToolError(
                f"{name} is not available while leveling a track: nothing is taught here. Ask probe/recall "
                "questions about items of the pending queue and close with leveling_done(known_item_ids, "
                "start_item_id, summary)."
            )
        if leveling and name in ("probe", "recall") and not session.pending_quiz and sum(
                1 for a in session.answers.values() if a.kind in ("quiz", "explain")) >= MAX_LEVELING_QUESTIONS:
            raise ToolError(f"The leveling budget of {MAX_LEVELING_QUESTIONS} questions is spent; call "
                            "leveling_done now with what the answers established.")
        if name == "leveling_done" and not leveling:
            raise ToolError("leveling_done only exists in a track leveling session.")
        return await fn(*args, **kwargs)

    return wrapper


def _refusals(fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    """Turn state conflicts and plan errors into tool errors the model can act on."""

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return await fn(*args, **kwargs)
        except (SessionConflict, PlanSyntaxError) as exc:
            raise ToolError(str(exc)) from exc

    return wrapper


# The order the catalog is published in (tests/golden/tool_catalog.json).
TOOL_ORDER = ("probe", "recall", "quiz", "explain", "ask_user_question", "probe_done", "plan_init",
              "grade_recall", "plan_advance", "track_foundation", "spawn_demo", "problem", "conclude",
              "graph_search", "research", "read_pdf", "visual", "leveling_done")


def session_tools(state, session_id) -> list[Callable[..., Awaitable[Any]]]:
    """Every harness tool bound to ``session_id``, wrapped in the mode guard and refusals."""
    from learnharness.mcp.tools import jobs, lesson, practice, questions

    built = {t.__name__: t for family in (questions, lesson, practice, jobs) for t in family.build(state, session_id)}
    return [_refusals(_mode_guard(state, session_id, built[name])) for name in TOOL_ORDER]


HARNESS_TOOL_NAMES = frozenset(t.__name__ for t in session_tools(None, None))


def _mcp_tool(name: str, prototype: Callable[..., Awaitable[Any]], bound: Callable[[], dict[str, Any]]):
    """A server-level tool with ``prototype``'s schema that dispatches to the bound session by name."""

    async def call(**kwargs: Any) -> Any:
        return await bound()[name](**kwargs)

    return functools.update_wrapper(call, prototype)


def create_runtime_mcp(state):
    server = FastMCP("learnharness")

    def bound() -> dict[str, Callable[..., Awaitable[Any]]]:
        request = get_http_request()
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            raise PermissionError("Execution authentication required")
        return {t.__name__: t for t in state.tool_functions(state.bound_session(authorization[7:]))}

    for prototype in session_tools(state, None):
        server.tool(_mcp_tool(prototype.__name__, prototype, bound))
    return server
