"""Lesson note v2: readable names, plan-shaped layout and the managed-block merge policy."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from learnharness.core.contracts.session import (
    DenseBlockDimensions,
    NodeSpan,
    PlanDag,
    PlanNode,
    SessionMessage,
    SessionRecord,
)
from learnharness.vault.lesson_layout import (
    balance_fences,
    current_node_id,
    lesson_note_stem,
    prose_by_node,
    render_lesson_blocks,
    sanitize_note_title,
)
from learnharness.vault.markdown_ast import (
    _render_owned_block,
    merge_frontmatter_keys,
    merge_lesson_note,
    merge_owned_blocks,
    sync_lesson_note,
)
from tests.conftest import configure_vault

FM = {"sessao": "s1", "topico": "T", "fonte": "livre", "status": "em andamento"}


def _sync(vault: Path, blocks, **kw) -> bool:
    return sync_lesson_note(vault, "Aulas/T.md", "T", FM, blocks, tags=["aula"],
                            touched={"atualizado": date(2026, 1, 2)}, **kw)


def test_note_names_are_readable_and_safe():
    assert lesson_note_stem("Atenção: Q/K/V #1 [rev]", date(2026, 10, 26)) == "2026-10-26 Atenção Q K V 1 rev"
    assert lesson_note_stem("  ..  ", date(2026, 1, 1)) == "2026-01-01 Sessão"
    assert len(sanitize_note_title("palavra " * 40)) <= 80


def test_user_content_outside_markers_is_byte_identical_and_sync_is_idempotent(tmp_path):
    vault = configure_vault(tmp_path / "V")
    assert _sync(vault, [("a", "**Objetivo:** T"), ("b", "## Plano\n- [ ] X")]) is True
    path = vault / "Aulas/T.md"
    text = path.read_text()
    # The learner writes between and after managed blocks, adds a callout and a YAML key.
    user_mid = "\n\n## Minhas dúvidas\n> [!question] Por quê?\n> Ver [[Vetor]].\n"
    first_end = text.index(":end -->") + len(":end -->")
    text = text[:first_end] + user_mid + text[first_end:] + "\n## Rodapé meu\nfim\n"
    text = text.replace("status: em andamento\n", "status: em andamento\nprioridade: alta # minha\n")
    path.write_text(text)
    before = path.read_bytes()

    assert _sync(vault, [("a", "**Objetivo:** T"), ("b", "## Plano\n- [ ] X")]) is False
    assert path.read_bytes() == before  # no churn

    assert _sync(vault, [("a", "**Objetivo:** T"), ("b", "## Plano\n- [x] X"), ("c", "## X\nprosa")]) is True
    after = path.read_text()
    assert user_mid in after and "## Rodapé meu\nfim\n" in after
    assert "prioridade: alta # minha\n" in after and "- [x] X" in after
    # New block lands right after its predecessor in the layout, before the user's footer.
    assert after.index("## X\nprosa") < after.index("## Rodapé meu")
    assert after.count("Minhas dúvidas") == 1


def test_learner_edit_inside_a_block_survives_or_is_moved_out_never_lost(tmp_path):
    vault = configure_vault(tmp_path / "V")
    _sync(vault, [("node", "## Nó\nversão do agente")])
    path = vault / "Aulas/T.md"
    path.write_text(path.read_text().replace("versão do agente", "minha versão editada"))
    edited = path.read_bytes()
    # Agent has nothing new for the block: the learner's edit stands untouched.
    assert _sync(vault, [("node", "## Nó\nversão do agente")]) is False
    assert path.read_bytes() == edited
    # Agent rewrites the block: the edited text is kept verbatim outside the markers.
    _sync(vault, [("node", "## Nó\nversão nova do agente")])
    text = path.read_text()
    end = text.index(":end -->")
    assert "versão nova do agente" in text[:end]
    assert "## Nó\nminha versão editada" in text[end:]
    assert _sync(vault, [("node", "## Nó\nversão nova do agente")]) is False


def test_frontmatter_only_managed_keys_change():
    content = "---\ntags: [estudo]\naliases:\n  - A\nstatus: em andamento\n---\n# T\n"
    out = merge_frontmatter_keys(content, {"status": "concluída", "sessao": "s1"}, ["aula"])
    assert "aliases:\n  - A\n" in out and "status: concluída\n" in out and "sessao: s1\n" in out
    assert "- estudo\n- aula\n" in out and out.endswith("---\n# T\n")
    assert merge_frontmatter_keys(out, {"status": "concluída"}, ["aula"]) == out
    broken = "---\nkey: [unclosed\n---\nbody\n"
    assert merge_frontmatter_keys(broken, {"status": "x"}, ["aula"]) == broken


def test_malformed_markers_refuse_instead_of_guessing(tmp_path):
    block = _render_owned_block("a", "x")
    with pytest.raises(ValueError):
        merge_owned_blocks(block.rsplit("\n", 1)[0] + "\n", [("a", "y")])
    with pytest.raises(ValueError):
        merge_owned_blocks(block + "\n" + block + "\n", [("a", "y")])


def test_legacy_msg_blocks_migrate_without_losing_user_edits(tmp_path):
    vault = configure_vault(tmp_path / "V")
    rel = "Aulas/sess-old.md"
    merge_lesson_note(vault, rel, "Velha", objetivo="Velha")
    merge_lesson_note(vault, rel, "Velha", node_section_title="msg-1", node_section_md="texto 1")
    merge_lesson_note(vault, rel, "Velha", node_section_title="msg-2", node_section_md="texto 2")
    path = vault / rel
    path.write_text(path.read_text().replace("texto 2", "texto 2 com nota minha") + "\n## Minha seção\nok\n")
    session = SessionRecord(id="sess-old", title="Velha", lesson_vault_path=rel, messages=[
        SessionMessage(id="msg-1", role="assistant", content="texto 1", created_at=""),
        SessionMessage(id="msg-2", role="assistant", content="texto 2", created_at=""),
    ])
    from learnharness.vault.lesson_layout import frontmatter_for, legacy_message_blocks

    managed, tags = frontmatter_for(session, "pt-BR")
    sync_lesson_note(vault, rel, "Velha", managed, render_lesson_blocks(session, "pt-BR"),
                     tags=tags, retire=legacy_message_blocks(session))
    text = path.read_text()
    assert "### msg-1" not in text and "texto 2 com nota minha" in text  # edited one unwrapped
    assert "## Diagnóstico\n\ntexto 1\n\ntexto 2" in text and "## Minha seção\nok" in text
    assert text.count("harness:") == 2 * 2  # objective + diagnosis blocks only


def test_prose_is_attributed_to_the_node_current_when_produced():
    plan = PlanDag(nodes=[PlanNode(id="a", label="A"), PlanNode(id="b", label="B", depends_on=["a"])])
    assert current_node_id(PlanDag()) is None and current_node_id(plan) == "a"
    message = SessionMessage(id="m", role="assistant", content="diag. sobre A. sobre B.", created_at="",
                             node_spans=[NodeSpan(start=0), NodeSpan(start=6, node_id="a"),
                                         NodeSpan(start=15, node_id="b")])
    session = SessionRecord(id="s", title="T", plan=plan, messages=[message])
    assert prose_by_node(session) == {None: "diag.", "a": "sobre A.", "b": "sobre B."}
    assert balance_fences("```py\nx = 1") == "```py\nx = 1\n```"


def test_dense_map_renders_four_dimensions_with_source_links():
    node = PlanNode(id="a", label="Bloco", four_dimensions=DenseBlockDimensions(
        said="Disse ^p1 e [[Fonte#^p2]]", assumed=["Base"], paragraph_refs=["^p1"]))
    session = SessionRecord(id="s", title="T", context_kind="dense_source",
                            source_path="Fontes/Sub/Minha Aula.md", plan=PlanDag(nodes=[node]))
    blocks = dict(render_lesson_blocks(session, "pt-BR"))
    dense = blocks["lesson:v2:dense-map"]
    assert "- **Dito:** Disse [[Minha Aula#^p1]] e [[Minha Aula#^p2]]" in dense
    assert "- **Pressuposto:**\n  - Base" in dense and "- **Pulado:** —" in dense
    assert "- **Trechos:** [[Minha Aula#^p1]]" in dense


async def test_session_note_name_collisions_never_overwrite(app_state, configured_vault):
    today = date.today().isoformat()
    existing = configured_vault / f"Aulas/{today} Atenção.md"
    existing.write_text("minha nota\n")
    session = await app_state.sessions.create("TEACH", "Atenção", start=False)
    assert session.lesson_vault_path == f"Aulas/{today} Atenção (2).md"
    assert existing.read_text() == "minha nota\n"
    note = (configured_vault / session.lesson_vault_path).read_text()
    assert note.startswith("---\ntags:\n- aula\nsessao: " + session.id)
    assert "**Objetivo:** Atenção" in note


async def test_set_plan_rejects_unknown_refs_in_four_dimensions(app_state, configured_vault):
    source = configured_vault / "Fontes/Aula.md"
    source.write_text("Um. ^p1\n\nDois. ^p12\n")
    session = await app_state.sessions.create("TEACH", "Aula", "Fontes/Aula.md", start=False)
    bad = PlanDag(nodes=[PlanNode(id="a", label="A", four_dimensions=DenseBlockDimensions(said="ver ^p2"))])
    with pytest.raises(ValueError, match="p2"):
        await app_state.sessions.set_plan(session.id, bad)
    good = PlanDag(nodes=[PlanNode(id="a", label="A", four_dimensions=DenseBlockDimensions(
        said="ver ^p12", paragraph_refs=["p1"]))])
    await app_state.sessions.set_plan(session.id, good)
    note = (configured_vault / session.lesson_vault_path).read_text()
    assert "[[Aula#^p12]]" in note and "fonte: '[[Aula]]'" in note
