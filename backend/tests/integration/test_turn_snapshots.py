"""Characterization of one agent turn: exactly what reaches the engine, and what is saved.

Each scenario drives ``SessionService.run`` against a recording engine and compares the
prompt, system instruction, history, offered tools and the settled session with a
reference file in ``tests/golden/turns/``. Volatile values (ids, timestamps, paths) are
normalized. After an intended prompt change, refresh the references with
``LEARNHARNESS_UPDATE_GOLDEN=1 uv run pytest tests/integration/test_turn_snapshots.py``
and review the diff.
"""

from __future__ import annotations

import os
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest

from learnharness.api.state import AppState
from learnharness.core.contracts.config import TrackConfig, TrackItem
from learnharness.core.contracts.session import SessionCompaction, SessionMessage
from learnharness.services.sessions import SessionService
from learnharness.vault.bootstrap import save_config
from learnharness.vault.transcript_importer import import_transcript_text
from tests.conftest import configure_vault

GOLDEN = Path(__file__).parent.parent / "golden" / "turns"
UPDATE = os.environ.get("LEARNHARNESS_UPDATE_GOLDEN") == "1"


class RecordingEngine:
    """Records every ``stream_turn`` and answers with one fixed sentence."""

    def __init__(self, persistent: bool) -> None:
        self.session_persistent = persistent
        self.tool_transport = "mcp" if persistent else "inline"
        self.calls: list[dict[str, Any]] = []

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        pass

    async def stream_turn(self, prompt, session_id, **kwargs):
        # Which keywords arrive is part of the contract: one-shot engines get no history
        # or system instruction (``AgentEnginePort.stream_turn``).
        self.calls.append({"prompt": prompt, "system": kwargs.get("system_instruction"),
                           "history": [f"{m.role}: {m.content}" for m in kwargs.get("history") or []],
                           "tools": sorted(t.__name__ for t in kwargs.get("tools") or []),
                           "kwargs": sorted(kwargs)})
        yield "Resposta do professor."


def _normalize(text: str, vault: Path) -> str:
    text = text.replace(str(vault), "<VAULT>")
    text = re.sub(r"\b(sess|msg|quiz|job|trk)-[0-9a-f]{8,32}\b", r"\1-<ID>", text)
    text = re.sub(r"\b[0-9a-f]{32}\b", "<HEX>", text)
    text = re.sub(r"\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)?", "<TIME>", text)
    return re.sub(r"\d{4}-\d{2}-\d{2}", "<DATE>", text)


def _render(engine: RecordingEngine, service: SessionService, session_id: str) -> str:
    session = service.get(session_id)
    parts = []
    for index, call in enumerate(engine.calls, start=1):
        parts += [f"===== TURN {index} =====", f"--- kwargs: {', '.join(call['kwargs'])}",
                  f"--- tools: {', '.join(call['tools']) or '(mcp)'}",
                  "--- history:", *call["history"], "--- system:", call["system"] or "(none)",
                  "--- prompt:", call["prompt"]]
    parts += ["===== SAVED =====", f"phase={session.phase} status={session.execution_status} "
              f"prompt_phase={session.prompt_phase} handoff_pending={session.handoff_pending} "
              f"model_cursor_is_last={session.model_cursor == (session.messages[-1].id if session.messages else None)}",
              *[f"{m.role}: {m.content} (delivered={m.delivered})" for m in session.messages]]
    return "\n".join(parts) + "\n"


def _message(i: int, role: str, content: str, **extra: Any) -> SessionMessage:
    return SessionMessage(id=f"m{i}", role=role, content=content, created_at="2026-10-27T10:00:00Z", **extra)


async def _with_history(service: SessionService, session_id: str, **fields: Any) -> None:
    session = service.get(session_id)
    session.messages = [_message(1, "assistant", "Qual sua experiência com vetores?"),
                        _message(2, "user", "Sei somar e multiplicar por escalar.")]
    for key, value in fields.items():
        setattr(session, key, value)
    service.save(session)


