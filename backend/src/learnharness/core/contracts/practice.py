"""PRACTICE session contracts (Fase 9): one problem at a time, hint ladder R0-R5.

Pure Pydantic models with ZERO I/O. The agent poses a problem with ``problem`` (the
model solution is written then and hidden from the learner), the learner's attempts are
appended to it, and ``conclude`` closes it with an outcome; the learner may dismiss it.
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

PracticeMode = Literal["recall", "discrimination", "composition"]
# ``dismissed`` is never sent by the agent: it is the learner's "Descartar problema".
PracticeOutcome = Literal["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"]
AgentOutcome = Literal["solved", "solvedWithHints", "movedOn", "surrendered"]
HintRung = Literal["R0", "R1", "R2", "R3", "R4", "R5"]
MissClass = Literal["cue", "discrimination", "execution", "careless", "structural"]

PRACTICE_MODES: tuple[str, ...] = ("recall", "discrimination", "composition")
AGENT_OUTCOMES: tuple[str, ...] = ("solved", "solvedWithHints", "movedOn", "surrendered")
HINT_RUNGS: tuple[str, ...] = ("R0", "R1", "R2", "R3", "R4", "R5")
MISS_CLASSES: tuple[str, ...] = ("cue", "discrimination", "execution", "careless", "structural")


class PracticeAttempt(BaseModel):
    """One learner submission (a reasoning draft or a final answer) on a problem."""
    at: str = ""
    text: str


class PracticeProblem(BaseModel):
    """A problem posed by ``problem``; closed by ``conclude`` or the learner's dismissal."""
    id: str
    statement: str
    mode: PracticeMode
    # Graph proposition ids (``n_...``) the problem exercises (names are resolved on input).
    target: list[str] = Field(default_factory=list)
    # Written before posing; serialized to the learner only once the problem is concluded.
    model_solution: str
    created_at: str = ""
    attempts: list[PracticeAttempt] = Field(default_factory=list)
    outcome: PracticeOutcome | None = None
    verdict: str = ""
    rung: HintRung | None = None
    miss_class: MissClass | None = None
    retest: bool = False
    concluded_at: str = ""

    @field_validator("statement", "model_solution")
    @classmethod
    def non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("statement and model_solution must be written before the problem is posed")
        return value

    @property
    def concluded(self) -> bool:
        return self.outcome is not None


class PracticeState(BaseModel):
    """The problems of one PRACTICE session; at most one is active."""
    active_problem_id: str | None = None
    problems: list[PracticeProblem] = Field(default_factory=list)

    def active(self) -> PracticeProblem | None:
        if self.active_problem_id is None:
            return None
        return next((p for p in self.problems if p.id == self.active_problem_id), None)


class PracticeLogEntry(BaseModel):
    """One ``conclude`` in ``.harness/practice-log.jsonl`` (append-only; never dismissals)."""
    at: str
    session_id: str
    problem_id: str
    mode: PracticeMode
    target: list[str] = Field(default_factory=list)
    outcome: AgentOutcome
    rung: HintRung | None = None
    miss_class: MissClass | None = None
    retest: bool = False
