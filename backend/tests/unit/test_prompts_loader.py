"""Prompt fragments: naming, ordering, phase selection, handoff and overrides."""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from learnharness.prompts.loader import (
    FRAGMENT_DIRS,
    FRAGMENT_RE,
    FRAGMENT_SEPARATOR,
    PROMPTS_ROOT,
    build_handoff_prompt,
    build_system_prompt,
    list_prompt_segments,
    load_overrides,
    selected_segments,
)

SPEC_TOOLS = {
    "probe", "recall", "quiz", "explain", "ask_user_question", "probe_done",
    "plan_init", "grade_recall", "plan_advance", "track_foundation", "spawn_demo",
}


def test_every_fragment_matches_the_naming_regex():
    assert FRAGMENT_RE.pattern == r"^\d+-[\w.-]+\.md$"
    for directory in FRAGMENT_DIRS:
        files = [p.name for p in (PROMPTS_ROOT / directory).iterdir() if p.suffix == ".md"]
        assert files, directory
        for name in files:
            assert FRAGMENT_RE.match(name), f"{directory}/{name}"


def test_segments_are_listed_in_numeric_order_with_sources():
    segments = list_prompt_segments()
    paths = [s["path"] for s in segments]
    assert paths[-1] == "handoff.md"
    for directory in FRAGMENT_DIRS:
        numbers = [int(p.split("/")[1].split("-")[0]) for p in paths if p.startswith(f"{directory}/")]
        assert numbers == sorted(numbers)
    assert all(s["source"].strip() for s in segments)


def test_tools_named_in_prompts_are_exactly_the_spec_tools():
    text = "\n".join(s["source"] for s in list_prompt_segments() if not s["path"].startswith("practice/"))
    for name in SPEC_TOOLS:
        assert f"`{name}" in text, name
    assert "pose_quiz" not in text
    named = set(re.findall(r"`([a-z]+_[a-z_]+)\(", text)) | set(re.findall(r"`([a-z]+_[a-z_]+)`", text))
    tool_like = {n for n in named if n.endswith(("_question", "_done", "_init", "_recall", "_advance", "_foundation", "_demo"))}
    assert tool_like <= SPEC_TOOLS


def test_probing_uses_shared_and_prober_only():
    paths = selected_segments("TEACH", "free_topic", "probing")
    assert any(p.startswith("shared/") for p in paths)
    assert any(p.startswith("prober/") for p in paths)
    assert not any(p.startswith(("teacher/", "practice/")) for p in paths)
    prompt = build_system_prompt("TEACH", "free_topic", "pt-BR", "probing")
    assert "probe_done" in prompt and "binary-search" in prompt


@pytest.mark.parametrize("phase", ["planning", "teaching", "awaiting_answer", "consolidating", "completed"])
def test_planning_teaching_and_legacy_phases_use_teacher(phase):
    paths = selected_segments("TEACH", "free_topic", phase)
    assert any(p.startswith("teacher/") for p in paths)
    assert not any(p.startswith(("prober/", "practice/")) for p in paths)


def test_context_fragments_are_included_only_for_their_kind():
    dense = build_system_prompt("TEACH", "dense_source", "pt-BR", "teaching")
    for word in ("Dito", "Pressuposto", "Pulado", "Simplificações", "[[Fonte#^pN]]", "four_dimensions"):
        assert word in dense
    assert "2:1" not in dense
    track = build_system_prompt("TEACH", "track_step", "pt-BR", "teaching")
    assert "2:1" in track and "track_foundation" in track and "Pressuposto" not in track
    drawing = selected_segments("TEACH", "drawing_review", "teaching")
    assert "teacher/80-context-drawing_review.md" in drawing
    assert not any("context-" in p for p in selected_segments("TEACH", "free_topic", "teaching"))


def test_practice_uses_shared_subset_and_unchanged_practice_text():
    paths = selected_segments("PRACTICE", "free_topic", "teaching")
    assert "practice/10-practice.md" in paths
    assert "shared/50-questions.md" not in paths
    assert not any(p.startswith(("prober/", "teacher/")) for p in paths)
    prompt = build_system_prompt("PRACTICE", "free_topic", "pt-BR", "teaching")
    assert "R0" in prompt and "R5" in prompt and "Commit-Before-Pose" in prompt


def test_runtime_section_language_and_extra_context():
    prompt = build_system_prompt("TEACH", "free_topic", "en", "teaching", extra_context='{"topic": "x"}')
    assert "Session language: `en`" in prompt and "English" in prompt
    assert prompt.rstrip().endswith('{"topic": "x"}')
    assert FRAGMENT_SEPARATOR in prompt
    pt = build_system_prompt("TEACH", "free_topic")  # backward-compatible defaults
    assert "Brazilian Portuguese" in pt


def test_quiz_example_uses_double_backslash_latex():
    questions = (PROMPTS_ROOT / "shared/50-questions.md").read_text(encoding="utf-8")
    block = questions.split("```json", 1)[1].split("```", 1)[0]
    payload = json.loads(block)
    assert payload["type"] == "check" and payload["correct"] == "A"
    assert "\\mathrm{softmax}" in payload["question"]  # decoded: single backslash
    assert "\\\\mathrm" in block  # encoded: doubled


def test_handoff_prompt():
    text = build_handoff_prompt("en")
    assert "plan_init" in text and "End your turn" in text and "English" in text
    assert "Brazilian Portuguese" in build_handoff_prompt("pt-BR")
    assert build_handoff_prompt("en", overrides={"handoff.md": "CUSTOM"}).startswith("CUSTOM")


def _write_override(vault: Path, path: str, text: str) -> None:
    target = vault / ".harness/prompts" / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def test_overrides_apply_only_when_enabled_and_present(tmp_path):
    vault = tmp_path
    _write_override(vault, "shared/20-voice.md", "VOICE OVERRIDE")
    _write_override(vault, "teacher/30-teaching.md", "TEACHING OVERRIDE")

    on = SimpleNamespace(prompt_overrides={"shared/20-voice.md": True, "teacher/30-teaching.md": False,
                                           "prober/10-diagnosis.md": True, "../evil.md": True})
    active = load_overrides(vault, on)
    assert active == {"shared/20-voice.md": "VOICE OVERRIDE"}  # disabled, missing and unknown are skipped

    prompt = build_system_prompt("TEACH", "free_topic", "pt-BR", "teaching", overrides=active)
    assert "VOICE OVERRIDE" in prompt and "No praise" not in prompt
    assert "TEACHING OVERRIDE" not in prompt

    assert load_overrides(vault, SimpleNamespace()) == {}  # config without the field yet
    assert "No praise" in build_system_prompt("TEACH", "free_topic", overrides=None)


def test_overrides_fallback_flag_file(tmp_path):
    _write_override(tmp_path, "shared/20-voice.md", "FROM FALLBACK")
    (tmp_path / ".harness/prompt-overrides.json").write_text(json.dumps({"shared/20-voice.md": True}))
    assert load_overrides(tmp_path, SimpleNamespace()) == {"shared/20-voice.md": "FROM FALLBACK"}
    # The config field, once present, wins over the fallback file.
    assert load_overrides(tmp_path, SimpleNamespace(prompt_overrides={"shared/20-voice.md": False})) == {}
