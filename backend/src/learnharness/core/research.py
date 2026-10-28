"""Pure helpers of the multi-step research loop (Fase 20). ZERO I/O."""
from __future__ import annotations

import re
from collections.abc import Iterable
from urllib.parse import urlsplit

from learnharness.core.contracts.jobs import ResearchFacet, ResearchPlan, ResearchSource

_CITATION = re.compile(r"\[(\d+)\](?!\()")


def normalize_url(url: str) -> str:
    """Scheme and host lower-cased, no fragment, no trailing slash (the key sources dedup on)."""
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/")
    query = f"?{parts.query}" if parts.query else ""
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}{path}{query}"


def merge_sources(groups: Iterable[Iterable[ResearchSource]]) -> list[ResearchSource]:
    """Union of the source lists, first occurrence wins; an empty title becomes the URL."""
    merged: list[ResearchSource] = []
    seen: set[str] = set()
    for group in groups:
        for source in group:
            key = normalize_url(source.url)
            if not source.url.strip() or key in seen:
                continue
            seen.add(key)
            merged.append(ResearchSource(title=source.title.strip() or source.url.strip(), url=source.url.strip()))
    return merged


def validate_citations(brief: str, n_sources: int) -> list[int]:
    """Distinct ``[n]`` references in ``brief`` outside ``1..n_sources`` (markdown links are not citations)."""
    bad: list[int] = []
    for match in _CITATION.finditer(brief):
        n = int(match.group(1))
        if not 1 <= n <= n_sources and n not in bad:
            bad.append(n)
    return bad


def strip_citations(brief: str, invalid: Iterable[int]) -> str:
    """Remove the given ``[n]`` references from the text."""
    drop = set(invalid)
    return _CITATION.sub(lambda m: "" if int(m.group(1)) in drop else m.group(0), brief)


def clamp_plan(plan: ResearchPlan, max_facets: int = 5) -> ResearchPlan:
    """Drop facets without a query and cut the excess."""
    facets = [ResearchFacet.model_construct(name=f.name, queries=[q for q in f.queries if q.strip()])
              for f in plan.facets]
    kept = [f for f in facets if f.queries][:max_facets]
    return ResearchPlan.model_construct(facets=kept)
