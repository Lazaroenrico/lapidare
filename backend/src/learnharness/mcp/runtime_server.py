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
import json
from collections.abc import Awaitable, Callable
from typing import Any, Literal
from uuid import uuid4

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_request
from pydantic import AliasChoices, BaseModel, Field, ValidationError

from learnharness.core.contracts.practice import (
    AGENT_OUTCOMES,
    AgentOutcome,
    HintRung,
    MissClass,
    PracticeMode,
)
from learnharness.core.contracts.quiz import QuizMode, QuizOption, QuizPayload
from learnharness.core.contracts.session import ProbeAssessment, ProbeStrand
from learnharness.core.latex_heal import heal_latex
from learnharness.core.plan_mermaid import PlanSyntaxError
from learnharness.services.sessions import SessionConflict, now

QuestionType = Literal["predict", "check"]
_TYPE_MODE: dict[str, QuizMode] = {"predict": "PREDICTION", "check": "CHECK"}


class QuizChoiceIn(BaseModel):
    """One answer option. ``label`` is the option text (KaTeX allowed)."""

    label: str = Field(validation_alias=AliasChoices("label", "text", "content"))
    value: str | None = None
    description: str | None = None


class StrandIn(BaseModel):
    """One dependency strand of the goal and where the learner's edge sits on it."""

    strand: str = Field(validation_alias=AliasChoices("strand", "name", "title"))
    assessment: str = Field(validation_alias=AliasChoices("assessment", "summary", "notes"))


class NodeDetailIn(BaseModel):
    """Dense-source extras for one plan node."""

    source_paragraphs: list[str] = Field(default_factory=list)
    four_dimensions: dict[str, Any] | None = None


OptionsIn = list[QuizChoiceIn | str] | str
CorrectIn = str | list[str]


def _heal_json(value: Any) -> Any:
    """Decode a JSON-encoded list/object that a model sent as a string."""
    if isinstance(value, str) and value.strip()[:1] in ("[", "{"):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _normalize_choices(choices: Any) -> list[QuizOption]:
    """Accept the shapes models actually send: objects ({label|text|content}) or bare strings.

    A real agy turn first sent options without ``label``; failing loudly there cost a turn.
    """
    choices = _heal_json(choices)
    if isinstance(choices, str) or not isinstance(choices, list):
        raise ToolError('options must be a list, e.g. ["first option", "second option"] or [{"label": "..."}].')
    options = []
    for i, choice in enumerate(choices):
        if isinstance(choice, str):
            choice = QuizChoiceIn(label=choice)
        elif isinstance(choice, dict):
            choice = QuizChoiceIn.model_validate(choice)
        options.append(QuizOption(value=choice.value or chr(65 + i), label=choice.label, description=choice.description))
    return options


def _correct_indices(correct: Any, options: list[QuizOption], multi_select: bool) -> list[int]:
    """Resolve ``correct`` (value or label, one or many) into option indices."""
    correct = _heal_json(correct)
    wanted = correct if isinstance(correct, list) else [correct]
    indices: list[int] = []
    for item in wanted:
        if not isinstance(item, str):
            raise ToolError("correct must be the value (A, B, ...) or the exact label of an option, not an index.")
        key = item.strip().casefold()
        match = next((i for i, o in enumerate(options) if o.value.strip().casefold() == key), None)
        if match is None:
            match = next((i for i, o in enumerate(options) if o.label.strip().casefold() == key), None)
        if match is None:
            valid = ", ".join(f"{o.value}={o.label!r}" for o in options)
            raise ToolError(f"correct {item!r} matches no option; use a value or label from: {valid}.")
        if match not in indices:
            indices.append(match)
    if not indices:
        raise ToolError("correct must name at least one option.")
    if len(indices) > 1 and not multi_select:
        raise ToolError("More than one correct option requires multi_select=true.")
    return indices


