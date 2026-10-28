"""Durable pedagogical state shared by HTTP, MCP and provider runtimes."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
from collections.abc import AsyncGenerator
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from learnharness.core.calibration import (
    apply_grade,
    compact_answer,
    evaluate_calibration,
    is_mastery_evidence,
    submission_matches,
)
from learnharness.core.contracts.config import EngineKind
from learnharness.core.contracts.quiz import CalibrationResult, QuizPayload, QuizSubmission
from learnharness.core.contracts.session import (
    LEGACY_PHASES,
    NodeSpan,
    PlanDag,
    ProbeAssessment,
    SessionMessage,
    SessionRecord,
)
from learnharness.core.events import SseEventType
from learnharness.core.lesson_layout import (
    current_node_id,
    frontmatter_for,
    legacy_message_blocks,
    lesson_note_stem,
    plan_paragraph_refs,
    render_lesson_blocks,
)
from learnharness.core.plan_mermaid import (
    STICKY_STATUSES,
    PlanSyntaxError,
    derive_plan_statuses,
    mermaid_to_plan_nodes,
)
from learnharness.core.text_hygiene import is_stray_fragment, strip_stray_tail
from learnharness.core.turn_prompt import compose_turn, prompt_family
from learnharness.engines.cli_protocol import EngineError
from learnharness.prompts.loader import build_handoff_prompt, build_system_prompt, load_overrides
from learnharness.vault.jsonl_store import (
    TRASHED_EVENT,
    append_quiz_log,
    append_session_event,
    list_sessions,
    list_trash,
    load_session,
    load_session_file,
    trash_file_path,
)
from learnharness.vault.markdown_ast import sync_lesson_note
from learnharness.vault.safety import RevisionConflictError, safe_component, safe_path

if TYPE_CHECKING:
    from learnharness.api.state import AppState

logger = logging.getLogger(__name__)


def now() -> str:
    return datetime.now(UTC).isoformat()


# Streaming: notify the UI often (the in-memory text is served by live_view), persist rarely.
LIVE_NOTIFY_SECONDS = 0.2
PERSIST_FLUSH_SECONDS = 2.0

class SessionConflict(ValueError):
    """An operation conflicts with the authoritative persisted session."""


class SessionNotFound(KeyError, FileNotFoundError):
    """No session with that id: a ``KeyError`` for callers, a 404 for the HTTP layer."""

    def __str__(self) -> str:
        return f"Session '{self.args[0] if self.args else ''}' not found"


# What the model receives when the learner closes a question without answering (Fase 12).
DISMISSED_DIRECTIVE = (
    "The learner dismissed this question without answering. Do not ask it again (not even "
    "reworded); continue the lesson from here."
)


def dismissed_answer(result: CalibrationResult) -> dict[str, Any]:
    """Compact tool result for a dismissed question (no grade, no answer key)."""
    return {"question_id": result.quiz_id, "kind": result.kind, "dismissed": True,
            "directive": DISMISSED_DIRECTIVE}


class SessionService:
    def __init__(self, state: AppState):
        self.state = state
        self.locks: dict[str, asyncio.Lock] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        # In-flight assistant text per session: [message_id, text, flushed_length].
        self.streaming: dict[str, list] = {}

    async def split_streaming(self, session_id: str) -> None:
        """Persist the text streamed so far and route what follows into a new message.

        PRACTICE cards (problem, conclude) sit between the prose before and after them.
        """
        await self.flush_streaming(session_id)
        entry = self.streaming.get(session_id)
        if entry and entry[1]:
            entry[0], entry[1], entry[2] = f"msg-{uuid4().hex}", "", 0

    async def flush_streaming(self, session_id: str) -> None:
        """Persist text streamed so far before a tool changes the plan state.

        Lesson-note sections are filed by the plan node current at flush time; without this,
        prose written right before plan_advance/quiz could land under the next node.
        """
        entry = self.streaming.get(session_id)
        if entry and entry[1] and len(entry[1]) != entry[2]:
            entry[2] = len(entry[1])
            await self._flush(session_id, entry[0], entry[1])

    def lock(self, session_id: str) -> asyncio.Lock:
        return self.locks.setdefault(session_id, asyncio.Lock())

    def get(self, session_id: str) -> SessionRecord:
        session = load_session(self.state.vault_path, session_id)
        if session is None:
            raise SessionNotFound(session_id)
        if session.pending_quiz_id and not session.pending_quiz:
            session.recovery_required = True
        self._normalize_phase(session)
        return session

    @staticmethod
    def _normalize_phase(session: SessionRecord) -> None:
        """Map pre-Fase 8 phases onto probing -> planning -> teaching (waiting lives in execution_status)."""
        if session.mode == "PRACTICE":
            if session.phase != "completed":
                session.phase = "teaching"  # PRACTICE has no probing/planning (Fase 9).
            return
        if session.phase == "completed":
            return
        if session.phase in LEGACY_PHASES:
            session.phase = "teaching"
        if (session.phase == "teaching" and not session.plan.nodes and session.assessment is None
                and session.context_kind != "drawing_review"):
            # Old answer() flipped a mid-diagnosis session to "teaching" after any answer.
            session.phase = "probing"

    def save(self, session: SessionRecord) -> None:
        session.sequence += 1
        session.event_id = uuid4().hex
        session.updated_at = now()
        append_session_event(self.state.vault_path, session.id, session)
        self.state.sse_hub.broadcast(SseEventType.SESSION_UPDATED, {"session_id": session.id, "sequence": session.sequence})

    async def create(self, mode="TEACH", topic=None, source_file=None, track_item_id=None, *, start=True,
                     slot_override=None, graph_context=None, track_id=None, context_kind=None):
        config = self.state.get_config()
        if not config.configured:
            raise SessionConflict("Complete setup before starting a session")
        graph_context = self.state.graph.validate_context(graph_context or [])  # Fase 8B
        track = None
        if context_kind == "leveling":  # Fase 15: the whole track, no single step.
            track = config.find_track(track_id)
            if track is None:
                raise SessionConflict("Unknown track")
            track_item_id = None
        elif track_item_id or track_id:
            # Fase 14: the step is (track_id, item_id); no track_id means the track in focus.
            track = config.find_track(track_id) if track_id else config.active_track()
            if track is None:
                raise SessionConflict("Unknown track")
            track_item_id = track_item_id or track.active_item_id
            item = track.item(track_item_id)
            if item is None:
                raise SessionConflict("Unknown track item")
            for existing in list_sessions(self.state.vault_path):
                if (existing.track_item_id == track_item_id and existing.phase != "completed"
                        and config.session_track(existing.track_id, existing.track_item_id) is track):
                    return existing
            topic = topic or item.title
            source_file = source_file or item.source_ref
        if source_file:
            source_file = self.resolve_source(source_file, track)
        session_id = f"sess-{uuid4().hex}"
        session = SessionRecord(
            id=session_id, title=(topic or "Nova sessão").strip()[:240], mode=mode,
            context_kind=context_kind or (
                "track_step" if track_item_id else ("dense_source" if source_file else "free_topic")),
            source_path=source_file, track_item_id=track_item_id, slot_override=slot_override,
            track_id=track.id if track else None,
            created_at=now(), updated_at=now(), execution_status="queued" if start else "idle",
            graph_context=graph_context, phase="teaching" if mode == "PRACTICE" else "probing",
        )
        session.lesson_vault_path = self._create_lesson_note(session, config)
        self.save(session)
        if start:
            self.schedule(session.id)
        return session

    def _create_lesson_note(self, session: SessionRecord, config) -> str:
        """Create ``<lessons>/<YYYY-MM-DD> <Título>.md``; never adopt or overwrite a user file.

        Collisions (including case-only ones, which clash on macOS/Windows vaults) get
        `` (2)``, `` (3)``, ... suffixes; creation itself is create-only, so a file that
        appears concurrently is skipped too.
        """
        lessons = config.folders.lessons_dir
        folder = safe_path(self.state.vault_path, lessons)
        taken = {p.name.casefold() for p in folder.iterdir()} if folder.is_dir() else set()
        stem = lesson_note_stem(session.title, date.today(), config.language, session.mode)
        for attempt in range(1, 1000):
            name = f"{stem}.md" if attempt == 1 else f"{stem} ({attempt}).md"
            if name.casefold() in taken:
                continue
            rel_path = f"{lessons}/{name}"
            session.lesson_vault_path = rel_path
            try:
                self._sync_lesson_note(session, config.language, create_only=True)
            except FileExistsError:
                continue
            return rel_path
        raise SessionConflict("Could not allocate a lesson note name")

    def _sync_lesson_note(self, session: SessionRecord, language: str, *, create_only: bool = False) -> bool:
        managed, tags = frontmatter_for(session, language)
        return sync_lesson_note(
            self.state.vault_path, session.lesson_vault_path, session.title, managed,
            render_lesson_blocks(session, language), tags=tags,
            retire=None if create_only else legacy_message_blocks(session),
            touched={"atualizado": date.today()}, create_only=create_only,
        )

    def resolve_source(self, source: str, track=None) -> str:
        """``track`` (a ``TrackConfig``) allows absolute paths inside its repository."""
        config = self.state.get_config()
        # Track materials outside the Vault are confined to the explicitly configured repository.
        if track is not None and track.repo_path:
            from pathlib import Path
            candidate = Path(source).expanduser()
            if candidate.is_absolute():
                root = Path(track.repo_path).expanduser().resolve()
                candidate = candidate.resolve()
                if candidate.is_relative_to(root) and candidate.is_file():
                    return str(candidate)
                raise ValueError("Track source is outside its configured repository")
        root = safe_path(self.state.vault_path, config.folders.sources_dir)
        candidate = safe_path(self.state.vault_path, source)
        if candidate.is_relative_to(root) and candidate.is_file():
            return str(candidate.relative_to(self.state.vault_path))
        matches = [p for p in root.rglob("*.md") if p.name == source or p.stem == source] if root.exists() else []
        matches = [p for p in matches if p.resolve().is_relative_to(root.resolve())]
        if len(matches) != 1:
            raise ValueError("Source not found or ambiguous")
        return str(matches[0].relative_to(self.state.vault_path))

    def _guard_question(self, session: SessionRecord, quiz: QuizPayload) -> None:
        """Phase/state rules for posing ``quiz``; refusals teach the model how to fix the call."""
        if session.phase == "completed":
            raise SessionConflict("The session is completed; no more questions.")
        if quiz.mode == "PROBE":
            if session.phase != "probing":
                raise SessionConflict(
                    "probe/recall are diagnosis tools and the diagnosis is over (probe_done was called); "
                    "ask teaching questions with quiz/explain and a plan node_id."
                )
            return
        if quiz.kind == "ask" or quiz.mode is None:
            return
        # quiz / explain with type predict|check
        if session.context_kind == "drawing_review" and not session.plan.nodes:
            quiz.node_id = None  # A drawing review follow-up has no plan to anchor to.
            return
        if session.phase == "probing":
            raise SessionConflict(
                "Still diagnosing: use probe/recall (no node_id), then call probe_done; "
                "teaching questions come after plan_init."
            )
        if not session.plan.nodes:
            raise SessionConflict("Call plan_init before teaching questions (quiz/explain).")
        ids = [n.id for n in session.plan.nodes]
        if quiz.node_id not in ids:
            raise SessionConflict(f"Unknown node_id {quiz.node_id!r}; use one of: {', '.join(ids)}.")

    def _question_node_ids(self, session: SessionRecord) -> list[str | None]:
        """Node ids of quiz/explain questions posed so far, oldest first (pending last)."""
        asked = [a.node_id for a in session.answers.values() if a.kind in ("quiz", "explain")]
        if session.pending_quiz and session.pending_quiz.kind in ("quiz", "explain"):
            asked.append(session.pending_quiz.node_id)
        return asked

    def _derive_statuses(self, session: SessionRecord) -> None:
        """Persist derived current/visited/pending (sticky mastered/needs_review win)."""
        statuses = derive_plan_statuses(session.plan.nodes, self._question_node_ids(session))
        for node in session.plan.nodes:
            node.status = statuses[node.id]

    async def pose(self, session_id: str, quiz: QuizPayload) -> dict[str, Any]:
        """Persist ``quiz`` as pending, open the dock and block until the learner answers.

        Returns the compact answer for the model (``core.calibration.compact_answer``).
        """
        await self.flush_streaming(session_id)
        async with self.lock(session_id):
            session = self.get(session_id)
            if session.pending_quiz:
                if session.pending_quiz.model_dump(exclude={"quiz_id", "created_at", "session_id", "topic"}) != quiz.model_dump(exclude={"quiz_id", "created_at", "session_id", "topic"}):
                    raise SessionConflict("A question is still pending; wait for the learner's answer before asking another.")
                quiz = session.pending_quiz  # Idempotent re-pose (e.g. a reconnecting tool call).
            else:
                self._guard_question(session, quiz)
            quiz.session_id = session_id
            quiz.created_at = quiz.created_at or now()
            if not quiz.topic:
                node = next((n for n in session.plan.nodes if n.id == quiz.node_id), None)
                quiz.topic = node.label if node else session.title
            session.pending_quiz = quiz
            session.pending_quiz_id = quiz.quiz_id
            if session.phase == "planning" and quiz.node_id and quiz.kind in ("quiz", "explain"):
                session.phase = "teaching"  # The first node-tagged question is the seam.
            self._derive_statuses(session)
            session.execution_status = "waiting"
            # Register before notifying; a very fast browser answer cannot race this future.
            future = self.state.dock_registry.open_dock(session_id, quiz)
            self.save(session)
            self.state.sse_hub.broadcast(SseEventType.DOCK_OPENED, {"session_id": session_id})
            if session.plan.nodes:
                self.state.sse_hub.broadcast(SseEventType.PLAN_UPDATED, {"session_id": session_id})
        await future
        result = self.get(session_id).answers.get(quiz.quiz_id)
        if result is None:
            raise SessionConflict("The question was closed without an answer")
        answer = dismissed_answer(result) if result.dismissed else compact_answer(result)
        return await self._attach_steers(session_id, answer)

    async def _attach_steers(self, session_id: str, answer: dict[str, Any]) -> dict[str, Any]:
        """Hand queued steers to the model inside the answer of a blocking question.

        A teacher can chain questions within one turn; steers otherwise wait for the turn to
        end, so a learner message sent meanwhile (or a finished job) would starve.
        """
        async with self.lock(session_id):
            session = self.get(session_id)
            pending = [m for m in session.messages if not m.delivered]
            if not pending:
                return answer
            for m in pending:
                m.delivered = True
            self.save(session)
        learner = [m.content for m in pending if m.steer_kind == "learner"]
        jobs = [m.content for m in pending if m.steer_kind != "learner"]
        if learner:
            answer["learner_messages"] = learner
        if jobs:
            answer["background_results"] = jobs
        answer["steer_note"] = ("The learner wrote these while answering / background work finished: "
                                "respond to them before continuing.")
        return answer

    async def open_quiz(self, session_id: str, quiz: QuizPayload, *, replace_pending: bool = False) -> QuizPayload:
        """Persist ``quiz`` as pending and open the dock without awaiting the answer.

        Non-blocking sibling of ``pose`` for HTTP flows (e.g. drawing review): the answer
        arrives later through ``answer`` (POST /api/chats/{id}/answer), which resolves a
        dock future only when one was registered. An unanswered quiz may be replaced only
        when ``replace_pending`` is set and no blocking ``pose`` is waiting on it.
        """
        async with self.lock(session_id):
            session = self.get(session_id)
            if session.phase == "completed":
                raise SessionConflict("Session is completed")
            if session.pending_quiz:
                same = session.pending_quiz.model_dump(exclude={"quiz_id", "created_at", "session_id"}) == quiz.model_dump(exclude={"quiz_id", "created_at", "session_id"})
                if same:
                    return session.pending_quiz
                if not replace_pending or self.state.dock_registry.get_pending_quiz(session_id):
                    raise SessionConflict("A different quiz is already pending")
            quiz.session_id = session_id
            quiz.created_at = quiz.created_at or now()
            session.pending_quiz = quiz
            session.pending_quiz_id = quiz.quiz_id
            session.recovery_required = False
            session.execution_status = "waiting"
            self.save(session)
            self.state.sse_hub.broadcast(SseEventType.DOCK_OPENED, {"session_id": session_id})
        return quiz

    def _auto_master(self, session: SessionRecord, result: CalibrationResult) -> None:
        """CHECK evidence masters its node when every prerequisite is already mastered."""
        if not result.node_id or not is_mastery_evidence(result, result.node_id):
            return
        target = next((n for n in session.plan.nodes if n.id == result.node_id), None)
        if target and all(any(n.id == dep and n.status == "mastered" for n in session.plan.nodes) for dep in target.depends_on):
            target.status = "mastered"

    async def answer(self, submission: QuizSubmission) -> CalibrationResult:
        async with self.lock(submission.session_id):
            session = self.get(submission.session_id)
            old = session.answers.get(submission.quiz_id)
            if old:
                if not submission_matches(old, submission):
                    raise SessionConflict("Quiz already answered with different input")
                return old
            quiz = session.pending_quiz
            if not quiz or quiz.quiz_id != submission.quiz_id:
                raise SessionConflict("Quiz does not match the persisted pending question")
            result = evaluate_calibration(submission, quiz)
            session.answers[quiz.quiz_id] = result
            session.pending_quiz = None
            session.pending_quiz_id = None
            session.recovery_required = False
            session.execution_status = "running" if self.is_running(session.id) else "idle"
            session.messages.append(SessionMessage(id=f"answer-{quiz.quiz_id}", role="user", content=json.dumps({"quiz": quiz.question, **compact_answer(result)}, ensure_ascii=False), created_at=now(), quiz_id=quiz.quiz_id))
            self._auto_master(session, result)
            self._derive_statuses(session)
            self.save(session)  # Authoritative commit precedes the derived quiz-log.
            self._ensure_quiz_logs(session)
            pending = self.state.dock_registry.get_pending_quiz(session.id)
            if pending and pending.quiz_id == quiz.quiz_id:
                self.state.dock_registry.resolve_dock(session.id, submission)
            self.state.sse_hub.broadcast(SseEventType.DOCK_RESOLVED, {"session_id": session.id})
        if not self.is_running(session.id) and session.phase != "completed":
            self.schedule(session.id)
        return result

    async def grade(self, session_id: str, question_id: str, verdict: str, feedback: str) -> dict[str, Any]:
        """Record the model's grade of an explain/recall answer (``grade_recall``)."""
        async with self.lock(session_id):
            session = self.get(session_id)
            result = session.answers.get(question_id)
            if result is None:
                pending = session.pending_quiz and session.pending_quiz.quiz_id == question_id
                raise SessionConflict(
                    "That question has not been answered yet." if pending
                    else f"Unknown question_id {question_id!r}; grade the question_id returned by explain/recall."
                )
            if result.dismissed:
                raise SessionConflict("The learner dismissed that question; there is no answer to grade.")
            if result.kind != "explain":
                raise SessionConflict("grade_recall only grades explain/recall answers; quiz answers are graded automatically.")
            if result.grade is not None:
                if (result.grade, result.grade_feedback) == (verdict, feedback):
                    return {"ok": True, "question_id": question_id, "grade": verdict}
                raise SessionConflict("This answer was already graded.")
            graded = apply_grade(result, verdict, feedback)  # type: ignore[arg-type]
            session.answers[question_id] = graded
            self._auto_master(session, graded)
            self._derive_statuses(session)
            self.save(session)
            self._ensure_quiz_logs(session)
        return {"ok": True, "question_id": question_id, "grade": verdict}

    async def probe_done(self, session_id: str, assessment: ProbeAssessment) -> dict[str, Any]:
        """Close the diagnosis: record the assessment, move to planning and arm the handoff."""
        await self.flush_streaming(session_id)
        async with self.lock(session_id):
            session = self.get(session_id)
            if session.assessment is not None or session.phase != "probing":
                raise SessionConflict("probe_done was already called; the diagnosis is closed.")
            if session.pending_quiz:
                raise SessionConflict("A question is still pending; wait for the answer before probe_done.")
            assessment.created_at = assessment.created_at or now()
            session.assessment = assessment
            session.phase = "planning"
            session.handoff_pending = True
            self.save(session)
        return {
            "ok": True,
            "next": "Diagnosis recorded. Say one closing sentence and end your turn; "
                    "planning starts automatically in the next turn.",
        }

    async def init_plan(self, session_id: str, mermaid: str, approach_prose: str = "",
                        node_details: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
        """``plan_init``: (re)write the plan from mermaid; kept ids keep their progress."""
        session = self.get(session_id)
        if session.phase == "probing":
            raise SessionConflict("Call probe_done before plan_init: the diagnosis comes first.")
        if session.phase == "completed":
            raise SessionConflict("Session is completed")
        try:
            nodes = mermaid_to_plan_nodes(mermaid, session.plan.nodes, node_details)
        except PlanSyntaxError:
            raise
        except ValueError as exc:  # Malformed node_details fields.
            raise PlanSyntaxError([f"node_details: {exc}"]) from exc
        plan = PlanDag(approach_prose=approach_prose, nodes=nodes, updated_at=now())
        await self.set_plan(session_id, plan)
        return {
            "ok": True,
            "node_ids": [n.id for n in nodes],
            "reminder": "These are the only valid node_id values for quiz/explain from now on. "
                        "Present the plan in prose and end your turn; do not teach yet."
            if self.get(session_id).phase == "planning" else
            "Plan updated; these are the valid node_id values.",
        }

    async def set_plan(self, session_id: str, plan: PlanDag):
        await self.flush_streaming(session_id)
        async with self.lock(session_id):
            session = self.get(session_id)
            if session.phase == "completed":
                raise SessionConflict("Session is completed")
            if session.source_path:
                source = self.source_text(session)
                for node in plan.nodes:
                    for ref in plan_paragraph_refs(node):
                        if not re.search(rf"\^{re.escape(ref)}(?![\w-])", source):
                            raise ValueError(f"Unknown source paragraph: {ref}")
            sticky = {n.id: n.status for n in session.plan.nodes if n.status in STICKY_STATUSES}
            for node in plan.nodes:  # Ids are permanent: a re-plan keeps their progress.
                if node.id in sticky and node.status not in STICKY_STATUSES:
                    node.status = sticky[node.id]
            session.plan = plan
            self._derive_statuses(session)
            if plan.nodes and session.handoff_pending:
                session.handoff_pending = False  # The teacher's planning turn did its job.
            self.save(session)
            self._refresh_lesson_note(session)
            self.state.sse_hub.broadcast(SseEventType.PLAN_UPDATED, {"session_id": session_id})
            return plan.model_dump()

    async def advance(self, session_id, node_id, status):
        await self.flush_streaming(session_id)
        async with self.lock(session_id):
            session = self.get(session_id)
            if status not in ("mastered", "needs_review"):
                raise SessionConflict("status must be 'mastered' or 'needs_review'; 'current' is derived from your questions.")
            if session.phase != "teaching":
                raise SessionConflict("plan_advance is for teaching: plan with plan_init, then ask quiz/explain with a node_id first.")
            node = next((n for n in session.plan.nodes if n.id == node_id), None)
            if node is None:
                raise SessionConflict(f"Unknown node_id {node_id!r}; use one of: {', '.join(n.id for n in session.plan.nodes)}.")
            if status == "mastered" and any(not any(n.id == dep and n.status == "mastered" for n in session.plan.nodes) for dep in node.depends_on):
                raise SessionConflict("Prerequisites are not mastered")
            if status == "mastered":
                self._recover_answer_modes(session)
            if status == "mastered" and not any(is_mastery_evidence(a, node_id) for a in session.answers.values()):
                raise SessionConflict("Mastery requires a calibrated check (a CHECK quiz answered correctly with high confidence, or a CHECK explain graded correct)")
            node.status = status
            self._derive_statuses(session)
            session.plan.updated_at = now()
            completed = bool(session.plan.nodes) and all(n.status == "mastered" for n in session.plan.nodes)
            if completed:
                session.phase = "completed"
                session.execution_status = "completed"
            self.save(session)
            self._refresh_lesson_note(session)
            self.state.sse_hub.broadcast(SseEventType.PLAN_UPDATED, {"session_id": session_id})
        if status == "mastered":  # Fase 8B: mastery is one case of the general graph trigger.
            self.state.graph.maybe_extract(session)
        if completed and session.track_item_id:
            track = self.state.get_config().session_track(session.track_id, session.track_item_id)
            if track is not None:  # an orphan track_id (track removed) completes nothing
                await self.state.tracks.complete(track.id, session.track_item_id)
        return {
            "ok": True, "node_id": node_id, "status": status, "phase": session.phase,
            "plan": [{"id": n.id, "status": n.status} for n in session.plan.nodes],
        }

    def _ensure_quiz_logs(self, session):
        from learnharness.vault.jsonl_store import logged_quiz_keys
        existing = logged_quiz_keys(self.state.vault_path)
        for answer in session.answers.values():
            # Only graded answers are calibration evidence (ask / ungraded explain are not).
            if answer.correct is not None and not answer.dismissed and (answer.session_id, answer.quiz_id) not in existing:
                append_quiz_log(self.state.vault_path, answer)

    def _recover_answer_modes(self, session: SessionRecord) -> None:
        """Backfill ``mode`` on legacy answers from the session's own append-only history.

        Every posed quiz is persisted as ``pending_quiz`` in a snapshot before it is
        answered, so the QuizPayload (and its mode) can be recovered by quiz_id.
        Answers whose quiz cannot be found keep ``mode=None`` and never count as
        CHECK evidence. Recovered modes are persisted by the caller's next save.
        """
        legacy = {qid for qid, a in session.answers.items() if a.mode is None}
        if not legacy:
            return
        path = safe_path(self.state.vault_path, f".harness/sessions/{safe_component(session.id)}.jsonl")
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        modes: dict[str, str] = {}
        for line in lines:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            quiz = entry.get("pending_quiz") if isinstance(entry, dict) else None
            if isinstance(quiz, dict) and quiz.get("quiz_id") in legacy:
                try:
                    modes[quiz["quiz_id"]] = QuizPayload.model_validate(quiz).mode
                except ValueError:
                    continue
        for qid, mode in modes.items():
            session.answers[qid].mode = mode

    def source_text(self, session):
        if not session.source_path:
            return ""
        from pathlib import Path
        if Path(session.source_path).is_absolute():
            track = self.state.get_config().session_track(session.track_id, session.track_item_id)
            path = Path(self.resolve_source(session.source_path, track))
        else:
            path = safe_path(self.state.vault_path, session.source_path)
        return path.read_text(encoding="utf-8")

    def is_running(self, session_id):
        task = self.tasks.get(session_id)
        return task is not None and not task.done()

    def schedule(self, session_id):
        if self.is_running(session_id):
            return
        self.tasks[session_id] = asyncio.create_task(self._drive(session_id))

    async def deliver_steer(self, session_id: str, kind: str, content: str,
                            details: dict[str, Any] | None = None) -> SessionMessage:
        """Queue input for the model's next turn and wake the session if it is idle.

        ``kind`` is ``learner`` (a message sent while a turn runs) or ``job`` (a background
        job's result; ``content`` is the model-facing text, ``details`` what the UI renders).
        A running turn picks the steer up as a follow-up turn; a pending question keeps it
        waiting until the learner answers.
        """
        async with self.lock(session_id):
            session = self.get(session_id)
            message = SessionMessage(id=f"msg-{uuid4().hex}", role="user", content=content, created_at=now(),
                                     steer_kind=kind, details=details, delivered=False)
            session.messages.append(message)
            idle = not (self.is_running(session_id) or session.pending_quiz
                        or session.recovery_required or session.phase == "completed")
            if idle:
                session.execution_status = "queued"
            self.save(session)
        if idle:
            self.schedule(session_id)
        return message

    # ------------------------------------------------------------------ session controls (Fase 12)

    async def dismiss_question(self, session_id: str, *, resume: bool = True) -> CalibrationResult:
        """Close the pending question without an answer.

        The answer is stored as ``dismissed`` (ungraded, never in the quiz-log) and a
        blocked ``pose`` returns ``dismissed_answer``. With ``resume`` and no turn running,
        a turn is scheduled so the model hears about the dismissal (like ``answer``).
        """
        async with self.lock(session_id):
            session = self.get(session_id)
            quiz = session.pending_quiz
            if quiz is None:
                raise SessionConflict("There is no pending question to dismiss")
            result = CalibrationResult(
                quiz_id=quiz.quiz_id, session_id=session_id, topic=quiz.topic, node_id=quiz.node_id,
                kind=quiz.kind, mode=quiz.mode, question=quiz.question, choices=quiz.choices,
                timestamp=now(), dismissed=True, pedagogical_directive=DISMISSED_DIRECTIVE,
            )
            session.answers[quiz.quiz_id] = result
            session.pending_quiz = None
            session.pending_quiz_id = None
            session.recovery_required = False
            session.execution_status = "running" if self.is_running(session_id) else "idle"
            session.messages.append(SessionMessage(
                id=f"answer-{quiz.quiz_id}", role="user", created_at=now(), quiz_id=quiz.quiz_id,
                content=json.dumps({"quiz": quiz.question, **dismissed_answer(result)}, ensure_ascii=False),
            ))
            self._derive_statuses(session)
            self.save(session)
            self.state.dock_registry.dismiss_dock(session_id, result)
            self.state.sse_hub.broadcast(SseEventType.DOCK_RESOLVED, {"session_id": session_id})
        if resume and not self.is_running(session_id) and session.phase != "completed":
            self.schedule(session_id)
        return result

    async def abort(self, session_id: str) -> SessionRecord:
        """Stop the running turn: cancel its task, close the persistent process, dismiss the question."""
        session = self.get(session_id)
        task = self.tasks.get(session_id)
        running = task is not None and not task.done()
        if task is not None and running:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.streaming.pop(session_id, None)
        if self.get(session_id).pending_quiz:  # Also resolves a pose blocked in an MCP request.
            await self.dismiss_question(session_id, resume=False)
        from learnharness.engines import close_engine_processes
        try:
            await close_engine_processes(session_id)
        except Exception:
            logger.warning("Could not close engine processes for %s", session_id, exc_info=True)
        async with self.lock(session_id):
            session = self.get(session_id)
            if session.phase != "completed" and (running or session.execution_status in
                                                  ("running", "queued", "waiting", "compacting")):
                session.execution_status = "interrupted"
                self.save(session)
        return session

    async def rename(self, session_id: str, title: str) -> SessionRecord:
        """New title; the lesson note keeps its path, only its managed title fields change."""
        title = title.strip()
        if not 1 <= len(title) <= 200:
            raise ValueError("The title must have between 1 and 200 characters")
        async with self.lock(session_id):
            session = self.get(session_id)
            if session.title != title:
                session.title = title
                self.save(session)
                self._refresh_lesson_note(session)
                self.state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {})  # Petal labels.
        return session

    async def delete(self, session_id: str, mode: str = "preserve-graph") -> dict[str, Any]:
        """Move the session JSONL to ``.harness/trash/``; the lesson note in the Vault stays.

        ``delete-nodes`` also unlinks the session from the graph first (nodes and chains
        that only came from it are tombstoned). Refused while a turn runs.
        """
        if mode not in ("preserve-graph", "delete-nodes"):
            raise ValueError("mode must be 'preserve-graph' or 'delete-nodes'")
        self.get(session_id)
        if self.is_running(session_id):
            raise SessionConflict("A turn is running; abort it before deleting the session")
        graph = None
        if mode == "delete-nodes":
            graph = await self.state.graph.unlink_session(session_id)
        async with self.lock(session_id):
            if self.is_running(session_id):
                raise SessionConflict("A turn is running; abort it before deleting the session")
            source = safe_path(self.state.vault_path, f".harness/sessions/{safe_component(session_id)}.jsonl")
            trash = safe_path(self.state.vault_path, ".harness/trash")
            trash.mkdir(parents=True, exist_ok=True)
            target = trash / source.name
            if target.exists():
                stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%f")
                target = trash / f"{source.stem}.{stamp}.jsonl"
            # Append-only record of the deletion, read back by the trash listing
            # (load_session ignores unknown events, so a restore replays unchanged).
            append_session_event(self.state.vault_path, session_id, {
                "event": TRASHED_EVENT, "deleted_at": now(), "mode": mode,
                "graph_unlinked": mode == "delete-nodes"})
            source.rename(target)
        self.state.dock_registry.cancel_dock(session_id)
        await self._release_runtime(session_id)
        # The lock stays: a request already waiting on it must not race one that would
        # get a fresh lock (it finds the session gone and fails cleanly).
        self.tasks.pop(session_id, None)
        self.state.sse_hub.broadcast(SseEventType.SESSION_UPDATED, {"session_id": session_id, "deleted": True})
        self.state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {})  # Its petal loses the title.
        return {"ok": True, "id": session_id, "mode": mode,
                "trash_path": str(target.relative_to(self.state.vault_path)), "graph": graph}

    def list_trash(self) -> list[dict[str, Any]]:
        return list_trash(self.state.vault_path)

    async def restore_from_trash(self, file_name: str) -> SessionRecord:
        """Move a trash entry back to ``.harness/sessions/<id>.jsonl``.

        409 when a live session already owns that id. Graph provenance unlinked by a
        ``delete-nodes`` deletion is not restored; the Aulas/ note was never touched.
        A session trashed mid-turn comes back normalized as ``recover()`` would.
        """
        path = trash_file_path(self.state.vault_path, file_name)
        if not path.is_file():
            raise FileNotFoundError("Unknown trash entry")
        record = load_session_file(path)
        if record is None:
            raise ValueError("Trash entry holds no session snapshot")
        session_id = safe_component(record.id)
        async with self.lock(session_id):
            target = safe_path(self.state.vault_path, f".harness/sessions/{session_id}.jsonl")
            if target.exists() or self.is_running(session_id):
                raise SessionConflict("A live session with this id already exists")
            target.parent.mkdir(parents=True, exist_ok=True)
            # link + unlink never overwrites a session created in between (unlike rename).
            os.link(path, target)
            path.unlink()
            session = self.get(session_id)
            if session.execution_status in ("running", "queued", "waiting", "compacting"):
                session.execution_status = "waiting" if session.pending_quiz else "interrupted"
                self.save(session)
            self.state.sse_hub.broadcast(SseEventType.SESSION_UPDATED,
                                         {"session_id": session_id, "restored": True})
            self.state.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {})
        return session

    def purge_trash(self, file_name: str) -> dict[str, Any]:
        """Permanently remove one trash file (only inside ``.harness/trash``)."""
        path = trash_file_path(self.state.vault_path, file_name)
        if not path.is_file():
            raise FileNotFoundError("Unknown trash entry")
        path.unlink()
        self.state.sse_hub.broadcast(SseEventType.SESSION_UPDATED, {"trash_file": file_name, "purged": True})
        return {"ok": True, "file": file_name}

    @staticmethod
    def _steers_due(session: SessionRecord) -> bool:
        return (any(not m.delivered for m in session.messages) and not session.pending_quiz
                and not session.recovery_required and session.phase != "completed")

    async def _drive(self, session_id):
        """Run turns back to back while one asks for a follow-up (the post-diagnosis handoff)."""
        while await self.run(session_id):
            pass

    @staticmethod
    def _handoff_due(session: SessionRecord) -> bool:
        return (session.handoff_pending and session.phase == "planning"
                and not session.plan.nodes and not session.pending_quiz)

    async def run(self, session_id) -> bool:
        """Execute one agent turn. Returns True when a follow-up turn is due (handoff, steers)."""
        completed = False
        follow_up = False
        usage = self.state.usage.capture(session_id=session_id)
        try:
            session = self.get(session_id)
            if session.pending_quiz or session.recovery_required or session.phase == "completed":
                completed = session.phase == "completed"
                return False
            handoff_run, steers = self._begin_turn(session)
            usage.turn = session.turn_seq
            config = self.state.get_config()
            engine, slot, tools = self._prepare_engine(session, config)
            persistent = bool(getattr(engine, "session_persistent", False))
            overrides = load_overrides(self.state.vault_path, config)
            turn = compose_turn(
                session, system=self._system_prompt(session, config, overrides), persistent=persistent,
                handoff=build_handoff_prompt(config.language, overrides=overrides) if handoff_run else None,
                steers=steers)
            if persistent and session.prompt_phase != (family := prompt_family(session)):
                current = self.get(session_id)
                current.prompt_phase = family  # The live process now holds this family's rules.
                self.save(current)
            # Only session-persistent engines take a history and a separate system instruction
            # (``AgentEnginePort.stream_turn`` has neither for one-shot engines).
            persisted = ({"history": turn.history, "system_instruction": turn.system_instruction}
                         if persistent else {})
            await self._stream_reply(session_id, engine.stream_turn(
                turn.prompt, session_id, slot=slot, tools=tools, **persisted))
            # The turn's usage is charged before settling: a compaction there resets the meter.
            usage.close()
            follow_up, completed = await self._settle(session_id, persistent=persistent, handoff_run=handoff_run)
        except asyncio.CancelledError:
            session = self.get(session_id)
            if session.phase != "completed":
                session.execution_status = "interrupted"
                self.save(session)
            raise
        except Exception as exc:
            logger.exception("Session execution failed: %s", session_id)
            session = self.get(session_id)
            session.execution_status = "failed"
            session.error = self.state.redact(str(exc))
            self.save(session)
        finally:
            usage.close()  # charges this turn's provider usage to session.usage
            self.streaming.pop(session_id, None)
            if completed:
                await self._release_runtime(session_id)
        return follow_up

    def _begin_turn(self, session: SessionRecord) -> tuple[bool, list[SessionMessage]]:
        """Mark the turn running; returns ``(handoff_run, steers delivered with it)``."""
        # A turn that starts with the handoff armed is the teacher's planning turn.
        handoff_run = self._handoff_due(session)
        session.execution_id = uuid4().hex
        session.turn_seq += 1
        session.execution_status = "running"
        session.error = None
        # Steers queued so far ride this turn; later ones trigger a follow-up turn.
        steers = [m for m in session.messages if not m.delivered]
        for m in steers:
            m.delivered = True
        self.save(session)
        return handoff_run, steers

    def _prepare_engine(self, session: SessionRecord, config) -> tuple[Any, Any, list[Any] | None]:
        """``(engine, slot, inline tools)`` for this turn, with its runtime dir and MCP token bound."""
        if config.slots.strong.engine == EngineKind.AGY and self.state.engine_factory is None:
            from learnharness.services.agy_permissions import status as agy_permission_status

            if not agy_permission_status()["granted"]:
                # Headless agy silently refuses harness tools without this rule: the
                # lesson would end with no quiz and no explanation of why.
                raise EngineError(
                    "O agy ainda não tem permissão para usar as ferramentas do harness. "
                    "Conceda em Configurações → Conectores (regra mcp(harness/*))."
                )
        slot = session.teaching_slot(config.slots.strong)
        engine = self.state.engine(slot)
        persistent = bool(getattr(engine, "session_persistent", False))
        # One token per session, re-bound to this execution (stale ones stay rejected).
        token = self.state.session_token(session.id, session.execution_id)
        # Persistent CLI processes outlive a run: their cwd must be stable per session.
        runtime = f".harness/runtime/{session.id}" + ("" if persistent else f"/{session.execution_id}")
        work_dir = safe_path(self.state.vault_path, runtime)
        work_dir.mkdir(parents=True, exist_ok=True)
        if hasattr(engine, "configure_runtime"):
            engine.configure_runtime(work_dir, self.state.mcp_url, token)
        # CLI engines reach the tools through the bound MCP server; only in-process
        # engines receive callables directly.
        inline = getattr(engine, "tool_transport", "inline") == "inline"
        return engine, slot, self.state.tool_functions(session.id) if inline else None

    def _system_prompt(self, session: SessionRecord, config, overrides) -> str:
        """Prompt fragments + session state, then the source, graph context and practice material."""
        practice = session.mode == "PRACTICE"
        # Fase 14: the session's own track, not the one in focus now.
        track = config.session_track(session.track_id, session.track_item_id) if session.track_item_id else None
        context_data: dict[str, Any] = {
            "topic": session.title, "phase": session.phase,
            "assessment": session.assessment.model_dump(mode="json") if session.assessment else None,
            "plan": session.plan.model_dump(),
            "answers": [a.model_dump(mode="json") for a in session.answers.values()],
            "track": track.model_dump(mode="json") if track else None,
        }
        if practice:
            context_data["practice"] = self.state.practice.state_context(session)
        if session.context_kind == "leveling":  # Fase 15: the ordered pending queue.
            context_data["leveling"] = self._leveling_context(session, config)
        system = build_system_prompt(session.mode, session.context_kind, config.language, session.phase,
                                     extra_context=json.dumps(context_data, ensure_ascii=False),
                                     overrides=overrides)
        system += "\n\nSOURCE (read-only; citations must exist):\n" + self.source_text(session)
        if graph_block := self.state.graph.context_for(session):  # Fase 8B graph_context
            system += "\n\n" + graph_block
        if practice and (material := self.state.practice.prompt_material(session)):  # Fase 9
            system += "\n\n" + material
        return system

    async def _stream_reply(self, session_id: str, stream: AsyncGenerator[str, None]) -> None:
        """Consume the engine stream: live notifies, sparse flushes, the final message saved."""
        message_id = f"msg-{uuid4().hex}"
        text = ""
        last_flush = last_notify = asyncio.get_running_loop().time()
        streaming = self.streaming[session_id] = [message_id, "", 0]
        # Closed even when the loop body raises: a CLI engine's generator holds the
        # session's process lock and idle timer until it is finalized.
        async with contextlib.aclosing(stream):
            async for chunk in stream:
                if streaming[0] != message_id:  # A PRACTICE tool split the message.
                    message_id, text = streaming[0], ""
                text += chunk
                streaming[1] = text
                current_time = asyncio.get_running_loop().time()
                if current_time - last_notify >= LIVE_NOTIFY_SECONDS:
                    # Live view: GET /api/chats/{id} overlays the in-memory text (live_view);
                    # nothing is written for this tick.
                    self.state.sse_hub.broadcast(SseEventType.SESSION_UPDATED, {"session_id": session_id, "streaming": True})
                    last_notify = current_time
                if current_time - last_flush >= PERSIST_FLUSH_SECONDS:
                    # Each save appends a full snapshot to the append-only JSONL: keep it sparse.
                    streaming[2] = len(text)
                    await self._flush(session_id, message_id, text, refresh_note=False)
                    last_flush = current_time
        self.streaming.pop(session_id, None)
        if text:
            await self._flush(session_id, message_id, text)

    async def _settle(self, session_id: str, *, persistent: bool, handoff_run: bool) -> tuple[bool, bool]:
        """Close the turn's status; returns ``(follow_up, completed)``."""
        session = self.get(session_id)
        if persistent and session.messages:
            # Everything up to here reached the live process (in the prompt or via tools).
            session.model_cursor = session.messages[-1].id
        if handoff_run:
            session.handoff_pending = False  # One planning turn; a retry needs the learner.
        follow_up = (not handoff_run and self._handoff_due(session)) or self._steers_due(session)
        if session.phase != "completed":
            session.execution_status = "waiting" if session.pending_quiz else ("queued" if follow_up else "idle")
        completed = session.phase == "completed"
        self.save(session)
        self._trigger_extraction(session_id)  # Fase 8B: end-of-run graph trigger
        if not completed:
            follow_up = await self._compact_at_settle(session_id, follow_up)
        return follow_up, completed

    @staticmethod
    def _leveling_context(session: SessionRecord, config) -> dict[str, Any] | None:
        from learnharness.core.leveling import count_questions, leveling_context

        track = config.find_track(session.track_id)
        asked = count_questions(a.kind for a in session.answers.values())
        return leveling_context(track, asked) if track is not None else None

    async def _compact_at_settle(self, session_id: str, follow_up: bool) -> bool:
        """Compact the history when it outgrew the budget; the next turn waits for it (Fase 12).

        Input that arrived while compacting (an answer, a steer) cannot schedule a turn
        because this task is still running, so the follow-up decision is taken again.
        A failed compaction is logged and the session goes on with the full history.
        """
        from learnharness.services.compaction import compact_session

        before = self.get(session_id)
        if not before.messages:
            return follow_up
        last_id = before.messages[-1].id
        try:
            compacted = await compact_session(self, session_id)
        except Exception:
            logger.exception("Context compaction failed for %s", session_id)
            compacted = True  # The status still has to leave "compacting".
        if not compacted:
            return follow_up
        async with self.lock(session_id):
            session = self.get(session_id)
            ids = [m.id for m in session.messages]
            arrived = ids[ids.index(last_id) + 1:] if last_id in ids else []
            new_input = any(m.role == "user" for m in session.messages if m.id in set(arrived))
            follow_up = follow_up or self._steers_due(session) or (
                new_input and not session.pending_quiz and not session.recovery_required)
            if session.phase != "completed":
                session.execution_status = ("waiting" if session.pending_quiz
                                            else "queued" if follow_up else "idle")
            self.save(session)
        return follow_up

    def _trigger_extraction(self, session_id: str) -> None:
        """Queue graph extraction when enough prose is uncovered or the session completed."""
        try:
            self.state.graph.maybe_extract(self.get(session_id))
        except Exception:
            # The trigger never fails a finished teaching turn; the job carries its own errors.
            logger.exception("Could not queue graph extraction for %s", session_id)

    async def _release_runtime(self, session_id):
        from learnharness.engines import close_engine_processes
        self.state.revoke_session_tokens(session_id)
        try:
            await close_engine_processes(session_id)
        except Exception:
            logger.warning("Could not close engine processes for %s", session_id, exc_info=True)

    async def _flush(self, session_id, message_id, text, refresh_note: bool = True):
        text = strip_stray_tail(text)
        async with self.lock(session_id):
            session = self.get(session_id)
            node_id = current_node_id(session.plan)
            message = next((m for m in session.messages if m.id == message_id), None)
            if message:
                # Text produced since the previous flush belongs to the node current now.
                if not message.node_spans:
                    message.node_spans.append(NodeSpan(start=0, node_id=message.node_id))
                if message.node_spans[-1].node_id != node_id:
                    message.node_spans.append(NodeSpan(start=len(message.content), node_id=node_id))
                message.content = text
                message.node_id = node_id
            elif is_stray_fragment(text):
                return  # Not (yet) content: a lone stray token after a tool call.
            else:
                session.messages.append(SessionMessage(
                    id=message_id, role="assistant", content=text, created_at=now(),
                    node_id=node_id, node_spans=[NodeSpan(start=0, node_id=node_id)],
                ))
            self.save(session)
            if refresh_note:
                self._refresh_lesson_note(session)

    def live_view(self, session: SessionRecord) -> SessionRecord:
        """``session`` with the text still streaming in memory (not yet persisted) applied."""
        entry = self.streaming.get(session.id)
        if not entry or not entry[1]:
            return session
        text = strip_stray_tail(entry[1])
        view = session.model_copy(deep=True)
        message = next((m for m in view.messages if m.id == entry[0]), None)
        if message is not None:
            message.content = text
        elif not is_stray_fragment(text):
            view.messages.append(SessionMessage(id=entry[0], role="assistant", content=text, created_at=now(),
                                                node_id=current_node_id(view.plan)))
        return view

    def refresh_lesson_note(self, session: SessionRecord) -> None:
        self._refresh_lesson_note(session)

    def _refresh_lesson_note(self, session: SessionRecord) -> None:
        """Mirror the session into its note; the JSONL session stays authoritative."""
        if not session.lesson_vault_path:
            return
        try:
            self._sync_lesson_note(session, self.state.get_config().language)
        except (ValueError, OSError, RevisionConflictError) as exc:
            # A malformed or concurrently edited note never fails a teaching turn.
            logger.warning("Lesson note sync skipped for %s: %s", session.id, exc)

    async def recover(self):
        for session in list_sessions(self.state.vault_path):
            self._ensure_quiz_logs(session)
            if session.execution_status in ("running", "queued", "waiting", "compacting"):
                session.execution_status = "waiting" if session.pending_quiz else "interrupted"
                self.save(session)

    async def close(self):
        tasks = [task for task in self.tasks.values() if not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for session_id in self.tasks:
            self.state.dock_registry.cancel_dock(session_id)
            self.state.revoke_session_tokens(session_id)
