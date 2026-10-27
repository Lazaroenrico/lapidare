"""Track leveling (Fase 15): pure rules for the binary-search diagnosis of a track.

A leveling session is a TEACH session with ``context_kind="leveling"``. The agent sees the
track's pending queue in order, probes the middle item, moves up or down, and closes with
``leveling_done(known_item_ids, start_item_id, summary)``. These functions validate that call,
apply it to a ``TrackConfig`` (recording an undo snapshot) and undo it. Zero I/O.
"""
from __future__ import annotations

from typing import Any

from learnharness.core.contracts.config import TrackConfig, TrackItem
from learnharness.core.contracts.session import LevelingItemFlags, LevelingItemRef, LevelingResult

LEVELED_STATUS_DETAIL = "nivelado"
# Below this many pending steps a diagnosis costs more than walking the steps.
MIN_PENDING_FOR_LEVELING = 4
MAX_LEVELING_QUESTIONS = 12


class LevelingError(ValueError):
    """A ``leveling_done`` call or an undo that cannot be applied; the text says how to fix it."""


def pending_queue(track: TrackConfig) -> list[TrackItem]:
    """The steps not completed yet, in track order."""
    return [item for item in track.queue if not item.completed]


def can_level(track: TrackConfig) -> bool:
    return not track.archived and len(pending_queue(track)) >= MIN_PENDING_FOR_LEVELING


def leveling_context(track: TrackConfig, questions_asked: int = 0) -> dict[str, Any]:
    """What the agent receives: the ordered pending queue with pending prerequisites only
    (completed prerequisites are already satisfied) and the question budget."""
    pending = pending_queue(track)
    pending_ids = {item.id for item in pending}
    return {
        "track_id": track.id,
        "track_title": track.title,
        "pending_count": len(pending),
        "pending_queue": [
            {"position": n, "id": item.id, "title": item.title,
             "prerequisites": [p for p in item.prerequisites if p in pending_ids]}
            for n, item in enumerate(pending, start=1)
        ],
        "questions_asked": questions_asked,
        "max_questions": MAX_LEVELING_QUESTIONS,
    }


def validate_leveling(track: TrackConfig, known_item_ids: list[str], start_item_id: str) -> list[str]:
    """Check a ``leveling_done`` call against the track; returns the known ids deduplicated
    in track order. Raises ``LevelingError`` with corrective text."""
    pending = pending_queue(track)
    pending_ids = [item.id for item in pending]
    listing = ", ".join(pending_ids)
    all_ids = {item.id for item in track.queue}
    known = list(dict.fromkeys(str(i).strip() for i in known_item_ids if str(i).strip()))
    unknown = [i for i in known if i not in all_ids]
    if unknown:
        raise LevelingError(f"Unknown item id(s) {', '.join(unknown)}; use ids from the pending queue: {listing}.")
    done_already = [i for i in known if i not in pending_ids]
    if done_already:
        raise LevelingError(
            f"Item(s) {', '.join(done_already)} are already completed; known_item_ids lists pending steps only: {listing}."
        )
    start = (start_item_id or "").strip()
    if start not in all_ids:
        raise LevelingError(f"Unknown start_item_id {start!r}; use an id from the pending queue: {listing}.")
    if start not in pending_ids:
        raise LevelingError(f"start_item_id {start!r} is already completed; pick a pending step: {listing}.")
    if start in known:
        raise LevelingError(
            f"start_item_id {start!r} is also in known_item_ids; the start is the first step NOT mastered. "
            "Remove it from known_item_ids or pick another start."
        )
    by_id = {item.id: item for item in pending}
    known_set = set(known)
    for item_id in known:
        missing = [p for p in by_id[item_id].prerequisites if p in by_id and p not in known_set]
        if missing:
            raise LevelingError(
                f"{item_id!r} is marked known but its prerequisite(s) {', '.join(missing)} are not; "
                "a step whose prerequisite is not mastered is never known. Add the prerequisites or drop the step."
            )
    return [i for i in pending_ids if i in known_set]


def apply_leveling(track: TrackConfig, known_item_ids: list[str], start_item_id: str,
                   summary: str = "", created_at: str = "") -> LevelingResult:
    """Validate, then mark ``known`` completed (``status_detail="nivelado"``) and move the track's
    active step to ``start``. Mutates ``track``; returns the record with the undo snapshot."""
    known = validate_leveling(track, known_item_ids, start_item_id)
    start = track.item(start_item_id.strip())
    snapshot: list[LevelingItemFlags] = []
    refs: list[LevelingItemRef] = []
    for item_id in known:
        item = track.item(item_id)
        snapshot.append(LevelingItemFlags(id=item.id, completed=item.completed, status_detail=item.status_detail))
        refs.append(LevelingItemRef(id=item.id, title=item.title))
        item.completed = True
        item.status_detail = LEVELED_STATUS_DETAIL
    result = LevelingResult(
        track_id=track.id, known_items=refs, start_item=LevelingItemRef(id=start.id, title=start.title),
        summary=(summary or "").strip(), snapshot=snapshot,
        previous_active_item_id=track.active_item_id, created_at=created_at,
    )
    track.active_item_id = start.id
    return result


def undo_blocker(track: TrackConfig, result: LevelingResult) -> str | None:
    """Why the leveling can no longer be undone, or ``None`` when it can.

    Undo is safe only while every step it touched is exactly as it left them: the known steps
    still completed as "nivelado", the start step still pending and still the active one.
    """
    if result.undone_at:
        return "This leveling was already undone."
    if result.track_id != track.id:
        return "This leveling belongs to another track."
    for ref in result.known_items:
        item = track.item(ref.id)
        if item is None:
            return f"Step {ref.id!r} no longer exists in the track."
        if not item.completed or item.status_detail != LEVELED_STATUS_DETAIL:
            return f"Step {ref.title or ref.id!r} changed after the leveling."
    if result.start_item:
        start = track.item(result.start_item.id)
        if start is None or start.completed:
            return f"Step {result.start_item.title or result.start_item.id!r} changed after the leveling."
        if track.active_item_id != start.id:
            return "The track moved on after the leveling."
    return None


def undo_leveling(track: TrackConfig, result: LevelingResult) -> None:
    """Restore the snapshot flags and the previous active step. Mutates ``track``."""
    blocker = undo_blocker(track, result)
    if blocker:
        raise LevelingError(blocker)
    for flags in result.snapshot:
        item = track.item(flags.id)
        item.completed = flags.completed
        item.status_detail = flags.status_detail
    previous = track.item(result.previous_active_item_id)
    track.active_item_id = previous.id if previous is not None else (
        next((i.id for i in track.queue if not i.completed), None))
