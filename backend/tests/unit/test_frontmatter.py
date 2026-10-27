"""One frontmatter rule (Obsidian's) for every reader and writer of vault notes."""

import pytest

from learnharness.core.frontmatter import split_frontmatter
from learnharness.vault.bootstrap import bootstrap_vault
from learnharness.vault.excalidraw import create_retrieval_drawing, load_drawing, save_drawing
from learnharness.vault.markdown_ast import merge_frontmatter_keys
from learnharness.vault.transcript_importer import import_transcript_text


def test_crlf_drawing_is_marked_reviewed(tmp_path):
    bootstrap_vault(tmp_path)
    slug, path = create_retrieval_drawing(tmp_path, "Atenção", "Desenhe Q, K, V.")
    path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))  # Saved on Windows.
    assert load_drawing(tmp_path, slug)["revisado"] is False
    save_drawing(tmp_path, slug, {}, review_markdown="Faltou o softmax.")
    assert load_drawing(tmp_path, slug)["revisado"] is True


def test_reimporting_a_source_whose_title_has_dashes_is_idempotent(tmp_path):
    bootstrap_vault(tmp_path)
    text = "Primeiro parágrafo.\n\nSegundo parágrafo."
    first, _ = import_transcript_text(tmp_path, text, "Módulo 1 --- Atenção")
    again, _ = import_transcript_text(tmp_path, text, "Módulo 1 --- Atenção")
    assert again == first


def test_repo_path_survives_dashes_in_an_earlier_value(tmp_path):
    from learnharness.vault.github_source import _repo_path_of

    note = tmp_path / "nota.md"
    note.write_text("---\nmodulo: Parte 1 --- Fundamentos\nrepo_path: docs/intro.md\n---\n# Intro\n", encoding="utf-8")
    assert _repo_path_of(note) == "docs/intro.md"


@pytest.mark.parametrize(("text", "repo_path", "body_head"), [
    ("---\nrepo_path: a.md\n---\n# H\n", "a.md", "# H"),
    ("---\r\nrepo_path: a.md\r\n---\r\n# H\r\n", "a.md", "# H"),           # Windows line endings
    ("\ufeff---\nrepo_path: a.md\n---\n# H\n", "a.md", "# H"),                # UTF-8 BOM
    ("--- \nrepo_path: a.md\n---  \n# H\n", "a.md", "# H"),                     # trailing spaces
    ("---\nmodulo: A --- B\nrepo_path: a.md\n---\n# H\n", "a.md", "# H"),     # dashes inside a value
    ("---\nrepo_path: a.md\n---", "a.md", ""),                                  # no final newline
    ("---\n---\n# H\n", None, "# H"),                                          # empty block
    ("----\nrepo_path: a.md\n----\n# H\n", None, "----"),                      # not a fence
    ("---\nrepo_path: a.md\n...\n# H\n", None, "---"),                         # Obsidian closes with --- only
    ("---\nrepo_path: a.md\n# H\n", None, "---"),                               # never closed
    ("# H\n\n---\n\ntext\n", None, "# H"),                                      # a rule, not frontmatter
])
def test_split_frontmatter_follows_obsidian(text, repo_path, body_head):
    fm = split_frontmatter(text)
    assert (fm.data or {}).get("repo_path") == repo_path
    assert fm.body.startswith(body_head)


def test_unparseable_yaml_is_a_block_without_data():
    fm = split_frontmatter("---\nrepo_path: [a\n---\n# H\n")
    assert fm.present and fm.data is None and fm.body == "# H\n"


@pytest.mark.parametrize("prefix", ["", "\ufeff"])
def test_writer_updates_the_existing_block_in_place(prefix):
    text = prefix + "---\r\ntags:\r\n- minha\r\n---\r\n# Nota\r\n"
    out = merge_frontmatter_keys(text, {"harness_id": "x"})
    assert out.count("---") == 2 and out.startswith(prefix + "---\r\n")
    assert split_frontmatter(out).data == {"tags": ["minha"], "harness_id": "x"}
    assert out.endswith("# Nota\r\n")
