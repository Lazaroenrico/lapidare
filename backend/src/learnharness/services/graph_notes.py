"""Notes -> knowledge trace (Fase 16).

Vault notes (and files uploaded into ``Fontes/Notas/``) feed the same extraction pipeline
as TEACH sessions, with a "learner's notes" preamble:

* each note is a **source** ``src_<sha256(path)[:12]>`` registered in
  ``.harness/graph/sources.jsonl`` (append-only, ``{id, path, title, imported_at}``);
* the note is cut into slices (headings, or paragraphs for ``^pN`` notes) and each slice
  plays the role of a teacher message: coverage is ``(source_id, slice id, fingerprint)``,
  so re-importing an unchanged note extracts nothing;
* node provenance is ``{session_id: source_id, message_id: slice id}`` and concept notes
  cite ``[[note#^pN]]`` when the slice has an anchor.

Notes are only **read**: nothing here writes, moves or deletes a user note. Removing a
source (``delete_source``) unlinks its provenance like a deleted session does.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from learnharness.core.contracts.graph import SourceRecord
from learnharness.core.events import SseEventType
from learnharness.core.graph_merge import coverage_index, select_batch
from learnharness.core.note_sources import (
    is_importable_note,
    is_source_id,
    note_title,
    slice_note,
    source_id_for,
    uncovered_slices,
)
from learnharness.vault.graph_store import append_records, load_coverage, load_sources
from learnharness.vault.safety import folder_map, safe_path

if TYPE_CHECKING:
    from collections.abc import Callable

    from learnharness.api.state import AppState

logger = logging.getLogger(__name__)

# Files extracted at the same time inside one ``notes_import`` job.
PARALLEL_FILES = 3
MAX_LISTED_NOTES = 5000
MAX_NOTES_PER_IMPORT = 200


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ---------------------------------------------------------------------------- registry


def sources(state: AppState) -> dict[str, SourceRecord]:
    return load_sources(state.vault_path)


def register_source(state: AppState, rel_path: str, title: str) -> SourceRecord:
    """Register (or revive) ``rel_path`` as a graph source; idempotent for the same title."""
    source_id = source_id_for(rel_path)
    current = sources(state).get(source_id)
    if current is not None and not current.deleted and current.path == rel_path and current.title == title:
        return current
    record = SourceRecord(id=source_id, path=rel_path, title=title, imported_at=_now())
    append_records(state.vault_path, "sources.jsonl", [record.model_dump(exclude={"deleted"})])
    return record


def normalize_note_path(state: AppState, raw: str) -> str:
    """Validate a vault-relative note path for ``import-vault`` (read-only use).

    Accepts any ``.md`` outside hidden folders (``.harness/`` ...) and the concepts folder,
    including ``Fontes/`` and ``Aulas/``. Raises ``ValueError`` / ``PermissionError`` /
    ``FileNotFoundError``.
    """
    rel = PurePosixPath(raw.strip().replace("\\", "/")).as_posix()
    if not is_importable_note(rel, folder_map(state.vault_path).concepts_dir):
        raise ValueError(f"Not an importable note: {raw}")
    path = safe_path(state.vault_path, rel)  # rejects traversal and symlinks
    if not path.is_file():
        raise FileNotFoundError(f"Note not found: {raw}")
    return rel


def read_note(state: AppState, rel_path: str) -> str:
    data = safe_path(state.vault_path, rel_path).read_bytes()
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def register_vault_note(state: AppState, rel_path: str) -> SourceRecord:
    rel = normalize_note_path(state, rel_path)
    return register_source(state, rel, note_title(read_note(state, rel), PurePosixPath(rel).stem))


def importable_notes(state: AppState) -> dict[str, Any]:
    """Every importable ``.md`` of the vault (sorted), with its source id and import state."""
    vault = Path(state.vault_path).resolve()
    concepts_dir = folder_map(vault).concepts_dir
    registered = {s.id: s for s in sources(state).values() if not s.deleted}
    notes: list[dict[str, Any]] = []
    truncated = False
    for root, dirs, files in os.walk(vault, followlinks=False):
        rel_root = Path(root).relative_to(vault)
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not (Path(root) / d).is_symlink()
                         and is_importable_note((rel_root / d / "x.md").as_posix(), concepts_dir))
        for name in sorted(files):
            rel = (rel_root / name).as_posix()
            if (Path(root) / name).is_symlink() or not is_importable_note(rel, concepts_dir):
                continue
            if len(notes) >= MAX_LISTED_NOTES:
                truncated = True
                break
            source_id = source_id_for(rel)
            notes.append({"path": rel, "name": PurePosixPath(rel).stem,
                          "folder": PurePosixPath(rel).parent.as_posix() if "/" in rel else "",
                          "source_id": source_id, "imported": source_id in registered})
        if truncated:
            break
    notes.sort(key=lambda n: n["path"].casefold())
    return {"notes": notes, "truncated": truncated}


def source_note(state: AppState, source_id: str) -> dict[str, Any]:
    """Read-only markdown of a registered source note (the node card's "nota: …" link)."""
    source = sources(state).get(source_id)
    if source is None:
        raise FileNotFoundError(f"Source '{source_id}' not found")
    path = safe_path(state.vault_path, source.path)
    if not path.is_file():
        raise FileNotFoundError(f"Note '{source.path}' no longer exists")
    return {"id": source.id, "path": source.path, "title": source.title, "markdown": read_note(state, source.path)}


def list_sources(state: AppState) -> list[dict[str, Any]]:
    from learnharness.vault.graph_store import load_nodes

    counts: dict[str, int] = {}
    for node in load_nodes(state.vault_path).values():
        for source_id in {p.session_id for p in node.provenance if is_source_id(p.session_id)}:
            counts[source_id] = counts.get(source_id, 0) + 1
    return [{**s.model_dump(exclude={"deleted"}), "node_count": counts.get(s.id, 0)}
            for s in sources(state).values() if not s.deleted]


# ---------------------------------------------------------------------------- job


def request_import(state: AppState, records: list[SourceRecord]) -> dict[str, Any]:
    """Queue one ``notes_import`` job for ``records`` (one status line per file)."""
    if not records:
        raise ValueError("No notes to import")
    if len(records) > MAX_NOTES_PER_IMPORT:
        raise ValueError(f"At most {MAX_NOTES_PER_IMPORT} notes per import")
    unique = list({r.id: r for r in records}.values())
    language = state.get_config().language
    label = (unique[0].title if len(unique) == 1
             else (f"{len(unique)} notes" if language == "en" else f"{len(unique)} notas"))
    files = [{"source_id": r.id, "path": r.path, "title": r.title} for r in unique]
    digest = hashlib.sha256("|".join(sorted(r.id for r in unique)).encode()).hexdigest()[:16]
    return state.jobs.submit("notes_import", {"label": label, "files": files},
                             key=f"notes:{digest}", dedup_statuses=("queued", "running"))


async def run_import_job(state: AppState, record: dict[str, Any], save: Callable[[], None]) -> dict[str, Any]:
    """Job body: extract every file of the job, up to ``PARALLEL_FILES`` at a time.

    ``record["files"]`` carries one live status per file (``queued → running →
    completed | partial | failed``). Raises when any file did not complete, so the job
    ends ``failed`` and ``retry`` re-runs it (finished slices are covered: no rework).
    """
    payload = record.get("payload") or {}
    record["files"] = [{**f, "status": "queued", "batches": 0, "new_node_ids": [], "error": None}
                       for f in payload.get("files", [])]
    save()
    semaphore = asyncio.Semaphore(PARALLEL_FILES)
    done = 0

    async def one(entry: dict[str, Any]) -> None:
        nonlocal done
        async with semaphore:
            entry["status"] = "running"
            save()
            await _extract_file(state, entry, save)
            done += 1
            record["activity"] = f"{done}/{len(record['files'])}"
            save()

    await asyncio.gather(*(one(e) for e in record["files"]))
    failed = [f for f in record["files"] if f["status"] != "completed"]
    summary = {"files": len(record["files"]),
               "new_node_ids": [i for f in record["files"] for i in f["new_node_ids"]],
               "batches": sum(f["batches"] for f in record["files"])}
    if failed:
        raise RuntimeError("; ".join(f"{f['title']}: {f['error'] or f['status']}" for f in failed))
    return summary


async def _extract_file(state: AppState, entry: dict[str, Any], save: Callable[[], None]) -> None:
    from learnharness.pipelines.extraction import run_extraction_pipeline

    vault = state.vault_path
    config = state.get_config()
    budget = config.graph.extraction_chunk_tokens
    source_id = entry["source_id"]
    try:
        slices = slice_note(read_note(state, entry["path"]), budget)
    except (OSError, PermissionError) as exc:
        entry.update(status="failed", error=state.redact(str(exc)) or type(exc).__name__)
        return
    note_errors: list[str] = []
    try:
        for _ in range(len(slices) + 1):
            coverage = coverage_index(r for r in load_coverage(vault) if r.session_id == source_id)
            batch = select_batch(uncovered_slices(source_id, slices, coverage), budget)
            if not batch:
                break
            result = await run_extraction_pipeline(
                vault, source_id, batch,
                engine=state.engine(config.slots.background), slot=config.slots.background,
                session_title=entry["title"], language=config.language,
                origin="notes", merge_lock=state.graph.lock,
            )
            entry["batches"] += 1
            entry["new_node_ids"] += result.get("new_node_ids", [])
            note_errors += result.get("note_errors", [])
            save()
            state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {"source_id": source_id})
            if result.get("notes_written"):
                state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"paths": result["notes_written"]})
    except Exception as exc:
        logger.exception("Note extraction failed for %s", entry["path"])
        entry.update(status="partial" if entry["batches"] else "failed",
                     error=state.redact(str(exc)) or type(exc).__name__)
        return
    if note_errors:
        entry.update(status="partial", error="Concept notes not written: " + "; ".join(note_errors))
    else:
        entry["status"] = "completed"


# ---------------------------------------------------------------------------- removal


async def delete_source(state: AppState, source_id: str, mode: str) -> dict[str, Any]:
    """Forget a source. ``delete-nodes`` also unlinks its provenance (nodes left without any
    provenance are tombstoned) and resets its coverage. The note itself is never touched."""
    if mode not in ("preserve-graph", "delete-nodes"):
        raise ValueError("mode must be preserve-graph or delete-nodes")
    source = sources(state).get(source_id)
    if source is None or source.deleted:
        raise FileNotFoundError(f"Source '{source_id}' not found")
    result: dict[str, Any] = {"ok": True, "id": source_id, "mode": mode, "unlinked_node_ids": [],
                              "deleted_node_ids": [], "deleted_chain_ids": []}
    if mode == "delete-nodes":
        unlinked = await state.graph.unlink_session(source_id)
        result.update({k: unlinked[k] for k in ("unlinked_node_ids", "deleted_node_ids", "deleted_chain_ids")})
        append_records(state.vault_path, "coverage.jsonl", [{"session_id": source_id, "reset": True, "at": _now()}])
    append_records(state.vault_path, "sources.jsonl", [{"id": source_id, "deleted": True}])
    state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {"source_id": source_id})
    return result
