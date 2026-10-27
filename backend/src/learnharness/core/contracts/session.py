"""Session, message, and pedagogical plan contracts for LearnHarness.

Pure Pydantic models with ZERO I/O.
Product Invariant: ONLY two session modes exist: TEACH and PRACTICE.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from learnharness.core.contracts.quiz import CalibrationResult, QuizPayload

# Strictly ONLY these two modes exist across the entire platform!
SessionMode = Literal["TEACH", "PRACTICE"]

# Context kind that the TEACH mode adapts to automatically
TeachContextKind = Literal["free_topic", "dense_source", "track_step", "drawing_review"]

# State-machine phase of an active session: probing -> planning -> teaching -> completed.
# "awaiting_answer" and "consolidating" only exist in records written before Fase 8
# (waiting on the learner is ``execution_status="waiting"``); they are normalized on load.
SessionPhase = Literal[
    "probing",
    "planning",
    "teaching",
    "awaiting_answer",
    "consolidating",
    "completed",
]
LEGACY_PHASES = frozenset({"awaiting_answer", "consolidating"})


class ProbeStrand(BaseModel):
    """One dependency strand of the learner's goal, as bracketed by the diagnosis."""
    strand: str = Field(min_length=1)
    # Floor, ceiling, misconceptions and where to build from.
    assessment: str = Field(min_length=1)


class ProbeAssessment(BaseModel):
    """The diagnosis handed from the prober to the teacher (``probe_done``)."""
    strands: list[ProbeStrand] = Field(min_length=1)
    summary: str | None = None
    created_at: str = ""


class DenseBlockDimensions(BaseModel):
    """Four analytical dimensions mapped for each dense source block.

    Mapeamento: Dito / Pressuposto / Pulado / Simplificações com citações #^pN.
    Every ``^pN`` mentioned here (and in ``paragraph_refs``) must exist in the source;
    ``SessionService.set_plan`` rejects the plan otherwise.
    """
    said: str = ""
    assumed: list[str] = Field(default_factory=list)
    skipped: list[str] = Field(default_factory=list)
    simplifications: list[str] = Field(default_factory=list)
    paragraph_refs: list[str] = Field(default_factory=list)


# ``mastered`` / ``needs_review`` are set by plan_advance and persist; ``current`` /
# ``visited`` / ``pending`` are derived from the questions posed (core.plan_mermaid).
PlanNodeStatus = Literal["pending", "current", "visited", "mastered", "needs_review"]


class PlanNode(BaseModel):
    """Single node in the lesson's pedagogical DAG (PlanWindow mini-DAG)."""
    id: str
    label: str
    kind: Literal["unconditional_truth", "derived_step", "goal"] = "derived_step"
    depends_on: list[str] = Field(default_factory=list)
    status: PlanNodeStatus = "pending"
    source_paragraphs: list[str] = Field(default_factory=list)
    four_dimensions: DenseBlockDimensions | None = None


class PlanDag(BaseModel):
    """The directed acyclic graph generated during plan_init and tracked in real-time."""
    approach_prose: str = ""
    nodes: list[PlanNode] = Field(default_factory=list)
    updated_at: str = ""

    @model_validator(mode="after")
    def valid_dag(self):
        ids = {node.id for node in self.nodes}
        if len(ids) != len(self.nodes):
            raise ValueError("Plan node ids must be unique")
        graph = {node.id: node.depends_on for node in self.nodes}
        done, active = set(), set()
        def visit(node_id):
            if node_id not in ids:
                raise ValueError("Unknown plan dependency")
            if node_id in active:
                raise ValueError("Plan must be acyclic")
            if node_id not in done:
                active.add(node_id)
                for dependency in graph[node_id]:
                    visit(dependency)
                active.remove(node_id)
                done.add(node_id)
        for node_id in ids:
            visit(node_id)
        return self


class NodeSpan(BaseModel):
    """Marks that ``content[start:]`` of a message was produced while ``node_id`` was current.

    ``node_id`` is ``None`` for prose produced before any plan existed (diagnosis).
    """
    start: int = 0
    node_id: str | None = None


class SessionMessage(BaseModel):
    """Single turn message in the teaching or practice session."""
    id: str
    role: Literal["user", "assistant", "system", "tool"]
    content: str
    created_at: str
    node_id: str | None = None
    quiz_id: str | None = None
    demo_slug: str | None = None
    citations: list[str] = Field(default_factory=list)
    node_spans: list[NodeSpan] = Field(default_factory=list)


class SessionRecord(BaseModel):
    """Full session record persisted in .harness/sessions/<id>.jsonl."""
    id: str
    title: str
    mode: SessionMode = "TEACH"
    context_kind: TeachContextKind = "free_topic"
    phase: SessionPhase = "probing"
    source_path: str | None = None
    track_item_id: str | None = None
    lesson_vault_path: str | None = None
    plan: PlanDag = Field(default_factory=PlanDag)
    messages: list[SessionMessage] = Field(default_factory=list)
    pending_quiz_id: str | None = None
    schema_version: int = 2
    sequence: int = 0
    event_id: str = ""
    pending_quiz: QuizPayload | None = None
    answers: dict[str, CalibrationResult] = Field(default_factory=dict)
    assessment: ProbeAssessment | None = None
    # probe_done happened and the teacher's planning turn has not completed yet.
    handoff_pending: bool = False
    # Prompt family ("prober" | "teacher" | "practice") last sent to a persistent process.
    prompt_phase: str | None = None
    execution_status: Literal["idle", "queued", "running", "waiting", "interrupted", "failed", "completed"] = "idle"
    execution_id: str | None = None
    error: str | None = None
    recovery_required: bool = False
    applied_actions: list[str] = Field(default_factory=list)
    # Graph node ids the learner picked as context (Fase 8B; at most 64).
    graph_context: list[str] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
