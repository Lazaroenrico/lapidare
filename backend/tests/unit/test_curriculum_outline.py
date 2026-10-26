"""Curriculum outline builder used by TrackService.generate over cloned repositories."""

from __future__ import annotations

import json
from pathlib import Path

from learnharness.services.tracks import build_curriculum_outline, markdown_title_and_summary


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _synthetic_repo(root: Path, phases: int = 3, lessons: int = 12) -> None:
    _write(root, "README.md", "# AI Engineering from Scratch\n\n![badge](x.svg)\n\nA hands-on curriculum.")
    _write(root, "ROADMAP.md", "# Roadmap\n\nPhase 0 setup, then math, then transformers.")
    _write(root, "learning-paths/llm-engineer.md", "# LLM Engineer path\n\nPhases 0, 2, 10.")
    _write(root, "node_modules/pkg/README.md", "# Dependency")
    _write(root, ".github/ISSUE.md", "# Hidden")
    for p in range(phases):
        phase = f"phases/{p:02d}-phase-{p}"
        _write(root, f"{phase}/README.md", f"# Phase {p}\n\nOverview of phase {p}.")
        for lesson in range(1, lessons + 1):
            base = f"{phase}/{lesson:02d}-lesson-{p}-{lesson}"
            _write(root, f"{base}/docs/en.md",
                   f"---\nid: x\n---\n# Lesson {p}.{lesson}\n\n```py\ncode()\n```\n\n"
                   f"Learn concept {p}.{lesson} in depth.\nSecond line.\n\nMore text.")
            _write(root, f"{base}/docs/pt.md", f"# Lição {p}.{lesson}\n\nTradução.")
    _write(root, "phases/00-phase-0/01-lesson-0-1/notes.txt", "Plain notes title\n\nbody")
    _write(root, "phases/00-phase-0/01-lesson-0-1/lab.ipynb", json.dumps(
        {"cells": [{"cell_type": "markdown", "source": ["# Notebook lab\n", "text"]}]}))


def test_title_and_summary_skip_frontmatter_code_and_badges() -> None:
    title, summary = markdown_title_and_summary(
        "---\na: 1\n---\n# Title\n\n[![b](x)](y)\n\n```\nx\n```\n\nFirst para\ncontinues.\n\nSecond.")
    assert title == "Title" and summary == "First para continues."


def test_outline_covers_whole_tree_in_curriculum_order(tmp_path: Path) -> None:
    _synthetic_repo(tmp_path)
    outline = build_curriculum_outline(tmp_path)
    # Structure documents first, with content.
    assert outline.index("## Structure documents") < outline.index("## Curriculum outline")
    assert "A hands-on curriculum." in outline and "Phases 0, 2, 10." in outline
    # Every lesson appears once, English preferred, translations dropped, junk skipped.
    assert outline.count("docs/en.md") == 36 and "docs/pt.md" not in outline
    assert "node_modules" not in outline and ".github" not in outline
    assert "phases/02-phase-2/12-lesson-2-12/docs/en.md — Lesson 2.12: Learn concept 2.12 in depth." in outline
    # Natural order: lesson 2 before lesson 10, phase 0 before phase 1.
    assert outline.index("02-lesson-0-2/") < outline.index("10-lesson-0-10/") < outline.index("01-lesson-1-1/")
    # .txt and .ipynb contribute titles.
    assert "notes.txt — Plain notes title" in outline and "lab.ipynb — Notebook lab" in outline


def test_outline_degrades_but_stays_whole_under_budget(tmp_path: Path) -> None:
    _synthetic_repo(tmp_path, phases=10, lessons=40)
    budget = 30_000
    outline = build_curriculum_outline(tmp_path, budget=budget)
    assert len(outline) <= budget
    # Summaries are dropped before coverage: the last lesson of the last phase is still listed.
    assert "Learn concept" not in outline
    assert "phases/09-phase-9/40-lesson-9-40/docs/en.md — Lesson 9.40" in outline

    tiny = build_curriculum_outline(tmp_path, budget=6_000)
    assert len(tiny) <= 6_000
    assert "lessons):" in tiny  # grouped per phase as a last resort
    assert "phases/09-phase-9/" in tiny  # ...and still spans the whole curriculum


def test_outline_skips_artifacts_strips_badges_and_keeps_every_phase(tmp_path):
    from learnharness.services.tracks import build_curriculum_outline

    (tmp_path / "README.md").write_text(
        '<p align="center"><img src="x.svg"><a href="y"><picture>badge</picture></a></p>\n\n'
        "Learn AI from first principles.\n",
        encoding="utf-8",
    )
    for phase in range(20):
        for lesson in range(30):
            unit = tmp_path / "phases" / f"{phase:02d}-phase" / f"{lesson:02d}-lesson-with-a-long-name"
            (unit / "docs").mkdir(parents=True)
            (unit / "docs" / "en.md").write_text(f"# Lesson {phase}.{lesson}\n\nBody.\n", encoding="utf-8")
            (unit / "outputs").mkdir()
            (unit / "outputs" / "prompt.md").write_text("# artifact\n", encoding="utf-8")
    outline = build_curriculum_outline(tmp_path, budget=8000)
    assert "<p" not in outline and "Learn AI from first principles." in outline
    assert "outputs" not in outline and "artifact" not in outline
    assert all(f"phases/{p:02d}-phase" in outline for p in range(20))
    assert "omitted" not in outline
