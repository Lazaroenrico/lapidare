"""⇶ Roteiro: modules and submodules of a track's steps (pure).

The Home draws each track as a constellation whose modules are
sub-constellations. The grouping is derived, never stored:

- goal/manual tracks: one module per ``stage_label`` (no label → one default module);
- repo/github/legacy tracks: the first meaningful directory of ``source_ref`` is the
  module and the next one the submodule (``phases/03-deep-learning/02-attention/docs/en.md``
  → module "Deep learning", submodule "Attention"); without a usable path the stage
  label applies.

The default module has ``id="track"`` and an empty title (the UI names it, per locale).
Module ``order`` is the order of first appearance in the queue.
"""
from __future__ import annotations

import re
from typing import Any

from learnharness.core.contracts.config import TrackConfig, TrackItem
from learnharness.core.repo_paths import GENERIC_STEMS, LANGUAGE_STEMS

DEFAULT_MODULE_ID = "track"
PATH_SOURCES = {"repo", "github", "legacy"}
# Directory names that group lessons without naming a subject.
CONTAINER_DIRS = {
    "phases", "phase", "lessons", "modules", "module", "chapters", "chapter", "units", "unit",
    "sections", "section", "parts", "part", "weeks", "week", "curriculum", "course", "courses",
    "code", "notebooks", "notebook", "exercises", "exercise", "assets", "images", "img", "examples",
    "outputs", "output", "static", "public",
}
SKIPPED_DIRS = GENERIC_STEMS | LANGUAGE_STEMS | CONTAINER_DIRS
ACRONYMS = {
    "ai", "ml", "llm", "nlp", "rnn", "cnn", "gpt", "api", "rag", "gan", "mlp", "sql", "gpu", "cpu",
    "rl", "cv", "nn", "svm", "pca", "bert", "lstm", "gru", "mcp", "json", "http", "ui", "ux", "os",
    "js", "ts", "css", "html", "io", "ci", "cd", "aws", "gcp", "vae", "rlhf", "dpo", "ppo", "kv",
}
_NUMERIC_PREFIX = re.compile(r"^\s*\d+(?:[._-]\d+)*[\s._-]*")
_FILE_SUFFIX = re.compile(r"\.[A-Za-z0-9]{1,8}$")


def _word(word: str, first: bool) -> str:
    low = word.lower()
    if low in ACRONYMS:
        return low.upper()
    if low.endswith("s") and low[:-1] in ACRONYMS:
        return low[:-1].upper() + "s"
    if word.isupper() and len(word) > 1:
        return word  # already an acronym in the source
    if any(c.isupper() for c in word[1:]):
        return word  # PyTorch, LangGraph
    return low.capitalize() if first else low


def prettify_segment(segment: str) -> str:
    """``03-deep_learning`` → ``Deep learning``; acronyms stay upper case (``llm-basics`` → ``LLM basics``)."""
    text = _NUMERIC_PREFIX.sub("", segment.strip()) or segment.strip()
    words = [w for w in re.split(r"[\s_-]+", text) if w]
    return " ".join(_word(w, i == 0) for i, w in enumerate(words))


def _meaningful_dirs(source_ref: str) -> list[tuple[str, str]]:
    """``(prefix path, segment)`` for each directory of ``source_ref`` worth naming."""
    parts = [p for p in re.split(r"[\\/]+", source_ref.strip()) if p and p != "."]
    if parts and _FILE_SUFFIX.search(parts[-1]):
        parts = parts[:-1]  # the file itself is the step, not a group
    out: list[tuple[str, str]] = []
    for i, part in enumerate(parts):
        if part.lower() in SKIPPED_DIRS or part == "..":
            continue
        out.append(("/".join(parts[: i + 1]), part))
    return out


def item_grouping(track: TrackConfig, item: TrackItem) -> tuple[dict[str, str], dict[str, str] | None]:
    """``(module {id, title}, submodule {id, title} | None)`` of one step."""
    if track.source in PATH_SOURCES and item.source_ref:
        dirs = _meaningful_dirs(item.source_ref)
        if dirs:
            module = {"id": f"path:{dirs[0][0]}", "title": prettify_segment(dirs[0][1])}
            sub = {"id": f"path:{dirs[1][0]}", "title": prettify_segment(dirs[1][1])} if len(dirs) > 1 else None
            return module, sub
    label = " ".join(item.stage_label.split())
    if label:
        return {"id": f"stage:{label.casefold()}", "title": label}, None
    return {"id": DEFAULT_MODULE_ID, "title": ""}, None


def roadmap_layout(track: TrackConfig) -> dict[str, dict[str, Any]]:
    """Per item id: ``{order, module: {id, title, order}, submodule: {id, title} | None}``."""
    module_order: dict[str, int] = {}
    out: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(track.queue):
        module, sub = item_grouping(track, item)
        order = module_order.setdefault(module["id"], len(module_order))
        out[item.id] = {"order": index, "module": {**module, "order": order}, "submodule": sub}
    return out
