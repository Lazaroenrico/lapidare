"""Multi-step research loop (Fase 20), scripted engine, no network."""

from __future__ import annotations

import json

import pytest

from learnharness.core.contracts.config import EngineKind
from learnharness.core.contracts.jobs import ResearchGaps, ResearchPlan, ResearchResult
from learnharness.services import research_agent
from learnharness.services.research_agent import run_research_agent
from tests.conftest import FakeEngine


class SlotStub:
    engine = EngineKind.GEMINI_CLI


class Searcher(FakeEngine):
    """Research answers are scripted per call order; a BaseException entry is raised."""

    def __init__(self, answers):
        super().__init__()
        self.answers = list(answers)
        self.prompts = []

    async def research(self, prompt, slot=None):
        self.prompts.append(prompt)
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer


def _found(n):
    return ResearchResult(brief=f"## Resumo\nfaceta {n}", sources=[{"title": f"S{n}", "url": f"https://s{n}.org/"}])


def _plan(names):
    return ResearchPlan(facets=[{"name": n, "queries": [f"q {n}"]} for n in names])


async def _run(engine, notes=None):
    notes = [] if notes is None else notes
    result = await run_research_agent(engine, SlotStub(), "Pergunta?", "", "Tema", "pt-BR", notes.append)
    return result, notes


async def test_happy_path_three_facets_synthesizes_with_numbered_sources():
    engine = Searcher([_found(1), _found(2), _found(3)])
    engine.program(ResearchPlan, _plan(["a", "b", "c"]))
    engine.program(ResearchGaps, ResearchGaps())
    engine.program(ResearchResult, ResearchResult(brief="## Resumo\nok [1] [3]", sources=[
        {"title": "inventada", "url": "https://fake.org"}]))
    result, notes = await _run(engine)
    assert result["facets"] == ["a", "b", "c"] and result["brief"].startswith("## Resumo\nok")
    assert [s["url"] for s in result["sources"]] == ["https://s1.org/", "https://s2.org/", "https://s3.org/"]
    assert notes[0] == "planejando facetas" and "faceta 2/3: b" in notes
    assert notes[-2:] == ["conferindo lacunas", "sintetizando"]
    synth = json.loads(next(c for c in engine.structured_calls if c["schema"] is ResearchResult)["prompt"])
    assert [s["n"] for s in synth["numbered_sources"]] == [1, 2, 3]
    assert "Focus on this facet" in engine.prompts[0]


async def test_a_failing_facet_does_not_stop_the_others():
    engine = Searcher([_found(1), RuntimeError("boom"), _found(3)])
    engine.program(ResearchPlan, _plan(["a", "b", "c"]))
    engine.program(ResearchGaps, ResearchGaps())
    engine.program(ResearchResult, ResearchResult(brief="## Resumo\nok [2]"))
    result, _ = await _run(engine)
    assert result["facets"] == ["a", "c"] and len(result["sources"]) == 2


async def test_all_facets_failing_raises_the_engine_error():
    engine = Searcher([RuntimeError("boom"), RuntimeError("boom"), RuntimeError("boom")])
    engine.program(ResearchPlan, _plan(["a", "b", "c"]))
    with pytest.raises(RuntimeError, match="boom"):
        await _run(engine)


async def test_plan_failure_degrades_to_one_facet_without_synthesis():
    engine = Searcher([_found(1)])
    result, _ = await _run(engine)
    assert "facets" not in result and result["brief"] == "## Resumo\nfaceta 1"
    assert [c["schema"] for c in engine.structured_calls] == [ResearchPlan, ResearchGaps]


async def test_follow_up_round_and_call_limit(monkeypatch):
    monkeypatch.setattr(research_agent, "MAX_ENGINE_CALLS", 4)
    engine = Searcher([_found(i) for i in range(1, 6)])
    engine.program(ResearchPlan, _plan(["a", "b", "c"]))
    engine.program(ResearchGaps, ResearchGaps(missing=["x"], follow_up=[
        {"name": "d", "queries": ["q"]}, {"name": "e", "queries": ["q"]}]))
    engine.program(ResearchResult, ResearchResult(brief="## Resumo\nok"))
    result, _ = await _run(engine)
    assert len(engine.prompts) == 4 and result["facets"] == ["a", "b", "c", "d"]


async def test_invalid_citation_is_corrected_once():
    engine = Searcher([_found(1), _found(2)])
    engine.program(ResearchPlan, _plan(["a", "b"]))
    engine.program(ResearchGaps, ResearchGaps())
    engine.program(ResearchResult, [ResearchResult(brief="## Resumo\nx [7]"), ResearchResult(brief="## Resumo\nx [2]")])
    result, _ = await _run(engine)
    assert result["brief"].endswith("x [2]")
    fix = json.loads([c for c in engine.structured_calls if c["schema"] is ResearchResult][1]["prompt"])
    assert "[7]" in fix["fix_these_citations"]


async def test_persistent_invalid_citation_is_stripped():
    engine = Searcher([_found(1), _found(2)])
    engine.program(ResearchPlan, _plan(["a", "b"]))
    engine.program(ResearchGaps, ResearchGaps())
    engine.program(ResearchResult, ResearchResult(brief="## Resumo\nx [1] y [9]"))
    result, _ = await _run(engine)
    assert "[9]" not in result["brief"] and "[1]" in result["brief"]
