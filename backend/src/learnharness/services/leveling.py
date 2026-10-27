"""Track leveling sessions (Fase 15): start, close (``leveling_done``) and undo.

Lock order is always session lock -> track lock, the same order the rest of the services use.
"""
from __future__ import annotations

from typing import Any

from learnharness.core.leveling import (
    MIN_PENDING_FOR_LEVELING,
    LevelingError,
    apply_leveling,
    can_level,
    pending_queue,
    undo_leveling,
)
from learnharness.services.sessions import SessionConflict, now
from learnharness.vault.jsonl_store import list_sessions

LEVELING_TITLE = {"pt-BR": "Nivelamento: {title}", "en": "Leveling: {title}"}


class LevelingService:
    def __init__(self, state):
        self.state = state

    def open_session(self, track_id: str):
        """An unfinished leveling session of this track, if any."""
        return next((s for s in list_sessions(self.state.vault_path)
                     if s.context_kind == "leveling" and s.track_id == track_id and s.phase != "completed"), None)

    async def start(self, track_id: str, *, start: bool = True):
        """Create (or reopen) the TEACH session that levels ``track_id``."""
        config = self.state.get_config()
        track = config.find_track(track_id)
        if track is None:
            raise FileNotFoundError("Unknown track")
        existing = self.open_session(track_id)
        if existing is not None:
            return existing
        if track.archived:
            raise SessionConflict("Archived tracks cannot be leveled; restore the track first.")
        if not can_level(track):
            raise SessionConflict(
                f"Leveling needs at least {MIN_PENDING_FOR_LEVELING} pending steps "
                f"(this track has {len(pending_queue(track))})."
            )
        template = LEVELING_TITLE.get(config.language, LEVELING_TITLE["pt-BR"])
        return await self.state.sessions.create(
            "TEACH", topic=template.format(title=track.title), track_id=track.id,
            context_kind="leveling", start=start,
        )

    async def done(self, session_id: str, known_item_ids: list[str], start_item_id: str,
                   summary: str = "") -> dict[str, Any]:
        """``leveling_done``: mark the known steps, move the track's start, close the session."""
        sessions = self.state.sessions
        await sessions.flush_streaming(session_id)
        async with sessions.lock(session_id):
            session = sessions.get(session_id)
            if session.context_kind != "leveling":
                raise SessionConflict("leveling_done only exists in a track leveling session.")
            if session.leveling is not None or session.phase == "completed":
                raise SessionConflict("leveling_done was already called; the leveling is closed. End your turn.")
            if session.pending_quiz:
                raise SessionConflict("A question is still pending; wait for the answer before leveling_done.")
            async with self.state.tracks.lock:
                config = self.state.get_config()
                track = config.find_track(session.track_id)
                if track is None:
                    raise SessionConflict("The track of this leveling was removed; end your turn.")
                try:
                    result = apply_leveling(track, known_item_ids, start_item_id, summary, created_at=now())
                except LevelingError as exc:
                    raise SessionConflict(str(exc)) from exc
                self.state.tracks._save(config)
            session.leveling = result
            session.phase = "completed"
            session.execution_status = "completed"
            sessions.save(session)
            sessions.refresh_lesson_note(session)
        return {
            "ok": True,
            "known": len(result.known_items),
            "start_item_id": result.start_item.id if result.start_item else None,
            "next": "Leveling recorded and the session is closed. In one or two sentences tell the "
                    "learner where the track starts and why; ask nothing else and end your turn.",
        }

    async def undo(self, track_id: str, session_id: str) -> dict[str, Any]:
        """Restore the flags and active step from the leveling snapshot, while nothing changed."""
        sessions = self.state.sessions
        async with sessions.lock(session_id):
            session = sessions.get(session_id)
            if session.context_kind != "leveling" or session.track_id != track_id:
                raise FileNotFoundError("No leveling session of this track with that id")
            if session.leveling is None:
                raise SessionConflict("This leveling has not finished; there is nothing to undo.")
            async with self.state.tracks.lock:
                config = self.state.get_config()
                track = config.find_track(track_id)
                if track is None:
                    raise FileNotFoundError("Unknown track")
                try:
                    undo_leveling(track, session.leveling)
                except LevelingError as exc:
                    raise SessionConflict(str(exc)) from exc
                self.state.tracks._save(config)
            session.leveling.undone_at = now()
            sessions.save(session)
            return {"ok": True, "session_id": session_id, "track": self.state.tracks.serialize(track, config)}
