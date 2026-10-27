"""Unit tests for the Vault & Bidirectional Sync Engine.

Tests Case A (fresh vault creation), Case B (non-destructive adoption of existing vault),
surgical non-destructive Markdown AST merges, Fontes/ read-only enforcement,
Excalidraw retrieval drawing creation/codec, transcript importer with ^pN citations,
append-only JSONL storage, and 2D graph snapshot generation.

CRITICAL INVARIANT: NEVER writes to the user's real vault; all tests use tmp_path.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from learnharness.core.contracts.graph import LogicalChain
from learnharness.core.contracts.quiz import CalibrationResult
from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.vault.bootstrap import (
    bootstrap_vault,
    load_config,
)
from learnharness.vault.excalidraw import (
    create_retrieval_drawing,
    load_drawing,
    save_drawing,
)
from learnharness.vault.jsonl_store import (
    append_chain,
    append_quiz_log,
    append_session_event,
    build_graph_snapshot,
    load_chains,
    load_quiz_logs,
    load_session,
)
from learnharness.vault.markdown_ast import (
    merge_concept_note,
    merge_lesson_note,
    parse_concept_note,
)
from learnharness.vault.transcript_importer import (
    get_source_paragraph,
    import_transcript_text,
)
from learnharness.vault.watcher import affects_graph, is_ignored_path

# ============================================================================
# 1. BOOTSTRAP TESTS (Case A and Case B)
# ============================================================================

def test_bootstrap_new_vault_case_a(tmp_path: Path):
    """Case A: Bootstrap in an empty directory creates the complete structure."""
    vault = tmp_path / "NewVault"
    vault.mkdir()

    config = bootstrap_vault(vault, language="pt-BR")

    assert config.configured is True
    assert config.language == "pt-BR"
    assert config.folders.map_file == "00 Mapa.md"
    assert config.folders.lessons_dir == "Aulas"
    assert config.folders.concepts_dir == "Conceitos"

    # Verify directory tree
    assert (vault / "Aulas" / "Mentoria").is_dir()
    assert (vault / "Aulas" / "Currículo").is_dir()
    assert (vault / "Aulas" / "Livre").is_dir()
    assert (vault / "Conceitos").is_dir()
    assert (vault / "Fontes" / "Mentoria").is_dir()
    assert (vault / "Desenhos").is_dir()
    assert (vault / "Sessões").is_dir()
    assert (vault / "Templates" / "Aula.md").is_file()
    assert (vault / "Templates" / "Conceito.md").is_file()
    assert (vault / "00 Mapa.md").is_file()
    assert (vault / ".harness" / "config.json").is_file()

    # Verify config round-trip
    loaded = load_config(vault)
    assert loaded.vault_path == str(vault)
    assert loaded.language == "pt-BR"


def test_bootstrap_new_vault_english(tmp_path: Path):
    """Case A (English): Bootstrap creates English naming convention."""
    vault = tmp_path / "EnglishVault"
    vault.mkdir()

    config = bootstrap_vault(vault, language="en")

    assert config.language == "en"
    assert config.folders.map_file == "00 Map.md"
    assert config.folders.lessons_dir == "Lessons"
    assert (vault / "Lessons" / "Mentorship").is_dir()
    assert (vault / "Concepts").is_dir()
    assert (vault / "Templates" / "Lesson.md").is_file()
    assert (vault / "Templates" / "Concept.md").is_file()
    assert (vault / "00 Map.md").is_file()


def test_bootstrap_adopt_existing_vault_case_b(tmp_path: Path):
    """Case B: Adopting existing vault preserves all existing notes and parses tracks."""
    vault = tmp_path / "ExistingVault"
    vault.mkdir()

    # Create existing structure mirroring real Obsidian vault
    (vault / "Aulas" / "Mentoria").mkdir(parents=True)
    (vault / "Conceitos").mkdir()
    (vault / "Fontes" / "Mentoria").mkdir(parents=True)
    (vault / "Desenhos").mkdir()

    # Existing 00 Mapa.md
    mapa_content = """---
tags: [mapa]
---
# Mapa — AI Engineering

## Trilha — Mentoria
| Módulo | Fontes | Blocos | Status |
|---|---|---|---|
| [[Aulas/Mentoria/S01 Fundamentos e API da OpenAI/00 Visão geral|S01 Fundamentos e API da OpenAI]] | pré-aula + aula | 11 | triagem feita (16/30) · 4/11 blocos concluídos |
| [[Aulas/Mentoria/S02 LangChain e LangGraph/00 Visão geral|S02 LangChain e LangGraph]] | 2 pré-aulas | 13 | aguardando triagem |

