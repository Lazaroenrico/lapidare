"""Adopting a real-looking Obsidian vault and teaching from it never alters user bytes.

Builds a vault shaped like a long-lived Obsidian vault (``.obsidian/``, nested folders,
frontmatter, callouts, wikilinks, CRLF, binary attachments, read-only ``Fontes/``, and an
``Aulas/`` note whose name collides with the new session), runs ``bootstrap_vault``
adoption plus a full fake-engine dense-source TEACH flow, then compares every byte.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

from learnharness.api.state import AppState
from learnharness.core.contracts.quiz import QuizSubmission
from learnharness.pipelines.extraction import _ExtractionStructuredPayload
from learnharness.vault.bootstrap import bootstrap_vault, save_config
from tests.conftest import FakeEngine, tool, wait_until

TOPIC = "Mecanismo de atenção"
SOURCE_REL = "Fontes/Mentoria/Aula Atenção.md"


def _build_vault(root: Path) -> Path:
    today = date.today().isoformat()
    files: dict[str, str | bytes] = {
        ".obsidian/app.json": '{"alwaysUpdateLinks": true}\n',
        ".obsidian/workspace.json": '{"main": {"id": "abc"}}\n',
        ".obsidian/plugins/dataview/data.json": "{}\n",
        "00 Mapa.md": "# Mapa\n\nMinhas anotações livres sobre o estudo.\n\n> [!info] Plano\n> Ler [[Vetor]] primeiro.\n",
        "Projetos/LLMs/Notas/Tokenização.md": (
            "---\ntags: [llm, tokens]\naliases:\n  - BPE\ncriado: 2024-01-02 # manual\n---\n"
            "# Tokenização\n\n> [!warning] Cuidado\n> BPE não é WordPiece.\n\nVer [[Vetor|vetores]] e ![[diagrama.png]].\n"
        ),
        "Projetos/LLMs/Notas/Windows.md": "---\r\ntitle: CRLF\r\n---\r\nLinha 1\r\nLinha 2\r\n",
        "Anexos/diagrama.png": b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00binary\xff",
        "Conceitos/Vetor.md": "---\ntags: [conceito]\n---\n# Vetor\n\nMinha definição própria.\n",
        "Aulas/Antigas/2023 Revisão.md": "# Revisão\n\n## Minhas notas\nTexto.\n",
        # Same title and day as the session about to be created (and a case-only clash).
        f"Aulas/{today} {TOPIC}.md": "# Nota minha com o mesmo nome\n\nNão sobrescrever.\n",
        f"Aulas/{today} mecanismo de atenção (2).md": "# Outra nota minha\n",
        SOURCE_REL: (
            "---\nfonte: mentoria\n---\n# Aula Atenção\n\n"
            "O produto escalar mede alinhamento entre vetores. ^p1\n\n"
            "A bilinearidade vale, como todos sabem. ^p2\n\n"
            "A atenção pondera valores pelo softmax dos produtos. ^p3\n"
        ),
        "Templates/Aula.md": "---\ntags: [aula]\n---\n# {{title}}\n",
    }
    vault = root / "AI Engineering"
    for rel, content in files.items():
        path = vault / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_bytes(content.encode("utf-8"))
    return vault


def _snapshot(vault: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(vault)): p.read_bytes()
        for p in vault.rglob("*")
        if p.is_file() and p.relative_to(vault).parts[0] != ".harness"
    }


def _strip_harness_blocks(text: str) -> str:
    return re.sub(r"\n*<!-- harness:([\w]+):start -->.*?<!-- harness:\1:end -->\n?", "", text, flags=re.S)


async def test_adoption_and_teach_flow_leave_user_bytes_identical(tmp_path: Path) -> None:
    vault = _build_vault(tmp_path)
    before = _snapshot(vault)

    config = bootstrap_vault(vault, language="pt-BR")
    assert config.folders.lessons_dir == "Aulas" and config.folders.sources_dir == "Fontes"
    config.configured = True
    save_config(vault, config)
    assert _snapshot(vault) == before, "adoption must only create .harness/"

    engine = FakeEngine()
    engine.program(_ExtractionStructuredPayload, {
        "concepts": [{"title": "Produto Escalar", "unconditional_truth": "Soma dos produtos coordenada a coordenada."}],
        "chains": [],
    })
    node_details = {
        "b1": {
            "source_paragraphs": ["p1"],
            "four_dimensions": {
                "said": "O produto escalar mede alinhamento ^p1.",
                "assumed": ["Vetores e coordenadas"],
                "skipped": ["Por que a bilinearidade vale ^p2"],
                "simplifications": ["Ignora normalização por $\\sqrt{d_k}$"],
                "paragraph_refs": ["p1", "p2"],
            },
        },
        "b2": {"source_paragraphs": ["p3"]},
    }
    mermaid = "graph TD\n  b1[Bloco 1 — Produto escalar] --> b2[Bloco 2 — Atenção]"
    engine.script_turn(
        "Antes de começar: você já viu produto escalar?\n",
        tool("probe_done", strands=[{"strand": "álgebra linear", "assessment": "Conhece vetores."}]),
        tool("plan_init", mermaid=mermaid, approach_prose="Primeiro o produto escalar, depois a atenção.",
             node_details=node_details),
        "O produto escalar soma produtos coordenada a coordenada [[Fonte#^p1]].\n",
    )
    engine.script_turn(
        tool("quiz", type="check", node_id="b1", question="(1,2)·(3,4)?",
             options=[{"label": "11"}, {"label": "10"}], explanation="3+8", correct="11"),
        tool("plan_advance", node_id="b1", status="mastered"),
    )
    engine.script_turn("A atenção pondera valores pelo softmax [[Fonte#^p3]].\n")

    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    try:
        session = await state.sessions.create("TEACH", TOPIC, SOURCE_REL)
        sid = session.id
        assert session.context_kind == "dense_source"
        assert session.lesson_vault_path == f"Aulas/{date.today().isoformat()} {TOPIC} (3).md"
        await wait_until(lambda: not state.sessions.is_running(sid) and state.sessions.get(sid).plan.nodes)

        state.sessions.schedule(sid)
        quiz = await wait_until(lambda: state.sessions.get(sid).pending_quiz)
        await state.sessions.answer(QuizSubmission(quiz_id=quiz.quiz_id, session_id=sid, chosen_index=0, confidence=85))
        await wait_until(lambda: not state.sessions.is_running(sid)
                         and state.sessions.get(sid).plan.nodes[0].status == "mastered")
        state.sessions.schedule(sid)
        await wait_until(lambda: not state.sessions.is_running(sid)
                         and any(m.content.startswith("A atenção") for m in state.sessions.get(sid).messages))
        await wait_until(lambda: any(j["kind"] == "extraction" and j["status"] in ("completed", "failed")
                                     for j in state.active_jobs.values()))
        assert all(j["status"] == "completed" for j in state.active_jobs.values()), state.active_jobs
    finally:
        await state.close()

    after = _snapshot(vault)
    lesson_rel = session.lesson_vault_path
    new_files = set(after) - set(before)
    assert new_files == {lesson_rel, "Conceitos/Produto Escalar.md"}, new_files
    assert set(before) <= set(after)
    for rel, original in before.items():
        if rel == config.folders.map_file:
            continue
        assert after[rel] == original, f"user file changed: {rel}"
    # The map may only gain explicitly managed harness blocks, appended after user bytes.
    map_after = after[config.folders.map_file].decode()
    assert map_after.startswith(before[config.folders.map_file].decode())
    assert _strip_harness_blocks(map_after).rstrip() == before[config.folders.map_file].decode().rstrip()

    note = after[lesson_rel].decode()
    assert "sessao: " + sid in note and "fonte: '[[Aula Atenção]]'" in note
    assert "## Diagnóstico\n\nAntes de começar" in note
    assert "- [x] [[#Bloco 1 — Produto escalar|Bloco 1 — Produto escalar]]" in note
    assert "## Mapa da fonte" in note and "- **Dito:** O produto escalar mede alinhamento [[Aula Atenção#^p1]]." in note
    assert "  - Por que a bilinearidade vale [[Aula Atenção#^p2]]" in note
    assert "## Bloco 1 — Produto escalar\n\nO produto escalar soma produtos coordenada a coordenada [[Aula Atenção#^p1]]." in note
    assert "## Bloco 2 — Atenção\n\nA atenção pondera valores pelo softmax [[Aula Atenção#^p3]]." in note
    assert "msg-" not in note

    # Re-syncing the same state is a byte-level no-op (no watcher churn).
    final = state.sessions.get(sid)
    assert state.sessions._sync_lesson_note(final, "pt-BR") is False
