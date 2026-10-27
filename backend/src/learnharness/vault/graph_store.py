"""Knowledge-trace storage (``.harness/graph/``) and its ``Conceitos/`` mirror (Fase 8B).

* ``nodes.jsonl`` / ``chains.jsonl`` / ``coverage.jsonl`` are append-only; folding lives in
  ``core.graph_merge``.
* ``positions.json`` holds positions dragged by the learner (rewritten atomically).
* Every proposition is mirrored into a short ``Conceitos/<Nome>.md``. Only the managed
  frontmatter keys (``harness_id``, ``aliases``, ``sessions``, the concept tag) and one
  managed block are ever written; free text outside is preserved byte-for-byte. A note
  ``Conceitos/X.md`` that exists without ``harness_id`` is adopted, never overwritten.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from learnharness.core.contracts.graph import (
    ChainRecord,
    CoverageRecord,
    PropositionNode,
    SourceRecord,
)
from learnharness.core.graph_merge import fold_chains, fold_nodes
from learnharness.core.lesson_layout import sanitize_note_title
from learnharness.core.note_sources import fold_sources
from learnharness.vault.jsonl_io import read_objects
from learnharness.vault.markdown_ast import (
    body_without_frontmatter,
    merge_frontmatter_keys,
    merge_owned_blocks,
    read_frontmatter,
    remove_owned_block,
)
from learnharness.vault.safety import (
    append_line,
    atomic_write,
    ensure_not_source,
    folder_map,
    locked_path,
    revision,
    safe_path,
)

logger = logging.getLogger(__name__)

GRAPH_DIR = ".harness/graph"
CONCEPT_BLOCK = "concept:proposition"

_LABELS = {
    "pt-BR": {"statement": "Afirmação", "premises": "Premissas", "origin": "Origem", "tag": "conceito"},
    "en": {"statement": "Statement", "premises": "Premises", "origin": "Origin", "tag": "concept"},
}


def _labels(language: str) -> dict[str, str]:
    return _LABELS["en" if language == "en" else "pt-BR"]


def _file(vault_path: Path, name: str) -> Path:
    return safe_path(Path(vault_path).resolve(), f"{GRAPH_DIR}/{name}")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Cached, append-only read (``jsonl_io``); the dicts are shared and read-only."""
    return read_objects(path)


def append_records(vault_path: Path, name: str, records: list[dict[str, Any]]) -> None:
    """Append ``records`` to ``.harness/graph/<name>`` in one write."""
    if not records:
        return
    payload = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    append_line(_file(vault_path, name), payload)


def load_nodes(vault_path: Path) -> dict[str, PropositionNode]:
    return fold_nodes(_read_jsonl(_file(vault_path, "nodes.jsonl")))


def load_graph_chains(vault_path: Path, live_node_ids: set[str] | None = None) -> list[ChainRecord]:
    return fold_chains(_read_jsonl(_file(vault_path, "chains.jsonl")), live_node_ids)


def raw_chain_records(vault_path: Path) -> list[dict[str, Any]]:
    return _read_jsonl(_file(vault_path, "chains.jsonl"))


def raw_node_records(vault_path: Path) -> list[dict[str, Any]]:
    return _read_jsonl(_file(vault_path, "nodes.jsonl"))


def append_session_unlink(vault_path: Path, session_id: str, plan: dict[str, list[str]]) -> None:
    """Append the unlink lines of ``core.graph_merge.plan_unlink`` and its tombstones.

    ``{id, unlink_session}`` drops the session from that record's provenance; nodes and
    chains left without provenance get ``{id, deleted: true}``. Nothing is rewritten.
    """
    append_records(vault_path, "nodes.jsonl",
                   [{"id": i, "unlink_session": session_id} for i in plan["unlink_nodes"]]
                   + [{"id": i, "deleted": True} for i in plan["dead_nodes"]])
    append_records(vault_path, "chains.jsonl",
                   [{"id": i, "unlink_session": session_id} for i in plan["unlink_chains"]]
                   + [{"id": i, "deleted": True} for i in plan["dead_chains"]])


