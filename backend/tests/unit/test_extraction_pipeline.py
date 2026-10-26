"""Unit tests for the LangGraph Extraction Pipeline (Extractor -> Auditor -> Merger).

Verifies:
1. build_extraction_graph() compiles as a valid LangGraph CompiledStateGraph.
2. Running await run_extraction_pipeline(...) extracts ConceptNodes and LogicalChains
   from session text about "Multi-Head Attention e KV Cache".
3. Notes in Conceitos/*.md are created/merged non-destructively, preserving manual user text.
4. Logical chains are appended to .harness/chains.jsonl.
5. Cycle detection in auditor_node prevents self-dependencies, 2-node cycles, and N-node cycles.
6. 00 Mapa.md is updated non-destructively with new concept links.
"""

from __future__ import annotations

from pathlib import Path

import asyncio

import pytest
from langgraph.graph.state import CompiledStateGraph

from learnharness.core.contracts.graph import ConceptNode, LogicalChain
from learnharness.pipelines.extraction import (
    ExtractionState,
    auditor_node,
    build_extraction_graph,
    extractor_node,
    merger_node,
    run_extraction_pipeline,
)
from learnharness.vault.bootstrap import bootstrap_vault
from learnharness.vault.jsonl_store import load_chains
from learnharness.vault.markdown_ast import parse_concept_note

SAMPLE_SESSION_TEXT = """# Multi-Head Attention e KV Cache

## Multi-Head Attention
**Verdade incondicional / definição:** Mecanismo que divide as matrizes de consulta, chave e valor em h sub-espaços lineares paralelos para aprender correlações em diferentes dimensões simultaneamente.
Depende de:: [[Self-Attention]], [[Projeções Lineares]]
Usado em:: [[Transformer Decoder]], [[KV Cache]]

## KV Cache
**Verdade incondicional / definição:** Estrutura de retenção de memória dos tensores Key e Value dos passos de tempo anteriores para evitar recomputação durante geração autorregressiva.
Depende de:: [[Multi-Head Attention]]
Usado em:: [[Inferência Autorregressiva]]

## Mecanismo
Durante a fase de decodificação token-a-token, cada novo token precisa calcular atenção com todos os anteriores. Sem o KV Cache, a complexidade computacional total por sequência seria quadrática.

## Cadeias Lógicas
[[Self-Attention]] ∧ [[Projeções Lineares]] ⟹ [[Multi-Head Attention]]
[[Multi-Head Attention]] ∧ [[Inferência Autorregressiva]] ⟹ [[KV Cache]]
"""


class FakeExtractionEngine:
    async def run_structured(self, prompt, schema, **kwargs):
        parsed = await extractor_node({"session_id":"fixture", "topic":"Attention", "messages_text":SAMPLE_SESSION_TEXT})
        return schema.model_validate({
            "concepts": [n.model_dump() for n in parsed["candidate_nodes"]],
            "chains": [c.model_dump() for c in parsed["candidate_chains"]],
        })


# ============================================================================
# 1. Compilation & Structure Tests
# ============================================================================

def test_build_extraction_graph_compiles():
    """Verify build_extraction_graph compiles into a valid CompiledStateGraph."""
    graph = build_extraction_graph()
    assert graph is not None
    assert isinstance(graph, CompiledStateGraph)
    assert hasattr(graph, "ainvoke")
    assert hasattr(graph, "invoke")

    # Verify nodes exist in compiled graph
    node_names = set(graph.nodes.keys())
    assert "extractor" in node_names
    assert "auditor" in node_names
    assert "merger" in node_names


# ============================================================================
# 2. Node-level Unit Tests
# ============================================================================