## Trilha — Currículo (ai-engineering-from-scratch)
| Etapa | Mentoria | Currículo junto | Base (2:1) | Status |
|---|---|---|---|---|
| 0 Fundamentos e API da OpenAI | S01 | 07/07, 10/01 | — | em andamento — **início** |
| 1 Agentes e tools | S02 | 13/01, 13/02 | 01/01 | a fazer |
"""
    (vault / "00 Mapa.md").write_text(mapa_content, encoding="utf-8")

    # Existing concept note
    concept_content = r"""---
tags: [conceito]
status: aprendendo
fontes: ["mentoria S01"]
criado: 2026-10-19
---
# Chain-of-thought

**Verdade incondicional / definição:** Raciocínio antes da resposta.

Depende de:: [[Autorregressão]]
Usado em:: [[Structured output]]

## Mecanismo
- $P(x_t \mid x_{<t})$

## Na prática
- Explicar antes de responder.
"""
    (vault / "Conceitos" / "Chain-of-thought.md").write_text(concept_content, encoding="utf-8")

    # Bootstrap vault
    config = bootstrap_vault(vault)

    # Invariant: Existing notes must NOT be overwritten!
    assert (vault / "00 Mapa.md").read_text(encoding="utf-8") == mapa_content
    assert (vault / "Conceitos" / "Chain-of-thought.md").read_text(encoding="utf-8") == concept_content

    # Invariant: .harness/ was created
    assert (vault / ".harness" / "config.json").is_file()
    assert (vault / ".harness" / "sessions").is_dir()

    # Track items detected
    assert len(config.active_track().queue) >= 4
    assert config.active_track().active_item_id is not None
    # S01 or Etapa 0 should be active
    assert any(
        config.active_track().active_item_id == item.id
        for item in config.active_track().queue
        if "em andamento" in item.status_detail or "triagem feita" in item.status_detail
    )


# ============================================================================
# 2. MARKDOWN AST & NON-DESTRUCTIVE SURGICAL MERGE
# ============================================================================

def test_parse_and_merge_concept_note_non_destructive(tmp_path: Path):
    """User callouts, custom notes, and existing sections must be 100% preserved."""
    vault = tmp_path / "Vault"
    (vault / "Conceitos").mkdir(parents=True)

    original_note = """---
tags: [conceito]
status: aprendendo
fontes: ["mentoria S01"]
criado: 2026-10-19
custom_meta: "preserved"
---
# Chain-of-thought

> [!note] Lembrar de citar o paper Wei et al. em entrevistas!

**Verdade incondicional / definição:** Raciocínio antes da resposta.

Depende de:: [[Autorregressão]]
Usado em:: [[Structured output]]

## Mecanismo
<!-- como funciona por dentro: matemática, código (fonte típica: currículo) -->

## Na prática
Minha nota escrita no Obsidian: Testado no Claude 3.5 Sonnet.

## Minhas Anotações Livres
Texto totalmente livre do usuário que o agente não conhece.

