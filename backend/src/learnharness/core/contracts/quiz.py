"""Quiz, QuestionDock, and calibration contracts for LearnHarness.

Pure Pydantic models with ZERO I/O.
Every test of understanding occurs via QuestionDock with prediction/check, confidence, and thinking.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

QuizMode = Literal["PREDICTION", "CHECK"]
ConfidenceBand = Literal["low", "medium", "high"]
CalibrationBand = Literal[
    "calibrated_mastery",
    "illusion_of_competence",
    "fragile_intuition",
    "conscious_gap",
    "moderate_correct",
    "moderate_error",
]


class QuizOption(BaseModel):
    """Single option in a quiz (supports KaTeX formulas in label)."""
    value: str
    label: str


class QuizPayload(BaseModel):
    """Payload presented inside the QuestionDock component."""
    quiz_id: str
    session_id: str
    node_id: str | None = None
    topic: str
    mode: QuizMode = "PREDICTION"
    question: str
    details: str | None = None
    choices: list[QuizOption] = Field(min_length=2, max_length=6)
    correct_index: int = Field(ge=0)
    explanation: str
    created_at: str = ""

    @model_validator(mode="after")
    def validate_correct_index(self) -> "QuizPayload":
        if self.correct_index >= len(self.choices):
            raise ValueError(
                f"correct_index {self.correct_index} is out of bounds for choices of length {len(self.choices)}"
            )
        return self


class QuizSubmission(BaseModel):
    """User response submitted from the QuestionDock UI."""
    quiz_id: str
    session_id: str
    chosen_index: int | None = None
    is_dont_know: bool = False
    confidence: int = Field(ge=0, le=100)
    learner_thinking: str = ""

    @model_validator(mode="after")
    def validate_choice_or_dont_know(self) -> "QuizSubmission":
        if not self.is_dont_know and self.chosen_index is None:
            raise ValueError("Must either select a chosen_index or indicate is_dont_know=True")
        return self


class CalibrationResult(BaseModel):
    """Calculated calibration metric stored in .harness/quiz-log.jsonl and passed to the agent."""
    quiz_id: str
    session_id: str
    topic: str
    node_id: str | None = None
    correct: bool
    is_dont_know: bool
    chosen_index: int | None
    correct_index: int
    confidence: int
    confidence_band: ConfidenceBand
    calibration_band: CalibrationBand
    # Mode of the quiz that produced this answer. None only for legacy records written
    # before the field existed; consumers must treat None as "not CHECK evidence".
    mode: QuizMode | None = None
    learner_thinking: str
    pedagogical_directive: str
    explanation: str
    timestamp: str = ""
