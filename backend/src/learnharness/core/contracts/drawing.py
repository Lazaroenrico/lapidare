"""Multimodal drawing review contracts (Excalidraw retrieval drawings).

Pure Pydantic models with ZERO I/O.
"""

from pydantic import BaseModel, Field, model_validator


class DrawingFollowUpQuiz(BaseModel):
    """Follow-up question the vision model proposes when a drawing has conceptual errors.

    The server turns it into a ``QuizPayload`` (ids, session) and poses it through the
    normal QuestionDock pipeline, so the answer is calibrated and logged like any other.
    """
    question: str = Field(min_length=1)
    choices: list[str] = Field(min_length=2, max_length=6)
    correct_index: int = Field(ge=0)
    explanation: str = Field(min_length=1)
    topic: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_choices(self) -> "DrawingFollowUpQuiz":
        if any(not choice.strip() for choice in self.choices):
            raise ValueError("Follow-up quiz choices must be non-empty")
        if self.correct_index >= len(self.choices):
            raise ValueError(
                f"correct_index {self.correct_index} is out of bounds for {len(self.choices)} choices"
            )
        return self


class DrawingReviewResult(BaseModel):
    """Multimodal vision evaluation of an Excalidraw retrieval drawing (.png).

    ``follow_up_quiz`` is optional and only meaningful when ``incorrect_points`` lists
    conceptual errors; the server ignores it otherwise.
    """
    slug: str = ""
    correct_points: list[str] = Field(default_factory=list)
    missing_points: list[str] = Field(default_factory=list)
    incorrect_points: list[str] = Field(default_factory=list)
    summary_markdown: str = Field(min_length=1)
    follow_up_quiz: DrawingFollowUpQuiz | None = None
