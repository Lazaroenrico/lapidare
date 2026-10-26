"""Transcript and source importer with paragraph-level citation anchoring.

Enforces Vault Invariant:
1. Fontes/ is strictly READ-ONLY once written.
2. Words in the transcript are NEVER modified or paraphrased.
3. Every paragraph ends with a unique citable block reference: ^p1, ^p2, ..., ^pN.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

from learnharness.vault.safety import (
    atomic_write,
    folder_map,
    locked_path,
    revision,
    safe_component,
    safe_path,
)


def _clean_safe_filename(title: str) -> str:
    """Sanitize title for filesystem naming."""
    clean = re.sub(r'[\\/*?:"<>|]', "", title).strip()
    return re.sub(r"\s+", " ", clean)


def import_transcript_text(
    vault_path: Path,
    raw_text: str,
    title: str,
    prefix: str | None = None,
    modulo: str | None = None,
    tipo: str = "aula",
    is_markdown: bool = False,
    praxis_id: str | None = None,
    force: bool = False,
) -> tuple[Path, int]:
    """Import a raw transcript or document into Fontes/ with ^pN citations.

    Never modifies words. Appends ^p1..^pN to each paragraph.
    Raises FileExistsError if target exists and force is False.
    Returns (target_file_path, paragraph_count).
    """
    vault_path = Path(vault_path).resolve()
    folders = folder_map(vault_path)
    target_dir = safe_path(vault_path, folders.sources_dir)
    if prefix or tipo in ["aula", "pre-aula", "mentoria"]:
        target_dir = safe_path(
            vault_path,
            Path(folders.sources_dir)
            / ("Mentorship" if folders.sources_dir == "Sources" else "Mentoria"),
        )
    safe_title = safe_component(_clean_safe_filename(title))
    if prefix:
        safe_component(prefix)
    filename = f"{prefix} {safe_title}.md" if prefix else f"{safe_title}.md"
    target_file = safe_path(vault_path, target_dir.relative_to(vault_path) / filename)

    # Split paragraphs by double newline (or single newline if text has no double newlines)
    raw_paragraphs = [p.strip() for p in re.split(r"\n\s*\n", raw_text) if p.strip()]
    if len(raw_paragraphs) <= 1 and "\n" in raw_text and len(raw_text) > 400:
        raw_paragraphs = [p.strip() for p in raw_text.splitlines() if p.strip()]

    numbered_paragraphs: list[str] = []
    total_words = 0

    for idx, p in enumerate(raw_paragraphs, start=1):
        # Strip existing ^p\d+ tag if already present
        clean_p = re.sub(r"\s*\^p\d+\s*$", "", p).strip()
        total_words += len(clean_p.split())
        numbered_paragraphs.append(f"{clean_p} ^p{idx}")

    today = datetime.now().strftime("%Y-%m-%d")
    fm_data = {
        "tags": ["fonte", "mentoria"]
        if (prefix or tipo in ["aula", "pre-aula", "mentoria"])
        else ["fonte"],
        "titulo": title,
        "semana": prefix or "",
        "tipo": tipo,
        "modulo": modulo or "",
        "importado": today,
        "praxis_id": praxis_id or "",
        "origem": "Praxis" if praxis_id else "Import",
        "paragrafos": len(numbered_paragraphs),
        "palavras": total_words,
        "content_sha256": revision(raw_text),
    }
    fm_str = yaml.dump(fm_data, allow_unicode=True, default_flow_style=None).strip()

    stem_name = target_file.stem
    content = f"""---
{fm_str}
---
# {title}

> [!info] Transcript bruto da mentoria, sem edição. Cite trechos com `[[{stem_name}#^p1]]`.
> Aula explicada: {modulo or ""}