## Erros que eu cometi
- 2026-10-19: Errei a ordem do schema.
"""
    note_path = vault / "Conceitos" / "Chain-of-thought.md"
    note_path.write_text(original_note, encoding="utf-8")

    # Parse note
    node = parse_concept_note(note_path)
    assert node.title == "Chain-of-thought"
    assert node.unconditional_truth == "Raciocínio antes da resposta."
    assert "Autorregressão" in node.depends_on
    assert "Structured output" in node.used_in
    assert node.mistake_count == 1

    # Merge updates from teaching session
    merge_concept_note(
        vault_path=vault,
        node=node,
        mechanism_md=r"Equação: $P(x_t \mid x_{<t})$. Tudo o que foi gerado entra no contexto.",
        practice_md="Em structured output, colocar 'reasoning' antes de 'decision'.",
        mistake_entry="2026-10-26: Confundi embedding com token id.",
        drawing_embed="![[cot-drawing-2026-10-26.excalidraw|600]]",
    )

    merged_text = note_path.read_text(encoding="utf-8")

    # INVARIANT CHECKS:
    # 1. Custom frontmatter preserved
    assert 'custom_meta: "preserved"' in merged_text
    assert merged_text.startswith(original_note)
    # 2. User callout preserved
    assert "> [!note] Lembrar de citar o paper Wei et al. em entrevistas!" in merged_text
    # 3. User custom section preserved
    assert "## Minhas Anotações Livres" in merged_text
    assert "Texto totalmente livre do usuário que o agente não conhece." in merged_text
    # 4. User notes in Na prática preserved while appending new practice
    assert "Minha nota escrita no Obsidian: Testado no Claude 3.5 Sonnet." in merged_text
    assert "Em structured output, colocar 'reasoning' antes de 'decision'." in merged_text
    # 5. Mechanism replaced template comment
    assert "Equação: $P(x_t \\mid x_{<t})$" in merged_text
    # 6. Both mistakes present
    assert "Errei a ordem do schema." in merged_text
    assert "Confundi embedding com token id." in merged_text
    # 7. Drawing embedded
    assert "![[cot-drawing-2026-10-26.excalidraw|600]]" in merged_text


def test_merge_lesson_note_non_destructive(tmp_path: Path):
    """Lesson notes preserve user notes and allow incremental DAG unfolding."""
    vault = tmp_path / "Vault"
    (vault / "Aulas" / "Mentoria").mkdir(parents=True)

    rel_path = "Aulas/Mentoria/S01 Visão geral.md"
    lesson_path = vault / rel_path

    # Initial creation
    merge_lesson_note(
        vault_path=vault,
        rel_path=rel_path,
        title="S01 Fundamentos e API da OpenAI",
        fonte="mentoria",
        objetivo="Entender autorregressão e tokens",
        fontes_links="[[S01 Pré-aula Tokens, embeddings e autorregressão]]",
        ponto_de_partida="Conceito de API e embeddings claros",
        mermaid_dag="graph TD\nTokens --> Autorregressao",
        node_section_title="Nó 1 — Tokens e Autorregressão",
        node_section_md="O próximo token depende de todos os anteriores.",
        quiz_summary="Acertos: 2/2",
    )

    assert lesson_path.exists()
    initial_text = lesson_path.read_text(encoding="utf-8")
    assert "## Ponto de partida" in initial_text
    assert "Tokens --> Autorregressao" in initial_text
    assert "### Nó 1 — Tokens e Autorregressão" in initial_text

    # User adds custom notes in Obsidian
    user_addition = initial_text + "\n\n## Minhas Observações Pessoais\nPerguntar na live sobre cache de prompt."
    lesson_path.write_text(user_addition, encoding="utf-8")

    # Second merge: advance plan to Node 2
    merge_lesson_note(
        vault_path=vault,
        rel_path=rel_path,
        title="S01 Fundamentos e API da OpenAI",
        node_section_title="Nó 2 — Custo de Input vs Output",
        node_section_md="Output custa 3x mais que input devido ao cache e KV cache.",
        quiz_summary="Acertos: 4/4",
    )

    updated_text = lesson_path.read_text(encoding="utf-8")
    # Verify user section preserved
    assert "## Minhas Observações Pessoais" in updated_text
    assert "Perguntar na live sobre cache de prompt." in updated_text
    # Verify both nodes present in Desdobrando
    assert "### Nó 1 — Tokens e Autorregressão" in updated_text
    assert "### Nó 2 — Custo de Input vs Output" in updated_text


def test_merge_lesson_note_fontes_strictly_read_only(tmp_path: Path):
    """Critical Invariant 2: Any attempt to modify Fontes/ or Sources/ raises PermissionError."""
    vault = tmp_path / "Vault"
    (vault / "Fontes" / "Mentoria").mkdir(parents=True)
    (vault / "Sources").mkdir(parents=True)

    with pytest.raises(PermissionError) as exc_info:
        merge_lesson_note(
            vault_path=vault,
            rel_path="Fontes/Mentoria/S01 Aula.md",
            title="Tentativa Ilegal",
        )
    assert "Fontes/ is strictly read-only" in str(exc_info.value)

    with pytest.raises(PermissionError) as exc_info_en:
        merge_lesson_note(
            vault_path=vault,
            rel_path="Sources/lesson.md",
            title="Illegal Attempt",
        )
    assert "Fontes/ is strictly read-only" in str(exc_info_en.value)


# ============================================================================
# 3. EXCALIDRAW CODEC & MULTIMODAL SYNC
# ============================================================================

def test_excalidraw_retrieval_drawing_and_save_load(tmp_path: Path):
    """Excalidraw drawings support retrieval prompts, scene update, and PNG export."""
    vault = tmp_path / "Vault"
    (vault / "Desenhos").mkdir(parents=True)

    slug, path = create_retrieval_drawing(
        vault_path=vault,
        title="Mecanismo de Atenção",
        prompt="Desenhe o fluxo de Q, K, V até o softmax e multiplicação por V.",
        aula_rel="Aulas/Mentoria/S01 Visão geral.md",
        conceitos=["Atenção", "Softmax"],
    )

    assert path.is_file()
    assert path.name.endswith(".excalidraw.md")

    # Load drawing
    drawing = load_drawing(vault, slug)
    assert drawing["slug"] == slug
    assert drawing["revisado"] is False
    assert "titulo01" in drawing["text_elements"]
    assert "enunciado01" in drawing["text_elements"]
    assert drawing["text_elements"]["titulo01"] == "Mecanismo de Atenção"

    # Simulate drawing edits + multimodal review
    scene = drawing["scene"]
    # Add a user box element
    scene["elements"].append(
        {
            "id": "box01",
            "type": "rectangle",
            "x": 200,
            "y": 200,
            "width": 100,
            "height": 50,
            "strokeColor": "#efeaff",
            "backgroundColor": "transparent",
            "isDeleted": False,
        }
    )

    fake_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRfake_png_data"
    review_text = "O desenho capturou Q e K corretamente. Faltou a divisão por $\\sqrt{d_k}$."

    saved_path = save_drawing(
        vault_path=vault,
        slug=slug,
        scene_json=scene,
        png_bytes=fake_png,
        review_markdown=review_text,
    )

    assert saved_path.is_file()
    # Reload and verify
    reloaded = load_drawing(vault, slug)
    assert reloaded["revisado"] is True
    assert reloaded["review"] is not None
    assert "$\\sqrt{d_k}$" in reloaded["review"]
    assert reloaded["png_path"] is not None
    assert Path(reloaded["png_path"]).is_file()

    # Our own export is refreshed on the next save...
    folder = saved_path.parent
    plain = folder / saved_path.name.replace(".excalidraw.md", ".png")
    save_drawing(vault_path=vault, slug=slug, scene_json=scene, png_bytes=fake_png + b"v2")
    assert plain.read_bytes() == fake_png + b"v2"
    # ...but an image the learner put under that name is never replaced.
    plain.write_bytes(b"learner image")
    save_drawing(vault_path=vault, slug=slug, scene_json=scene, png_bytes=fake_png + b"v3")
    assert plain.read_bytes() == b"learner image"
    assert (folder / saved_path.name.replace(".md", ".light.png")).read_bytes() == fake_png + b"v3"


# ============================================================================
# 4. TRANSCRIPT IMPORTER & ^pN CITATIONS
# ============================================================================

def test_transcript_importer_and_get_paragraph(tmp_path: Path):
    """Import raw transcript, verify ^p1..^pN numbering, and citation extraction."""
    vault = tmp_path / "Vault"

    transcript_text = """Tokens são a unidade básica de qualquer modelo de linguagem autorregressivo.
