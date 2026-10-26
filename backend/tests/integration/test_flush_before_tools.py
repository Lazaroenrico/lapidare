"""Prose streamed right before a plan change must be filed under the node it was written for."""

import asyncio

from learnharness.api.state import AppState
from learnharness.core.contracts.quiz import QuizSubmission
from tests.conftest import FakeEngine, configure_vault, tool, wait_until

PREDICT_B = {"type": "predict", "node_id": "b", "question": "O que vem depois?", "options": ["x", "y"],
             "explanation": "y segue de A.", "correct": "B"}


async def test_prose_before_a_node_question_stays_in_its_node(tmp_path):
    vault = configure_vault(tmp_path / "Vault")
    engine = FakeEngine().script_turn(
        tool("probe_done", strands=[{"strand": "blocos", "assessment": "Conhece A."}]),
        tool("plan_init", approach_prose="Dois blocos.", mermaid="graph TD\n  a[Bloco A] --> b[Bloco B]"),
        "Abertura. ",
        "Explicação exclusiva do bloco A.",  # buffered: < 0.2s after the previous flush
        tool("quiz", **PREDICT_B),  # The first question on b makes b current.
        "Explicação exclusiva do bloco B.",
    )
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    session = await state.sessions.create(mode="TEACH", topic="Blocos", start=False)
    run = asyncio.create_task(state.sessions.run(session.id))
    quiz = await wait_until(lambda: state.sessions.get(session.id).pending_quiz)
    await state.sessions.answer(QuizSubmission(quiz_id=quiz.quiz_id, session_id=session.id,
                                               chosen_indices=[1], confidence=70))
    await asyncio.wait_for(run, 3)
    note = (vault / state.sessions.get(session.id).lesson_vault_path).read_text(encoding="utf-8")
    section_a = note.split("## Bloco A", 1)[1].split("## Bloco B", 1)[0]
    section_b = note.split("## Bloco B", 1)[1]
    assert "Explicação exclusiva do bloco A." in section_a
    assert "Explicação exclusiva do bloco A." not in section_b
    assert "Explicação exclusiva do bloco B." in section_b
    await state.close()
