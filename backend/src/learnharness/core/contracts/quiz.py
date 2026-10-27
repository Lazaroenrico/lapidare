"""Question, QuestionDock, and calibration contracts for LearnHarness.

Pure Pydantic models with ZERO I/O.
Every question reaches the learner through the QuestionDock. Three kinds exist:

* ``quiz``: graded multiple choice (single or multi select) with confidence and thinking;
* ``explain``: free-text answer graded later by the agent (``grade_recall``) against an
  answer it committed to before asking;
* ``ask``: an ungraded question to the learner (goal, preference), with "Other…".

Records persisted before Fase 8 (``correct_index`` / ``chosen_index`` scalars, mandatory
confidence) still validate: the legacy scalars are folded into the list fields.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field, model_validator

from learnharness.core.contracts.config import wire_dict

QuizMode = Literal["PROBE", "PREDICTION", "CHECK"]
QuestionKind = Literal["quiz", "explain", "ask"]
GradeVerdict = Literal["correct", "partial", "incorrect"]
ConfidenceBand = Literal["low", "medium", "high"]
CalibrationBand = Literal[
    "calibrated_mastery",
    "illusion_of_competence",
    "fragile_intuition",
    "conscious_gap",
    "moderate_correct",
    "moderate_error",
]


def _fold_legacy_index(data: Any, scalar: str, plural: str) -> Any:
    """Map a legacy ``scalar`` index into the ``plural`` list (the list wins when both exist)."""
    fields = wire_dict(data)
    if fields is None or scalar not in fields:
        return data
    value = fields.pop(scalar)
    if plural not in fields and value is not None:
        fields[plural] = [value]
    return fields


class QuizOption(BaseModel):
    """Single option in a question (supports KaTeX formulas in label)."""
    value: str
    label: str
    description: str | None = None


class QuizPayload(BaseModel):
    """A question presented inside the QuestionDock (name kept for API compatibility).

    ``correct_indices``, ``committed_answer`` and ``explanation`` are the answer key:
    they never leave the server while the question is pending.
    """
    quiz_id: str
    session_id: str
    node_id: str | None = None
    topic: str = ""
    kind: QuestionKind = "quiz"
    mode: QuizMode | None = None
    question: str
    details: str | None = None
    choices: list[QuizOption] = Field(default_factory=list, max_length=6)
    multi_select: bool = False
    correct_indices: list[int] = Field(default_factory=list)
    committed_answer: str | None = None
    explanation: str = ""
    created_at: str = ""

    @model_validator(mode="before")
    @classmethod
    def _legacy_correct_index(cls, data: Any) -> Any:
        return _fold_legacy_index(data, "correct_index", "correct_indices")

    @model_validator(mode="after")
    def _consistent_kind(self) -> "QuizPayload":
        if self.kind == "quiz":
            if len(self.choices) < 2:
                raise ValueError("A quiz needs between 2 and 6 options")
            if not self.correct_indices:
                raise ValueError("A quiz needs at least one correct option")
            for index in self.correct_indices:
                if not 0 <= index < len(self.choices):
                    raise ValueError(
                        f"correct index {index} is out of bounds for choices of length {len(self.choices)}"
                    )
            if len(set(self.correct_indices)) != len(self.correct_indices):
                raise ValueError("correct indices must be unique")
            if len(self.correct_indices) > 1 and not self.multi_select:
                raise ValueError("More than one correct option requires multi_select=true")
        elif self.kind == "explain":
            if self.choices or self.correct_indices:
                raise ValueError("An explain question has no options")
            if not (self.committed_answer or "").strip():
                raise ValueError("An explain question needs the committed_answer it will be graded against")
        elif self.correct_indices:
            raise ValueError("An ask question is not graded")
        return self

    @computed_field  # type: ignore[prop-decorator]
    @property
    def correct_index(self) -> int | None:
        """Legacy single-answer view of ``correct_indices``."""
        return self.correct_indices[0] if self.correct_indices else None


class QuizSubmission(BaseModel):
    """Learner response submitted from the QuestionDock UI.

    Which fields are required depends on the question kind; ``evaluate_calibration``
    enforces it against the pending question.
    """
    quiz_id: str
    session_id: str
    chosen_indices: list[int] = Field(default_factory=list)
    is_dont_know: bool = False
    confidence: int | None = Field(default=None, ge=0, le=100)
    learner_thinking: str = ""
    reading_thinking: str = ""
    text: str = ""
    other_text: str = ""

    @model_validator(mode="before")
    @classmethod
    def _legacy_chosen_index(cls, data: Any) -> Any:
        return _fold_legacy_index(data, "chosen_index", "chosen_indices")

    @property
    def chosen_index(self) -> int | None:
        return self.chosen_indices[0] if self.chosen_indices else None


class CalibrationResult(BaseModel):
    """Evaluated answer stored in the session, in .harness/quiz-log.jsonl and shown to the agent.

    ``correct`` is ``None`` for ``ask`` and for an ``explain`` not yet graded; confidence
    and the bands only exist for a ``quiz`` answered without "Don't know" (the band is
    ``conscious_gap`` for a quiz "Don't know"). ``dismissed`` marks a question the learner
    closed without answering (Fase 12): nothing is graded and it never reaches the quiz-log.
    """
    quiz_id: str
    session_id: str
    topic: str = ""
    node_id: str | None = None
    kind: QuestionKind = "quiz"
    # Mode of the question. None for ask and for legacy records written before the
    # field existed. Mastery gates treat None as "not CHECK evidence" (conservative);
    # practice prioritization treats None as CHECK (keeps old ranking).
    mode: QuizMode | None = None
    question: str = ""
    choices: list[QuizOption] = Field(default_factory=list)
    correct: bool | None = None
    is_dont_know: bool = False
    chosen_indices: list[int] = Field(default_factory=list)
    correct_indices: list[int] = Field(default_factory=list)
    confidence: int | None = None
    confidence_band: ConfidenceBand | None = None
    calibration_band: CalibrationBand | None = None
    learner_thinking: str = ""
    reading_thinking: str = ""
    text: str = ""
    other_text: str = ""
    committed_answer: str | None = None
    grade: GradeVerdict | None = None
    grade_feedback: str = ""
    pedagogical_directive: str = ""
    explanation: str = ""
    timestamp: str = ""
    dismissed: bool = False

    @model_validator(mode="before")
    @classmethod
    def _legacy_indices(cls, data: Any) -> Any:
        data = _fold_legacy_index(data, "chosen_index", "chosen_indices")
        return _fold_legacy_index(data, "correct_index", "correct_indices")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def chosen_index(self) -> int | None:
        """Legacy single-answer view of ``chosen_indices``."""
        return self.chosen_indices[0] if self.chosen_indices else None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def correct_index(self) -> int | None:
        """Legacy single-answer view of ``correct_indices``."""
        return self.correct_indices[0] if self.correct_indices else None