@pytest.mark.asyncio
async def test_extractor_node_deterministic():
    """Verify extractor_node extracts candidate concepts and logical chains deterministically."""
    state: ExtractionState = {
        "session_id": "test-sess-1",
        "topic": "Multi-Head Attention e KV Cache",
        "messages_text": SAMPLE_SESSION_TEXT,
        "source_ref": "Fontes/Mentoria/aula-04.md#^p12",
    }

    result = await extractor_node(state)

    candidate_nodes = result["candidate_nodes"]
    candidate_chains = result["candidate_chains"]

    # Verify extracted concepts
    node_titles = {n.title: n for n in candidate_nodes}
    assert "Multi-Head Attention" in node_titles
    assert "KV Cache" in node_titles

    mha = node_titles["Multi-Head Attention"]
    assert "Self-Attention" in mha.depends_on
    assert "Projeções Lineares" in mha.depends_on
    assert "sub-espaços lineares" in mha.unconditional_truth
    assert mha.sources == ["Fontes/Mentoria/aula-04.md#^p12"]

    kv = node_titles["KV Cache"]
    assert "Multi-Head Attention" in kv.depends_on
    assert "retenção de memória" in kv.unconditional_truth

    # Verify extracted chains
    assert len(candidate_chains) >= 2
    chain_conclusions = {c.conclusion: c for c in candidate_chains}
    assert "Multi-Head Attention" in chain_conclusions
    assert "KV Cache" in chain_conclusions

    mha_chain = chain_conclusions["Multi-Head Attention"]
    assert "Self-Attention" in mha_chain.premises
    assert "Projeções Lineares" in mha_chain.premises


@pytest.mark.asyncio
async def test_auditor_node_cycle_and_self_dependency_detection(tmp_path: Path):
    """Verify auditor_node eliminates self-dependencies, 2-node cycles, and invalid chains."""
    vault = tmp_path / "AuditVault"
    bootstrap_vault(vault, language="pt-BR")

    # Candidate with a self-dependency
    node_a = ConceptNode(
        id="conceito-a",
        title="Conceito A",
        depends_on=["Conceito A", "Conceito B"],
    )

    # Candidate forming a 2-node cycle: A depends on B, B depends on A
    node_b = ConceptNode(
        id="conceito-b",
        title="Conceito B",
        depends_on=["Conceito A"],
    )

    # Invalid chain with self-implication: A ∧ B ⟹ A
    invalid_chain = LogicalChain(
        chain_id="chain-inv-1",
        premises=["Conceito A", "Conceito B"],
        conclusion="Conceito A",
        expression="Conceito A ∧ Conceito B ⟹ Conceito A",
    )

    # Valid chain: A ∧ B ⟹ Conceito C
    valid_chain = LogicalChain(
        chain_id="chain-val-1",
        premises=["Conceito A", "Conceito B"],
        conclusion="Conceito C",
        expression="Conceito A ∧ Conceito B ⟹ Conceito C",
    )

    state: ExtractionState = {
        "vault_path": str(vault),
        "candidate_nodes": [node_a, node_b],
        "candidate_chains": [invalid_chain, valid_chain],
    }

    result = await auditor_node(state)

    audited_nodes = result["audited_nodes"]
    audited_chains = result["audited_chains"]
    rejected_nodes = result["rejected_nodes"]
    rejected_chains = result["rejected_chains"]

    # 1. Self-dependency check: Conceito A must NOT depend on Conceito A
    node_a_audited = next(n for n in audited_nodes if n.id == "conceito-a")
    assert "Conceito A" not in node_a_audited.depends_on

    # 2. 2-Node Cycle check: Conceito A and Conceito B cannot mutually depend on each other
    node_b_audited = next(n for n in audited_nodes if n.id == "conceito-b")
    # One of the directions was accepted, the returning direction was rejected to keep DAG acyclic
    is_a_in_b = "Conceito A" in node_b_audited.depends_on
    is_b_in_a = "Conceito B" in node_a_audited.depends_on
    assert not (is_a_in_b and is_b_in_a), "Both A->B and B->A dependencies were accepted, forming a cycle!"
    assert len(rejected_nodes) >= 2  # 1 self-dependency + 1 cycle rejection

    # 3. Chains check: invalid self-implication was rejected, valid chain was preserved
    assert len(rejected_chains) == 1
    assert "Self-implication" in rejected_chains[0]["reason"]
    assert len(audited_chains) == 1
    assert audited_chains[0].conclusion == "Conceito C"


