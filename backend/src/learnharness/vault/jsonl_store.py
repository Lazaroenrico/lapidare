"""Append-only JSONL machine storage in .harness/.

Maintains session histories, calibration quiz logs, propositional chains,
and constructs the deterministic 2D Canvas GraphSnapshot for the Home view.
Zero destructive overwrites: format is strictly append-only.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from learnharness.core.contracts.graph import GraphEdge, GraphSnapshot, LogicalChain
from learnharness.core.contracts.quiz import CalibrationResult
from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.vault.markdown_ast import scan_all_concepts
from learnharness.vault.safety import append_line, safe_component, safe_path


def _slugify(text: str) -> str:
    """Generate clean node id from title."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower())
    return slug.strip("-")


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

    if isinstance(record_or_event, SessionRecord):
        data = record_or_event.model_dump(mode="json")
    else:
        data = record_or_event

    line = json.dumps(data, ensure_ascii=False) + "\n"
    append_line(file_path, line)


def load_session(vault_path: Path, session_id: str) -> SessionRecord | None:
    """Reconstruct a SessionRecord from its append-only event stream."""
    _, sessions_dir = _ensure_harness_dir(vault_path)
    file_path = safe_path(sessions_dir, f"{safe_component(session_id)}.jsonl")

    if not file_path.exists():
        return None

    lines = [l.strip() for l in file_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not lines:
        return None

    last_record: SessionRecord | None = None

    for line in lines:
        try:
            entry = json.loads(line)
        except Exception:
            continue

        if "mode" in entry and ("id" in entry or "session_id" in entry):
            # Full snapshot
            try:
                if "session_id" in entry and "id" not in entry:
                    entry["id"] = entry["session_id"]
                last_record = SessionRecord.model_validate(entry)
            except Exception:
                pass
        elif last_record is not None:
            # Incremental event
            event_type = entry.get("event")
            if event_type == "message" and "message" in entry:
                try:
                    msg = SessionMessage.model_validate(entry["message"])
                    last_record.messages.append(msg)
                except Exception:
                    pass
            elif event_type == "quiz_pending":
                last_record.pending_quiz_id = entry.get("quiz_id")
            elif event_type == "plan_update" and "plan" in entry:
                try:
                    last_record.plan = entry["plan"]
                except Exception:
                    pass

    return last_record


def list_sessions(vault_path: Path) -> list[SessionRecord]:
    """List all sessions stored in .harness/sessions/, sorted descending by updated_at."""
    _, sessions_dir = _ensure_harness_dir(vault_path)
    records: list[SessionRecord] = []

    for f in sessions_dir.glob("*.jsonl"):
        session_id = f.stem
        rec = load_session(vault_path, session_id)
        if rec:
            records.append(rec)

    records.sort(key=lambda r: r.updated_at or r.created_at or "", reverse=True)
    return records


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

    if isinstance(result, CalibrationResult):
        data = result.model_dump(mode="json")
    else:
        data = result

    if not data.get("timestamp"):
        data["timestamp"] = datetime.now().isoformat()

    line = json.dumps(data, ensure_ascii=False) + "\n"
    append_line(file_path, line)


def load_quiz_logs(vault_path: Path) -> list[CalibrationResult]:
    """Load all calibration logs from .harness/quiz-log.jsonl."""
    harness_dir, _ = _ensure_harness_dir(vault_path)
    file_path = safe_path(harness_dir, "quiz-log.jsonl")

    if not file_path.exists():
        return []

    results: list[CalibrationResult] = []
    for line in file_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            results.append(CalibrationResult.model_validate(data))
        except Exception:
            continue

    return results


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

    if isinstance(chain, LogicalChain):
        data = chain.model_dump(mode="json")
    else:
        data = chain

    if not data.get("created_at"):
        data["created_at"] = datetime.now().isoformat()

    line = json.dumps(data, ensure_ascii=False) + "\n"
    append_line(file_path, line)


def load_chains(vault_path: Path) -> list[LogicalChain]:
    """Load all logical implication chains from .harness/chains.jsonl."""
    harness_dir, _ = _ensure_harness_dir(vault_path)
    file_path = safe_path(harness_dir, "chains.jsonl")

    if not file_path.exists():
        return []

    chains: list[LogicalChain] = []
    for line in file_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            chains.append(LogicalChain.model_validate(data))
        except Exception:
            continue

    return chains


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
                t_slug = _slugify(q.topic)
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
            dep_id = _slugify(dep)
            key = (dep_id, node.id, "depends_on")
            if key not in seen_edges:
                edges.append(GraphEdge(source=dep_id, target=node.id, kind="depends_on"))
                seen_edges.add(key)

    # Chain edges (premises -> conclusion)
    for chain in chains:
        target_id = _slugify(chain.conclusion)
        for premise in chain.premises:
            source_id = _slugify(premise)
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
