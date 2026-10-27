"""Pure rules for feeding notes into the knowledge trace (Fase 16).

ZERO I/O: callers read the note text and the JSONL lines and pass them in.

* ``source_id_for``: stable id of a vault-relative note path.
* ``fold_sources``: append-only ``sources.jsonl`` -> current registry (last line wins).
* ``slice_note``: heading sections (or paragraphs, for anchored ``^pN`` notes and for
  sections over the token budget) that the extractor reads as "messages".
* ``uncovered_slices``: slices whose fingerprint was never extracted.
* ``citation_target``: ``[[note#^pN]]`` target when the slice has an anchor.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping
from pathlib import PurePosixPath
from typing import Any

from pydantic import ValidationError

from learnharness.core.contracts.graph import BatchMessage, NoteSlice, SourceRecord
from learnharness.core.graph_merge import estimate_tokens, fingerprint

SOURCE_PREFIX = "src_"
NOTE_EXTENSIONS = (".md",)

_ANCHOR = re.compile(r"\s*\^(p\d+)\s*$")
_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
# The banner the Fontes/ importer writes under the title: metadata, not knowledge.
_IMPORT_BANNER = re.compile(r"^>\s*\[!info\]", re.IGNORECASE)
_TITLE_KEY = re.compile(r"^(title|titulo|título)\s*:\s*(.+?)\s*$", re.IGNORECASE)


def source_id_for(rel_path: str) -> str:
    """``src_`` + the first 12 hex chars of sha256 of the vault-relative POSIX path."""
    return SOURCE_PREFIX + hashlib.sha256(rel_path.encode("utf-8")).hexdigest()[:12]


def is_source_id(value: str | None) -> bool:
    return bool(value) and str(value).startswith(SOURCE_PREFIX)


def fold_sources(records: Iterable[Mapping[str, Any]]) -> dict[str, SourceRecord]:
    """Fold ``sources.jsonl``: creation/update lines and ``{id, deleted: true}`` tombstones.

    Deleted sources stay in the result (flagged) so their nodes keep a readable label;
    a later registration line revives the source.
    """
    sources: dict[str, SourceRecord] = {}
    for record in records:
        source_id = record.get("id")
        if not isinstance(source_id, str):
            continue
        if record.get("deleted"):
            if source_id in sources:
                sources[source_id].deleted = True
            continue
        try:
            sources[source_id] = SourceRecord.model_validate({**record, "deleted": False})
        except ValidationError:
            continue
    return sources


def is_importable_note(rel_path: str, concepts_dir: str) -> bool:
    """Any ``.md`` of the vault outside hidden folders (``.harness/`` ...) and the concepts folder."""
    path = PurePosixPath(rel_path)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        return False
    if path.suffix.lower() not in NOTE_EXTENSIONS:
        return False
    if any(part.startswith(".") for part in path.parts):
        return False  # .harness/, .obsidian/, .git/, .trash/ ...
    concepts = PurePosixPath(concepts_dir).parts
    return not (concepts and tuple(p.casefold() for p in path.parts[: len(concepts)])
                == tuple(p.casefold() for p in concepts))


def strip_frontmatter(text: str) -> str:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text
    for index in range(1, len(lines)):
        if lines[index].strip() in ("---", "..."):
            return "\n".join(lines[index + 1:])
    return text


def note_title(text: str, fallback: str) -> str:
    """Frontmatter ``title``/``titulo``, else the first H1, else ``fallback``."""
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        for line in lines[1:]:
            if line.strip() in ("---", "..."):
                break
            match = _TITLE_KEY.match(line)
            if match and (value := match.group(2).strip().strip("'\"")):
                return value
    for line in strip_frontmatter(text).splitlines():
        match = _HEADING.match(line)
        if match and len(match.group(1)) == 1 and match.group(2).strip():
            return match.group(2).strip()
    return fallback


def split_blocks(text: str) -> list[str]:
    """Blank-line separated blocks, never splitting inside a fenced code block.

    A heading line outside a fence is always a block of its own.
    """
    blocks: list[str] = []
    current: list[str] = []
    fence: str | None = None

    def flush() -> None:
        block = "\n".join(current).strip()
        if block:
            blocks.append(block)
        current.clear()

    for line in text.splitlines():
        match = _FENCE.match(line)
        if fence is None and match:
            fence = match.group(1)
            current.append(line)
            continue
        if fence is not None:
            current.append(line)
            if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= len(fence) \
                    and line.strip() == match.group(1):
                fence = None
            continue
        if not line.strip():
            flush()
        elif _HEADING.match(line):
            flush()
            current.append(line)
            flush()
        else:
            current.append(line)
    flush()
    return blocks


def _anchor_of(block: str) -> str | None:
    match = _ANCHOR.search(block)
    return match.group(1) if match else None


def _clean(block: str) -> str:
    """Drop a trailing ``^pN`` (the slice id carries it)."""
    return _ANCHOR.sub("", block).rstrip()


def _groups(sections: list[tuple[str, list[str]]], anchored: bool, budget: int) -> list[tuple[str, list[str]]]:
    groups: list[tuple[str, list[str]]] = []
    for heading, paragraphs in sections:
        if not paragraphs:
            continue  # A heading with nothing under it teaches nothing.
        if anchored:
            groups += [(heading, [p]) for p in paragraphs]
            continue
        head_tokens = estimate_tokens(heading)
        if head_tokens + sum(estimate_tokens(p) for p in paragraphs) <= budget:
            groups.append((heading, paragraphs))
            continue
        chunk: list[str] = []
        size = head_tokens
        for paragraph in paragraphs:
            tokens = estimate_tokens(paragraph)
            if chunk and size + tokens > budget:
                groups.append((heading, chunk))
                chunk, size = [], head_tokens
            chunk.append(paragraph)
            size += tokens
        if chunk:
            groups.append((heading, chunk))
    return groups


def slice_note(text: str, budget_tokens: int) -> list[NoteSlice]:
    """Cut a note into extraction slices.

    * Sections start at headings (``#`` .. ``######``); the heading goes with the text under it.
    * A note with ``^pN`` anchors (every ``Fontes/`` file) is cut per paragraph, so each
      proposition can cite its paragraph; each slice keeps its section heading as context.
    * Otherwise a section is one slice, or paragraph groups when it exceeds the budget.
    * A slice id is the anchor of its first paragraph (``p3``) or ``s<n>`` (1-based position).
    """
    blocks = [b for b in split_blocks(strip_frontmatter(text)) if not _IMPORT_BANNER.match(b)]
    anchored = any(_anchor_of(b) for b in blocks)
    sections: list[tuple[str, list[str]]] = []
    for block in blocks:
        if "\n" not in block and _HEADING.match(block):
            sections.append((_clean(block.strip()), []))
        elif sections:
            sections[-1][1].append(block)
        else:
            sections.append(("", [block]))

    slices: list[NoteSlice] = []
    seen: set[str] = set()
    for index, (heading, paragraphs) in enumerate(_groups(sections, anchored, max(budget_tokens, 1)), start=1):
        body = "\n\n".join(_clean(p) for p in paragraphs).strip()
        if not body:
            continue
        anchor = _anchor_of(paragraphs[0])
        slice_id = anchor if anchor and anchor not in seen else f"s{index}"
        seen.add(slice_id)
        content = f"{heading}\n\n{body}" if heading else body
        title = _HEADING.match(heading)
        slices.append(NoteSlice(id=slice_id, content=content, heading=title.group(2) if title else ""))
    return slices


def uncovered_slices(
    source_id: str, slices: Iterable[NoteSlice], coverage: Mapping[tuple[str, str], set[str]]
) -> list[BatchMessage]:
    """Slices whose current fingerprint was never extracted for this source."""
    result: list[BatchMessage] = []
    for item in slices:
        fp = fingerprint(item.content)
        if fp in coverage.get((source_id, item.id), set()):
            continue
        result.append(BatchMessage(message_id=item.id, content=item.content, fp=fp,
                                   tokens=estimate_tokens(item.content)))
    return result


def citation_target(rel_path: str, slice_id: str | None) -> str:
    """Wikilink target (no brackets): ``Fontes/Notas/x#^p3``, or ``Notas/y`` without an anchor."""
    target = rel_path[:-3] if rel_path.endswith(".md") else rel_path
    if slice_id and re.fullmatch(r"p\d+", slice_id):
        return f"{target}#^{slice_id}"
    return target
