"""Structured outputs of the background jobs the teacher dispatches (Fase 10).

Pure Pydantic models with ZERO I/O.
"""

from pydantic import BaseModel, Field


class ResearchSource(BaseModel):
    """One web page the research actually consulted."""
    title: str
    url: str


class ResearchFacet(BaseModel):
    """One angle of a research question and the web queries that cover it (Fase 20)."""
    name: str
    queries: list[str] = Field(min_length=1, max_length=3)


class ResearchPlan(BaseModel):
    facets: list[ResearchFacet] = Field(min_length=2, max_length=5)


class ResearchGaps(BaseModel):
    """What the first round left open; ``follow_up`` facets get one more search round."""
    missing: list[str] = Field(default_factory=list)
    follow_up: list[ResearchFacet] = Field(default_factory=list)


class ResearchResult(BaseModel):
    """``brief`` is markdown with the sections Resumo / Achados citados / Fontes / Lacunas."""
    brief: str
    sources: list[ResearchSource] = Field(default_factory=list)
    facets: list[str] = Field(default_factory=list)
    engine: str | None = None


class PdfTriage(BaseModel):
    """First pass over the text pages: a draft and which pages must be seen, not just read."""
    draft: str
    visual_pages: list[int] = Field(default_factory=list)
    confident: bool = False


class PdfPageReading(BaseModel):
    """What the vision path saw on one rendered page."""
    page: int
    findings: str
    figures: list[str] = Field(default_factory=list)


class PdfFigure(BaseModel):
    page: int
    description: str


class PdfAnswer(BaseModel):
    """Answer to a question about a PDF, citing pages as ``(p. N)``."""
    answer: str
    pages_cited: list[int] = Field(default_factory=list)
    figures: list[PdfFigure] = Field(default_factory=list)
    pages_viewed: list[int] = Field(default_factory=list)


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
