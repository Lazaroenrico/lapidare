"""Extraction pipeline (Fase 8B): Extractor -> Auditor -> Merger over a TEACH session.

Uses the scripted ``FakeEngine``: every structured answer is programmed by the test.
Covers: graph compilation, extraction into ``.harness/graph/`` + ``Conceitos/`` notes,
paraphrase fusion by the auditor, adoption of an existing user note without losing
text, "nothing new -> no engine call", and failure propagation.

The previous concept/dependency pipeline (``depends_on``/``used_in`` DAG with cycle
detection, ``parse_structured_markdown`` and the ``00 Mapa.md`` region) was removed on
purpose: the trace is now propositions + implication chains.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from langgraph.graph.state import CompiledStateGraph

from learnharness.api.state import AppState
from learnharness.core.contracts.graph import AuditPayload, ExtractionPayload
from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.core.graph_merge import coverage_index, select_batch, uncovered_messages
from learnharness.pipelines.extraction import (
    build_extraction_graph,
    extractor_node,
    run_extraction_pipeline,
)
from learnharness.vault.graph_store import load_coverage, load_graph_chains, load_nodes
from learnharness.vault.jsonl_store import append_session_event
from learnharness.vault.markdown_ast import read_frontmatter
from tests.conftest import FakeEngine, configure_vault

DOT = "O produto escalar soma os produtos coordenada a coordenada e mede alinhamento entre vetores."
ATT = "A atenção pondera os valores pelo softmax dos produtos escalares entre consulta e chave."

EXTRACTED = {
    "propositions": [
        {"key": "p1", "name": "Produto escalar", "statement": "O produto escalar soma os produtos das coordenadas.",
         "aliases": ["Dot product"], "message_id": "msg-1"},
        {"key": "p2", "name": "Atenção pondera valores", "statement": "A atenção pondera valores pelo softmax.",
         "message_id": "msg-2"},
    ],
    "chains": [{"premises": ["p1"], "conclusion": "p2"}],
}


def _session(vault: Path, session_id: str = "sess-1", texts=(DOT, ATT), title: str = "Atenção") -> SessionRecord:
    record = SessionRecord(
        id=session_id, title=title, lesson_vault_path=f"Aulas/2026-10-27 {title}.md",
        messages=[SessionMessage(id=f"msg-{i}", role="assistant", content=t, created_at="t")
                  for i, t in enumerate(texts, start=1)]
        + [SessionMessage(id="u-1", role="user", content="Não sei.", created_at="t")],
    )
    append_session_event(vault, session_id, record)
    return record


def _batch(vault: Path, session: SessionRecord, budget: int = 4096):
    index = coverage_index(load_coverage(vault))
    return select_batch(uncovered_messages(session.id, ((m.id, m.role, m.content) for m in session.messages), index), budget)


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    return configure_vault(tmp_path / "Vault")


def test_build_extraction_graph_compiles() -> None:
    graph = build_extraction_graph()
    assert isinstance(graph, CompiledStateGraph)
    assert {"extractor", "auditor", "merger"} <= set(graph.nodes)


async def test_extracts_into_graph_coverage_and_notes(vault: Path) -> None:
    session = _session(vault)
    engine = FakeEngine().program(ExtractionPayload, EXTRACTED)
    result = await run_extraction_pipeline(vault, session.id, _batch(vault, session), engine=engine,
                                           slot="bg", session_title=session.title)

    nodes = load_nodes(vault)
    assert len(nodes) == 2 and set(result["new_node_ids"]) == set(nodes)
    dot = next(n for n in nodes.values() if n.name == "Produto escalar")
    att = next(n for n in nodes.values() if n.name == "Atenção pondera valores")
    assert dot.id.startswith("n_") and len(dot.id) == 14
    assert dot.aliases == ["Dot product"]
    assert [(p.session_id, p.message_id) for p in dot.provenance] == [("sess-1", "msg-1")]
    chains = load_graph_chains(vault, set(nodes))
    assert [(c.premises, c.conclusion) for c in chains] == [([dot.id], att.id)]
    assert chains[0].id.startswith("arg_")
    assert {c.message_id for c in load_coverage(vault)} == {"msg-1", "msg-2"}  # user prose is never covered

    # The extractor saw the labelled teacher messages; no auditor call on an empty graph.
    assert [c["schema"] for c in engine.structured_calls] == [ExtractionPayload]
    call = engine.structured_calls[0]
    assert "TEACHER [msg-1]" in call["prompt"] and "TEACHER [msg-2]" in call["prompt"]
    assert "Não sei." not in call["prompt"] and call["slot"] == "bg"
    assert "Never record the learner's state" in call["system_instruction"]

    note = (vault / dot.vault_rel_path).read_text(encoding="utf-8")
    assert dot.vault_rel_path == "Conceitos/Produto escalar.md" and dot.note_created
    fm = read_frontmatter(note)
    assert fm["harness_id"] == dot.id and fm["aliases"] == ["Dot product"] and fm["sessions"] == ["sess-1"]
    assert "**Afirmação:** O produto escalar soma os produtos das coordenadas." in note
    assert "**Origem:** [[Aulas/2026-10-27 Atenção]]" in note
    att_note = (vault / att.vault_rel_path).read_text(encoding="utf-8")
    assert "**Premissas:**\n- [[Produto escalar]]" in att_note


async def test_auditor_fuses_paraphrase_across_sessions(vault: Path) -> None:
    first = _session(vault)
    await run_extraction_pipeline(vault, first.id, _batch(vault, first),
                                  engine=FakeEngine().program(ExtractionPayload, EXTRACTED))
    dot_id = next(n.id for n in load_nodes(vault).values() if n.name == "Produto escalar")

    second = _session(vault, "sess-2", ("Produto interno: soma dos produtos das coordenadas dos vetores.",),
                      title="Vetores")
    engine = FakeEngine()
    engine.program(ExtractionPayload, {"propositions": [
        {"key": "p1", "name": "Produto interno", "statement": "A soma dos produtos das coordenadas de dois vetores.",
         "message_id": "msg-1"}]})
    engine.program(AuditPayload, lambda prompt: {"links": [{"key": "p1", "link_to": dot_id}]})
    result = await run_extraction_pipeline(vault, second.id, _batch(vault, second), engine=engine)

    nodes = load_nodes(vault)
    assert len(nodes) == 2 and result["new_node_ids"] == [] and result["linked_node_ids"] == [dot_id]
    dot = nodes[dot_id]
    assert "Produto interno" in dot.aliases
    assert {p.session_id for p in dot.provenance} == {"sess-1", "sess-2"}
    audit_call = engine.structured_calls[1]
    assert audit_call["schema"] is AuditPayload and f"[{dot_id}] Produto escalar" in audit_call["prompt"]
    note = (vault / dot.vault_rel_path).read_text(encoding="utf-8")
    fm = read_frontmatter(note)
    assert fm["sessions"] == ["sess-1", "sess-2"] and "Produto interno" in fm["aliases"]
    assert "[[Aulas/2026-10-27 Vetores]]" in note


async def test_exact_name_links_without_auditor_call(vault: Path) -> None:
    first = _session(vault)
    await run_extraction_pipeline(vault, first.id, _batch(vault, first),
                                  engine=FakeEngine().program(ExtractionPayload, EXTRACTED))
    second = _session(vault, "sess-2", ("O produto escalar outra vez.",))
    engine = FakeEngine().program(ExtractionPayload, {"propositions": [
        {"key": "p1", "name": "produto ESCALAR", "statement": "Outra redação."}]})
    await run_extraction_pipeline(vault, second.id, _batch(vault, second), engine=engine)
    assert len(load_nodes(vault)) == 2
    assert [c["schema"] for c in engine.structured_calls] == [ExtractionPayload]


async def test_existing_user_note_is_adopted_without_losing_text(vault: Path) -> None:
    user_note = vault / "Conceitos" / "Produto Escalar.md"
    original = ("---\ntags: [conceito]\naliases: [Dot]\ncriado: 2024-01-01 # meu\n---\n# Produto Escalar\n\n"
                "Minha definição própria.\n\n> [!note] Não apagar.\n")
    user_note.write_text(original, encoding="utf-8")
    session = _session(vault)
    await run_extraction_pipeline(vault, session.id, _batch(vault, session),
                                  engine=FakeEngine().program(ExtractionPayload, EXTRACTED))

    dot = next(n for n in load_nodes(vault).values() if n.name == "Produto escalar")
    assert dot.vault_rel_path == "Conceitos/Produto Escalar.md" and not dot.note_created
    assert not (vault / "Conceitos" / "Produto escalar.md").exists()
    assert not (vault / "Conceitos" / "Produto escalar (2).md").exists()
    text = user_note.read_text(encoding="utf-8")
    assert "Minha definição própria.\n\n> [!note] Não apagar.\n" in text
    assert "criado: 2024-01-01 # meu" in text
    fm = read_frontmatter(text)
    assert fm["harness_id"] == dot.id and fm["aliases"] == ["Dot", "Dot product"]
    assert "**Afirmação:**" in text


async def test_second_run_without_new_text_extracts_nothing(vault: Path) -> None:
    session = _session(vault)
    engine = FakeEngine().program(ExtractionPayload, EXTRACTED)
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    try:
        first = await state.graph.extract_session(session.id)
        assert first["batches"] == 1 and len(first["new_node_ids"]) == 2
        second = await state.graph.extract_session(session.id)
        assert second["batches"] == 0 and second["new_node_ids"] == []
        assert len(engine.structured_calls) == 1
    finally:
        await state.close()


async def test_drains_uncovered_prose_in_budgeted_batches(vault: Path) -> None:
    session = _session(vault, texts=("a" * 400, "b" * 400, "c" * 400))
    engine = FakeEngine().program(ExtractionPayload, {"propositions": []})
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    config = state.get_config()
    config.graph.extraction_chunk_tokens = 200
    from learnharness.vault.bootstrap import save_config
    save_config(vault, config)
    try:
        summary = await state.graph.extract_session(session.id)
    finally:
        await state.close()
    assert summary["batches"] == 2  # 100 + 100 tokens, then 100
    assert len(load_coverage(vault)) == 3


async def test_failure_propagates_and_writes_nothing(vault: Path) -> None:
    session = _session(vault)
    engine = FakeEngine().program(ExtractionPayload, RuntimeError("provider failed"))
    with pytest.raises(RuntimeError, match="provider failed"):
        await run_extraction_pipeline(vault, session.id, _batch(vault, session), engine=engine)
    assert load_nodes(vault) == {} and load_coverage(vault) == []
    assert not list((vault / "Conceitos").glob("*.md"))


async def test_pipeline_requires_engine(vault: Path) -> None:
    with pytest.raises(ValueError, match="configured engine"):
        await run_extraction_pipeline(vault, "s", [], engine=None)
    with pytest.raises(ValueError, match="configured engine"):
        await extractor_node({"vault_path": str(vault), "session_id": "s", "batch": []}, {"configurable": {}})


async def test_extractor_prompt_shows_session_graph_so_far(vault: Path) -> None:
    session = _session(vault)
    await run_extraction_pipeline(vault, session.id, _batch(vault, session),
                                  engine=FakeEngine().program(ExtractionPayload, EXTRACTED))
    later = _session(vault, texts=(DOT, ATT, "Mais texto sobre atenção multi-cabeça."))
    engine = FakeEngine().program(ExtractionPayload, {"propositions": []})
    await run_extraction_pipeline(vault, later.id, _batch(vault, later), engine=engine)
    prompt = engine.structured_calls[0]["prompt"]
    dot_id = next(n.id for n in load_nodes(vault).values() if n.name == "Produto escalar")
    assert f"[{dot_id}] Produto escalar" in prompt
    assert "Produto escalar ⟹ Atenção pondera valores" in prompt
    assert "TEACHER [msg-3]" in prompt and "TEACHER [msg-1]" not in prompt  # covered prose is not re-read
