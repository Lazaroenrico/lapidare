"""Knowledge graph and logical chain contracts for LearnHarness.

Pure Pydantic models with ZERO I/O.
Product Invariant: Single central 2D canvas graph (no Macro | Micro toggle) + ☍ Chains view.
"""

from typing import Literal

from pydantic import BaseModel, Field

ConceptStatus = Literal["aprendendo", "sólido", "revisar"]


class ConceptNode(BaseModel):
    """Single concept node in the single central 2D knowledge graph."""
    id: str
    title: str
    status: ConceptStatus = "aprendendo"
    unconditional_truth: str = ""
    depends_on: list[str] = Field(default_factory=list)
    used_in: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    vault_rel_path: str = ""
    cluster_id: str = "geral"
    x: float | None = None
    y: float | None = None
    mistake_count: int = 0
    mechanism_summary: str = ""
    practice_summary: str = ""


class GraphEdge(BaseModel):
    """Directed edge between concept nodes."""
    source: str
    target: str
    kind: Literal["depends_on", "chain"] = "depends_on"


class LogicalChain(BaseModel):
    """Propositional implication chain (e.g. A ∧ B ⟹ C) displayed in the Chains table."""
    chain_id: str
    premises: list[str] = Field(default_factory=list)
    conclusion: str
    expression: str
    topic: str = ""
    source_session_id: str | None = None
    created_at: str = ""


class GraphSnapshot(BaseModel):
    """Snapshot of the knowledge graph served to the Home 2D Canvas and Chains view."""
    nodes: list[ConceptNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    chains: list[LogicalChain] = Field(default_factory=list)
    updated_at: str = ""


# ============================================================================
# Fase 8B: continuous knowledge trace (.harness/graph/*.jsonl)
# ============================================================================
#
# A proposition is a true, self-contained statement with a short name. A chain links
# premises that together imply a conclusion. Both are stored append-only: creation
# lines, link-appends (same id, more aliases/provenance) and ``{id, deleted: true}``
# tombstones are folded on read (``core.graph_merge``).

GraphClusterKind = Literal["session", "notes", "legacy"]


class Provenance(BaseModel):
    """Where a proposition or chain was taught: a session and, when known, the message."""
    session_id: str
    message_id: str | None = None


class PropositionNode(BaseModel):
    """Folded view of a proposition (``nodes.jsonl``)."""
    id: str
    name: str
    statement: str
    aliases: list[str] = Field(default_factory=list)
    created_at: str = ""
    provenance: list[Provenance] = Field(default_factory=list)
    vault_rel_path: str = ""
    # True when the harness created the note file (it may then remove an emptied note).
    note_created: bool = False


class ChainRecord(BaseModel):
    """Folded view of an implication chain (``chains.jsonl``): premises ⟹ conclusion."""
    id: str
    premises: list[str] = Field(default_factory=list)
    conclusion: str
    provenance: list[Provenance] = Field(default_factory=list)
    created_at: str = ""


class CoverageRecord(BaseModel):
    """A teacher message already read by the extractor (``coverage.jsonl``)."""
    session_id: str
    message_id: str
    fp: str
    tokens: int = 0
    at: str = ""


class BatchMessage(BaseModel):
    """One uncovered teacher message selected for an extraction batch."""
    message_id: str
    content: str
    fp: str
    tokens: int


# --- Structured I/O of the extraction subagents (engine ``run_structured``) ---


class ExtractedProposition(BaseModel):
    key: str = Field(min_length=1)
    name: str = Field(min_length=1)
    statement: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    message_id: str | None = None


class ExtractedChain(BaseModel):
    """Premises/conclusion are batch keys (``p1``) or existing node ids (``n_<12hex>``)."""
    premises: list[str] = Field(min_length=1)
    conclusion: str = Field(min_length=1)


class ExtractionPayload(BaseModel):
    propositions: list[ExtractedProposition] = Field(default_factory=list)
    chains: list[ExtractedChain] = Field(default_factory=list)


class AuditLink(BaseModel):
    key: str
    link_to: str | None = None


class AuditPayload(BaseModel):
    links: list[AuditLink] = Field(default_factory=list)


class MergePlan(BaseModel):
    """Deterministic result of merging one audited batch (``core.graph_merge.plan_merge``)."""
    new_nodes: list[PropositionNode] = Field(default_factory=list)
    link_appends: list[dict] = Field(default_factory=list)
    new_chains: list[ChainRecord] = Field(default_factory=list)
    coverage: list[CoverageRecord] = Field(default_factory=list)
    key_to_id: dict[str, str] = Field(default_factory=dict)
    rejected_chains: list[dict] = Field(default_factory=list)

    @property
    def touched_node_ids(self) -> list[str]:
        ids = [n.id for n in self.new_nodes] + [a["id"] for a in self.link_appends]
        ids += [c.conclusion for c in self.new_chains]
        return list(dict.fromkeys(ids))


# ============================================================================
# Fase 16: notes -> graph (.harness/graph/sources.jsonl)
# ============================================================================


class SourceRecord(BaseModel):
    """A vault note registered as a graph source. ``id = "src_" + sha256(path)[:12]``.

    Provenance of the nodes it produced is ``{session_id: id, message_id: <slice id>}``.
    A ``deleted`` source keeps its title for labels; the note itself is never touched.
    """
    id: str
    path: str
    title: str
    imported_at: str = ""
    deleted: bool = False


class NoteSlice(BaseModel):
    """One extraction unit of a note: a heading section or a paragraph.

    ``id`` is the block anchor (``p3``) when the slice starts at an anchored paragraph,
    otherwise its position (``s4``); coverage is per ``(source_id, id, fingerprint)``.
    """
    id: str
    content: str
    heading: str = ""
