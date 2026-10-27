"""HTTP adapters for durable pedagogical sessions."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from learnharness.api.state import get_app_state
from learnharness.core.contracts.config import EffortLevel
from learnharness.core.contracts.quiz import QuizPayload, QuizSubmission
from learnharness.core.contracts.session import SessionMode, SessionRecord, slot_override_for
from learnharness.core.plan_mermaid import derive_plan_statuses
from learnharness.services.practice import attempt_prefix, next_request, public_practice
from learnharness.services.sessions import SessionConflict, now
from learnharness.vault.jsonl_store import list_sessions

chats_router = APIRouter(prefix="/api/chats", tags=["chats"])


class CreateChatPayload(BaseModel):
    mode: SessionMode = "TEACH"
    topic: str | None = Field(default=None, max_length=10000)
    source_file: str | None = None
    track_item_id: str | None = None
    track_id: str | None = None  # Fase 14; without it the step belongs to the active track
    graph_context: list[str] = Field(default_factory=list, max_length=64)
    # Optional per-session model/effort (the strong slot's engine is kept).
    model_id: str | None = Field(default=None, max_length=200)
    effort: EffortLevel | None = None


class SessionSettingsPayload(BaseModel):
    """Per-session model/effort; both null clears the override (back to slots.strong)."""
    model_id: str | None = Field(default=None, max_length=200)
    effort: EffortLevel | None = None


class SendMessagePayload(BaseModel):
    """Learner input. PRACTICE adds ``attempt`` (on the active problem) and ``next`` (no content)."""
    content: str = Field(default="", max_length=100000)
    kind: Literal["text", "attempt", "next"] = "text"


class QuizSubmissionPayload(BaseModel):
    """QuestionDock answer; ``chosen_index`` is the legacy single-choice spelling."""
    quiz_id: str
    chosen_indices: list[int] = Field(default_factory=list)
    chosen_index: int | None = Field(default=None, ge=0)
    confidence: int | None = Field(default=None, ge=0, le=100)
    learner_thinking: str = ""
    reading_thinking: str = ""
    text: str = Field(default="", max_length=100000)
    other_text: str = Field(default="", max_length=10000)
    is_dont_know: bool = False


class ResumePayload(BaseModel):
    restart_diagnostic: bool = False


def _serialize_quiz(quiz: QuizPayload) -> dict[str, Any]:
    """The pending question as the dock sees it: never the answer key.

    ``correct_indices`` / ``correct_index``, ``committed_answer`` and ``explanation`` stay
    on the server until the learner answers.
    """
    return {
        "id": quiz.quiz_id, "quiz_id": quiz.quiz_id, "session_id": quiz.session_id,
        "kind": quiz.kind, "mode": quiz.mode, "question": quiz.question, "details": quiz.details,
        "options": [{"index": i, "label": opt.value.upper(), "text": opt.label, "description": opt.description}
                    for i, opt in enumerate(quiz.choices)],
        "choices": [opt.model_dump() for opt in quiz.choices], "multi_select": quiz.multi_select,
        "has_dont_know": quiz.kind != "ask", "has_confidence": quiz.kind == "quiz",
        "has_other": quiz.kind == "ask", "collapsed": quiz.mode == "CHECK",
        "target_concept": quiz.topic, "plan_node_id": quiz.node_id, "node_id": quiz.node_id,
        "created_at": quiz.created_at,
    }


def _question_node_ids(session: SessionRecord, pending_quiz: QuizPayload | None) -> list[str | None]:
    asked = [a.node_id for a in session.answers.values() if a.kind in ("quiz", "explain")]
    if pending_quiz and pending_quiz.kind in ("quiz", "explain"):
        asked.append(pending_quiz.node_id)
    return asked


def _serialize_session(session: SessionRecord, pending_quiz=None) -> dict[str, Any]:
    pending_quiz = pending_quiz or session.pending_quiz
    data = session.model_dump(mode="json", exclude={"pending_quiz", "answers", "applied_actions", "practice"})
    data.update({
        "topic": session.title, "teach_context": session.context_kind,
        "source_file": session.source_path,
        "status": "waiting_quiz" if pending_quiz else ("completed" if session.phase == "completed" else "active"),
        "pending_quiz": _serialize_quiz(pending_quiz) if pending_quiz else None,
        "answers": [a.model_dump(mode="json") for a in session.answers.values()],
        "execution_status": session.execution_status,
        "error": session.error,
        "recovery_required": session.recovery_required or bool(session.pending_quiz_id and not session.pending_quiz),
        "messages": [{**m.model_dump(mode="json"), "timestamp": m.created_at} for m in session.messages],
        # Fase 9: model_solution only appears once a problem is concluded.
        "practice": public_practice(session),
        # Fase 12 sidebar: a question waits for the learner / a PRACTICE problem is open.
        "pending": pending_quiz is not None,
        "problem_open": session.practice.active_problem_id is not None,
    })
    statuses = derive_plan_statuses(session.plan.nodes, _question_node_ids(session, pending_quiz))
    data["plan"]["nodes"] = [{**n.model_dump(mode="json"), "status": statuses[n.id], "title": n.label, "dependencies": n.depends_on, "summary": n.four_dimensions.said if n.four_dimensions else ""} for n in session.plan.nodes]
    return data


# The sidebar refetches the list on every session notify: rows carry no transcript.
_LIST_EXCLUDE = {"messages", "plan", "answers", "pending_quiz", "applied_actions", "practice",
                 "assessment", "leveling", "compaction", "graph_context"}


def _summarize_session(session: SessionRecord) -> dict[str, Any]:
    """One sidebar row: identity, status and track, without messages, plan or answers."""
    pending = session.pending_quiz is not None
    data = session.model_dump(mode="json", exclude=_LIST_EXCLUDE)
    data.update({
        "topic": session.title, "teach_context": session.context_kind,
        "source_file": session.source_path,
        "status": "waiting_quiz" if pending else ("completed" if session.phase == "completed" else "active"),
        "recovery_required": session.recovery_required or bool(session.pending_quiz_id and not pending),
        "practice": {"active_problem_id": session.practice.active_problem_id},
        "pending": pending,
        "problem_open": session.practice.active_problem_id is not None,
    })
    return data


def _with_slot(state, session: SessionRecord) -> dict[str, Any]:
    """Session payload plus the slot its next teaching turn will use."""
    data = _serialize_session(session)
    data["effective_slot"] = session.teaching_slot(state.get_config().slots.strong).model_dump(mode="json")
    return data


@chats_router.get("")
async def get_chats(request: Request):
    state = get_app_state(request.app)
    return [_summarize_session(s) for s in list_sessions(state.vault_path)]


@chats_router.post("")
async def create_chat(payload: CreateChatPayload, request: Request):
    state = get_app_state(request.app)
    override = slot_override_for(state.get_config().slots.strong, payload.model_id, payload.effort)
    session = await state.sessions.create(**payload.model_dump(exclude={"model_id", "effort"}),
                                          slot_override=override)
    return _with_slot(state, session)


# Trash routes are declared before ``/{chat_id}`` so "trash" never reads as a session id.
@chats_router.get("/trash")
async def get_trash(request: Request):
    """Sessions moved to ``.harness/trash/`` by DELETE, most recently deleted first."""
    state = get_app_state(request.app)
    return state.sessions.list_trash()


@chats_router.post("/trash/{file}/restore")
async def restore_trash(file: str, request: Request):
    """Move a trash entry back to ``.harness/sessions/``; 409 if that id is live again.

    Graph provenance removed by a ``delete-nodes`` deletion is not brought back
    (``graph_restored`` is always false); the Aulas/ note was never deleted.
    """
    state = get_app_state(request.app)
    session = await state.sessions.restore_from_trash(file)
    return {"session": _with_slot(state, session), "graph_restored": False}


@chats_router.delete("/trash/{file}")
async def purge_trash(file: str, request: Request, confirm: bool = False):
    """Permanently delete one trash file; requires ``?confirm=true``."""
    if not confirm:
        raise HTTPException(status_code=422, detail="Permanent deletion requires confirm=true")
    state = get_app_state(request.app)
    return state.sessions.purge_trash(file)


@chats_router.get("/{chat_id}")
async def get_chat(chat_id: str, request: Request):
    state = get_app_state(request.app)
    return _with_slot(state, state.sessions.live_view(state.sessions.get(chat_id)))


class RenamePayload(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@chats_router.put("/{chat_id}")
async def rename_chat(chat_id: str, payload: RenamePayload, request: Request):
    """Rename the session; the lesson note keeps its path (only managed title fields change)."""
    state = get_app_state(request.app)
    session = await state.sessions.rename(chat_id, payload.title)
    return _with_slot(state, session)


@chats_router.delete("/{chat_id}")
async def delete_chat(chat_id: str, request: Request,
                      mode: Literal["preserve-graph", "delete-nodes"] = "preserve-graph"):
    """Move the session to ``.harness/trash/`` (the Aulas/ note stays); 409 while a turn runs."""
    state = get_app_state(request.app)
    return await state.sessions.delete(chat_id, mode)


@chats_router.post("/{chat_id}/abort")
async def abort_chat(chat_id: str, request: Request):
    """Cancel the running turn (-> interrupted) and dismiss a pending question."""
    state = get_app_state(request.app)
    session = await state.sessions.abort(chat_id)
    return {"session": _serialize_session(session)}


@chats_router.post("/{chat_id}/questions/dismiss")
async def dismiss_question(chat_id: str, request: Request):
    """Close the pending question without answering it (no grade, no quiz-log line)."""
    state = get_app_state(request.app)
    result = await state.sessions.dismiss_question(chat_id)
    return {"answer": result.model_dump(mode="json"), "session": _serialize_session(state.sessions.get(chat_id))}


@chats_router.get("/{chat_id}/markdown")
async def export_chat_markdown(chat_id: str, request: Request):
    from urllib.parse import quote

    from fastapi.responses import Response

    from learnharness.core.session_export import export_filename, render_session_markdown

    state = get_app_state(request.app)
    session = state.sessions.get(chat_id)
    body = render_session_markdown(session, state.get_config().language)
    filename = export_filename(session.title)
    fallback = filename.encode("ascii", "replace").decode("ascii").replace("?", "_").replace('"', "_")
    disposition = f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"
    return Response(content=body, media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": disposition})


@chats_router.put("/{chat_id}/settings")
async def update_chat_settings(chat_id: str, payload: SessionSettingsPayload, request: Request):
    """Change the session's model/effort; it applies from the next teaching turn.

    An idle session's persistent engine process is closed so the next turn respawns with
    the new model and rehydrates from the persisted history. A running turn is never
    killed: the persistent engines respawn by themselves when the slot no longer matches.
    """
    from learnharness import engines

    state = get_app_state(request.app)
    strong = state.get_config().slots.strong
    async with state.sessions.lock(chat_id):
        try:
            session = state.sessions.get(chat_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Unknown session") from None
        before = session.teaching_slot(strong)
        session.slot_override = slot_override_for(strong, payload.model_id, payload.effort)
        changed = session.teaching_slot(strong) != before
        state.sessions.save(session)
        running = state.sessions.is_running(chat_id)
    if changed and not running:
        await engines.close_engine_processes(chat_id)
    return _with_slot(state, session)


@chats_router.post("/{chat_id}/messages")
@chats_router.post("/{chat_id}/message")
async def send_chat_message(chat_id: str, payload: SendMessagePayload, request: Request):
    from uuid import uuid4

    from learnharness.core.contracts.session import SessionMessage
    state = get_app_state(request.app)
    if payload.kind != "next" and not payload.content.strip():
        raise ValueError("Message content is empty")
    language = state.get_config().language
    async with state.sessions.lock(chat_id):
        session = state.sessions.get(chat_id)
        if state.sessions.is_running(chat_id) or session.pending_quiz or session.recovery_required or session.phase == "completed":
            raise SessionConflict("Answer the pending question or resume the session before sending a message")
        message = SessionMessage(id=f"msg-{uuid4().hex}", role="user", content=payload.content, created_at=now())
        if payload.kind == "attempt":
            problem = state.practice.add_attempt(session, payload.content)
            message.content = attempt_prefix(language) + payload.content
            message.practice_kind, message.problem_id = "attempt", problem.id
        elif payload.kind == "next":
            if session.mode != "PRACTICE":
                raise SessionConflict("Only PRACTICE sessions take a next-problem request")
            if session.practice.active_problem_id:
                raise SessionConflict("Conclude or dismiss the active problem before asking for the next one")
            message.content, message.practice_kind = next_request(language), "next"
        session.messages.append(message)
        session.execution_status = "queued"
        state.sessions.save(session)
        if payload.kind == "attempt":
            state.sessions.refresh_lesson_note(session)
        state.sessions.schedule(chat_id)
    return {"session": _serialize_session(session)}


class SteerPayload(BaseModel):
    content: str = Field(min_length=1, max_length=100000)


@chats_router.post("/{chat_id}/steer")
async def steer_chat(chat_id: str, payload: SteerPayload, request: Request):
    """A learner message sent while a turn runs: delivered at the next turn boundary."""
    state = get_app_state(request.app)
    try:
        state.sessions.get(chat_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown session") from None
    await state.sessions.deliver_steer(chat_id, "learner", payload.content)
    return {"session": _serialize_session(state.sessions.get(chat_id))}


@chats_router.post("/{chat_id}/practice/dismiss")
async def dismiss_practice_problem(chat_id: str, request: Request):
    """Dismiss the active PRACTICE problem (outcome ``dismissed``, no log line, no new turn)."""
    state = get_app_state(request.app)
    session = await state.practice.dismiss(chat_id)
    return {"session": _serialize_session(session)}


@chats_router.post("/{chat_id}/answer")
async def answer_quiz(chat_id: str, payload: QuizSubmissionPayload, request: Request):
    state = get_app_state(request.app)
    fields = payload.model_dump(exclude={"chosen_index"})
    if not fields["chosen_indices"] and payload.chosen_index is not None:
        fields["chosen_indices"] = [payload.chosen_index]
    result = await state.sessions.answer(QuizSubmission(session_id=chat_id, **fields))
    feedback = "\n\n".join(p for p in (result.pedagogical_directive, result.explanation) if p)
    return {**result.model_dump(mode="json"), "is_correct": result.correct, "band": result.calibration_band, "feedback_prose": feedback}


@chats_router.post("/{chat_id}/resume")
async def resume_chat(chat_id: str, payload: ResumePayload, request: Request):
    state = get_app_state(request.app)
    async with state.sessions.lock(chat_id):
        session = state.sessions.get(chat_id)
        if state.sessions.is_running(chat_id):
            return _serialize_session(session)
        if session.recovery_required or (session.pending_quiz_id and not session.pending_quiz):
            if not payload.restart_diagnostic:
                raise SessionConflict("Legacy question is incomplete; explicitly restart diagnosis")
            session.pending_quiz_id = None
            session.pending_quiz = None
            session.recovery_required = False
            session.phase = "probing"
            from learnharness.core.contracts.session import PlanDag
            session.plan = PlanDag()
            # A restarted diagnosis must be able to close again with probe_done.
            session.assessment = None
            session.handoff_pending = False
            session.prompt_phase = None
        if not session.pending_quiz and session.phase != "completed":
            session.execution_status = "queued"
            state.sessions.save(session)
            state.sessions.schedule(chat_id)
    return _serialize_session(session)
