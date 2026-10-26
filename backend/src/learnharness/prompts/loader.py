"""System prompt assembly from numbered Markdown fragments.

Layout (all paths relative to this package, which is also the override key):

- ``shared/NN-*.md``   — identity, voice, accuracy, questions, confidence, formatting, Vault;
- ``prober/NN-*.md``   — diagnosis (phase ``probing``);
- ``teacher/NN-*.md``  — method, planning, teaching (phases ``planning``/``teaching``);
  fragments named ``NN-context-<kind>.md`` are included only for that context kind;
- ``practice/NN-*.md`` — PRACTICE mode;
- ``handoff.md``       — the automatic planning turn after ``probe_done``.

Fragments are composed in numeric order and joined by ``FRAGMENT_SEPARATOR``. A user
override replaces a fragment's text only when it is enabled in
``config.prompt_overrides`` and its file exists under ``<vault>/.harness/prompts/``.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

PROMPTS_ROOT = Path(__file__).resolve().parent
FRAGMENT_RE = re.compile(r"^\d+-[\w.-]+\.md$")
FRAGMENT_SEPARATOR = "\n\n---\n\n"
FRAGMENT_DIRS = ("shared", "prober", "teacher", "practice")
HANDOFF_PATH = "handoff.md"
OVERRIDES_DIR = ".harness/prompts"
# Used only until HarnessConfig grows ``prompt_overrides``; config wins when both exist.
OVERRIDE_FLAGS_FALLBACK = ".harness/prompt-overrides.json"

# PRACTICE keeps the shared rules except the TEACH question-tool catalogue.
PRACTICE_SHARED_EXCLUDE = frozenset({"shared/50-questions.md"})
PROBING_PHASES = frozenset({"probing"})
LANGUAGE_NAMES = {"pt-BR": "Brazilian Portuguese (pt-BR)", "en": "English (en)"}
_CONTEXT_RE = re.compile(r"^\d+-context-(?P<kind>[\w]+)\.md$")


def _sort_key(name: str) -> tuple[int, str]:
    return int(name.split("-", 1)[0]), name


def _fragments(directory: str) -> list[str]:
    """Fragment paths of one directory, in numeric order."""
    folder = PROMPTS_ROOT / directory
    names = sorted((p.name for p in folder.iterdir() if p.is_file() and FRAGMENT_RE.match(p.name)), key=_sort_key)
    return [f"{directory}/{name}" for name in names]


def list_prompt_segments() -> list[dict[str, str]]:
    """Every editable prompt segment with its bundled text: ``[{path, source}]``."""
    paths = [path for directory in FRAGMENT_DIRS for path in _fragments(directory)] + [HANDOFF_PATH]
    return [{"path": path, "source": (PROMPTS_ROOT / path).read_text(encoding="utf-8")} for path in paths]


def segment_paths() -> set[str]:
    return {segment["path"] for segment in list_prompt_segments()}


def _text(path: str, overrides: Mapping[str, str] | None) -> str:
    if overrides and path in overrides:
        return overrides[path]
    return (PROMPTS_ROOT / path).read_text(encoding="utf-8")


def _applies(path: str, context_kind: str) -> bool:
    match = _CONTEXT_RE.match(path.rsplit("/", 1)[-1])
    return match is None or match.group("kind") == context_kind


def selected_segments(mode: str, context_kind: str, phase: str) -> list[str]:
    """Which fragment paths make up the prompt for this mode/context/phase."""
    shared = _fragments("shared")
    if mode == "PRACTICE":
        return [p for p in shared if p not in PRACTICE_SHARED_EXCLUDE] + _fragments("practice")
    # Legacy phases (awaiting_answer, consolidating) and completed belong to the teacher.
    role = "prober" if phase in PROBING_PHASES else "teacher"
    return shared + [p for p in _fragments(role) if _applies(p, context_kind)]


def _runtime_section(mode: str, context_kind: str, language: str, phase: str) -> str:
    language_name = LANGUAGE_NAMES.get(language, language)
    return "\n".join(
        [
            "# Runtime",
            f"- Mode: `{mode}`",
            f"- Context kind: `{context_kind}`",
            f"- Phase: `{phase}`",
            f"- Session language: `{language}`. Write everything the learner reads in {language_name}.",
        ]
    )


def build_system_prompt(
    mode: str,
    context_kind: str,
    language: str = "pt-BR",
    phase: str = "teaching",
    extra_context: str = "",
    overrides: Mapping[str, str] | None = None,
) -> str:
    """Assemble the system prompt.

    ``overrides`` maps segment path to replacement text and must contain only the
    *active* overrides (see ``load_overrides``).
    """
    parts = [_text(path, overrides) for path in selected_segments(mode, context_kind, phase)]
    parts.append(_runtime_section(mode, context_kind, language, phase))
    if extra_context and extra_context.strip():
        parts.append(f"# Session state\n{extra_context.strip()}")
    return FRAGMENT_SEPARATOR.join(part.strip() for part in parts)


def build_handoff_prompt(language: str = "pt-BR", overrides: Mapping[str, str] | None = None) -> str:
    """User-turn text for the automatic planning turn scheduled after ``probe_done``."""
    language_name = LANGUAGE_NAMES.get(language, language)
    return f"{_text(HANDOFF_PATH, overrides).strip()}\n\nSession language: {language_name}."


def override_file(vault_path: Path, path: str) -> Path:
    from learnharness.vault.safety import safe_path

    return safe_path(vault_path, f"{OVERRIDES_DIR}/{path}")


def load_override_flags(vault_path: Path, config: Any) -> dict[str, bool]:
    """Enabled flags: fallback file first, then ``config.prompt_overrides`` on top."""
    from learnharness.vault.safety import safe_path

    flags: dict[str, bool] = {}
    fallback = safe_path(vault_path, OVERRIDE_FLAGS_FALLBACK)
    if fallback.is_file():
        try:
            raw = json.loads(fallback.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        if isinstance(raw, dict):
            flags.update({str(k): v is True for k, v in raw.items()})
    configured = getattr(config, "prompt_overrides", {}) or {}
    flags.update({str(k): v is True for k, v in dict(configured).items()})
    return flags


def load_overrides(vault_path: Path, config: Any) -> dict[str, str]:
    """Active overrides: enabled in config, a known segment, and present on disk."""
    vault_path = Path(vault_path)
    known = segment_paths()
    active: dict[str, str] = {}
    for path, enabled in load_override_flags(vault_path, config).items():
        if not enabled or path not in known:
            continue
        try:
            target = override_file(vault_path, path)
        except PermissionError:
            continue
        if target.is_file():
            active[path] = target.read_text(encoding="utf-8")
    return active
