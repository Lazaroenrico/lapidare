"""compose_turn is pure: what a turn sends is checked without an engine, a vault or I/O."""

from learnharness.core.contracts.session import SessionCompaction, SessionMessage, SessionRecord
from learnharness.core.turn_prompt import TURN_RULES, UPDATED_INSTRUCTIONS, compose_turn


def _msg(i: int, role: str, content: str) -> SessionMessage:
    return SessionMessage(id=f"m{i}", role=role, content=content, created_at="t")


def test_one_shot_opening_carries_everything_in_the_prompt():
    turn = compose_turn(SessionRecord(id="s", title="Atenção"), system="SYS", persistent=False)
    assert turn.prompt.startswith("SYS\n\nPERSISTED HISTORY:\n\n" + TURN_RULES)
    assert '"Atenção"' in turn.prompt.split("NOW:\n", 1)[1]
    assert turn.history is None and turn.system_instruction is None


def test_persistent_turn_sends_only_what_is_new():
    session = SessionRecord(id="s", title="t", phase="teaching", prompt_phase="teacher",
                            messages=[_msg(1, "assistant", "Pergunta?"), _msg(2, "user", "Resposta.")])
    turn = compose_turn(session, system="SYS", persistent=True)
    assert turn.prompt.startswith("user: Resposta.\n\nCURRENT STATE:")
    assert [m.id for m in turn.history or []] == ["m1"]
    assert turn.system_instruction == "SYS\n" + TURN_RULES


def test_persistent_phase_change_leads_with_the_new_rules():
    session = SessionRecord(id="s", title="t", phase="planning", prompt_phase="prober",
                            messages=[_msg(1, "assistant", "a")])
    assert compose_turn(session, system="SYS", persistent=True).prompt.startswith(UPDATED_INSTRUCTIONS + "SYS")


def test_compaction_summary_replaces_the_condensed_history():
    session = SessionRecord(id="s", title="t", messages=[_msg(i, "user", f"x{i}") for i in range(1, 5)],
                            compaction=SessionCompaction(summary="RESUMO", first_kept_message_id="m3"))
    one_shot = compose_turn(session, system="SYS", persistent=False).prompt
    assert "RESUMO" in one_shot and "x1" not in one_shot and "user: x3" in one_shot
    live = compose_turn(session, system="SYS", persistent=True)
    assert "RESUMO" in (live.system_instruction or "")


def test_handoff_is_the_request_and_keeps_new_input():
    session = SessionRecord(id="s", title="t", messages=[_msg(1, "assistant", "a"), _msg(2, "user", "b")])
    assert compose_turn(session, system="SYS", persistent=False, handoff="PLANEJE").prompt.endswith("NOW:\nPLANEJE")
    live = compose_turn(session, system="SYS", persistent=True, handoff="PLANEJE").prompt
    assert live.startswith("PLANEJE\n\nAlso new since the diagnosis:\nuser: b")
