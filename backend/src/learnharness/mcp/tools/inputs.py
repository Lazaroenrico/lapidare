"""Tolerant tool inputs: models send options as strings or objects, lists JSON-encoded as
strings, ``correct`` as value or label. Bad input raises ``ToolError`` with corrective text."""

from __future__ import annotations

import json
from typing import Any, Literal
from uuid import uuid4

from fastmcp.exceptions import ToolError
from pydantic import AliasChoices, BaseModel, Field, ValidationError

from learnharness.core.contracts.practice import AGENT_OUTCOMES
from learnharness.core.contracts.quiz import QuizMode, QuizOption, QuizPayload
from learnharness.core.latex_heal import heal_latex
from learnharness.services.sessions import now

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


def _required_text(value: Any, name: str, what: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ToolError(f"{name} is empty; pass {what}.")
    return text
