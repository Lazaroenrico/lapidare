"""SessionService.run with engines that keep the conversation (``session_persistent``)."""

import asyncio
from types import SimpleNamespace

import pytest

import learnharness.engines as engines
from learnharness.api.state import AppState
from learnharness.core.contracts.session import SessionMessage
from tests.conftest import configure_vault


class PersistentEngine:
    tool_transport = "mcp"
    session_persistent = True

    def __init__(self):
        self.calls = []
        self.runtime = []

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        self.runtime.append((str(work_dir), mcp_token))

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None):
        self.calls.append(SimpleNamespace(prompt=prompt, history=list(history or []), system=system_instruction, tools=tools))
        yield f"resposta {len(self.calls)}"


@pytest.fixture
def closed(monkeypatch):
    calls = []

    async def record(session_id=None):
        calls.append(session_id)

    monkeypatch.setattr(engines, "close_engine_processes", record)
    return calls


async def test_persistent_engine_gets_only_new_content_and_one_token(tmp_path, closed):
    engine = PersistentEngine()
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    service = state.sessions
    session = await service.create(topic="Atenção", start=False)

    await service.run(session.id)
    first = engine.calls[0]
    assert first.prompt.startswith("Begin the session.") and "CURRENT STATE" in first.prompt
    assert "\"Atenção\"" in first.prompt  # the title is the learner's stated goal
    assert first.history == [] and "probe_done" in first.system and "PERSISTED HISTORY" not in first.system

    current = service.get(session.id)
    current.messages.append(SessionMessage(id="answer-q1", role="user", content="minha resposta", created_at="t"))
    service.save(current)
    await service.run(session.id)
    second = engine.calls[1]
    assert second.prompt.startswith("user: minha resposta")
    assert [m.content for m in second.history] == ["resposta 1"]

    (dir1, token1), (dir2, token2) = engine.runtime
    assert token1 == token2 and dir1 == dir2 and dir1.endswith(f".harness/runtime/{session.id}")
    assert state.bound_session(token1) == session.id  # re-bound to the latest execution

    current = service.get(session.id)
    current.execution_id = "superseded"
    service.save(current)
    with pytest.raises(PermissionError, match="stale"):
        state.bound_session(token1)

    current.phase = "completed"
    service.save(current)
    await service.run(session.id)
    assert closed == [session.id]
    assert token1 not in state.tokens


async def test_non_persistent_engine_keeps_full_history_prompt(tmp_path, closed):
    engine = PersistentEngine()
    engine.session_persistent = False
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    session = await state.sessions.create(topic="Atenção", start=False)
    await state.sessions.run(session.id)
    await state.sessions.run(session.id)
    assert "PERSISTED HISTORY:\nassistant: resposta 1" in engine.calls[1].prompt
    assert engine.calls[1].system is None
    (dir1, _), (dir2, _) = engine.runtime
    assert dir1 != dir2  # per-execution runtime dir, as before
    assert closed == []


class MidTurnEngine(PersistentEngine):
    """First turn: the learner answers a blocking question mid-turn (handed over via the tool)."""

    def __init__(self, service):
        super().__init__()
        self.service = service

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None):
        self.calls.append(SimpleNamespace(prompt=prompt, history=list(history or []), system=system_instruction, tools=tools))
        yield "explicação"
        if len(self.calls) == 1:
            session = self.service.get(session_id)
            session.messages.append(SessionMessage(id="answer-q1", role="user", content="RESPOSTA-JA-VISTA",
                                                   created_at="2026-10-27T00:00:00+00:00"))
            self.service.save(session)
        yield " continua"


async def test_content_seen_mid_turn_is_not_resent_next_turn(tmp_path, closed):
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    engine = MidTurnEngine(state.sessions)
    session = await state.sessions.create(topic="Atenção", start=False)
    await state.sessions.run(session.id)
    current = state.sessions.get(session.id)
    current.messages.append(SessionMessage(id="msg-new", role="user", content="PERGUNTA-NOVA",
                                           created_at="2026-10-27T00:00:01+00:00"))
    state.sessions.save(current)
    await state.sessions.run(session.id)
    second = engine.calls[1].prompt
    assert "PERGUNTA-NOVA" in second and "RESPOSTA-JA-VISTA" not in second


async def test_handoff_turn_keeps_learner_input_that_arrived_meanwhile(tmp_path, closed):
    engine = PersistentEngine()
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    session = await state.sessions.create(topic="Atenção", start=False)
    await state.sessions.run(session.id)
    current = state.sessions.get(session.id)
    current.phase, current.handoff_pending = "planning", True
    state.sessions.save(current)
    await state.sessions.deliver_steer(session.id, "learner", "quero focar em implementação")
    await asyncio.sleep(0)
    for _ in range(200):
        if not state.sessions.is_running(session.id):
            break
        await asyncio.sleep(0.01)
    handoff_prompt = engine.calls[1].prompt
    assert "quero focar em implementação" in handoff_prompt
    await state.close()
