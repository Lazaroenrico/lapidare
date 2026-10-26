"""Durable pedagogical state shared by HTTP, MCP and provider runtimes."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING
from uuid import uuid4

from learnharness.core.calibration import evaluate_calibration, is_mastery_evidence
from learnharness.core.contracts.quiz import CalibrationResult, QuizPayload, QuizSubmission
from learnharness.core.contracts.session import NodeSpan, PlanDag, SessionMessage, SessionRecord
from learnharness.core.events import SseEventType
from learnharness.prompts.loader import build_system_prompt
from learnharness.vault.jsonl_store import (
    append_quiz_log,
    append_session_event,
    list_sessions,
    load_session,
)
from learnharness.vault.lesson_layout import (
    current_node_id,
    frontmatter_for,
    legacy_message_blocks,
    lesson_note_stem,
    plan_paragraph_refs,
    render_lesson_blocks,
)
from learnharness.vault.markdown_ast import sync_lesson_note
from learnharness.vault.safety import RevisionConflictError, safe_component, safe_path

if TYPE_CHECKING:
    from learnharness.api.state import AppState

logger = logging.getLogger(__name__)


def now() -> str:
    return datetime.now(UTC).isoformat()


TURN_RULES = "Use pose_quiz for every graded question; never put a quiz in prose. Initialize a valid plan with plan_init after diagnosis. Use plan_advance after checks. Do not invent citations. If prior answers exist, react to their calibration before advancing. PRACTICE gives one hint at a time, never the solution."


class SessionConflict(ValueError):
    """An operation conflicts with the authoritative persisted session."""


class SessionService:
    def __init__(self, state: AppState):
        self.state = state
        self.locks: dict[str, asyncio.Lock] = {}
        self.tasks: dict[str, asyncio.Task] = {}

    def lock(self, session_id: str) -> asyncio.Lock:
        return self.locks.setdefault(session_id, asyncio.Lock())

    def get(self, session_id: str) -> SessionRecord:
        session = load_session(self.state.vault_path, session_id)
        if session is None:
            raise KeyError(session_id)
        if session.pending_quiz_id and not session.pending_quiz:
            session.recovery_required = True
        return session

    def save(self, session: SessionRecord) -> None:
        session.sequence += 1
        session.event_id = uuid4().hex
        session.updated_at = now()
        append_session_event(self.state.vault_path, session.id, session)
        self.state.sse_hub.broadcast(SseEventType.SESSION_UPDATED, {"session_id": session.id, "sequence": session.sequence})

    async def create(self, mode="TEACH", topic=None, source_file=None, track_item_id=None, *, start=True):
        config = self.state.get_config()
        if not config.configured:
            raise SessionConflict("Complete setup before starting a session")
        if track_item_id:
            item = next((i for i in config.track.queue if i.id == track_item_id), None)
            if item is None:
                raise SessionConflict("Unknown track item")
            for existing in list_sessions(self.state.vault_path):
                if existing.track_item_id == track_item_id and existing.phase != "completed":
                    return existing
            topic = topic or item.title
            source_file = source_file or item.source_ref
        if source_file:
            source_file = self.resolve_source(source_file, track_item_id is not None)
        session_id = f"sess-{uuid4().hex}"
        session = SessionRecord(
            id=session_id, title=(topic or "Nova sessão").strip()[:240], mode=mode,
            context_kind="track_step" if track_item_id else ("dense_source" if source_file else "free_topic"),
            source_path=source_file, track_item_id=track_item_id,
            created_at=now(), updated_at=now(), execution_status="queued" if start else "idle",
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
        stem = lesson_note_stem(session.title, date.today(), config.language)
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

    def resolve_source(self, source: str, track=False) -> str:
        config = self.state.get_config()
        # Track materials outside the Vault are confined to the explicitly configured repository.
        if track and config.track.repo_path:
            from pathlib import Path
            candidate = Path(source).expanduser()
            if candidate.is_absolute():
                root = Path(config.track.repo_path).expanduser().resolve()
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

    async def pose(self, session_id: str, quiz: QuizPayload):
        async with self.lock(session_id):
            session = self.get(session_id)
            if session.pending_quiz:
                if session.pending_quiz.model_dump(exclude={"quiz_id", "created_at"}) != quiz.model_dump(exclude={"quiz_id", "created_at"}):
                    raise SessionConflict("A different quiz is already pending")
                quiz = session.pending_quiz
            quiz.session_id = session_id
            session.pending_quiz = quiz
            session.pending_quiz_id = quiz.quiz_id
            session.phase = "awaiting_answer"
            session.execution_status = "waiting"
            # Register before notifying; a very fast browser answer cannot race this future.
            future = self.state.dock_registry.open_dock(session_id, quiz)
            self.save(session)
            self.state.sse_hub.broadcast(SseEventType.DOCK_OPENED, {"session_id": session_id})
        return (await future).model_dump()

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
            session.phase = "awaiting_answer"
            session.execution_status = "waiting"
            self.save(session)
            self.state.sse_hub.broadcast(SseEventType.DOCK_OPENED, {"session_id": session_id})
        return quiz

    async def answer(self, submission: QuizSubmission) -> CalibrationResult:
        async with self.lock(submission.session_id):
            session = self.get(submission.session_id)
            old = session.answers.get(submission.quiz_id)
            if old:
                if (old.chosen_index, old.confidence, old.is_dont_know, old.learner_thinking) != (submission.chosen_index, submission.confidence, submission.is_dont_know, submission.learner_thinking):
                    raise SessionConflict("Quiz already answered with different input")
                return old
            quiz = session.pending_quiz
            if not quiz or quiz.quiz_id != submission.quiz_id:
                raise SessionConflict("Quiz does not match the persisted pending question")
            if submission.chosen_index is not None and not 0 <= submission.chosen_index < len(quiz.choices):
                raise ValueError("Choice index is out of bounds")
            result = evaluate_calibration(submission, quiz)
            session.answers[quiz.quiz_id] = result
            session.pending_quiz = None
            session.pending_quiz_id = None
            session.recovery_required = False
            session.phase = "teaching"
            session.execution_status = "running" if self.is_running(session.id) else "idle"
            session.messages.append(SessionMessage(id=f"answer-{quiz.quiz_id}", role="user", content=json.dumps({"quiz": quiz.question, **result.model_dump()}, ensure_ascii=False), created_at=now(), quiz_id=quiz.quiz_id))
            if quiz.mode == "CHECK" and result.calibration_band == "calibrated_mastery" and quiz.node_id:
                target = next((n for n in session.plan.nodes if n.id == quiz.node_id), None)
                if target and all(any(n.id == dep and n.status == "mastered" for n in session.plan.nodes) for dep in target.depends_on):
                    target.status = "mastered"
            self.save(session)  # Authoritative commit precedes the derived quiz-log.
            self._ensure_quiz_logs(session)
            pending = self.state.dock_registry.get_pending_quiz(session.id)
            if pending and pending.quiz_id == quiz.quiz_id:
                self.state.dock_registry.resolve_dock(session.id, submission)
            self.state.sse_hub.broadcast(SseEventType.DOCK_RESOLVED, {"session_id": session.id})
        if not self.is_running(session.id) and session.phase != "completed":
            self.schedule(session.id)
        return result

    def _ensure_quiz_logs(self, session):
        from learnharness.vault.jsonl_store import load_quiz_logs
        existing = {(q.session_id, q.quiz_id) for q in load_quiz_logs(self.state.vault_path)}
        for answer in session.answers.values():
            if (answer.session_id, answer.quiz_id) not in existing:
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

    async def set_plan(self, session_id: str, plan: PlanDag):
        async with self.lock(session_id):
            session = self.get(session_id)
            if session.phase == "completed":
                raise SessionConflict("Session is completed")
            if session.plan.nodes:
                if session.plan.model_dump(exclude={"updated_at"}) == plan.model_dump(exclude={"updated_at"}):
                    return session.plan.model_dump()
                raise SessionConflict("An initialized plan cannot be replaced")
            if session.source_path:
                source = self.source_text(session)
                for node in plan.nodes:
                    for ref in plan_paragraph_refs(node):
                        if not re.search(rf"\^{re.escape(ref)}(?![\w-])", source):
                            raise ValueError(f"Unknown source paragraph: {ref}")
            session.plan = plan
            session.phase = "teaching"
            self.save(session)
            self._refresh_lesson_note(session)
            self.state.sse_hub.broadcast(SseEventType.PLAN_UPDATED, {"session_id": session_id})
            return plan.model_dump()

    async def advance(self, session_id, node_id, status):
        async with self.lock(session_id):
            session = self.get(session_id)
            node = next((n for n in session.plan.nodes if n.id == node_id), None)
            if node is None:
                raise ValueError("Unknown plan node")
            if status in ("current", "mastered") and any(not any(n.id == dep and n.status == "mastered" for n in session.plan.nodes) for dep in node.depends_on):
                raise SessionConflict("Prerequisites are not mastered")
            if status == "mastered":
                self._recover_answer_modes(session)
            if status == "mastered" and not any(is_mastery_evidence(a, node_id) for a in session.answers.values()):
                raise SessionConflict("Mastery requires a calibrated check")
            node.status = status
            session.plan.updated_at = now()
            completed = bool(session.plan.nodes) and all(n.status == "mastered" for n in session.plan.nodes)
            if completed:
                session.phase = "completed"
                session.execution_status = "completed"
            self.save(session)
            self._refresh_lesson_note(session)
        if status == "mastered":
            self.state.jobs.extraction(session, node_id)
        if completed and session.track_item_id:
            await self.state.tracks.complete(session.track_item_id)
        return session.plan.model_dump()

    def source_text(self, session):
        if not session.source_path:
            return ""
        from pathlib import Path
        if Path(session.source_path).is_absolute():
            path = Path(self.resolve_source(session.source_path, track=True))
        else:
            path = safe_path(self.state.vault_path, session.source_path)
        return path.read_text(encoding="utf-8")

    def is_running(self, session_id):
        task = self.tasks.get(session_id)
        return task is not None and not task.done()

    def schedule(self, session_id):
        if self.is_running(session_id):
            return
        self.tasks[session_id] = asyncio.create_task(self.run(session_id))

    async def run(self, session_id):
        completed = False
        try:
            session = self.get(session_id)
            if session.pending_quiz or session.recovery_required or session.phase == "completed":
                completed = session.phase == "completed"
                return
            session.execution_id = uuid4().hex
            session.execution_status = "running"
            session.error = None
            self.save(session)
            config = self.state.get_config()
            engine = self.state.engine(config.slots.strong)
            persistent = bool(getattr(engine, "session_persistent", False))
            # One token per session, re-bound to this execution (stale ones stay rejected).
            token = self.state.session_token(session_id, session.execution_id)
            # Persistent CLI processes outlive a run: their cwd must be stable per session.
            runtime = f".harness/runtime/{session_id}" + ("" if persistent else f"/{session.execution_id}")
            work_dir = safe_path(self.state.vault_path, runtime)
            work_dir.mkdir(parents=True, exist_ok=True)
            if hasattr(engine, "configure_runtime"):
                engine.configure_runtime(work_dir, self.state.mcp_url, token)
            # CLI engines reach the tools through the bound MCP server; only in-process
            # engines receive callables directly.
            tools = self.state.tool_functions(session_id) if getattr(engine, "tool_transport", "inline") == "inline" else None
            context = json.dumps({"topic": session.title, "plan": session.plan.model_dump(), "answers": [a.model_dump() for a in session.answers.values()], "track": config.track.model_dump(mode="json") if session.track_item_id else None}, ensure_ascii=False)
            system = build_system_prompt(session.mode, session.context_kind, config.language, session.phase, extra_context=context)
            system += "\n\nSOURCE (read-only; citations must exist):\n" + self.source_text(session)
            if persistent:
                # The engine keeps the conversation: send rules once (on a fresh process,
                # with a compact history) and per turn only what is new.
                history, prompt = self._persistent_turn(session)
                stream = engine.stream_turn(prompt, session_id, history=history, slot=config.slots.strong, tools=tools, system_instruction=system + "\n" + TURN_RULES)
            else:
                history = "\n\n".join(f"{m.role}: {m.content}" for m in session.messages)
                prompt = system + "\n\nPERSISTED HISTORY:\n" + history + "\n" + TURN_RULES
                stream = engine.stream_turn(prompt, session_id, slot=config.slots.strong, tools=tools)
            message_id = f"msg-{uuid4().hex}"
            text = ""
            last_flush = 0.0
            async for chunk in stream:
                text += chunk
                current_time = asyncio.get_running_loop().time()
                if current_time - last_flush >= 0.2:
                    await self._flush(session_id, message_id, text)
                    last_flush = current_time
            if text:
                await self._flush(session_id, message_id, text)
            session = self.get(session_id)
            if session.phase != "completed":
                session.execution_status = "waiting" if session.pending_quiz else "idle"
            completed = session.phase == "completed"
            self.save(session)
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
            if completed:
                await self._release_runtime(session_id)

    @staticmethod
    def _persistent_turn(session):
        """Split persisted messages into ``(history, new-content prompt)``.

        New content is everything after the last assistant message (quiz answers, learner
        input); the plan status travels each turn because answers can master nodes.
        """
        messages = list(session.messages)
        last = max((i for i, m in enumerate(messages) if m.role == "assistant"), default=-1)
        history, new = messages[: last + 1], messages[last + 1:]
        state = json.dumps({"phase": session.phase, "plan": [{"id": n.id, "status": n.status} for n in session.plan.nodes]}, ensure_ascii=False)
        if new:
            body = "\n\n".join(f"{m.role}: {m.content}" for m in new)
        elif messages:
            body = "Continue the session from where it stopped."
        else:
            body = "Begin the session."
        return history, f"{body}\n\nCURRENT STATE: {state}"

    async def _release_runtime(self, session_id):
        from learnharness.engines import close_engine_processes
        self.state.revoke_session_tokens(session_id)
        try:
            await close_engine_processes(session_id)
        except Exception:
            logger.warning("Could not close engine processes for %s", session_id, exc_info=True)

    async def _flush(self, session_id, message_id, text):
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
            else:
                session.messages.append(SessionMessage(
                    id=message_id, role="assistant", content=text, created_at=now(),
                    node_id=node_id, node_spans=[NodeSpan(start=0, node_id=node_id)],
                ))
            self.save(session)
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
            if session.execution_status in ("running", "queued", "waiting"):
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
