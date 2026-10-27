"""Track generation guard: a listed syllabus collapsed into one item is retried, then refused.

Regression for a real agy run (gemini-3.8-flash-low) that turned a nine-topic Cálculo I
syllabus into the single item "MAT0111 Learning Track Generation" (twice out of four runs).
"""

from __future__ import annotations

import pytest

from learnharness.services.track_generation import (
    GeneratedTrack,
    generate_track_items,
    is_degenerate,
    listed_topics,
)
from learnharness.services.tracks import GeneratedTrack as ReExported
from tests.conftest import FakeEngine

EMENTA = """MAT0111 Cálculo Diferencial e Integral I
Ementa: Limites, continuidade, derivada, integral.
Programa:
1. Números reais: desigualdades, valor absoluto.
2. Funções: domínio, imagem, composição, inversa.
3. Limites: definição intuitiva e formal (épsilon-delta).
4. Continuidade: Teorema do Valor Intermediário.
5. Derivada: regras de derivação, regra da cadeia.
6. Integral: somas de Riemann, Teorema Fundamental do Cálculo.
"""

COLLAPSED = {"items": [{"id": "mat0111-revisao-consolidacao", "title": "MAT0111 Learning Track Generation"}]}
FULL = {"items": [{"id": f"t{i}", "title": f"Tópico {i}", "prerequisites": [f"t{i - 1}"] if i > 1 else []}
                  for i in range(1, 7)]}


def test_listed_topics_counts_numbered_bulleted_and_roman_lines():
    assert listed_topics(EMENTA) == 6
    assert listed_topics("- Vetores\n* Matrizes\n• Determinantes\nIV. Autovalores\n2) Bases") == 5
    assert listed_topics("Aprender estatística") == 0
    assert listed_topics("Ementa: Probabilidade\n" + "Conteúdo programático. " * 200) == 0


def test_degenerate_only_when_the_material_lists_topics():
    one = GeneratedTrack.model_validate(COLLAPSED)
    assert is_degenerate(one, EMENTA)
    assert not is_degenerate(one, "Aprender estatística")  # a short goal may be one step
    assert not is_degenerate(GeneratedTrack.model_validate(FULL), EMENTA)
    assert ReExported is GeneratedTrack


async def test_collapsed_reply_is_retried_with_a_correction():
    engine = FakeEngine().program(GeneratedTrack, [COLLAPSED, FULL])
    result = await generate_track_items(engine, None, "pt-BR", EMENTA, syllabus=EMENTA)
    assert [i.id for i in result.items] == [f"t{i}" for i in range(1, 7)]
    first, second = (c["prompt"] for c in engine.structured_calls)
    assert "Language: pt-BR" in first and EMENTA in first
    assert "never a single item that describes this task" in first
    assert second.startswith(first) and "MAT0111 Learning Track Generation" in second
    assert "syllabus above lists 6 topics" in second


async def test_a_second_collapsed_reply_fails_the_generation():
    engine = FakeEngine().program(GeneratedTrack, [COLLAPSED, COLLAPSED])
    with pytest.raises(ValueError, match="1 item"):
        await generate_track_items(engine, None, "pt-BR", EMENTA, syllabus=EMENTA)
    assert len(engine.structured_calls) == 2


async def test_a_good_first_reply_is_not_retried():
    engine = FakeEngine().program(GeneratedTrack, [FULL])
    await generate_track_items(engine, None, "pt-BR", EMENTA, syllabus=EMENTA)
    assert len(engine.structured_calls) == 1


async def test_a_repository_outline_does_not_count_as_listed_topics():
    outline = "CURRICULUM REPOSITORY\n" + "\n".join(f"- lessons/{i:02}.md — Lição {i}" for i in range(1, 9))
    engine = FakeEngine().program(GeneratedTrack, [COLLAPSED])
    result = await generate_track_items(engine, None, "pt-BR", outline, syllabus="")
    assert len(result.items) == 1 and len(engine.structured_calls) == 1
