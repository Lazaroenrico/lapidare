"""Questions to the learner (they block until answered) and grading of free answers."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Literal

from fastmcp.exceptions import ToolError

from learnharness.mcp.tools.inputs import (
    _TYPE_MODE,
    CorrectIn,
    OptionsIn,
    QuestionType,
    _graded_options,
    _normalize_choices,
    _payload,
)


def build(state, session_id) -> list[Callable[..., Awaitable[Any]]]:
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

    async def grade_recall(question_id: str, verdict: Literal["correct", "partial", "incorrect"],
                           feedback: str) -> dict[str, Any]:
        """Grade a recall/explain answer against your committed_answer, before commenting on it.

        verdict: correct | partial | incorrect (strict: missing a load-bearing step is not
        correct). feedback: one or two sentences on what was right and what was missing.
        """
        return await state.sessions.grade(session_id, question_id, verdict, feedback)

    return [probe, recall, quiz, explain, ask_user_question, grade_recall]