def load_coverage(vault_path: Path) -> list[CoverageRecord]:
    """Coverage lines; a ``{session_id, reset: true}`` line forgets that origin's earlier lines
    (a note source removed with its nodes is extracted again when re-imported)."""
    result: list[CoverageRecord] = []
    for record in _read_jsonl(_file(vault_path, "coverage.jsonl")):
        if record.get("reset"):
            result = [c for c in result if c.session_id != record.get("session_id")]
            continue
        try:
            result.append(CoverageRecord.model_validate(record))
        except ValidationError:
            continue
    return result


def load_sources(vault_path: Path) -> dict[str, SourceRecord]:
    """Note sources registered for the graph (``sources.jsonl``), deleted ones flagged."""
    return fold_sources(_read_jsonl(_file(vault_path, "sources.jsonl")))


def load_positions(vault_path: Path) -> dict[str, dict[str, float]]:
    path = _file(vault_path, "positions.json")
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Ignoring unreadable graph positions: %s", exc)
        return {}
    return data if isinstance(data, dict) else {}


def save_positions(vault_path: Path, updates: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
    """Merge ``updates`` into ``positions.json`` (not append-only by design)."""
    path = _file(vault_path, "positions.json")
    with locked_path(path):
        positions = load_positions(vault_path)
        positions.update(updates)
        atomic_write(path, json.dumps(positions, ensure_ascii=False, sort_keys=True))
    return positions


# ---------------------------------------------------------------------------
# Conceitos/ mirror
# ---------------------------------------------------------------------------


def render_concept_block(
    node: PropositionNode, premise_groups: list[list[str]], lesson_links: list[str], language: str
) -> str:
    """Managed block: statement, premises (one line per chain) and origin lessons."""
    lang = _labels(language)
    parts = [f"**{lang['statement']}:** {node.statement}"]
    if premise_groups:
        lines = "\n".join("- " + " ∧ ".join(f"[[{p}]]" for p in group) for group in premise_groups)
        parts.append(f"**{lang['premises']}:**\n{lines}")
    if lesson_links:
        parts.append(f"**{lang['origin']}:** " + ", ".join(f"[[{link}]]" for link in lesson_links))
    return "\n\n".join(parts)


def note_link(rel_path: str) -> str:
    """Wikilink target for a vault-relative note path (no ``.md``)."""
    return rel_path[:-3] if rel_path.endswith(".md") else rel_path


def _concepts_folder(vault_path: Path) -> tuple[Path, str]:
    folders = folder_map(vault_path)
    folder = safe_path(vault_path, folders.concepts_dir)
    ensure_not_source(vault_path, folder, folders)
    return folder, folders.concepts_dir


def _apply(content: str, node: PropositionNode, block: str, session_ids: list[str], language: str) -> str:
    current = read_frontmatter(content)
    raw_aliases = current.get("aliases")
    existing = [raw_aliases] if isinstance(raw_aliases, str) else (
        [a for a in raw_aliases if isinstance(a, str)] if isinstance(raw_aliases, list) else [])
    aliases = list(dict.fromkeys([*existing, *node.aliases]))
    managed: dict[str, object] = {"harness_id": node.id, "aliases": aliases, "sessions": session_ids}
    content = merge_frontmatter_keys(content, managed, [_labels(language)["tag"]])
    return merge_owned_blocks(content, [(CONCEPT_BLOCK, block)])


def _write(target: Path, node: PropositionNode, block: str, session_ids: list[str], language: str,
           *, create: bool) -> bool:
    with locked_path(target):
        exists = target.exists()
        if create and exists:
            raise FileExistsError(target.name)
        original = target.read_bytes().decode("utf-8") if exists else None
        content = _apply(original if original is not None else f"# {node.name}\n",
                         node, block, session_ids, language)
        if content == original:
            return False
        atomic_write(target, content, expected_revision=revision(original) if original is not None else None,
                     create_only=not exists)
    return True


def sync_concept_note(
    vault_path: Path,
    node: PropositionNode,
    block: str,
    session_ids: list[str],
    language: str,
    live_node_ids: set[str],
) -> tuple[str, bool, bool]:
    """Mirror ``node`` into its note. Returns ``(rel_path, note_created, bytes_written)``.

    A node without a note gets ``<concepts>/<Nome>.md``: an existing file of that name
    (case-insensitively) without a live ``harness_id`` is adopted; one owned by another
    live node pushes the name to `` (2)``, `` (3)``, ...
    """
    vault_path = Path(vault_path).resolve()
    folder, concepts_dir = _concepts_folder(vault_path)
    if node.vault_rel_path:
        target = safe_path(vault_path, node.vault_rel_path)
        if not target.resolve().is_relative_to(folder.resolve()) or target.suffix != ".md":
            raise PermissionError("Concept notes must be Markdown files inside the concepts folder")
        written = _write(target, node, block, session_ids, language, create=False)
        return node.vault_rel_path, node.note_created, written
    folder.mkdir(parents=True, exist_ok=True)
    existing = {p.name.casefold(): p for p in folder.iterdir() if p.is_file() and p.suffix == ".md"}
    stem = sanitize_note_title(node.name) or node.id
    for attempt in range(1, 1000):
        name = f"{stem}.md" if attempt == 1 else f"{stem} ({attempt}).md"
        found = existing.get(name.casefold())
        if found is not None:
            if found.is_symlink():
                continue
            owner = read_frontmatter(found.read_text(encoding="utf-8")).get("harness_id")
            if owner and owner != node.id and owner in live_node_ids:
                continue
            target, created = found, False
        else:
            target, created = safe_path(vault_path, f"{concepts_dir}/{name}"), True
        try:
            written = _write(target, node, block, session_ids, language, create=created)
        except FileExistsError:
            continue
        return str(target.relative_to(vault_path)), created, written
    raise FileExistsError("Could not allocate a concept note name")


_MANAGED_KEYS = {"harness_id", "aliases", "sessions", "tags"}
_HARNESS_TAGS = {labels["tag"] for labels in _LABELS.values()}


def _only_managed_frontmatter(content: str, node: PropositionNode) -> bool:
    """True when every frontmatter key/value is one the harness writes (a learner's tag,
    alias or property keeps the note alive)."""
    data = read_frontmatter(content)
    if not data and body_without_frontmatter(content) != content:
        return False  # Unparseable YAML is the learner's: keep the note.
    if not set(data) <= _MANAGED_KEYS:
        return False
    tags, aliases = data.get("tags") or [], data.get("aliases") or []
    tags = [tags] if isinstance(tags, str) else tags
    aliases = [aliases] if isinstance(aliases, str) else aliases
    return (isinstance(tags, list) and set(tags) <= _HARNESS_TAGS
            and isinstance(aliases, list) and set(aliases) <= set(node.aliases))


def remove_concept_section(vault_path: Path, node: PropositionNode) -> bool:
    """Remove only the managed block; delete the file only if the harness created it and
    nothing but its heading/frontmatter remains. Returns True when the note changed."""
    if not node.vault_rel_path:
        return False
    vault_path = Path(vault_path).resolve()
    folder, _ = _concepts_folder(vault_path)
    target = safe_path(vault_path, node.vault_rel_path)
    if not target.resolve().is_relative_to(folder.resolve()):
        raise PermissionError("Concept notes must be inside the concepts folder")
    with locked_path(target):
        if not target.exists():
            return False
        original = target.read_bytes().decode("utf-8")
        content = remove_owned_block(original, CONCEPT_BLOCK)
        body = body_without_frontmatter(content).strip()
        if node.note_created and body in ("", f"# {node.name}") and _only_managed_frontmatter(content, node):
            target.unlink()
            return True
        if content == original:
            return False
        atomic_write(target, content, expected_revision=revision(original))
    return True


def harness_owned_note(path: Path) -> bool:
    """True when a concept note carries a ``harness_id`` (it is not a legacy note)."""
    try:
        return bool(read_frontmatter(path.read_text(encoding="utf-8")).get("harness_id"))
    except (OSError, UnicodeDecodeError):
        return False
