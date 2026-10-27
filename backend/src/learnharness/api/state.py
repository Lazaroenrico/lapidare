"""Application-scoped runtime, lifecycle and adapter injection."""
from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from learnharness.api.sse import SseHub
from learnharness.core.contracts.config import HarnessConfig
from learnharness.mcp.content_client import ContentMcpClient
from learnharness.mcp.pending_dock import PendingDockRegistry
from learnharness.vault.bootstrap import load_config
from learnharness.vault.watcher import VaultWatcher, affects_graph


def selected_vault_path():
    explicit = os.environ.get("LEARNHARNESS_VAULT_PATH")
    if explicit:
        return Path(explicit).expanduser().resolve()
    registry = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "learnharness" / "active-vault"
    if registry.is_file():
        return Path(registry.read_text(encoding="utf-8").strip()).expanduser().resolve()
    return (Path.home() / "Documents" / "StudyVault").resolve()


class AppState:
    def __init__(self, vault_path=None, sse_hub=None, dock_registry=None, engine_factory=None):
        self.explicit_vault = vault_path is not None or bool(os.environ.get("LEARNHARNESS_VAULT_PATH"))
        self.vault_path = Path(vault_path).expanduser().resolve() if vault_path else selected_vault_path()
        self.sse_hub = sse_hub or SseHub()
        self.dock_registry = dock_registry or PendingDockRegistry()
        self.active_jobs: dict[str, dict[str, Any]] = {}
        self.tokens: dict[str, tuple[str, str]] = {}
        self.api_key: str | None = None
        self.engine_factory = engine_factory
        port = os.environ.get("LEARNHARNESS_PORT", "8000")
        self.mcp_url = os.environ.get("LEARNHARNESS_MCP_URL", f"http://127.0.0.1:{port}/internal/mcp/")
        self.watcher = None
        self.started = False
        self.refresh_content_mcp_client()
        from learnharness.services.graph import GraphService
        from learnharness.services.jobs import JobManager
        from learnharness.services.leveling import LevelingService
        from learnharness.services.practice import PracticeService
        from learnharness.services.sessions import SessionService
        from learnharness.services.tracks import TrackService
        from learnharness.services.usage import UsageService
        self.sessions = SessionService(self)
        self.usage = UsageService(self)
        self.jobs = JobManager(self)
        self.tracks = TrackService(self)
        self.graph = GraphService(self)
        self.practice = PracticeService(self)
        self.leveling = LevelingService(self)

    def refresh_content_mcp_client(self):
        servers = self.get_config().content_mcps
        self.content_mcp_client = ContentMcpClient(servers=servers, vault_path=self.vault_path)
        return self.content_mcp_client

    def get_config(self):
        if not (self.vault_path / ".harness/config.json").is_file():
            return HarnessConfig(configured=False, vault_path=str(self.vault_path))
        return load_config(self.vault_path)

    def engine(self, slot):
        if self.engine_factory:
            return self.engine_factory(slot)
        from learnharness.engines import get_engine
        # CLI idle timeouts pause while the learner is answering a QuestionDock.
        return get_engine(
            slot,
            runtime_config={"api_key": self.api_key},
            is_waiting_on_learner=lambda sid: self.dock_registry.get_pending_quiz(sid) is not None,
        )

    def redact(self, text):
        for secret in (self.api_key, os.environ.get("GEMINI_API_KEY"), *self.tokens):
            if secret:
                text = text.replace(secret, "[redacted]")
        return text[:2000]

    def issue_token(self, session_id, execution_id):
        token = secrets.token_urlsafe(32)
        self.tokens[token] = (session_id, execution_id)
        return token

    def session_token(self, session_id, execution_id):
        """The session's single MCP token, re-bound to ``execution_id``.

        The token lives as long as the session (persistent CLI processes keep it in their
        MCP config, so re-minting would force a respawn/re-bind every turn), but it only
        authorizes the *current* execution: ``bound_session`` still rejects it as stale
        once ``session.execution_id`` moves on without a re-bind.
        """
        for token, (bound, _) in self.tokens.items():
            if bound == session_id:
                self.tokens[token] = (session_id, execution_id)
                return token
        return self.issue_token(session_id, execution_id)

    def revoke_session_tokens(self, session_id):
        for token in [t for t, (bound, _) in self.tokens.items() if bound == session_id]:
            del self.tokens[token]

    def bound_session(self, token):
        binding = self.tokens.get(token)
        if not binding:
            raise PermissionError("Invalid or expired execution token")
        session = self.sessions.get(binding[0])
        if session.execution_id != binding[1]:
            raise PermissionError("Execution token is stale")
        return binding[0]

    def tool_functions(self, session_id):
        from learnharness.mcp.runtime_server import session_tools
        return session_tools(self, session_id)

    async def start(self):
        if self.started:
            return
        self.started = True
        if self.get_config().configured:
            self.jobs.recover()
            await self.sessions.recover()
            await self.start_watcher()

    async def start_watcher(self):
        if self.watcher:
            await self.watcher.stop()
        from learnharness.core.events import SseEventType
        async def changed(paths):
            self.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"paths": [str(Path(p).relative_to(self.vault_path)) for p in paths]})
            if affects_graph(paths):
                self.sse_hub.broadcast(SseEventType.GRAPH_UPDATED, {})
        self.watcher = VaultWatcher(self.vault_path, changed)
        await self.watcher.start()

    async def close(self):
        from learnharness.engines import close_engine_processes
        await self.sessions.close()
        await self.jobs.close()
        await close_engine_processes()
        if self.watcher:
            await self.watcher.stop()
        self.tokens.clear()
        self.api_key = None
        self.started = False

    async def switch_vault(self, path, api_key=None):
        await self.close()
        self.vault_path = Path(path).expanduser().resolve()
        self.api_key = api_key
        self.active_jobs.clear()
        self.refresh_content_mcp_client()
        await self.start()


def get_app_state(app: FastAPI | None = None):
    if app is None or not hasattr(app.state, "learnharness_state"):
        raise RuntimeError("Application state must be explicitly initialized")
    return app.state.learnharness_state
