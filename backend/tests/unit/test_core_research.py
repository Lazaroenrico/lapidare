"""Pure helpers of the multi-step research loop (Fase 20)."""

from learnharness.core.contracts.jobs import ResearchFacet, ResearchPlan, ResearchSource
from learnharness.core.research import (
    clamp_plan,
    merge_sources,
    strip_citations,
    validate_citations,
)


def _src(title, url):
    return ResearchSource(title=title, url=url)


def test_merge_sources_dedups_by_normalized_url_and_fills_titles():
    merged = merge_sources([
        [_src("A", "https://Example.org/a/"), _src("", "https://x.org/p")],
        [_src("dup", "https://example.org/a#frag"), _src("B", "https://example.org/b")],
    ])
    assert [(s.title, s.url) for s in merged] == [
        ("A", "https://Example.org/a/"), ("https://x.org/p", "https://x.org/p"), ("B", "https://example.org/b")]


def test_validate_citations_reports_out_of_range_once_and_ignores_links():
    brief = "a [1] b [3] c [3] d [0] e [[2]](https://x.org) f [9](https://y.org)"
    assert validate_citations(brief, 2) == [3, 0]
    assert validate_citations("sem citações", 2) == []


def test_strip_citations_removes_only_invalid():
    assert strip_citations("a [1] b [4]", [4]) == "a [1] b "


def test_clamp_plan_drops_empty_facets_and_cuts_excess():
    facets = [ResearchFacet(name=f"f{i}", queries=["q"]) for i in range(5)]
    plan = ResearchPlan(facets=facets)
    plan.facets[1] = ResearchFacet.model_construct(name="vazia", queries=["", "  "])
    clamped = clamp_plan(plan, max_facets=3)
    assert [f.name for f in clamped.facets] == ["f0", "f2", "f3"]