def _payload(session_id: str, **fields: Any) -> QuizPayload:
    for key in ("question", "explanation", "details", "committed_answer"):
        if isinstance(fields.get(key), str):
            fields[key] = heal_latex(fields[key])
    for choice in fields.get("choices") or []:
        choice.label = heal_latex(choice.label)
        if choice.description:
            choice.description = heal_latex(choice.description)
    try:
        return QuizPayload(quiz_id=f"quiz-{uuid4().hex}", session_id=session_id, created_at=now(), **fields)
    except ValidationError as exc:
        raise ToolError("; ".join(e["msg"] for e in exc.errors())) from exc


def _graded_options(options: Any, correct: Any, multi_select: bool) -> dict[str, Any]:
    choices = _normalize_choices(options)
    if not 2 <= len(choices) <= 6:
        raise ToolError('A graded question needs 2 to 6 options; the UI adds "Don\'t know" itself.')
    return {"choices": choices, "multi_select": multi_select, "correct_indices": _correct_indices(correct, choices, multi_select)}


def _optional_choice(value: Any) -> str | None:
    """``None`` for the null spellings models send ("", "none", "null")."""
    if value is None:
        return None
    text = str(value).strip()
    return None if text.casefold() in ("", "none", "null", "n/a") else text


def _rung(value: Any) -> str | None:
    text = _optional_choice(value)
    if text is None:
        return None
    text = text.upper()
    return f"R{text}" if text.isdigit() else text


def _outcome(value: Any) -> str:
    key = str(value).strip().replace("_", "").replace(" ", "").casefold()
    return next((o for o in AGENT_OUTCOMES if o.casefold() == key), str(value))


