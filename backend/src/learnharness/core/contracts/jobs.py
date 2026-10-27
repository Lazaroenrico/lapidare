"""Structured outputs of the background jobs the teacher dispatches (Fase 10).

Pure Pydantic models with ZERO I/O.
"""

from pydantic import BaseModel, Field


class ResearchSource(BaseModel):
    """One web page the research actually consulted."""
    title: str
    url: str


class ResearchResult(BaseModel):
    """``brief`` is markdown with the sections Resumo / Achados citados / Fontes / Lacunas."""
    brief: str
    sources: list[ResearchSource] = Field(default_factory=list)


class PdfAnswer(BaseModel):
    """Answer to a question about a PDF, citing pages as ``(p. N)``."""
    answer: str
    pages_cited: list[int] = Field(default_factory=list)


class VisualDraft(BaseModel):
    """One self-contained SVG figure for the current lesson step."""
    title: str
    alt: str = ""
    svg: str
