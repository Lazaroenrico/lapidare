"""Shared test doubles and fixtures.

``FakeEngine`` is a scripted, in-process stand-in for a provider engine. It never
fabricates output: every streamed turn and every structured response must be
programmed by the test, and anything unprogrammed raises, mirroring the product
policy of no silent fallbacks.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel
from starlette.testclient import TestClient

from learnharness.api.app import create_app
from learnharness.api.state import AppState
from learnharness.vault.bootstrap import bootstrap_vault, save_config
from learnharness.vault.safety import safe_path


@pytest.fixture(autouse=True)
def _no_system_chromium(monkeypatch):
    """Artifact jobs skip the headless-browser checks unless a test opts in (Fase 17)."""
    monkeypatch.setenv("LEARNHARNESS_CHROMIUM", "off")


@dataclass
class ToolCall:
    """A scripted step: await the inline tool ``name`` with ``kwargs``."""

    name: str
    kwargs: dict[str, Any] = field(default_factory=dict)


def tool(name: str, **kwargs: Any) -> ToolCall:
    return ToolCall(name=name, kwargs=kwargs)


class FakeEngine:
    """Scripted engine honoring the AgentEnginePort shape used by the services.

    * ``script_turn(*steps)`` queues one ``stream_turn`` call. A step is either a
      ``str`` (yielded as a text delta), a ``ToolCall`` (the named tool from
      ``tools`` is awaited; its result is recorded in ``tool_results``) or an
      exception instance (raised, simulating a provider failure).
    * ``program(schema, response)`` sets what ``run_structured`` returns for that
      schema class. ``response`` may be a model instance, a dict, a list of those
      (consumed in order), a callable ``(prompt) -> response`` or an exception.
    """

    tool_transport = "inline"

    def __init__(self) -> None:
        self.turns: list[list[Any]] = []
        self.structured: dict[type, Any] = {}
        self.stream_calls: list[dict[str, Any]] = []
        self.structured_calls: list[dict[str, Any]] = []
        self.tool_results: list[tuple[str, Any]] = []

    def script_turn(self, *steps: Any) -> FakeEngine:
        self.turns.append(list(steps))
        return self

    def program(self, schema: type, response: Any) -> FakeEngine:
        self.structured[schema] = response
        return self

    async def stream_turn(
        self, prompt: str, session_id: str, history: Any = None, slot: Any = None,
        tools: list[Callable[..., Any]] | None = None, system_instruction: str | None = None,
    ) -> AsyncIterator[str]:
        self.stream_calls.append({"prompt": prompt, "session_id": session_id, "slot": slot,
                                  "tools": [t.__name__ for t in tools or []]})
        steps = self.turns.pop(0) if self.turns else []
        available = {t.__name__: t for t in tools or []}
        for step in steps:
            if isinstance(step, str):
                yield step
            elif isinstance(step, ToolCall):
                if step.name not in available:
                    raise LookupError(f"Tool {step.name!r} was not offered to the engine")
                result = await available[step.name](**step.kwargs)
                self.tool_results.append((step.name, result))
            elif isinstance(step, BaseException):
                raise step
            else:
                raise TypeError(f"Unsupported scripted step: {step!r}")

    async def run_structured(
        self, prompt: str, schema: type[BaseModel], slot: Any = None, system_instruction: str | None = None,
    ) -> BaseModel:
        self.structured_calls.append({"prompt": prompt, "schema": schema, "slot": slot,
                                      "system_instruction": system_instruction})
        if schema not in self.structured:
            raise LookupError(f"FakeEngine has no programmed response for {schema.__name__}")
        response = self.structured[schema]
        if isinstance(response, list):
            if not response:
                raise LookupError(f"FakeEngine exhausted responses for {schema.__name__}")
            response = response.pop(0)
        if isinstance(response, BaseException):
            raise response
        if callable(response) and not isinstance(response, BaseModel):
            response = response(prompt)
        if isinstance(response, BaseModel):
            response = response.model_dump()
        return schema.model_validate(response)


def configure_vault(vault: Path, language: str = "pt-BR") -> Path:
    """Bootstrap a Vault and mark setup as complete, like ``POST /api/setup/complete``."""
    vault.mkdir(parents=True, exist_ok=True)
    config = bootstrap_vault(vault, language=language)
    config.language = language
    config.vault_path = str(vault.resolve())
    config.configured = True
    save_config(vault, config)
    folders = config.folders
    for name in (folders.lessons_dir, folders.concepts_dir, folders.sources_dir,
                 folders.drawings_dir, folders.viz_dir, folders.templates_dir):
        safe_path(vault, name).mkdir(parents=True, exist_ok=True)
    return vault


async def wait_until(predicate: Callable[[], Any], timeout: float = 3.0, interval: float = 0.01) -> Any:
    """Await a truthy predicate result within a bounded time (tests only)."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("Condition not met before timeout")
        await asyncio.sleep(interval)


def poll_until(fetch: Callable[[], Any], predicate: Callable[[Any], bool], timeout: float = 3.0,
               interval: float = 0.02) -> Any:
    """Synchronous bounded polling for TestClient-driven tests."""
    deadline = time.monotonic() + timeout
    value = fetch()
    while not predicate(value):
        if time.monotonic() >= deadline:
            raise AssertionError(f"Condition not met before timeout; last value: {value!r}")
        time.sleep(interval)
        value = fetch()
    return value


@pytest.fixture
def fake_engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def configured_vault(tmp_path: Path) -> Path:
    return configure_vault(tmp_path / "TestVault")


@pytest.fixture
def app_state(configured_vault: Path, fake_engine: FakeEngine) -> AppState:
    return AppState(vault_path=configured_vault, engine_factory=lambda slot: fake_engine)


@pytest.fixture
def api_client(app_state: AppState) -> Iterator[TestClient]:
    """TestClient with lifespan running, so background session tasks keep executing."""
    with TestClient(create_app(state=app_state)) as client:
        yield client
