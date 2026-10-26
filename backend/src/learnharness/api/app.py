"""FastAPI application factory and middleware configuration."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from learnharness.api.routes.chats import chats_router
from learnharness.api.routes.drawings import drawings_router
from learnharness.api.routes.graph import graph_router
from learnharness.api.routes.import_content import import_router
from learnharness.api.routes.practice import practice_router
from learnharness.api.routes.setup import setup_router
from learnharness.api.sse import sse_router
from learnharness.api.state import AppState


def create_app(vault_path: Path | None = None) -> FastAPI:
    """Create and configure FastAPI application instance.

    Allows overriding vault_path for isolated unit and integration testing
    without ever touching the user's real Obsidian Vault.
    """
    app = FastAPI(
        title="LearnHarness API",
        version="0.1.0",
        description="Local-first AI Engineering Learning Harness",
    )

    # Attach AppState
    app.state.learnharness_state = AppState(vault_path=vault_path)

    # CORS configuration for Next.js frontend dev server
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Include routers
    app.include_router(sse_router)
    app.include_router(setup_router)
    app.include_router(graph_router)
    app.include_router(chats_router)
    app.include_router(import_router)
    app.include_router(drawings_router)
    app.include_router(practice_router)

    return app


app = create_app()
