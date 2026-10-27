"""FastAPI application factory, lifecycle and middleware configuration."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from learnharness.api.routes.chats import chats_router
from learnharness.api.routes.drawings import drawings_router
from learnharness.api.routes.graph import graph_router
from learnharness.api.routes.import_content import import_router
from learnharness.api.routes.import_github import import_github_router
from learnharness.api.routes.jobs import jobs_router
from learnharness.api.routes.prompts import prompts_router
from learnharness.api.routes.setup import setup_router
from learnharness.api.routes.usage import usage_router
from learnharness.api.sse import sse_router
from learnharness.api.state import AppState
from learnharness.engines.cli_protocol import EngineError
from learnharness.mcp.runtime_server import create_runtime_mcp
from learnharness.services.sessions import SessionConflict

MCP_MOUNT = "/internal/mcp"
DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"
# "testserver" is Starlette's TestClient host; it never resolves on a real network.
DEFAULT_ALLOWED_HOSTS = "localhost,127.0.0.1,::1,testserver"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _csv_env(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


class LocalRequestGuard:
    """Block DNS rebinding and cross-site writes against this local, disk-writing API.

    Some routes can register stdio MCP servers (i.e. run local commands) or write to the
    Vault, so a hostile web page must not reach them: the Host must be loopback, and a
    state-changing request carrying an Origin must come from the configured frontend.
    """

    def __init__(self, app: ASGIApp, allowed_hosts: list[str], allowed_origins: list[str]) -> None:
        self.app = app
        self.allowed_hosts = {h.lower() for h in allowed_hosts}
        self.allowed_origins = {o.rstrip("/").lower() for o in allowed_origins}

    @staticmethod
    def _hostname(host: str) -> str:
        host = host.strip().lower()
        if host.startswith("["):
            return host[1 : host.find("]")]
        return host.rsplit(":", 1)[0] if host.count(":") == 1 else host

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope.get("headers") or []}
            if self._hostname(headers.get("host", "")) not in self.allowed_hosts:
                await JSONResponse({"detail": "Host not allowed"}, status_code=421)(scope, receive, send)
                return
            origin = headers.get("origin")
            if (
                scope["method"] not in SAFE_METHODS
                and origin is not None
                and origin.rstrip("/").lower() not in self.allowed_origins
            ):
                await JSONResponse({"detail": "Origin not allowed"}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class ExecutionTokenGate:
    """Reject MCP traffic that does not carry a live per-execution Bearer token.

    Tool handlers re-validate the binding; this gate keeps unauthenticated callers
    from even listing the pedagogical tools.
    """

    def __init__(self, app: ASGIApp, state: AppState) -> None:
        self.app = app
        self.state = state

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = dict(scope.get("headers") or [])
            authorization = headers.get(b"authorization", b"").decode("latin-1")
            token = authorization[7:] if authorization.startswith("Bearer ") else ""
            if token not in self.state.tokens:
                response = JSONResponse({"detail": "Execution authentication required"}, status_code=401)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def _register_error_handlers(app: FastAPI, state: AppState) -> None:
    def handler(status_code: int, redact: bool = False):
        async def respond(request: Request, exc: Exception) -> JSONResponse:
            detail = state.redact(str(exc)) if redact else str(exc)
            return JSONResponse({"detail": detail}, status_code=status_code)

        return respond

    # Order matters only for documentation; Starlette resolves by MRO.
    app.add_exception_handler(SessionConflict, handler(409))
    app.add_exception_handler(EngineError, handler(502, redact=True))
    app.add_exception_handler(PermissionError, handler(403))
    app.add_exception_handler(FileNotFoundError, handler(404))
    app.add_exception_handler(ValueError, handler(422))


def create_app(vault_path: Path | None = None, state: AppState | None = None) -> FastAPI:
    """Create and configure FastAPI application instance.

    Allows overriding vault_path (or the whole AppState, e.g. with an injected engine
    factory) for isolated testing without ever touching the user's real Obsidian Vault.
    """
    state = state or AppState(vault_path=vault_path)
    mcp_app = create_runtime_mcp(state).http_app(path="/", stateless_http=True)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # The streamable-HTTP session manager only runs inside the MCP app's lifespan.
        async with mcp_app.lifespan(app):
            await state.start()
            try:
                yield
            finally:
                await state.close()

    app = FastAPI(
        title="LearnHarness API",
        version="0.1.0",
        description="Local-first AI Engineering Learning Harness",
        lifespan=lifespan,
    )
    app.state.learnharness_state = state

    # The browser talks through the Next.js /api proxy; CORS only matters for direct dev access.
    origins = _csv_env("LEARNHARNESS_CORS_ORIGINS", DEFAULT_CORS_ORIGINS)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # Added last so it runs first (outermost), before CORS and routing.
    app.add_middleware(
        LocalRequestGuard,
        allowed_hosts=_csv_env("LEARNHARNESS_ALLOWED_HOSTS", DEFAULT_ALLOWED_HOSTS),
        allowed_origins=origins,
    )
    _register_error_handlers(app, state)

    app.include_router(sse_router)
    app.include_router(setup_router)
    app.include_router(graph_router)
    app.include_router(chats_router)
    app.include_router(import_router)
    app.include_router(import_github_router)
    app.include_router(drawings_router)
    app.include_router(jobs_router)
    app.include_router(prompts_router)
    app.include_router(usage_router)
    app.mount(MCP_MOUNT, ExecutionTokenGate(mcp_app, state))

    return app


app = create_app()
