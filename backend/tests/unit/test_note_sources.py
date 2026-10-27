"""Fase 16 pure rules: source ids, registry fold, note slicing, coverage and citations."""

from __future__ import annotations

import hashlib

from learnharness.core.contracts.graph import CoverageRecord
from learnharness.core.graph_merge import coverage_index, fingerprint
from learnharness.core.note_sources import (
    citation_target,
    fold_sources,
    is_importable_note,
    is_source_id,
    note_title,
    slice_note,
    source_id_for,
    split_blocks,
    uncovered_slices,
)


def test_source_id_is_sha256_of_the_relative_path() -> None:
    sid = source_id_for("Notas/Atenção.md")
    assert sid == "src_" + hashlib.sha256("Notas/Atenção.md".encode()).hexdigest()[:12]
    assert is_source_id(sid) and not is_source_id("sess-1") and not is_source_id(None)


def test_fold_sources_last_line_wins_and_tombstones_keep_the_title() -> None:
    folded = fold_sources([
        {"id": "src_a", "path": "A.md", "title": "A", "imported_at": "t1"},
        {"id": "src_a", "path": "A.md", "title": "A renamed", "imported_at": "t2"},
        {"id": "src_b", "path": "B.md", "title": "B"},
        {"id": "src_b", "deleted": True},
        {"id": "src_ghost", "deleted": True},
        {"bad": True},
    ])
    assert folded["src_a"].title == "A renamed" and not folded["src_a"].deleted
    assert folded["src_b"].deleted and folded["src_b"].title == "B"
    assert "src_ghost" not in folded
    revived = fold_sources([{"id": "src_b", "path": "B.md", "title": "B"}, {"id": "src_b", "deleted": True},
                            {"id": "src_b", "path": "B.md", "title": "B"}])
    assert not revived["src_b"].deleted


def test_importable_notes_exclude_machine_hidden_and_concept_folders() -> None:
    assert is_importable_note("Notas/x.md", "Conceitos")
    assert is_importable_note("Fontes/Local/aula.md", "Conceitos")
    assert is_importable_note("Aulas/2026-10-27 Atenção.md", "Conceitos")
    assert is_importable_note("solta.md", "Conceitos")
    assert not is_importable_note(".harness/config.md", "Conceitos")
    assert not is_importable_note(".obsidian/x.md", "Conceitos")
    assert not is_importable_note("Conceitos/Softmax.md", "Conceitos")
    assert not is_importable_note("conceitos/Softmax.md", "Conceitos")
    assert not is_importable_note("Notas/x.txt", "Conceitos")
    assert not is_importable_note("../fora.md", "Conceitos")
    assert not is_importable_note("/etc/x.md", "Conceitos")


def test_note_title_prefers_frontmatter_then_h1_then_fallback() -> None:
    assert note_title("---\ntitulo: Atenção\n---\n# Outro\n", "x") == "Atenção"
    assert note_title("---\ntags: [a]\n---\n## H2\n# Primeiro H1\n", "x") == "Primeiro H1"
    assert note_title("só texto", "arquivo") == "arquivo"


def test_split_blocks_keeps_fences_whole_and_isolates_headings() -> None:
    text = "# T\nlinha\n\n```py\na = 1\n\nb = 2\n```\n\nfim"
    assert split_blocks(text) == ["# T", "linha", "```py\na = 1\n\nb = 2\n```", "fim"]


def test_slice_note_by_heading_sections() -> None:
    text = ("---\ntags: [x]\n---\n# Atenção\n\nIntro sobre atenção.\n\n## Softmax\n\n"
            "Softmax normaliza.\n\nSoma um.\n\n## Vazio\n\n## Produto\n\nSoma de produtos.")
    slices = slice_note(text, budget_tokens=4096)
    assert [s.id for s in slices] == ["s1", "s2", "s3"]
    assert slices[0].content == "# Atenção\n\nIntro sobre atenção."
    assert slices[1].heading == "Softmax"
    assert slices[1].content == "## Softmax\n\nSoftmax normaliza.\n\nSoma um."
    assert all("tags" not in s.content for s in slices)  # frontmatter is not knowledge
    assert all(s.heading != "Vazio" for s in slices)  # an empty section yields nothing


def test_slice_note_splits_a_section_over_budget_by_paragraph() -> None:
    para = "palavra " * 40  # ~80 tokens
    text = "# Grande\n\n" + "\n\n".join([para] * 4)
    slices = slice_note(text, budget_tokens=170)
    assert len(slices) == 2
    assert all(s.content.startswith("# Grande") for s in slices)


def test_anchored_notes_slice_per_paragraph_and_use_the_anchor_as_id() -> None:
    text = ("---\ntitulo: X\n---\n# X\n\n> [!info] Fonte importada sem edição. Cite trechos com `[[X#^p1]]`.\n"
            "> Aula explicada: \n\nPrimeiro parágrafo. ^p1\n\nSegundo parágrafo. ^p2\n")
    slices = slice_note(text, budget_tokens=4096)
    assert [s.id for s in slices] == ["p1", "p2"]
    assert slices[0].content == "# X\n\nPrimeiro parágrafo."  # heading as context, anchor stripped
    assert "Fonte importada" not in "".join(s.content for s in slices)
    # The importer anchors headings too ("# X ^p1"): the heading keeps no anchor.
    headed = slice_note("# Aula ^p1\n\nTexto. ^p2\n", 4096)
    assert [(s.id, s.heading, s.content) for s in headed] == [("p2", "Aula", "# Aula\n\nTexto.")]


def test_uncovered_slices_skip_the_same_fingerprint_only() -> None:
    slices = slice_note("# A\n\num\n\n# B\n\ndois", 4096)
    covered = coverage_index([CoverageRecord(session_id="src_x", message_id=slices[0].id,
                                             fp=fingerprint(slices[0].content))])
    left = uncovered_slices("src_x", slices, covered)
    assert [m.message_id for m in left] == [slices[1].id]
    # The same slice id in another source is not covered.
    assert len(uncovered_slices("src_y", slices, covered)) == 2
    edited = slice_note("# A\n\num editado\n\n# B\n\ndois", 4096)
    assert [m.message_id for m in uncovered_slices("src_x", edited, covered)] == [s.id for s in edited]


def test_citation_target_only_anchors_paragraph_ids() -> None:
    assert citation_target("Fontes/Notas/x.md", "p3") == "Fontes/Notas/x#^p3"
    assert citation_target("Notas/y.md", "s2") == "Notas/y"
    assert citation_target("Notas/y.md", None) == "Notas/y"
