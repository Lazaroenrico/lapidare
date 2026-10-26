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
from learnharness.api.routes.practice import practice_router
from learnharness.api.routes.setup import setup_router
from learnharness.api.sse import sse_router
from learnharness.api.state import AppState
from learnharness.engines.cli_protocol import EngineError
from learnharness.mcp.runtime_server import create_runtime_mcp
from learnharness.services.sessions import SessionConflict

MCP_MOUNT = "/internal/mcp"
DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"


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
    origins = [o.strip() for o in os.environ.get("LEARNHARNESS_CORS_ORIGINS", DEFAULT_CORS_ORIGINS).split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    _register_error_handlers(app, state)

    app.include_router(sse_router)
    app.include_router(setup_router)
    app.include_router(graph_router)
    app.include_router(chats_router)
    app.include_router(import_router)
    app.include_router(import_github_router)
    app.include_router(drawings_router)
    app.include_router(practice_router)
    app.mount(MCP_MOUNT, ExecutionTokenGate(mcp_app, state))

    return app


app = create_app()
