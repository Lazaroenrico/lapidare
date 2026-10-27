"""Pure folding/merging rules of the knowledge trace (core.graph_merge, Fase 8B)."""

from __future__ import annotations

import itertools

from learnharness.core.contracts.graph import (
    AuditLink,
    AuditPayload,
    BatchMessage,
    ChainRecord,
    CoverageRecord,
    ExtractedChain,
    ExtractedProposition,
    ExtractionPayload,
    PropositionNode,
    Provenance,
)
from learnharness.core.graph_merge import (
    candidate_matches,
    coverage_index,
    estimate_tokens,
    fingerprint,
    fold_chains,
    fold_nodes,
    format_graph_context,
    is_redundant,
    plan_merge,
    select_batch,
    uncovered_messages,
)

A = "n_aaaaaaaaaaaa"
B = "n_bbbbbbbbbbbb"
C = "n_cccccccccccc"


def _creation(node_id: str, name: str, statement: str = "s", session: str = "s1") -> dict:
    return {"id": node_id, "name": name, "statement": statement, "aliases": [], "created_at": "t0",
            "provenance": [{"session_id": session, "message_id": "m1"}], "vault_rel_path": ""}


def _ids():
    counter = itertools.count(1)
    return lambda prefix: f"{prefix}_{next(counter):012x}"


def test_link_append_unions_aliases_and_provenance() -> None:
    nodes = fold_nodes([
        _creation(A, "Produto escalar"),
        {"id": A, "aliases": ["Produto interno", "produto escalar"], "provenance": [{"session_id": "s2", "message_id": "m9"}]},
        {"id": A, "aliases": ["Produto Interno"], "provenance": [{"session_id": "s1", "message_id": "m1"}]},
        {"id": A, "vault_rel_path": "Conceitos/Produto escalar.md", "note_created": True},
    ])
    node = nodes[A]
    assert node.aliases == ["Produto interno"]  # the name itself and case-duplicates are not aliases
    assert node.provenance == [Provenance(session_id="s1", message_id="m1"), Provenance(session_id="s2", message_id="m9")]
    assert node.vault_rel_path == "Conceitos/Produto escalar.md" and node.note_created


def test_tombstone_hides_node_and_ignores_later_appends() -> None:
    nodes = fold_nodes([_creation(A, "A"), _creation(B, "B"), {"id": A, "deleted": True},
                        {"id": A, "aliases": ["back"]}, {"id": "broken"}, {"no": "id"}])
    assert list(nodes) == [B]


def test_chains_merge_by_signature_and_drop_dead_references() -> None:
    chains = fold_chains([
        {"id": "arg_1", "premises": [A, B], "conclusion": C, "provenance": [{"session_id": "s1"}], "created_at": "t1"},
        {"id": "arg_2", "premises": [B, A], "conclusion": C, "provenance": [{"session_id": "s2"}], "created_at": "t2"},
        {"id": "arg_3", "premises": [A], "conclusion": B, "provenance": [], "created_at": "t3"},
        {"id": "arg_3", "deleted": True},
        {"id": "arg_4", "premises": ["n_gone00000000"], "conclusion": C, "provenance": [], "created_at": "t4"},
    ], live_node_ids={A, B, C})
    assert len(chains) == 1
    merged = chains[0]
    assert merged.id == "arg_1" and merged.created_at == "t1"
    assert {p.session_id for p in merged.provenance} == {"s1", "s2"}


def test_redundant_chains_are_discarded() -> None:
    existing = [ChainRecord(id="arg_1", premises=[A], conclusion=C)]
    assert is_redundant([A], C, existing)  # same premises and conclusion
    assert is_redundant([A, B], C, existing)  # superset of an existing chain's premises
    assert not is_redundant([B], C, existing)
    assert not is_redundant([A], B, existing)

    nodes = fold_nodes([_creation(A, "A"), _creation(B, "B"), _creation(C, "C")])
    extraction = ExtractionPayload(chains=[
        ExtractedChain(premises=[A, B], conclusion=C),  # superset -> redundant
        ExtractedChain(premises=[B], conclusion=C),
        ExtractedChain(premises=[B, B], conclusion=C),  # same as the previous one in this batch
        ExtractedChain(premises=[C], conclusion=C),  # self-implication
        ExtractedChain(premises=["p9"], conclusion=C),  # unknown key
    ])
    plan = plan_merge(extraction, AuditPayload(), nodes, existing, "s1", [], "now", _ids())
    assert [(c.premises, c.conclusion) for c in plan.new_chains] == [([B], C)]
    assert [r["reason"] for r in plan.rejected_chains] == ["redundant", "redundant", "self-implication", "unknown reference"]


