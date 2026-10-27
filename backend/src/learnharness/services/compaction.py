"""Context compaction (Fase 12): summarize old history with the background slot.

Runs at the end of a teaching turn (``SessionService.run``) before the next one starts,
while ``execution_status`` reads ``"compacting"``. The summarized messages stay in the
session JSONL; ``SessionRecord.compaction`` only tells prompt assembly where the verbatim
tail starts and what replaces the history before it.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from learnharness.core.compaction import (
    SUMMARIZER_SYSTEM,
    CompactionSummary,
    build_summarizer_prompt,
    choose_first_kept,
    history_tokens,
    needs_compaction,
    render_summary,
    verbatim_messages,
)
from learnharness.core.contracts.session import SessionCompaction, SessionRecord

if TYPE_CHECKING:
    from learnharness.services.sessions import SessionService

logger = logging.getLogger(__name__)


def compaction_due(session: SessionRecord, budget: int) -> bool:
    return (needs_compaction(session.messages, session.compaction, budget)
            and choose_first_kept(session.messages, session.compaction) is not None)


def _state_for_summary(sessions: SessionService, session: SessionRecord) -> dict:
    data: dict = {"phase": session.phase, "plan": session.plan.model_dump(mode="json")}
    if session.assessment is not None:
        data["assessment"] = session.assessment.model_dump(mode="json")
    if session.pending_quiz is not None:
        quiz = session.pending_quiz
        data["open_question"] = {"question_id": quiz.quiz_id, "kind": quiz.kind, "mode": quiz.mode,
                                 "node_id": quiz.node_id, "question": quiz.question,
                                 "choices": [c.label for c in quiz.choices]}
    if session.mode == "PRACTICE":
        data["practice"] = sessions.state.practice.state_context(session)
    return data


async def compact_session(sessions: SessionService, session_id: str) -> bool:
    """Summarize the history before a ~20k-token tail when it outgrew the budget.

    Returns True when a new compaction was stored. Provider errors propagate; the caller
    decides the session status afterwards.
    """
    state = sessions.state
    config = state.get_config()
    session = sessions.get(session_id)
    first_kept = choose_first_kept(session.messages, session.compaction)
    if first_kept is None or not compaction_due(session, config.agent.compaction_tokens):
        return False
    tokens_before = history_tokens(session.messages, session.compaction)
    async with sessions.lock(session_id):
        current = sessions.get(session_id)
        current.execution_status = "compacting"
        sessions.save(current)
    prompt = build_summarizer_prompt(
        title=session.title, mode=session.mode, language=config.language,
        previous_summary=session.compaction.summary if session.compaction else None,
        messages=verbatim_messages(session.messages, session.compaction),
        state=_state_for_summary(sessions, session),
    )
    slot = config.slots.background
    result = await state.engine(slot).run_structured(
        prompt=prompt, schema=CompactionSummary, slot=slot, system_instruction=SUMMARIZER_SYSTEM)
    if not isinstance(result, CompactionSummary):
        result = CompactionSummary.model_validate(result)
    summary = render_summary(result, config.language)
    async with sessions.lock(session_id):
        current = sessions.get(session_id)
        current.compaction = SessionCompaction(summary=summary, first_kept_message_id=first_kept,
                                               tokens_before=tokens_before, at=datetime.now(UTC).isoformat())
        sessions.save(current)
    # A live persistent process still holds the long context: the next turn respawns it
    # and rehydrates from summary + tail.
    from learnharness.engines import close_engine_processes
    try:
        await close_engine_processes(session_id)
    except Exception:
        logger.warning("Could not close engine processes after compaction of %s", session_id, exc_info=True)
    return True
