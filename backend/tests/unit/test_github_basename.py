"""Basename clash detection for GitHub imports (exact stems, no glob)."""

from pathlib import Path

from learnharness.vault.github_source import _unique_basename


def test_bracketed_names_still_detect_their_clash(tmp_path: Path) -> None:
    existing = tmp_path / "01-[intro].md"
    existing.write_text("---\nrepo_path: other/01-[intro].md\n---\nbody\n", encoding="utf-8")
    index = {"01-[intro]": [existing]}
    assert _unique_basename(index, "01-[intro]", "phase-a/01-[intro].md") == "phase-a - 01-[intro]"
    # The same repo path re-imported is not a clash.
    same = tmp_path / "same.md"
    same.write_text("---\nrepo_path: phase-a/01-[intro].md\n---\n", encoding="utf-8")
    assert _unique_basename({"01-[intro]": [same]}, "01-[intro]", "phase-a/01-[intro].md") == "01-[intro]"
