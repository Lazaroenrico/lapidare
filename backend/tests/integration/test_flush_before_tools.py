"""Prose streamed right before a plan change must be filed under the node it was written for."""

import asyncio

from learnharness.api.state import AppState
from tests.conftest import FakeEngine, configure_vault, tool


async def test_prose_before_plan_advance_stays_in_its_node(tmp_path):
    vault = configure_vault(tmp_path / "Vault")
    engine = FakeEngine().script_turn(
        tool("plan_init", approach_prose="Dois blocos.", nodes=[
            {"id": "a", "label": "Bloco A", "kind": "unconditional_truth"},
            {"id": "b", "label": "Bloco B", "kind": "goal"},
        ]),
        "Abertura. ",
        "Explicação exclusiva do bloco A.",  # buffered: < 0.2s after the previous flush
        tool("plan_advance", node_id="b", status="current"),
        "Explicação exclusiva do bloco B.",
    )
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    session = await state.sessions.create(mode="TEACH", topic="Blocos", start=False)
    await state.sessions.run(session.id)
    note = (vault / state.sessions.get(session.id).lesson_vault_path).read_text(encoding="utf-8")
    section_a = note.split("## Bloco A", 1)[1].split("## Bloco B", 1)[0]
    section_b = note.split("## Bloco B", 1)[1]
    assert "Explicação exclusiva do bloco A." in section_a
    assert "Explicação exclusiva do bloco A." not in section_b
    assert "Explicação exclusiva do bloco B." in section_b
    await asyncio.sleep(0)
