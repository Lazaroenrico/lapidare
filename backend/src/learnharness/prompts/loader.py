"""Prompt assembly and system prompt loader for LearnHarness.

Combines modular pedagogical instructions according to session mode,
phase, context kind, and language.
"""

from pathlib import Path
from typing import Literal

from learnharness.core.contracts.session import (
    SessionMode,
    SessionPhase,
    TeachContextKind,
)

PROMPTS_ROOT = Path(__file__).resolve().parent


def _read_prompt_part(relative_path: str) -> str:
    """Read a markdown prompt snippet from disk."""
    file_path = PROMPTS_ROOT / relative_path
    if not file_path.is_file():
        raise FileNotFoundError(f"Prompt snippet not found: {file_path}")
    return file_path.read_text(encoding="utf-8")


def build_system_prompt(
    mode: SessionMode,
    context_kind: TeachContextKind,
    language: Literal["pt-BR", "en"] = "pt-BR",
    phase: SessionPhase = "teaching",
    extra_context: str = "",
) -> str:
    """Assemble modular system prompt for the agent runtime.

    Includes:
    1. Core identity, language rules, and teaching principles (i & ii).
    2. Phase-specific guidance (prober vs teacher vs practice).
    3. Context-specific rules (dense source 4-dimension mapping, 2:1 track integration, free topic).
    4. Optional dynamic extra context (e.g. current note excerpt, prior quiz mistakes).
    """
    parts: list[str] = []

    # 1. Base identity and principles (always included)
    parts.append(_read_prompt_part("shared/01_identity_and_principles.md"))

    # 2. Mode and Phase-specific instructions
    if mode == "PRACTICE":
        parts.append(_read_prompt_part("practice/01_practice.md"))
    else:  # TEACH mode
        if phase in ("probing", "awaiting_answer"):
            parts.append(_read_prompt_part("prober/01_prober.md"))
        parts.append(_read_prompt_part("teacher/01_teacher.md"))

    # 3. Context kind directives
    context_notes: list[str] = [
        "## Session Runtime Context",
        f"- **Session Mode:** `{mode}`",
        f"- **Context Kind:** `{context_kind}`",
        f"- **Current Phase:** `{phase}`",
        f"- **Active Language:** `{language}`",
    ]

    if context_kind == "dense_source":
        context_notes.append(
            "- **Dense Source Ingestion Active:** Slice transcript into logical blocks, "
            "cite paragraph anchors (`[[Fonte#^pN]]`), and systematically map "
            "Dito / Pressuposto / Pulado / Simplificações."
        )
    elif context_kind == "track_step":
        context_notes.append(
            "- **Track Step Active:** Follow 2:1 syllabus progression, connect to established "
            "foundations, and advance syllabus pointer upon completion."
        )
    elif context_kind == "free_topic":
        context_notes.append(
            "- **Free Topic Active:** Probe learner zone of proximal development with 1-3 quizzes, "
            "build minimal dependency DAG via `plan_init`, then teach node by node."
        )

    parts.append("\n".join(context_notes))

    # 4. Extra dynamic context (if provided)
    if extra_context and extra_context.strip():
        parts.append(f"## Dynamic Vault and Session State\n{extra_context.strip()}")

    return "\n\n---\n\n".join(parts)
