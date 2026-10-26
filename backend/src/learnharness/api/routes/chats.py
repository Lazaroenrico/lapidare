"""HTTP adapters for durable pedagogical sessions."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from learnharness.api.state import get_app_state
from learnharness.core.contracts.quiz import QuizPayload, QuizSubmission
from learnharness.core.contracts.session import SessionMode, SessionRecord
from learnharness.services.sessions import SessionConflict, now
from learnharness.vault.jsonl_store import list_sessions

chats_router = APIRouter(prefix="/api/chats", tags=["chats"])


class CreateChatPayload(BaseModel):
    mode: SessionMode = "TEACH"
    topic: str | None = Field(default=None, max_length=10000)
    source_file: str | None = None
    track_item_id: str | None = None


class SendMessagePayload(BaseModel):
    content: str = Field(min_length=1, max_length=100000)


class QuizSubmissionPayload(BaseModel):
    quiz_id: str
    chosen_index: int | None = Field(default=None, ge=0)
    confidence: int = Field(ge=0, le=100)
    learner_thinking: str = ""
    is_dont_know: bool = False


class ResumePayload(BaseModel):
    restart_diagnostic: bool = False


def _serialize_quiz(quiz: QuizPayload) -> dict[str, Any]:
    return {
        "id": quiz.quiz_id, "quiz_id": quiz.quiz_id, "session_id": quiz.session_id,
        "mode": quiz.mode, "question": quiz.question, "details": quiz.details,
        "options": [{"index": i, "label": opt.value.upper(), "text": opt.label} for i, opt in enumerate(quiz.choices)],
        "choices": [opt.model_dump() for opt in quiz.choices], "has_dont_know": True,
        "target_concept": quiz.topic, "plan_node_id": quiz.node_id,
    }


def _serialize_session(session: SessionRecord, pending_quiz=None) -> dict[str, Any]:
    pending_quiz = pending_quiz or session.pending_quiz
    data = session.model_dump(mode="json", exclude={"pending_quiz", "answers", "applied_actions"})
    data.update({
        "topic": session.title, "teach_context": session.context_kind,
        "source_file": session.source_path,
        "status": "waiting_quiz" if pending_quiz else ("completed" if session.phase == "completed" else "active"),
        "pending_quiz": _serialize_quiz(pending_quiz) if pending_quiz else None,
        "execution_status": session.execution_status,
        "error": session.error,
        "recovery_required": session.recovery_required or bool(session.pending_quiz_id and not session.pending_quiz),
        "messages": [{**m.model_dump(mode="json"), "timestamp": m.created_at} for m in session.messages],
    })
    data["plan"]["nodes"] = [{**n.model_dump(mode="json"), "title": n.label, "dependencies": n.depends_on, "summary": n.four_dimensions.said if n.four_dimensions else ""} for n in session.plan.nodes]
    return data


@chats_router.get("")
async def get_chats(request: Request):
    state = get_app_state(request.app)
    return [_serialize_session(s) for s in list_sessions(state.vault_path)]


@chats_router.post("")
async def create_chat(payload: CreateChatPayload, request: Request):
    state = get_app_state(request.app)
    session = await state.sessions.create(**payload.model_dump())
    return _serialize_session(session)


@chats_router.get("/{chat_id}")
async def get_chat(chat_id: str, request: Request):
    return _serialize_session(get_app_state(request.app).sessions.get(chat_id))


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
    submission = QuizSubmission(session_id=chat_id, **payload.model_dump())
    result = await state.sessions.answer(submission)
    return {**result.model_dump(mode="json"), "is_correct": result.correct, "band": result.calibration_band, "feedback_prose": result.pedagogical_directive + "\n\n" + result.explanation}


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
