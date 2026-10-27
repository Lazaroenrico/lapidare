"""Fase 12 context compaction: trigger, summary sections, first_kept and prompt assembly."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from learnharness.api.state import AppState
from learnharness.core.compaction import (
    TAIL_TOKENS,
    CompactionSummary,
    choose_first_kept,
    history_tokens,
    needs_compaction,
    split_history,
)
from learnharness.core.contracts.session import SessionCompaction, SessionMessage
from learnharness.core.graph_merge import fold_nodes, plan_unlink
from learnharness.vault.bootstrap import load_config, save_config
from tests.conftest import FakeEngine, configure_vault

BUDGET = 32_000
SUMMARY = CompactionSummary(
    learner_understanding="Sabe produto escalar; confunde softmax com normalização L2.",
    teaching_arc="Produto escalar, depois escala por raiz de d.",
    current_plan="dot (mastered) -> softmax (current)",
    current_moment="Pergunta aberta sobre softmax.",
)


def _msg(i: int, chars: int, role: str = "assistant") -> SessionMessage:
    return SessionMessage(id=f"m{i}", role=role, content=f"<{i}>" + "x" * (chars - len(f"<{i}>")),
                          created_at=f"2026-10-27T00:00:{i:02d}")


def _long_history(n: int = 10, chars: int = 16_000) -> list[SessionMessage]:
    return [_msg(i, chars, "user" if i % 2 else "assistant") for i in range(n)]


# --------------------------------------------------------------------------- pure rules


def test_trigger_counts_only_history_since_last_compaction() -> None:
    messages = _long_history()  # 10 x 4000 tokens
    assert history_tokens(messages, None) == 40_000
    assert needs_compaction(messages, None, BUDGET)
    compaction = SessionCompaction(summary="s", first_kept_message_id="m6")
    assert history_tokens(messages, compaction) == 16_000
    assert not needs_compaction(messages, compaction, BUDGET)


def test_first_kept_keeps_about_twenty_thousand_tokens() -> None:
    messages = _long_history()
    first = choose_first_kept(messages, None)
    assert first == "m5"  # m5..m9 = 20 000 tokens
    summary, tail = split_history(messages, SessionCompaction(summary="S", first_kept_message_id=first))
    assert summary == "S" and [m.id for m in tail] == ["m5", "m6", "m7", "m8", "m9"]
    assert sum(len(m.content) // 4 for m in tail) <= TAIL_TOKENS
    # A single huge last message is still kept whole; something must remain to summarize.
    assert choose_first_kept([_msg(0, 400), _msg(1, 200_000)], None) == "m1"
    assert choose_first_kept([_msg(0, 400)], None) is None
    assert split_history(messages, None) == (None, messages)


def test_plan_unlink_is_pure_and_folds() -> None:
    p = lambda s: [{"session_id": s}]  # noqa: E731
    nodes = [{"id": "a", "name": "A", "statement": "a", "provenance": p("s1")},
             {"id": "b", "name": "B", "statement": "b", "provenance": p("s2")},
             {"id": "b", "provenance": p("s1")}]
    chains = [{"id": "c1", "premises": ["b"], "conclusion": "a", "provenance": p("s2")},
              {"id": "c2", "premises": ["b"], "conclusion": "a", "provenance": p("s1")}]
    plan = plan_unlink(nodes, chains, "s1")
    assert plan == {"unlink_nodes": ["a", "b"], "unlink_chains": ["c2"], "dead_nodes": ["a"],
                    "dead_chains": ["c1", "c2"]}
    folded = fold_nodes([*nodes, {"id": "b", "unlink_session": "s1"}])
    assert [x.session_id for x in folded["b"].provenance] == ["s2"]


# --------------------------------------------------------------------------- service


def _state(tmp_path, engine) -> AppState:
    vault = configure_vault(tmp_path / "Vault")
    config = load_config(vault)
    config.agent.compaction_tokens = BUDGET
    save_config(vault, config)
    return AppState(vault_path=vault, engine_factory=lambda slot: engine)


async def _seed(state: AppState):
    session = await state.sessions.create(topic="Atenção", start=False)
    async with state.sessions.lock(session.id):
        current = state.sessions.get(session.id)
        current.messages = _long_history()
        state.sessions.save(current)
    return session.id


async def test_turn_end_compacts_and_next_prompt_uses_summary_and_tail(tmp_path) -> None:
    engine = FakeEngine()
    state = _state(tmp_path, engine)
    seen = []
    try:
        session_id = await _seed(state)

        def summarize(prompt):
            seen.append((state.sessions.get(session_id).execution_status, prompt))
            return SUMMARY

        engine.program(CompactionSummary, summarize)
        engine.script_turn("Seguimos para o softmax.")
        engine.script_turn("Próximo passo.")
        await state.sessions.run(session_id)

        session = state.sessions.get(session_id)
        assert seen and seen[0][0] == "compacting"
        assert "<0>" in seen[0][1] and "AUTHORITATIVE SESSION STATE" in seen[0][1]
        call = engine.structured_calls[0]
        assert call["slot"] == state.get_config().slots.background
        assert "current_plan" in call["system_instruction"]
        compaction = session.compaction
        assert compaction is not None and compaction.tokens_before > BUDGET
        for heading in ("## Entendimento do aluno e evolução", "## Arco do ensino", "## Plano atual",
                        "## Momento atual"):
            assert heading in compaction.summary
        # m5..m9 plus the new assistant message: the tail stays ~20k tokens.
        assert compaction.first_kept_message_id == "m6"
        assert session.execution_status == "idle"
        assert len(session.messages) == 11  # Old messages stay persisted.

        await state.sessions.run(session_id)
        prompt = engine.stream_calls[-1]["prompt"]
        assert "CONVERSATION SUMMARY" in prompt and "confunde softmax" in prompt
        assert "<5>" not in prompt and "<6>" in prompt and "<9>" in prompt
        assert "Seguimos para o softmax." in prompt
        # Within budget again: no second compaction.
        assert len(engine.structured_calls) == 1
    finally:
        await state.close()


async def test_failed_compaction_keeps_the_session_usable(tmp_path) -> None:
    engine = FakeEngine()
    state = _state(tmp_path, engine)
    try:
        session_id = await _seed(state)
        engine.program(CompactionSummary, RuntimeError("background slot down"))
        engine.script_turn("ok")
        await state.sessions.run(session_id)
        session = state.sessions.get(session_id)
        assert session.compaction is None and session.execution_status == "idle"
    finally:
        await state.close()


class PersistentEngine:
    """Records what a persistent engine would rehydrate from."""

    tool_transport = "mcp"
    session_persistent = True

    def __init__(self):
        self.calls = []

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        pass

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None):
        self.calls.append(SimpleNamespace(prompt=prompt, history=list(history or []),
                                          system=system_instruction or ""))
        yield f"resposta {len(self.calls)}"

    async def run_structured(self, prompt, schema, slot=None, system_instruction=None):
        await asyncio.sleep(0)
        return SUMMARY


async def test_persistent_rehydration_gets_summary_and_tail(tmp_path) -> None:
    engine = PersistentEngine()
    state = _state(tmp_path, engine)
    try:
        session_id = await _seed(state)
        await state.sessions.run(session_id)
        assert state.sessions.get(session_id).compaction is not None
        assert "CONVERSATION SUMMARY" not in engine.calls[0].system
        await state.sessions.deliver_steer(session_id, "learner", "e o softmax?")
        for _ in range(200):
            if not state.sessions.is_running(session_id):
                break
            await asyncio.sleep(0.01)
        call = engine.calls[-1]
        assert "CONVERSATION SUMMARY" in call.system and "Pergunta aberta sobre softmax." in call.system
        assert call.history[0].id == "m6"
        assert "e o softmax?" in call.prompt
    finally:
        await state.close()