Eles entram na rede e determinam os próximos passos do cálculo.

Uma LLM é autorregressiva porque cada novo token gerado é condicionado a todos os anteriores.
Não existe volta no tempo para corrigir o passado uma vez que o token foi emitido.

Por isso o raciocínio precisa acontecer antes da resposta final.
Essa é a base conceitual do chain-of-thought."""

    target_path, count = import_transcript_text(
        vault_path=vault,
        raw_text=transcript_text,
        title="Tokens e Autorregressão",
        prefix="S01",
        modulo="S01 Fundamentos",
        tipo="pre-aula",
    )

    assert target_path.is_file()
    assert count == 3

    content = target_path.read_text(encoding="utf-8")
    assert "^p1" in content
    assert "^p2" in content
    assert "^p3" in content

    # Invariant: FileExistsError without force
    with pytest.raises(FileExistsError):
        import_transcript_text(
            vault_path=vault,
            raw_text="Different text",
            title="Tokens e Autorregressão",
            prefix="S01",
            force=False,
        )

    # Retrieval of paragraph 2 with radius=1
    result = get_source_paragraph(
        vault_path=vault,
        source_name="S01 Tokens e Autorregressão",
        paragraph_id="p2",
        context_radius=1,
    )

    assert result["target_paragraph_id"] == "p2"
    assert "Uma LLM é autorregressiva" in result["target_text"]
    assert len(result["context_before"]) == 1
    assert "Tokens são a unidade básica" in result["context_before"][0]
    assert len(result["context_after"]) == 1
    assert "Por isso o raciocínio" in result["context_after"][0]


# ============================================================================
# 5. APPEND-ONLY JSONL STORE & GRAPH SNAPSHOT
# ============================================================================

def test_jsonl_store_and_graph_snapshot(tmp_path: Path):
    """Verify session, quiz logs, chains persistence and deterministic 2D graph snapshot."""
    vault = tmp_path / "Vault"
    (vault / "Conceitos").mkdir(parents=True)

    # 1. Create two concept notes
    note1 = """---
tags: [conceito]
status: aprendendo
---
# Autorregressão
**Verdade incondicional / definição:** O próximo token depende de todos os anteriores.
Depende de:: 
Usado em:: [[Chain-of-thought]]
"""
    note2 = """---
