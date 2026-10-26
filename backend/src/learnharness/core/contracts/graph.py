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
