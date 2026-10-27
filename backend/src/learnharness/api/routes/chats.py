"""HTTP adapters for durable pedagogical sessions."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from learnharness.api.state import get_app_state
from learnharness.core.contracts.config import EffortLevel
from learnharness.core.contracts.quiz import QuizPayload, QuizSubmission
from learnharness.core.contracts.session import SessionMode, SessionRecord, slot_override_for
from learnharness.core.plan_mermaid import derive_plan_statuses
from learnharness.services.sessions import SessionConflict, now
from learnharness.vault.jsonl_store import list_sessions

chats_router = APIRouter(prefix="/api/chats", tags=["chats"])


class CreateChatPayload(BaseModel):
    mode: SessionMode = "TEACH"
    topic: str | None = Field(default=None, max_length=10000)
    source_file: str | None = None
    track_item_id: str | None = None
    # Optional per-session model/effort (the strong slot's engine is kept).
    model_id: str | None = Field(default=None, max_length=200)
    effort: EffortLevel | None = None


class SessionSettingsPayload(BaseModel):
    """Per-session model/effort; both null clears the override (back to slots.strong)."""
    model_id: str | None = Field(default=None, max_length=200)
    effort: EffortLevel | None = None


class SendMessagePayload(BaseModel):
    content: str = Field(min_length=1, max_length=100000)


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
    data = session.model_dump(mode="json", exclude={"pending_quiz", "answers", "applied_actions"})
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
    })
    statuses = derive_plan_statuses(session.plan.nodes, _question_node_ids(session, pending_quiz))
    data["plan"]["nodes"] = [{**n.model_dump(mode="json"), "status": statuses[n.id], "title": n.label, "dependencies": n.depends_on, "summary": n.four_dimensions.said if n.four_dimensions else ""} for n in session.plan.nodes]
    return data


def _with_slot(state, session: SessionRecord) -> dict[str, Any]:
    """Session payload plus the slot its next teaching turn will use."""
    data = _serialize_session(session)
    data["effective_slot"] = session.teaching_slot(state.get_config().slots.strong).model_dump(mode="json")
    return data


@chats_router.get("")
async def get_chats(request: Request):
    state = get_app_state(request.app)
    return [_serialize_session(s) for s in list_sessions(state.vault_path)]


@chats_router.post("")
async def create_chat(payload: CreateChatPayload, request: Request):
    state = get_app_state(request.app)
    override = slot_override_for(state.get_config().slots.strong, payload.model_id, payload.effort)
    session = await state.sessions.create(**payload.model_dump(exclude={"model_id", "effort"}),
                                          slot_override=override)
    return _with_slot(state, session)


@chats_router.get("/{chat_id}")
async def get_chat(chat_id: str, request: Request):
    state = get_app_state(request.app)
    return _with_slot(state, state.sessions.get(chat_id))


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
    async with state.sessions.lock(chat_id):
        session = state.sessions.get(chat_id)
        if state.sessions.is_running(chat_id) or session.pending_quiz or session.recovery_required or session.phase == "completed":
            raise SessionConflict("Answer the pending question or resume the session before sending a message")
        session.messages.append(SessionMessage(id=f"msg-{uuid4().hex}", role="user", content=payload.content, created_at=now()))
        session.execution_status = "queued"
        state.sessions.save(session)
        state.sessions.schedule(chat_id)
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
        if not session.pending_quiz and session.phase != "completed":
            session.execution_status = "queued"
            state.sessions.save(session)
            state.sessions.schedule(chat_id)
    return _serialize_session(session)
