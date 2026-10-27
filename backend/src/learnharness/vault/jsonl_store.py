"""Append-only JSONL machine storage in .harness/.

Maintains session histories, calibration quiz logs, propositional chains,
and constructs the deterministic 2D Canvas GraphSnapshot for the Home view.
Zero destructive overwrites: format is strictly append-only.
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from learnharness.core.contracts.graph import GraphEdge, GraphSnapshot, LogicalChain
from learnharness.core.contracts.practice import PracticeLogEntry
from learnharness.core.contracts.quiz import CalibrationResult
from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.core.slug import ascii_slug
from learnharness.vault.jsonl_io import cached_fold, lines_backward, parse_object, read_objects
from learnharness.vault.markdown_ast import scan_all_concepts
from learnharness.vault.safety import append_line, safe_component, safe_path

logger = logging.getLogger(__name__)



def _ensure_harness_dir(vault_path: Path) -> tuple[Path, Path]:
    """Ensure .harness and .harness/sessions directories exist."""
    vault_path = Path(vault_path).resolve()
    harness_dir = safe_path(vault_path, ".harness")
    sessions_dir = safe_path(vault_path, ".harness/sessions")
    harness_dir.mkdir(parents=True, exist_ok=True)
    sessions_dir.mkdir(parents=True, exist_ok=True)
    return harness_dir, sessions_dir


# ==========================================
# 1. Sessions Storage
# ==========================================


def append_session_event(
    vault_path: Path,
    session_id: str,
    record_or_event: dict[str, Any] | SessionRecord,
) -> None:
    """Append a session state snapshot or incremental event to .harness/sessions/<id>.jsonl."""
    _, sessions_dir = _ensure_harness_dir(vault_path)
    file_path = safe_path(sessions_dir, f"{safe_component(session_id)}.jsonl")

    data = (
        record_or_event.model_dump(mode="json")
        if isinstance(record_or_event, SessionRecord)
        else record_or_event
    )

    line = json.dumps(data, ensure_ascii=False) + "\n"
    append_line(file_path, line)


def _sessions_dir(vault_path: Path) -> Path:
    """``.harness/sessions`` without creating it (reads must not touch the disk)."""
    return safe_path(Path(vault_path).resolve(), ".harness/sessions")


def load_session(vault_path: Path, session_id: str) -> SessionRecord | None:
    """Reconstruct a SessionRecord from its append-only event stream."""
    return load_session_file(_sessions_dir(vault_path) / f"{safe_component(session_id)}.jsonl")


def _is_snapshot(entry: dict[str, Any]) -> bool:
    return "mode" in entry and ("id" in entry or "session_id" in entry)


def _snapshot(entry: dict[str, Any], where: str, path: Path) -> SessionRecord | None:
    if "session_id" in entry and "id" not in entry:
        entry["id"] = entry["session_id"]
    try:
        return SessionRecord.model_validate(entry)
    except ValidationError as exc:
        logger.warning("Skipping invalid session snapshot at %s in %s: %s", where, path, exc)
        return None


def _apply_event(record: SessionRecord, entry: dict[str, Any], where: str, path: Path) -> None:
    """Incremental events of older files (nothing writes them any more)."""
    event_type = entry.get("event")
    if event_type == "message" and "message" in entry:
        try:
            msg = SessionMessage.model_validate(entry["message"])
        except ValidationError as exc:
            logger.warning("Skipping invalid session message at %s in %s: %s", where, path, exc)
        else:
            record.messages.append(msg)
    elif event_type == "quiz_pending":
        record.pending_quiz_id = entry.get("quiz_id")
    elif event_type == "plan_update" and "plan" in entry:
        record.plan = entry["plan"]


def _cold_session(path: Path, end: int) -> tuple[SessionRecord | None, int]:
    """Only the last valid snapshot matters: scan back to it, then replay the events after it.

    The earlier lines are never read, so later log line numbers count from this point.
    """
    events: list[dict[str, Any]] = []
    record: SessionRecord | None = None
    for back, line in enumerate(lines_backward(path, end), start=1):
        entry = parse_object(line, -back, path)
        if entry is None:
            continue
        if not _is_snapshot(entry):
            events.append(entry)
        elif (record := _snapshot(entry, f"line -{back}", path)) is not None:
            break
    if record is not None:
        for entry in reversed(events):
            _apply_event(record, entry, "tail", path)
    return record, 0


def _fold_session(record: SessionRecord | None, line: bytes, lineno: int, path: Path) -> SessionRecord | None:
    entry = parse_object(line, lineno, path)
    if entry is None:
        return record
    if _is_snapshot(entry):
        return _snapshot(entry, f"line {lineno}", path) or record
    if record is not None:
        _apply_event(record, entry, f"line {lineno}", path)
    return record


def _finish_session(record: SessionRecord | None, fragment: bytes, lineno: int, path: Path) -> SessionRecord | None:
    copy = record.model_copy(deep=True) if record is not None else None
    return _fold_session(copy, fragment, lineno, path)


_session_reader = cached_fold(_cold_session, _fold_session, _finish_session)


def load_session_file(file_path: Path) -> SessionRecord | None:
    """Replay one session JSONL (live or trashed); unknown events are ignored.

    Every save appends a full snapshot, so only the last valid one is parsed; the result
    is cached until the file grows (``jsonl_io``). Callers own the returned copy.
    """
    record = _session_reader(file_path)
    return record.model_copy(deep=True) if record is not None else None


def list_sessions(vault_path: Path) -> list[SessionRecord]:
    """List all sessions stored in .harness/sessions/, sorted descending by updated_at."""
    sessions_dir = _sessions_dir(vault_path)
    if not sessions_dir.is_dir():
        return []
    records = [rec for f in sessions_dir.glob("*.jsonl") if (rec := load_session_file(f))]
    records.sort(key=lambda r: r.updated_at or r.created_at or "", reverse=True)
    return records


# ------------------------------------------
# 1b. Session trash (.harness/trash/)
# ------------------------------------------

TRASHED_EVENT = "trashed"


def trash_dir(vault_path: Path) -> Path:
    return safe_path(Path(vault_path).resolve(), ".harness/trash")


def trash_file_path(vault_path: Path, file_name: str) -> Path:
    """A trash entry by basename; anything but a plain ``*.jsonl`` name is refused."""
    if not file_name.endswith(".jsonl") or file_name.startswith("."):
        raise PermissionError("Trash entries are .jsonl files inside .harness/trash")
    try:
        component = safe_component(file_name)
    except ValueError:
        raise PermissionError("Trash entries are .jsonl files inside .harness/trash") from None
    return safe_path(trash_dir(vault_path), component)


def last_trashed_event(file_path: Path) -> dict[str, Any] | None:
    """The most recent ``{"event": "trashed"}`` line (absent on pre-trash-index files)."""
    found = None
    for raw in file_path.read_text(encoding="utf-8").splitlines():
        if TRASHED_EVENT not in raw:
            continue
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict) and entry.get("event") == TRASHED_EVENT:
            found = entry
    return found


def trash_entry(file_path: Path) -> dict[str, Any] | None:
    """The listing shape of one trash file, or None when it holds no session snapshot."""
    record = load_session_file(file_path)
    if record is None:
        return None
    event = last_trashed_event(file_path) or {}
    deleted_at = event.get("deleted_at")
    if not isinstance(deleted_at, str):
        # Legacy entry (deleted before the trashed event existed): the rename into
        # trash/ updated the inode's ctime, which is the best available move time.
        deleted_at = datetime.fromtimestamp(file_path.stat().st_ctime).astimezone().isoformat()
    return {
        "id": record.id, "file": file_path.name, "title": record.title, "mode": record.mode,
        "deleted_at": deleted_at, "updated_at": record.updated_at,
        "message_count": len(record.messages),
        "graph_unlinked": bool(event.get("graph_unlinked", False)),
        "delete_mode": event.get("mode"),
    }


def list_trash(vault_path: Path) -> list[dict[str, Any]]:
    """Trashed sessions, most recently deleted first; unreadable files are skipped."""
    folder = trash_dir(vault_path)
    if not folder.is_dir():
        return []
    entries: list[dict[str, Any]] = []
    for f in folder.glob("*.jsonl"):
        if f.is_symlink() or not f.is_file():
            continue
        try:
            entry = trash_entry(f)
        except (OSError, UnicodeDecodeError) as exc:
            logger.warning("Skipping unreadable trash file %s: %s", f, exc)
            continue
        if entry is not None:
            entries.append(entry)
    entries.sort(key=lambda e: _sort_instant(e["deleted_at"]), reverse=True)
    return entries


def _sort_instant(value: str) -> float:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.timestamp()


# ==========================================
# 2. Quiz Logs Storage
# ==========================================


def append_quiz_log(
    vault_path: Path,
    result: CalibrationResult | dict[str, Any],
) -> None:
    """Append a quiz calibration result to .harness/quiz-log.jsonl."""
    harness_dir, _ = _ensure_harness_dir(vault_path)
    file_path = safe_path(harness_dir, "quiz-log.jsonl")

    data = result.model_dump(mode="json") if isinstance(result, CalibrationResult) else result

    if not data.get("timestamp"):
        data["timestamp"] = datetime.now().isoformat()

    line = json.dumps(data, ensure_ascii=False) + "\n"
    append_line(file_path, line)


def _harness_file(vault_path: Path, name: str) -> Path:
    """A file directly under ``.harness/`` without creating the folder."""
    return safe_path(Path(vault_path).resolve(), f".harness/{name}")


def _validated(file_path: Path, model: type[Any], what: str) -> list[Any]:
    results = []
    for entry in read_objects(file_path):
        try:
            results.append(model.model_validate(entry))
        except ValidationError as exc:
            logger.warning("Skipping invalid %s line in %s: %s", what, file_path, exc)
    return results


def load_quiz_logs(vault_path: Path) -> list[CalibrationResult]:
    """Load all calibration logs from .harness/quiz-log.jsonl."""
    return _validated(_harness_file(vault_path, "quiz-log.jsonl"), CalibrationResult, "quiz-log")


def logged_quiz_keys(vault_path: Path) -> set[tuple[Any, Any]]:
    """``(session_id, quiz_id)`` of every quiz-log line (cached read, no model validation)."""
    return {(r.get("session_id"), r.get("quiz_id"))
            for r in read_objects(_harness_file(vault_path, "quiz-log.jsonl"))}


def append_practice_log(vault_path: Path, entry: PracticeLogEntry) -> None:
    """Append one ``conclude`` to .harness/practice-log.jsonl (Fase 9)."""
    harness_dir, _ = _ensure_harness_dir(vault_path)
    append_line(safe_path(harness_dir, "practice-log.jsonl"), entry.model_dump_json() + "\n")


def load_practice_log(vault_path: Path) -> list[PracticeLogEntry]:
    """All valid lines of .harness/practice-log.jsonl (malformed ones are skipped)."""
    return _validated(_harness_file(vault_path, "practice-log.jsonl"), PracticeLogEntry, "practice-log")


# ==========================================
# 3. Chains Storage
# ==========================================


def append_chain(
    vault_path: Path,
    chain: LogicalChain | dict[str, Any],
) -> None:
    """Append a logical implication chain (A ∧ B ⟹ C) to .harness/chains.jsonl."""
    harness_dir, _ = _ensure_harness_dir(vault_path)
    file_path = safe_path(harness_dir, "chains.jsonl")

    data = chain.model_dump(mode="json") if isinstance(chain, LogicalChain) else chain

    if not data.get("created_at"):
        data["created_at"] = datetime.now().isoformat()

    line = json.dumps(data, ensure_ascii=False) + "\n"
    append_line(file_path, line)


def load_chains(vault_path: Path) -> list[LogicalChain]:
    """Load all logical implication chains from .harness/chains.jsonl."""
    return _validated(_harness_file(vault_path, "chains.jsonl"), LogicalChain, "chain")


# ==========================================
# 4. Graph Snapshot Generator
# ==========================================


def build_graph_snapshot(vault_path: Path) -> GraphSnapshot:
    """Build complete GraphSnapshot for the single central 2D Canvas graph.

    Combines:
    - ConceptNode list scanned from Conceitos/*.md
    - LogicalChain list loaded from .harness/chains.jsonl
    - Mistake counts from .harness/quiz-log.jsonl
    - Deterministic radial/cluster coordinates (x, y) so every node renders smoothly
    - Directed edges representing depends_on and chain premises
    """
    vault_path = Path(vault_path).resolve()
    concepts = scan_all_concepts(vault_path)
    chains = load_chains(vault_path)
    quiz_logs = load_quiz_logs(vault_path)

    # 1. Calculate mistakes per concept from quiz logs
    mistakes_by_concept: dict[str, int] = {}
    for q in quiz_logs:
        if not q.correct:
            if q.node_id:
                mistakes_by_concept[q.node_id] = mistakes_by_concept.get(q.node_id, 0) + 1
            if q.topic:
                t_slug = ascii_slug(q.topic)
                mistakes_by_concept[t_slug] = mistakes_by_concept.get(t_slug, 0) + 1

    # 2. Assign deterministic coordinates and mistake counts
    total_nodes = max(len(concepts), 1)
    for idx, node in enumerate(concepts):
        # Update mistake count if higher from quiz logs
        log_mistakes = mistakes_by_concept.get(node.id, 0)
        node.mistake_count = max(node.mistake_count, log_mistakes)

        # Deterministic radial positioning
        if node.x is None or node.y is None:
            angle = (2.0 * math.pi * idx) / total_nodes
            radius = 320.0 + 90.0 * (idx % 3)
            node.x = round(radius * math.cos(angle), 1)
            node.y = round(radius * math.sin(angle), 1)

    # 3. Build directed edges
    edges: list[GraphEdge] = []
    seen_edges: set[tuple[str, str, str]] = set()

    # Depende de edges
    for node in concepts:
        for dep in node.depends_on:
            dep_id = ascii_slug(dep)
            key = (dep_id, node.id, "depends_on")
            if key not in seen_edges:
                edges.append(GraphEdge(source=dep_id, target=node.id, kind="depends_on"))
                seen_edges.add(key)

    # Chain edges (premises -> conclusion)
    for chain in chains:
        target_id = ascii_slug(chain.conclusion)
        for premise in chain.premises:
            source_id = ascii_slug(premise)
            key = (source_id, target_id, "chain")
            if key not in seen_edges:
                edges.append(GraphEdge(source=source_id, target=target_id, kind="chain"))
                seen_edges.add(key)

    return GraphSnapshot(
        nodes=concepts,
        edges=edges,
        chains=chains,
        updated_at=datetime.now().isoformat(),
    )