tags: [conceito]
status: aprendendo
---
# Chain-of-thought
**Verdade incondicional / definição:** Raciocínio antes da resposta.
Depende de:: [[Autorregressão]]
Usado em:: 
"""
    (vault / "Conceitos" / "Autorregressão.md").write_text(note1, encoding="utf-8")
    (vault / "Conceitos" / "Chain-of-thought.md").write_text(note2, encoding="utf-8")

    # 2. Append session record
    session = SessionRecord(
        id="session-test-01",
        title="Aula de Autorregressão",
        mode="TEACH",
        messages=[
            SessionMessage(
                id="msg-1",
                role="user",
                content="Como funciona autorregressão?",
                created_at="2026-10-26T12:00:00",
            )
        ],
    )
    append_session_event(vault, session.id, session)
    loaded_session = load_session(vault, session.id)
    assert loaded_session is not None
    assert loaded_session.id == "session-test-01"
    assert len(loaded_session.messages) == 1

    # 3. Append quiz log
    quiz_res = CalibrationResult(
        quiz_id="q-1",
        session_id=session.id,
        topic="Autorregressão",
        node_id="autorregressao",
        correct=False,
        is_dont_know=False,
        chosen_index=1,
        correct_index=0,
        confidence=85,
        confidence_band="high",
        calibration_band="illusion_of_competence",
        learner_thinking="Achei que o modelo olhava para frente",
        pedagogical_directive="Exibir contra-exemplo causal",
        explanation="O modelo só vê tokens anteriores.",
    )
    append_quiz_log(vault, quiz_res)
    logs = load_quiz_logs(vault)
    assert len(logs) == 1
    assert logs[0].calibration_band == "illusion_of_competence"

    # 4. Append logical chain
    chain = LogicalChain(
        chain_id="chain-01",
        premises=["Autorregressão", "Context Window"],
        conclusion="Chain-of-thought",
        expression="Autorregressão ∧ Context Window ⟹ Chain-of-thought",
        topic="Mecanismo CoT",
    )
    append_chain(vault, chain)
    chains = load_chains(vault)
    assert len(chains) == 1
    assert chains[0].conclusion == "Chain-of-thought"

    # 5. Build Graph Snapshot
    snapshot = build_graph_snapshot(vault)
    assert len(snapshot.nodes) == 2
    # Verify deterministic coordinates
    for node in snapshot.nodes:
        assert node.x is not None
        assert node.y is not None
        if node.id == "autorregressao":
            # Mistake recorded
            assert node.mistake_count >= 1

    # Verify edges
    assert len(snapshot.edges) >= 2
    # Verify chain present
    assert len(snapshot.chains) == 1


# ============================================================================
# 6. WATCHER PATH FILTERING
# ============================================================================

def test_watcher_is_ignored_path():
    """Verify that temporary, obsidian workspace, and database files are ignored."""
    assert is_ignored_path("/vault/.obsidian/workspace.json") is True
    assert is_ignored_path("/vault/.obsidian/workspace-mobile.json") is True
    assert is_ignored_path("/vault/Conceitos/test.md.tmp") is True
    assert is_ignored_path("/vault/Conceitos/test.md.abc123.tmp") is True
    assert is_ignored_path("/vault/.harness/langgraph.sqlite") is True
    assert is_ignored_path("/vault/.harness/langgraph.sqlite-wal") is True
    assert is_ignored_path("/vault/.git/index") is True
    # The harness's own appends are announced by targeted events, not by the watcher.
    for machine in ("sessions/s1.jsonl", "jobs.jsonl", "usage.jsonl", "quiz-log.jsonl",
                    "graph/nodes.jsonl", "repos/x/README.md", "runtime/s1/settings.json"):
        assert is_ignored_path(f"/vault/.harness/{machine}") is True
    assert is_ignored_path("/vault/.harness/config.json") is False
    assert is_ignored_path("/vault/.harness/prompts/teacher/10-method.md") is False
    assert affects_graph(["/vault/.harness/prompts/shared/20-voice.md"]) is False
    assert affects_graph(["/vault/.harness/config.json"]) is True
    assert affects_graph(["/vault/Conceitos/Atenção.md"]) is True

    # Real user content must NOT be ignored
    assert is_ignored_path("/vault/Conceitos/Chain-of-thought.md") is False
    assert is_ignored_path("/vault/Aulas/Mentoria/S01.md") is False
    assert is_ignored_path("/vault/Desenhos/teste.excalidraw.md") is False
    assert is_ignored_path("/vault/00 Mapa.md") is False
