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


class VisualCheck(BaseModel):
    """Vision verdict on the rendered figure (Fase 17).

    ``problems`` lists concrete defects (overlapping, cut or illegible text, a missing or
    wrong element of the brief); the figure passes only when it communicates the brief and
    the list is empty.
    """
    communicates_brief: bool
    problems: list[str] = Field(default_factory=list)
    notes: str = ""

    @property
    def passed(self) -> bool:
        return self.communicates_brief and not any(p.strip() for p in self.problems)
