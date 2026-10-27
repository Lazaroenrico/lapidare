"""Steers: input that arrives outside the turn cycle reaches the model at the next turn."""

import asyncio
from types import SimpleNamespace

from learnharness.api.state import AppState
from tests.conftest import configure_vault


class GatedEngine:
    """Persistent engine whose first turn blocks until ``release`` is set."""

    tool_transport = "mcp"
    session_persistent = True

    def __init__(self):
        self.calls = []
        self.release = asyncio.Event()
        self.started = asyncio.Event()

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        pass

    async def stream_turn(self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None):
        self.calls.append(SimpleNamespace(prompt=prompt))
        if len(self.calls) == 1:
            self.started.set()
            await self.release.wait()
        yield f"resposta {len(self.calls)}"


async def _settle(service, session_id):
    for _ in range(200):
        if not service.is_running(session_id):
            return
        await asyncio.sleep(0.01)
    raise AssertionError("session never settled")


async def test_learner_steer_mid_turn_runs_a_follow_up_turn(tmp_path):
    engine = GatedEngine()
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    try:
        session = await state.sessions.create(topic="Atenção", start=False)
        state.sessions.schedule(session.id)
        await engine.started.wait()
        await state.sessions.deliver_steer(session.id, "learner", "espera, explica o softmax antes")
        engine.release.set()
        await _settle(state.sessions, session.id)
        assert len(engine.calls) == 2
        assert "espera, explica o softmax antes" in engine.calls[1].prompt
        assert all(m.delivered for m in state.sessions.get(session.id).messages)
    finally:
        await state.close()


async def test_job_steer_wakes_an_idle_session(tmp_path):
    engine = GatedEngine()
    engine.release.set()
    state = AppState(vault_path=configure_vault(tmp_path / "Vault"), engine_factory=lambda slot: engine)
    try:
        session = await state.sessions.create(topic="Atenção", start=False)
        await state.sessions.run(session.id)
        message = await state.sessions.deliver_steer(
            session.id, "job", "Research complete: cite the sources.", {"job_id": "job-1", "kind": "research"})
        await _settle(state.sessions, session.id)
        assert len(engine.calls) == 2 and "Research complete" in engine.calls[1].prompt
        stored = next(m for m in state.sessions.get(session.id).messages if m.id == message.id)
        assert stored.steer_kind == "job" and stored.details["kind"] == "research" and stored.delivered
    finally:
        await state.close()
