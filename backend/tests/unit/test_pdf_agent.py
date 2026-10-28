"""The PDF reading agent with a scripted engine (no network)."""
from __future__ import annotations

import pytest

from learnharness.core.contracts.jobs import PdfAnswer, PdfPageReading, PdfTriage
from learnharness.engines.cli_protocol import EngineError
from learnharness.services import pdf_agent
from learnharness.services.pdf_agent import MAX_MODEL_CALLS, run_pdf_agent
from tests.conftest import FakeEngine, configure_vault
from tests.unit.test_background_jobs import _pdf


class SeeingEngine(FakeEngine):
    def __init__(self, readings=()):
        super().__init__()
        self.readings = list(readings)
        self.image_calls: list[dict] = []

    async def review_image(self, png_bytes, instructions, schema, slot=None, **kwargs):
        self.image_calls.append({"png": png_bytes, "schema": schema, **kwargs})
        item = self.readings.pop(0)
        if isinstance(item, BaseException):
            raise item
        return schema.model_validate(item)


def _state(tmp_path, engine):
    from learnharness.api.state import AppState
    return AppState(vault_path=configure_vault(tmp_path / "V"), engine_factory=lambda slot: engine)


def _put(state, name, pages):
    (state.vault_path / name).write_bytes(_pdf(pages))


async def _run(state, path="a.pdf", question="What does softmax do?"):
    activity: list[str] = []
    result = await run_pdf_agent(state, {"path": path, "question": question}, activity.append)
    return result, activity


async def test_page_that_needs_eyes_is_rendered_and_read(tmp_path) -> None:
    engine = SeeingEngine([{"page": 2, "findings": "curva sobe", "figures": ["gráfico da softmax"]}])
    engine.program(PdfTriage, {"draft": "d", "visual_pages": [2, 99]})
    engine.program(PdfAnswer, {"answer": "Normaliza (p. 2).", "pages_cited": [2],
                               "figures": [{"page": 2, "description": "gráfico da softmax"},
                                           {"page": 8, "description": "inventada"}]})
    state = _state(tmp_path, engine)
    _put(state, "a.pdf", ["Introduction", "softmax normalizes logits"])
    result, activity = await _run(state)
    assert result["pages_viewed"] == [2] and result["pages_cited"] == [2]
    assert result["figures"] == [{"page": 2, "description": "gráfico da softmax"}]
    assert "warnings" not in result
    assert engine.image_calls[0]["png"].startswith(b"\x89PNG") and engine.image_calls[0]["image_name"] == "p2.png"
    assert engine.image_calls[0]["schema"] is PdfPageReading
    assert "curva sobe" in engine.structured_calls[1]["prompt"]
    assert activity == ["extraindo texto de a.pdf", "triagem", "vendo p. 2", "sintetizando"]


async def test_scanned_pdf_skips_triage_and_only_sees(tmp_path) -> None:
    engine = SeeingEngine([{"page": n, "findings": f"f{n}"} for n in range(1, 5)])
    engine.program(PdfAnswer, {"answer": "Diz isso (p. 3).", "pages_cited": [3]})
    state = _state(tmp_path, engine)
    _put(state, "a.pdf", ["", "", "", "", ""])
    result, _ = await _run(state)
    assert result["pages_viewed"] == [1, 2, 3, 4] and result["pages_read"] == []
    assert [c["schema"] for c in engine.structured_calls] == [PdfAnswer]
    assert len(engine.image_calls) == MAX_MODEL_CALLS - 3


async def test_scanned_pdf_without_vision_fails(tmp_path) -> None:
    state = _state(tmp_path, FakeEngine())
    _put(state, "a.pdf", [""])
    with pytest.raises(pdf_agent.PdfPathError, match=r"nada pôde ser lido.*a visão não está disponível"):
        await _run(state)


async def test_engine_without_review_image_degrades_to_text_with_a_warning(tmp_path) -> None:
    engine = FakeEngine()
    engine.program(PdfTriage, {"draft": "d", "visual_pages": [2]})
    engine.program(PdfAnswer, {"answer": "Normaliza (p. 2)."})
    state = _state(tmp_path, engine)
    _put(state, "a.pdf", ["Introduction", "softmax normalizes logits"])
    result, _ = await _run(state)
    assert result["pages_viewed"] == [] and result["pages_cited"] == [2]
    assert "não lê imagens" in result["warnings"][0]


async def test_vision_error_stops_vision_and_keeps_what_was_seen(tmp_path) -> None:
    engine = SeeingEngine([{"page": 1, "findings": "ok"}, EngineError("sem imagem")])
    engine.program(PdfTriage, {"draft": "d", "visual_pages": [1, 2, 3]})
    engine.program(PdfAnswer, {"answer": "Visto (p. 1)."})
    state = _state(tmp_path, engine)
    _put(state, "a.pdf", ["softmax one", "softmax two", "softmax three"])
    result, _ = await _run(state)
    assert result["pages_viewed"] == [1] and "p. 2" in result["warnings"][0]


async def test_invalid_citation_gets_one_correction_round(tmp_path) -> None:
    engine = SeeingEngine()
    engine.program(PdfTriage, {"draft": "d"})
    engine.program(PdfAnswer, [{"answer": "Errado (p. 9)."}, {"answer": "Certo (p. 2)."}])
    state = _state(tmp_path, engine)
    _put(state, "a.pdf", ["Introduction " * 20, "softmax normalizes logits " * 20])
    result, _ = await _run(state)
    assert result["answer"] == "Certo (p. 2)." and "warnings" not in result
    assert "[9]" in engine.structured_calls[2]["prompt"]


async def test_persisting_invalid_citation_is_filtered_and_warned(tmp_path) -> None:
    engine = SeeingEngine()
    engine.program(PdfTriage, {"draft": "d"})
    engine.program(PdfAnswer, {"answer": "Errado (p. 9).", "pages_cited": [9]})
    state = _state(tmp_path, engine)
    _put(state, "a.pdf", ["Introduction " * 20, "softmax normalizes logits " * 20])
    result, _ = await _run(state)
    assert result["pages_cited"] == [] and "[9]" in result["warnings"][0]


async def test_never_more_than_the_call_budget(tmp_path) -> None:
    engine = SeeingEngine([{"page": n, "findings": "x"} for n in range(1, 5)])
    engine.program(PdfTriage, {"draft": "d", "visual_pages": [1, 2, 3, 4, 5]})
    engine.program(PdfAnswer, {"answer": "Errado (p. 9)."})
    state = _state(tmp_path, engine)
    _put(state, "a.pdf", ["softmax"] * 6)
    await _run(state)
    assert len(engine.structured_calls) + len(engine.image_calls) == MAX_MODEL_CALLS