@pytest.mark.asyncio
async def test_auditor_node_multi_node_cycle(tmp_path: Path):
    """Verify auditor_node eliminates 3-node cycles (A -> B -> C -> A)."""
    vault = tmp_path / "Cycle3Vault"
    bootstrap_vault(vault, language="pt-BR")

    node_1 = ConceptNode(id="n1", title="N1", depends_on=["N2"])
    node_2 = ConceptNode(id="n2", title="N2", depends_on=["N3"])
    node_3 = ConceptNode(id="n3", title="N3", depends_on=["N1"])

    state: ExtractionState = {
        "vault_path": str(vault),
        "candidate_nodes": [node_1, node_2, node_3],
        "candidate_chains": [],
    }

    result = await auditor_node(state)
    audited = {n.title: n for n in result["audited_nodes"]}

    # Ensure no cycle N1 -> N2 -> N3 -> N1 exists
    # N3's dependency on N1 should have been rejected
    assert "N1" not in audited["N3"].depends_on
    assert len(result["rejected_nodes"]) >= 1


@pytest.mark.asyncio
async def test_merger_node_preserves_user_content(tmp_path: Path):
    """Verify merger_node non-destructively preserves user comments and manual sections."""
    vault = tmp_path / "MergeVault"
    bootstrap_vault(vault, language="pt-BR")

    # Pre-create a concept note with manual user notes
    concept_file = vault / "Conceitos" / "KV Cache.md"
    manual_content = """---
tags: [conceito]
status: aprendendo
fontes: []
criado: 2026-10-26
---
# KV Cache

**Verdade incondicional / definição:** Definição inicial manual

Depende de:: [[Multi-Head Attention]]
Usado em:: 

## Mecanismo

## Na prática
Minhas anotações manuais sobre economia de VRAM em batching dinâmico.
> [!note] Lembrar de verificar PagedAttention / vLLM.

## Onde as fontes divergem

## Como eu poderia ter descoberto isso

## Erros que eu cometi
- Erro manual número 1

## Desenhos
"""
    concept_file.write_text(manual_content, encoding="utf-8")

    # Create audited node with new mechanism summary and additional dependencies
    audited_kv = ConceptNode(
        id="kv-cache",
        title="KV Cache",
        status="sólido",
        unconditional_truth="Definição atualizada pelo agente",
        depends_on=["Multi-Head Attention", "PagedAttention"],
        used_in=["Inferência Autorregressiva"],
        sources=["Fontes/Mentoria/aula-04.md#^p10"],
        mechanism_summary="Alocação prévia de blocos K e V nos passos de geração.",
    )

    state: ExtractionState = {
        "vault_path": str(vault),
        "audited_nodes": [audited_kv],
        "audited_chains": [],
    }

    res = await merger_node(state)
    assert "kv-cache" in res["merged_node_ids"]

    # Verify file content
    merged_text = concept_file.read_text(encoding="utf-8")

    # Invariant: user-written notes and callouts MUST be 100% preserved
    assert "Minhas anotações manuais sobre economia de VRAM em batching dinâmico." in merged_text
    assert "> [!note] Lembrar de verificar PagedAttention / vLLM." in merged_text
    assert "- Erro manual número 1" in merged_text

    # Verify agent updates were merged
    assert "[[PagedAttention]]" in merged_text
    assert "[[Multi-Head Attention]]" in merged_text


# ============================================================================
# 3. End-to-End Pipeline Tests
# ============================================================================

@pytest.mark.asyncio
async def test_run_extraction_pipeline_end_to_end(tmp_path: Path):
    """End-to-end test of run_extraction_pipeline on Multi-Head Attention and KV Cache."""
    vault = tmp_path / "E2EVault"
    bootstrap_vault(vault, language="pt-BR")

    progress_log: list[tuple[str, float]] = []

    def on_progress(label: str, pct: float) -> None:
        progress_log.append((label, pct))

    result = await run_extraction_pipeline(
        vault_path=vault,
        engine=FakeExtractionEngine(),
        session_id="session-attn-kv",
        topic="Multi-Head Attention e KV Cache",
        messages_text=SAMPLE_SESSION_TEXT,
        source_ref="Fontes/Mentoria/aula-04.md#^p1",
        on_progress=on_progress,
    )

    # 1. Pipeline result checks
    assert result["status"] == "completed"
    assert "multi-head-attention" in result["merged_node_ids"]
    assert "kv-cache" in result["merged_node_ids"]
    assert len(result["merged_chain_ids"]) >= 2

    # 2. Check concept files on disk
    mha_file = vault / "Conceitos" / "Multi-Head Attention.md"
    kv_file = vault / "Conceitos" / "KV Cache.md"
    assert mha_file.is_file()
    assert kv_file.is_file()

    mha_node = parse_concept_note(mha_file)
    assert mha_node.title == "Multi-Head Attention"
    assert "Self-Attention" in mha_node.depends_on
    assert "Projeções Lineares" in mha_node.depends_on
    assert "sub-espaços lineares" in mha_node.unconditional_truth

    kv_node = parse_concept_note(kv_file)
    assert kv_node.title == "KV Cache"
    assert "Multi-Head Attention" in kv_node.depends_on

    # 3. Check chains appended to .harness/chains.jsonl
    chains = load_chains(vault)
    assert len(chains) >= 2
    chain_exprs = [c.expression for c in chains]
    assert any("Self-Attention" in e and "Multi-Head Attention" in e for e in chain_exprs)
    assert any("KV Cache" in e for e in chain_exprs)

    # 4. Check 00 Mapa.md updated
    map_file = vault / "00 Mapa.md"
    map_text = map_file.read_text(encoding="utf-8")
    assert "[[Multi-Head Attention]]" in map_text
    assert "[[KV Cache]]" in map_text

    # 5. Check progress reporting
    assert len(progress_log) >= 3
    assert progress_log[-1][1] == 1.0


