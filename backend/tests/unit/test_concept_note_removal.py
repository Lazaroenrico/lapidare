"""Removing a node's concept note: the file goes only when nothing in it is the learner's."""

from learnharness.core.contracts.graph import PropositionNode
from learnharness.vault.bootstrap import bootstrap_vault
from learnharness.vault.graph_store import remove_concept_section, sync_concept_note

NODE_ID = "prop_000000000001"


def _created_note(vault):
    node = PropositionNode(id=NODE_ID, name="Softmax", statement="Normaliza escores.", aliases=["softmax"])
    rel, created, _ = sync_concept_note(vault, node, "**Afirmação:** Normaliza escores.", ["sess-1"], "pt-BR",
                                        {NODE_ID})
    assert created
    return node.model_copy(update={"vault_rel_path": rel, "note_created": True}), vault / rel


def test_untouched_harness_note_is_deleted(tmp_path):
    bootstrap_vault(tmp_path)
    node, path = _created_note(tmp_path)
    assert remove_concept_section(tmp_path, node) and not path.exists()


def test_learner_tag_keeps_the_note(tmp_path):
    bootstrap_vault(tmp_path)
    node, path = _created_note(tmp_path)
    path.write_text(path.read_text(encoding="utf-8").replace("- conceito", "- conceito\n- revisar", 1), encoding="utf-8")
    assert remove_concept_section(tmp_path, node)
    text = path.read_text(encoding="utf-8")
    assert "revisar" in text and "Normaliza escores" not in text


def test_learner_property_keeps_the_note(tmp_path):
    bootstrap_vault(tmp_path)
    node, path = _created_note(tmp_path)
    path.write_text(path.read_text(encoding="utf-8").replace("---\n", "---\nfonte: livro\n", 1), encoding="utf-8")
    assert remove_concept_section(tmp_path, node)
    assert "fonte: livro" in path.read_text(encoding="utf-8")


def test_unparseable_frontmatter_keeps_the_note(tmp_path):
    bootstrap_vault(tmp_path)
    node, path = _created_note(tmp_path)
    path.write_text(path.read_text(encoding="utf-8").replace("tags:", "tags: [oops", 1), encoding="utf-8")
    remove_concept_section(tmp_path, node)
    assert path.exists()