def _flag(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().casefold() in ("true", "1", "yes", "sim")
    return bool(value)


def _targets(value: Any) -> list[str]:
    value = _heal_json(value)
    if value in (None, ""):
        return []
    if isinstance(value, str):
        return [value]
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ToolError('target must be a list of graph node ids or names, e.g. ["n_0123456789ab"].')
    return value


# Which session mode each mode-specific tool belongs to (the rest work in both).
TEACH_ONLY = frozenset({"probe", "recall", "quiz", "explain", "probe_done", "plan_init", "grade_recall",
                        "plan_advance", "track_foundation", "spawn_demo", "visual"})
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


def _required_text(value: Any, name: str, what: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ToolError(f"{name} is empty; pass {what}.")
    return text


def _dispatched(record: dict[str, Any]) -> dict[str, Any]:
    from learnharness.services.jobs import DISPATCH_NOTE
    return {"ok": True, "job_id": record["job_id"], "status": record["status"], "note": DISPATCH_NOTE}


def _mode_guard(state, session_id, fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    """Refuse TEACH tools in PRACTICE sessions (and vice versa) with corrective text."""
    name = fn.__name__
    if name not in TEACH_ONLY and name not in PRACTICE_ONLY:
        return fn

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        mode = state.sessions.get(session_id).mode
        if mode == "PRACTICE" and name in TEACH_ONLY:
            raise ToolError(
                f"{name} is a TEACH tool and this is a PRACTICE session. Use problem to pose one problem, "
                "conclude to close it, graph_search to look up propositions and ask_user_question for "
                "anything ungraded; hints go in prose."
            )
        if mode != "PRACTICE" and name in PRACTICE_ONLY:
            raise ToolError(f"{name} is a PRACTICE tool and this is a TEACH session; teach with quiz/explain.")
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


def session_tools(state, session_id) -> list[Callable[..., Awaitable[Any]]]:

    async def probe(question: str, options: OptionsIn, explanation: str, correct: CorrectIn,
                    multi_select: bool = False, details: str | None = None) -> dict[str, Any]:
        """Diagnosis only (before probe_done): a graded multiple-choice probe on one strand of the goal.

        Blocks until the learner answers and returns what they added (choice, correctness,
        confidence, thinking). options: 2-6 strings or {label, value?} objects, symmetric
        distractors, each diagnosing a specific wrong model; never include "Don't know"
        (the UI adds it). Write explanation (why the answer is right) BEFORE correct.
        correct: the value (A, B, ...) or label of the right option, or a list of them with
        multi_select=true. details: optional context shown above the question.
        """
        payload = _payload(session_id, kind="quiz", mode="PROBE", question=question, explanation=explanation,
                        details=details, **_graded_options(options, correct, multi_select))
        return await state.sessions.pose(session_id, payload)

    async def recall(question: str, committed_answer: str, details: str | None = None) -> dict[str, Any]:
        """Diagnosis only (before probe_done): a free-recall question answered in the learner's words.

        committed_answer: your complete reference answer with its reasoning, written now and
        immutable; you will grade against it. Blocks until the learner answers; then call
        grade_recall(question_id, verdict, feedback) before commenting.
        """
        payload = _payload(session_id, kind="explain", mode="PROBE", question=question,
                        committed_answer=committed_answer, details=details)
        return await state.sessions.pose(session_id, payload)

    async def quiz(type: QuestionType, node_id: str, question: str, options: OptionsIn, explanation: str,
                   correct: CorrectIn, multi_select: bool = False, details: str | None = None) -> dict[str, Any]:
        """Teaching: a graded multiple-choice question about one plan node (requires plan_init).

        type="predict" comes BEFORE you teach the step (a nudge to commit to a prediction,
        not a test; start teaching by resolving it). type="check" comes AFTER the step
        (applied, not recited; each distractor diagnoses one specific wrong model).
        node_id must be an id from plan_init. options: 2-6 strings or {label, value?}
        objects without "Don't know". Write explanation BEFORE correct (value or label, or a
        list with multi_select=true). Blocks until the learner answers. One question per turn.
        """
        payload = _payload(session_id, kind="quiz", mode=_TYPE_MODE[type], node_id=node_id, question=question,
                        explanation=explanation, details=details, **_graded_options(options, correct, multi_select))
        return await state.sessions.pose(session_id, payload)

    async def explain(type: QuestionType, node_id: str, question: str, committed_answer: str,
                      details: str | None = None) -> dict[str, Any]:
        """Teaching: a free-text question about one plan node (requires plan_init).

        type="predict" before the step, type="check" after it. committed_answer: your full
        reference answer with reasoning, fixed before asking. Blocks until the learner
        answers; then call grade_recall(question_id, verdict, feedback) before commenting.
        A CHECK explain graded "correct" counts as mastery evidence for the node.
        """
        payload = _payload(session_id, kind="explain", mode=_TYPE_MODE[type], node_id=node_id, question=question,
                        committed_answer=committed_answer, details=details)
        return await state.sessions.pose(session_id, payload)

    async def ask_user_question(question: str, options: OptionsIn | None = None, multi_select: bool = False,
                                details: str | None = None) -> dict[str, Any]:
        """Ask the learner something ungraded (goal, preference, scope); allowed in any phase.

        options: optional strings or {label, value?, description?} objects; put the
        recommended option first with "(Recommended)" in its label. The UI always offers
        "Other..." with free text. Blocks until the learner answers.
        """
        choices = _normalize_choices(options) if options not in (None, "", []) else []
        if len(choices) > 6:
            raise ToolError("ask_user_question takes at most 6 options.")
        payload = _payload(session_id, kind="ask", mode=None, question=question, details=details,
                        choices=choices, multi_select=multi_select)
        return await state.sessions.pose(session_id, payload)

    async def probe_done(strands: list[StrandIn] | str, summary: str | None = None) -> dict[str, Any]:
        """Close the diagnosis exactly once, with no question pending.

        strands: one entry per dependency strand the goal rests on, each
        {strand, assessment} where assessment states the floor (reliably right), the
        ceiling (where it breaks), misconceptions seen and where to build from.
        summary: optional overall read. After it succeeds, say one closing sentence and
        end your turn; planning starts automatically.
        """
        raw = _heal_json(strands)
        if not isinstance(raw, list) or not raw:
            raise ToolError("strands must be a non-empty list of {strand, assessment} objects.")
        try:
            items = [s if isinstance(s, StrandIn) else StrandIn.model_validate(s) for s in raw]
            assessment = ProbeAssessment(
                strands=[ProbeStrand(strand=s.strand, assessment=s.assessment) for s in items],
                summary=summary or None,
            )
        except ValidationError as exc:
            raise ToolError("strands must be {strand, assessment} objects with non-empty text.") from exc
        return await state.sessions.probe_done(session_id, assessment)

    async def plan_init(mermaid: str, approach_prose: str = "",
                        node_details: dict[str, NodeDetailIn] | str | None = None) -> dict[str, Any]:
        """Write or rewrite the lesson map after probe_done (a mermaid flowchart).

        Example:
            graph TD
              ratio[Ratios compare quantities] --> slope[Slope is a ratio of changes]
              slope --> derivative[Derivative is the limit of slopes]
        Ids are permanent lowercase slugs (a-z, 0-9 joined by - or _); every quiz/explain
        references one as node_id. Titles are single-line; `a --> b` means a is a
        prerequisite of b (chains allowed); no subgraphs or styles. Aim for the minimal
        tree: roots are truths this learner already holds unconditionally, nothing off the
        path. Re-call it when a gap appears: kept ids keep their progress.
        approach_prose: the approach in a few sentences. node_details (dense sources):
        {id: {source_paragraphs: ["p3"], four_dimensions: {said, assumed, skipped,
        simplifications, paragraph_refs}}}; every ^pN must exist in the source. On the first
        call, present the plan and end your turn without teaching.
        """
        details = _heal_json(node_details) or {}
        if not isinstance(details, dict):
            raise ToolError("node_details must be an object keyed by node id.")
        details = {k: (v.model_dump(exclude_none=True) if isinstance(v, BaseModel) else v) for k, v in details.items()}
        return await state.sessions.init_plan(session_id, mermaid, approach_prose, details)

    async def grade_recall(question_id: str, verdict: Literal["correct", "partial", "incorrect"],
                           feedback: str) -> dict[str, Any]:
        """Grade a recall/explain answer against your committed_answer, before commenting on it.

        verdict: correct | partial | incorrect (strict: missing a load-bearing step is not
        correct). feedback: one or two sentences on what was right and what was missing.
        """
        return await state.sessions.grade(session_id, question_id, verdict, feedback)

    async def plan_advance(node_id: str, status: Literal["mastered", "needs_review"]) -> dict[str, Any]:
        """Mark a plan node mastered or needs_review after its check.

        mastered requires mastered prerequisites and CHECK evidence on the node (a CHECK
        quiz answered correctly with high confidence, or a CHECK explain graded correct).
        Which node is current is derived from your questions; do not track it here.
        """
        return await state.sessions.advance(session_id, node_id, status)

    async def track_foundation(title: str, prerequisite: str) -> dict[str, Any]:
        """Insert a prerequisite lesson only when diagnostic evidence identifies a gap."""
        return await state.tracks.foundation(session_id, title, prerequisite)

    async def spawn_demo(title: str, topic: str, description: str = "") -> dict[str, Any]:
        """Dispatch a lesson-specific interactive simulator as a background job; returns at once.

        Keep teaching: when the demo is ready (or fails) a message arrives on its own.
        """
        from learnharness.services.demos import submit_demo
        _require_tool(state, "demo")
        record = submit_demo(state, title, topic, description, session_id=session_id)
        return _dispatched(record)

    async def research(question: str, context: str = "") -> dict[str, Any]:
        """Dispatch web research with sources as a background job; returns at once (TEACH and PRACTICE).

        question: one precise, checkable question (a fact you are unsure of, a source to cite).
        context: optional, why it matters for this lesson. Keep teaching: the brief and its
        sources arrive on their own as a message; never wait for it or invent its result.
        """
        _require_tool(state, "research")
        question = _required_text(question, "question", "the question to research")
        record = state.jobs.dispatch(session_id, "research", {"question": question, "context": context or ""},
                                     label=question[:120])
        return _dispatched(record)

    async def read_pdf(path: str, question: str) -> dict[str, Any]:
        """Dispatch reading a PDF from the learner's vault as a background job; returns at once (TEACH and PRACTICE).

        path: vault-relative path of a .pdf (e.g. "Fontes/paper.pdf"); nothing outside the
        vault is readable. question: what to find in it. The relevant pages are triaged and
        read; the answer arrives on its own with pages cited as (p. N).
        """
        from learnharness.services.pdf_reader import PdfPathError, resolve_pdf
        _require_tool(state, "pdf")
        question = _required_text(question, "question", "what to look for in the PDF")
        try:
            _, rel = resolve_pdf(state.vault_path, path)
        except PdfPathError as exc:
            raise ToolError(str(exc)) from None
        record = state.jobs.dispatch(session_id, "pdf", {"path": rel, "question": question},
                                     label=f"{rel.rsplit('/', 1)[-1]}: {question[:80]}")
        return _dispatched(record)

    async def visual(brief: str) -> dict[str, Any]:
        """Dispatch a static figure (a self-contained SVG) for the current step; returns at once.

        brief: what the figure must show that prose cannot (elements, labels, relations,
        layout). It is inserted in the lesson when ready and a message tells you; until
        then, do not refer to it as visible.
        """
        _require_tool(state, "visual")
        brief = _required_text(brief, "brief", "what the figure must show")
        record = state.jobs.dispatch(session_id, "visual", {"brief": brief}, label=brief[:120])
        return _dispatched(record)

    async def problem(statement: str, mode: PracticeMode, model_solution: str,
                      target: list[str] | str | None = None) -> dict[str, Any]:
        """PRACTICE: pose exactly one problem; it does not block.

        statement: the problem as the learner sees it (never name the target idea).
        mode: recall | discrimination | composition. model_solution: your complete worked
        solution, written now; it stays hidden until conclude. target: graph proposition
        ids (n_...) or their exact names (resolved to ids), [] when none apply. Refused while
        another problem is active. After it succeeds, end your turn and wait for the attempt.
        """
        return await state.practice.pose(
            session_id, heal_latex(statement), str(mode).strip().casefold(), heal_latex(model_solution),
            _targets(target),
        )

    async def conclude(outcome: AgentOutcome, verdict: str, rung: HintRung | None = None,
                       miss_class: MissClass | None = None, retest: bool = False) -> dict[str, Any]:
        """PRACTICE: close the active problem and reveal its model solution.

        outcome: solved (no hints) | solvedWithHints | movedOn | surrendered. verdict: one
        sentence. rung: the highest hint rung used (R0..R5), null when none. miss_class:
        cue | discrimination | execution | careless | structural, null when nothing went
        wrong. retest: true to retest these targets later. Then write the closing words and
        end your turn; the next problem waits for the learner.
        """
        miss = _optional_choice(miss_class)
        return await state.practice.conclude(
            session_id, _outcome(outcome), heal_latex(verdict), _rung(rung),
            miss.casefold() if miss else None, _flag(retest),
        )

    async def graph_search(query: str, limit: int = 10) -> list[dict[str, str]]:
        """Read-only search of the learner's knowledge graph (TEACH and PRACTICE).

        Returns up to ``limit`` propositions as {id, name, statement, session_title},
        ranked by word overlap with ``query`` in name, statement and aliases.
        """
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            raise ToolError("limit must be an integer.") from None
        return state.practice.search(query, limit)

    tools = [probe, recall, quiz, explain, ask_user_question, probe_done, plan_init,
             grade_recall, plan_advance, track_foundation, spawn_demo, problem, conclude, graph_search,
             research, read_pdf, visual]
    return [_refusals(_mode_guard(state, session_id, t)) for t in tools]


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