@pytest.mark.asyncio
async def test_run_extraction_pipeline_preserves_existing_concept_in_vault(tmp_path: Path):
    """Verify end-to-end extraction preserves pre-existing user concept note."""
    vault = tmp_path / "NonDestructiveE2E"
    bootstrap_vault(vault, language="pt-BR")

    # User wrote an early concept note with custom notes
    mha_file = vault / "Conceitos" / "Multi-Head Attention.md"
    mha_file.write_text(
        """---
tags: [conceito]
status: aprendendo
fontes: []
criado: 2026-10-20
---
# Multi-Head Attention

**Verdade incondicional / definição:** Minha intuição primitiva

Depende de:: [[Self-Attention]]
Usado em:: 

## Mecanismo

## Na prática
Aqui está minha anotação de benchmark: 8 cabeças d_k=64 vs 1 cabeça d_model=512.
> [!important] Nunca apague meu benchmark!

## Onde as fontes divergem

## Como eu poderia ter descoberto isso

## Erros que eu cometi
- Erro no reshape de tensores antes da multiplicação de matrizes

## Desenhos
""",
        encoding="utf-8",
    )

    await run_extraction_pipeline(
        vault_path=vault,
        engine=FakeExtractionEngine(),
        session_id="session-attn-update",
        topic="Multi-Head Attention e KV Cache",
        messages_text=SAMPLE_SESSION_TEXT,
    )

    updated_text = mha_file.read_text(encoding="utf-8")

    # Invariants: manual text and callout intact
    assert "Aqui está minha anotação de benchmark: 8 cabeças d_k=64 vs 1 cabeça d_model=512." in updated_text
    assert "> [!important] Nunca apague meu benchmark!" in updated_text
    assert "- Erro no reshape de tensores antes da multiplicação de matrizes" in updated_text

    # Dependencies merged
    assert "[[Projeções Lineares]]" in updated_text
    assert "[[Self-Attention]]" in updated_text


async def test_failure_propagates_without_checkpoint_fallback(tmp_path):
    bootstrap_vault(tmp_path, language="pt-BR")
    class BrokenEngine:
        async def run_structured(self, **kwargs):
            raise RuntimeError("provider failed")
    with pytest.raises(RuntimeError, match="provider failed"):
        await asyncio.wait_for(run_extraction_pipeline(tmp_path, "failure", "topic", "evidence", engine=BrokenEngine()), 3)
    assert not list((tmp_path / "Conceitos").glob("*.md"))


async def test_repeat_extraction_deduplicates_chains(tmp_path):
    bootstrap_vault(tmp_path, language="pt-BR")
    for _ in range(2):
        await asyncio.wait_for(run_extraction_pipeline(tmp_path, "same-source", "Attention", SAMPLE_SESSION_TEXT, engine=FakeExtractionEngine()), 3)
    chains = load_chains(tmp_path)
    assert len(chains) == 2
    assert (tmp_path / ".harness/langgraph.sqlite").exists()


async def test_no_fabrication_from_topic_without_evidence():
    result = await extractor_node({"topic":"Made up topic", "messages_text":""})
    assert result["candidate_nodes"] == []
    assert result["candidate_chains"] == []