def test_plan_merge_resolves_keys_links_and_coverage() -> None:
    nodes = fold_nodes([_creation(A, "Produto escalar", "Soma dos produtos das coordenadas.")])
    batch = [BatchMessage(message_id="m5", content="texto", fp=fingerprint("texto"), tokens=1)]
    extraction = ExtractionPayload(
        propositions=[
            ExtractedProposition(key="p1", name="Produto interno", statement="Paráfrase.", message_id="m5"),
            ExtractedProposition(key="p2", name="Atenção", statement="Pondera valores.", aliases=["Attention"]),
            ExtractedProposition(key="p3", name="atenção", statement="Duplicata no lote."),
        ],
        chains=[ExtractedChain(premises=["p1"], conclusion="p2")],
    )
    audit = AuditPayload(links=[AuditLink(key="p1", link_to=A), AuditLink(key="p2", link_to=None)])
    plan = plan_merge(extraction, audit, nodes, [], "s2", batch, "now", _ids())

    assert plan.key_to_id["p1"] == A
    assert plan.link_appends == [{"id": A, "aliases": ["Produto interno"],
                                  "provenance": [{"session_id": "s2", "message_id": "m5"}]}]
    assert len(plan.new_nodes) == 1  # p3 is the same name as p2 within the batch
    new = plan.new_nodes[0]
    assert plan.key_to_id["p2"] == plan.key_to_id["p3"] == new.id
    assert new.aliases == ["Attention"] and new.provenance == [Provenance(session_id="s2", message_id="m5")]
    assert [(c.premises, c.conclusion) for c in plan.new_chains] == [([A], new.id)]
    assert plan.coverage == [CoverageRecord(session_id="s2", message_id="m5", fp=fingerprint("texto"), tokens=1, at="now")]
    assert set(plan.touched_node_ids) == {A, new.id}


def test_coverage_by_fingerprint_and_greedy_batch() -> None:
    messages = [
        ("m1", "assistant", "a" * 400),
        ("m2", "user", "pergunta"),
        ("m3", "assistant", "b" * 400),
        ("m4", "assistant", "c" * 4000),
        ("m5", "assistant", "streaming"),
    ]
    coverage = coverage_index([CoverageRecord(session_id="s", message_id="m1", fp=fingerprint("a" * 400)),
                               CoverageRecord(session_id="s", message_id="m3", fp=fingerprint("old text"))])
    pending = uncovered_messages("s", messages, coverage, exclude={"m5"})
    # m1 is covered; m3 changed since it was read; user prose never counts.
    assert [m.message_id for m in pending] == ["m3", "m4"]
    assert pending[0].tokens == estimate_tokens("b" * 400) == 100
    assert [m.message_id for m in select_batch(pending, 500)] == ["m3"]
    assert [m.message_id for m in select_batch(pending[1:], 10)] == ["m4"]  # an oversized message still goes
    assert uncovered_messages("other", messages[:1], coverage)[0].message_id == "m1"  # coverage is per session


def test_candidate_prefilter_ranks_token_overlap() -> None:
    nodes = {
        A: PropositionNode(id=A, name="Produto escalar", statement="Soma dos produtos coordenada a coordenada."),
        B: PropositionNode(id=B, name="Softmax", statement="Normaliza escores em probabilidades."),
        C: PropositionNode(id=C, name="Escalar", statement="Um número."),
    }
    ranked = candidate_matches("Produto escalar de vetores", "Soma dos produtos das coordenadas.", nodes)
    assert ranked[0] == A and B not in ranked
    assert candidate_matches("??", "", nodes) == []


def test_graph_context_lists_propositions_and_chains_among_them() -> None:
    a = PropositionNode(id=A, name="A", statement="sa")
    b = PropositionNode(id=B, name="B", statement="sb")
    chains = [ChainRecord(id="arg_1", premises=[A], conclusion=B),
              ChainRecord(id="arg_2", premises=[A], conclusion=C)]
    text = format_graph_context([a, b], chains)
    assert f"[{A}] A: sa" in text and f"[{B}] B: sb" in text
    assert "do not re-teach" in text
    assert "[arg_1] A ⟹ B" in text and "arg_2" not in text
    assert "PRACTICE MATERIAL" in format_graph_context([a], chains, practice=True)
    assert format_graph_context([], chains) == ""
