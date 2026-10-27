"""What one agent turn sends to the engine, from the session and the system prompt (pure).

Two transports:

* one-shot engines get everything in one prompt every turn: system prompt, the persisted
  history (the compaction summary first, when there is one), the turn rules and the
  request (opening or post-diagnosis handoff);
* session-persistent engines keep the conversation in a live process: they get the system
  instruction (rules included) for a fresh process, the history it would rehydrate from,
  and per turn only what is new since the model last spoke. When the session moved to
  another prompt family (prober -> teacher), the live process still holds the old rules,
  so the new ones lead the prompt.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from learnharness.core.compaction import split_history, summary_block
from learnharness.core.contracts.session import SessionMessage, SessionRecord

TURN_RULES = (
    "Every question goes through a question tool, never in prose, one per turn: probe/recall while "
    "diagnosing, then exactly one probe_done; after it, plan_init (mermaid), present the plan and end "
    "the turn; then quiz/explain with type predict|check and a plan node_id; ask_user_question for "
    "anything ungraded. Grade every recall/explain answer with grade_recall before commenting on it. "
    "Use plan_advance (mastered | needs_review) after checks. Do not invent citations. If prior answers "
    "exist, react to their calibration before advancing. research, read_pdf, visual and spawn_demo "
    "dispatch background jobs and return at once: announce the dispatch in one sentence and keep "
    "teaching; never wait for or ask about the result. It arrives later as a message: use it then, "
    "citing its sources or pages; if it fails or never comes, continue in prose and never invent it."
)

PRACTICE_TURN_RULES = (
    "PRACTICE tools: problem(statement, mode, model_solution, target) poses exactly one problem (write "
    "the full model_solution first; it stays hidden until conclude) and then you end the turn and wait "
    "for the learner's attempt. Read each attempt; give hints in prose, one rung (R0..R5) per request. "
    "Close every problem with conclude(outcome, verdict, rung, miss_class, retest), then write the "
    "closing words and end the turn: the next problem only comes when the learner asks for it. "
    "graph_search(query) looks up propositions of the learner's graph; ask_user_question is for anything "
    "ungraded. probe/recall/quiz/explain/plan tools do not exist in PRACTICE. Never reopen a problem the "
    "learner dismissed. research(question) and read_pdf(path, question) dispatch background jobs and "
    "return at once; the result arrives later as a message. Do not wait for it and never invent it."
)

LEVELING_TURN_RULES = (
    "TRACK LEVELING (Fase 15): every question goes through probe or recall, never in prose, one per "
    "turn, about one item of the pending queue in the session state; grade every recall answer with "
    "grade_recall before commenting. plan_init, quiz, explain and probe_done do not exist here; nothing "
    "is taught. Close with exactly one leveling_done(known_item_ids, start_item_id, summary) and end the turn."
)

UPDATED_INSTRUCTIONS = "UPDATED INSTRUCTIONS (they replace your previous system instructions):\n"


def turn_rules(session: SessionRecord) -> str:
    if session.mode == "PRACTICE":
        return PRACTICE_TURN_RULES
    return LEVELING_TURN_RULES if session.context_kind == "leveling" else TURN_RULES


def prompt_family(session: SessionRecord) -> str:
    """Which prompt set the session needs now: ``prober``, ``teacher`` or ``practice``."""
    if session.mode == "PRACTICE":
        return "practice"
    return "prober" if session.phase == "probing" else "teacher"


def opening_request(session: SessionRecord) -> str:
    """First-turn request: the session title IS what the learner asked for."""
    if session.mode == "PRACTICE":
        return (
            f'Begin the practice session. The learner asked to practice: "{session.title}". '
            "Open directly with the first problem (no warm-up)."
        )
    if session.context_kind == "leveling":
        return ("Begin the track leveling. Say in one sentence what this short diagnosis is for, then "
                "ask the first question about the middle item of the pending queue.")
    return (
        f'Begin the session. The learner opened it with: "{session.title}". Treat that as '
        "their stated goal; ask to clarify only if two readings would lead to different lessons."
    )


def persistent_turn(session: SessionRecord, handoff: str | None = None,
                    steers: Sequence[SessionMessage] = ()) -> tuple[list[SessionMessage], str]:
    """Split persisted messages into ``(history, new-content prompt)`` for a live process.

    New content is everything after the last assistant message (quiz answers, learner
    input); the plan status travels each turn because answers can master nodes. The
    post-diagnosis ``handoff`` instruction, when given, is the turn's request.
    """
    messages = list(session.messages)
    ids = [m.id for m in messages]
    if session.model_cursor in ids:
        # What the live process has already seen ends at the cursor (see SessionRecord).
        cut = ids.index(session.model_cursor)
    else:
        cut = max((i for i, m in enumerate(messages) if m.role == "assistant"), default=-1)
    history, new = messages[: cut + 1], messages[cut + 1:]
    new = [m for m in new if m.role != "assistant"]
    # A steer can land before the cursor (it arrived while the previous turn ran and was
    # not handed over mid-turn); it is still new content for the model.
    new_ids = {m.id for m in new}
    late = [m for m in steers if m.id not in new_ids]
    history = [m for m in history if m.id not in {s.id for s in late}]
    new = late + new
    current: dict[str, Any] = {"phase": session.phase,
                               "plan": [{"id": n.id, "status": n.status} for n in session.plan.nodes]}
    if session.mode == "PRACTICE":
        current = {"phase": session.phase, "active_problem_id": session.practice.active_problem_id}
    state = json.dumps(current, ensure_ascii=False)
    if handoff:
        # The planning request leads; learner input that arrived meanwhile still goes along.
        body = handoff
        if new:
            body += "\n\nAlso new since the diagnosis:\n" + "\n\n".join(f"{m.role}: {m.content}" for m in new)
    elif new:
        body = "\n\n".join(f"{m.role}: {m.content}" for m in new)
    elif messages:
        body = "Continue the session from where it stopped."
    else:
        body = opening_request(session)
    return history, f"{body}\n\nCURRENT STATE: {state}"


@dataclass(frozen=True)
class TurnPrompt:
    prompt: str
    # Session-persistent engines only (``None`` for one-shot engines):
    system_instruction: str | None = None
    history: list[SessionMessage] | None = None


def compose_turn(session: SessionRecord, *, system: str, persistent: bool, handoff: str | None = None,
                 steers: Sequence[SessionMessage] = ()) -> TurnPrompt:
    """The engine input of one turn; ``system`` is the assembled system prompt (no rules)."""
    rules = turn_rules(session)
    # Fase 12: after a compaction the model reads its summary plus the verbatim tail.
    summary, tail = split_history(session.messages, session.compaction)
    if persistent:
        history, prompt = persistent_turn(session, handoff=handoff, steers=steers)
        if summary:
            # Rehydration of a fresh process (compose_prompt) gets the summary with the
            # instructions; its history is only the tail.
            tail_ids = {m.id for m in tail}
            history = [m for m in history if m.id in tail_ids]
            system += "\n\n" + summary_block(summary)
        if session.prompt_phase is not None and session.prompt_phase != prompt_family(session):
            prompt = UPDATED_INSTRUCTIONS + system + "\n" + rules + "\n\n" + prompt
        return TurnPrompt(prompt, system + "\n" + rules, history)
    persisted = "\n\n".join(f"{m.role}: {m.content}" for m in tail)
    if summary:
        persisted = summary_block(summary) + "\n\n" + persisted
    prompt = system + "\n\nPERSISTED HISTORY:\n" + persisted + "\n" + rules
    if not session.messages and not handoff:
        prompt += "\n\nNOW:\n" + opening_request(session)
    if handoff:
        prompt += "\n\nNOW:\n" + handoff
    return TurnPrompt(prompt)