def _add_track(vault: Path, state: AppState) -> TrackConfig:
    config = state.get_config()
    track = TrackConfig(id="trk-a1b2c3d4", title="Álgebra Linear", queue=[
        TrackItem(id="t1", title="Vetores"), TrackItem(id="t2", title="Produto escalar", prerequisites=["t1"])],
        active_item_id="t1")
    config.tracks, config.active_track_id = [track], track.id
    save_config(vault, config)
    return track


Scenario = Callable[[AppState, Path], Awaitable[str]]


async def opening(state: AppState, vault: Path) -> str:
    return (await state.sessions.create(topic="Atenção em transformers", start=False)).id


async def second_turn(state: AppState, vault: Path) -> str:
    session_id = await opening(state, vault)
    await _with_history(state.sessions, session_id)
    return session_id


async def steers(state: AppState, vault: Path) -> str:
    session_id = await second_turn(state, vault)
    session = state.sessions.get(session_id)
    session.messages.append(_message(3, "user", "Pode ir mais devagar?", steer_kind="learner", delivered=False))
    state.sessions.save(session)
    return session_id


async def handoff(state: AppState, vault: Path) -> str:
    session_id = await opening(state, vault)
    await _with_history(state.sessions, session_id, phase="planning", handoff_pending=True)
    return session_id


async def phase_change(state: AppState, vault: Path) -> str:
    session_id = await opening(state, vault)
    await _with_history(state.sessions, session_id, phase="planning", prompt_phase="prober", model_cursor="m1")
    return session_id


async def compacted(state: AppState, vault: Path) -> str:
    session_id = await opening(state, vault)
    session = state.sessions.get(session_id)
    session.messages = [_message(i, "assistant" if i % 2 else "user", f"mensagem {i}") for i in range(1, 7)]
    session.compaction = SessionCompaction(summary="O aluno domina soma de vetores.", first_kept_message_id="m5")
    state.sessions.save(session)
    return session_id


async def practice(state: AppState, vault: Path) -> str:
    return (await state.sessions.create(mode="PRACTICE", topic="Produto escalar", start=False)).id


async def dense_source(state: AppState, vault: Path) -> str:
    path, _ = import_transcript_text(vault, "Atenção pondera valores.\n\nSoftmax normaliza escores.",
                                     "Aula de atenção")
    rel = path.relative_to(vault).as_posix()
    return (await state.sessions.create(topic="Aula de atenção", source_file=rel, start=False)).id


async def track_step(state: AppState, vault: Path) -> str:
    _add_track(vault, state)
    return (await state.sessions.create(track_item_id="t1", start=False)).id


async def leveling(state: AppState, vault: Path) -> str:
    track = _add_track(vault, state)
    return (await state.sessions.create(topic="Nivelamento", context_kind="leveling", track_id=track.id,
                                        start=False)).id


SCENARIOS: dict[str, Scenario] = {
    "opening": opening, "second_turn": second_turn, "steers": steers, "handoff": handoff,
    "phase_change": phase_change, "compacted": compacted, "practice": practice,
    "dense_source": dense_source, "track_step": track_step, "leveling": leveling,
}


@pytest.mark.parametrize("persistent", [False, True], ids=["oneshot", "persistent"])
@pytest.mark.parametrize("name", sorted(SCENARIOS))
async def test_turn_matches_reference(tmp_path: Path, name: str, persistent: bool) -> None:
    vault = configure_vault(tmp_path / "Vault")
    engine = RecordingEngine(persistent)
    state = AppState(vault_path=vault, engine_factory=lambda slot: engine)
    session_id = await SCENARIOS[name](state, vault)
    await state.sessions.run(session_id)
    actual = _normalize(_render(engine, state.sessions, session_id), vault)
    reference = GOLDEN / f"{name}-{'persistent' if persistent else 'oneshot'}.txt"
    if UPDATE or not reference.exists():
        reference.parent.mkdir(parents=True, exist_ok=True)
        reference.write_text(actual, encoding="utf-8")
    assert actual == reference.read_text(encoding="utf-8")