{"\n\n".join(numbered_paragraphs)}
"""
    with locked_path(target_file):
        if target_file.exists():
            old = target_file.read_text(encoding="utf-8")
            old_fm = yaml.safe_load(old.split("---", 2)[1]) if old.startswith("---") else {}
            if isinstance(old_fm, dict) and old_fm.get("content_sha256") == revision(raw_text):
                return target_file, len(numbered_paragraphs)
            if not force:
                raise FileExistsError(
                    f"Source file {target_file} already exists; force=True creates an immutable version"
                )
            versioned = target_file.with_name(f"{target_file.stem}--{revision(raw_text)[:16]}.md")
            content = content.replace(f"[[{target_file.stem}#", f"[[{versioned.stem}#")
            target_file = safe_path(vault_path, versioned.relative_to(vault_path))
            if target_file.exists():
                existing = target_file.read_text(encoding="utf-8")
                meta = (
                    yaml.safe_load(existing.split("---", 2)[1])
                    if existing.startswith("---")
                    else {}
                )
                if not isinstance(meta, dict) or meta.get("content_sha256") != revision(raw_text):
                    raise FileExistsError("Immutable version name already occupied")
                return target_file, len(numbered_paragraphs)
        atomic_write(target_file, content, create_only=True)
    return target_file, len(numbered_paragraphs)


def get_source_paragraph(
    vault_path: Path,
    source_name: str,
    paragraph_id: str,
    context_radius: int = 2,
) -> dict[str, Any]:
    """Retrieve an anchored paragraph (^pN) with surrounding context for the citation drawer.

    Matches source_name flexibly (with or without .md, wikilinks, or partial match).
    """
    vault_path = Path(vault_path).resolve()

    # Clean source_name: remove wikilink brackets and anchors
    clean_name = re.sub(r"^\[\[|\]\]$", "", source_name.strip())
    if "#" in clean_name:
        clean_name = clean_name.split("#")[0]
    clean_name = clean_name.removesuffix(".md")

    # Resolve exact source-relative paths, then unique basename matches. Never read outside sources.
    source_root = safe_path(vault_path, folder_map(vault_path).sources_dir)
    safe_path(source_root, f"{clean_name}.md")
    if clean_name.startswith(str(source_root.relative_to(vault_path)) + "/"):
        clean_name = clean_name[len(str(source_root.relative_to(vault_path))) + 1 :]
    exact = safe_path(source_root, f"{clean_name}.md")
    target_file = exact if exact.is_file() else None
    if target_file is None and source_root.exists():
        candidates = []
        for candidate in source_root.rglob("*.md"):
            if candidate.stem == clean_name:
                safe_path(vault_path, candidate.relative_to(vault_path))
                candidates.append(candidate)
        if len(candidates) > 1:
            raise ValueError("Ambiguous source name; use its relative path")
        target_file = candidates[0] if candidates else None

    if not target_file:
        raise FileNotFoundError(f"Source file not found for '{source_name}' in {vault_path}")

    # Normalize paragraph ID
    target_pid = paragraph_id.strip().lstrip("^")
    if target_pid.isdigit():
        target_pid = f"p{target_pid}"

    content = target_file.read_text(encoding="utf-8")
    # Parse paragraphs
    raw_paras = [p.strip() for p in re.split(r"\n\s*\n", content) if p.strip()]

    target_idx: int | None = None
    target_text = ""

    for i, p in enumerate(raw_paras):
        m = re.search(r"\^(p\d+)\s*$", p)
        if m and m.group(1).lower() == target_pid.lower():
            target_idx = i
            target_text = p
            break

    if target_idx is None:
        raise KeyError(f"Paragraph '^{target_pid}' not found in {target_file.name}")

    context_radius = max(0, min(context_radius, 50))
    start_idx = max(0, target_idx - context_radius)
    end_idx = min(len(raw_paras), target_idx + context_radius + 1)

    context_before = raw_paras[start_idx:target_idx]
    context_after = raw_paras[target_idx + 1 : end_idx]
    full_context = "\n\n".join(raw_paras[start_idx:end_idx])

    return {
        "source": target_file.name,
        "path": str(target_file),
        "target_paragraph_id": target_pid,
        "target_text": target_text,
        "context_before": context_before,
        "context_after": context_after,
        "full_context": full_context,
        "paragraph_index": target_idx + 1,
        "total_paragraphs": len(raw_paras),
    }
