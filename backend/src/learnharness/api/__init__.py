"""LearnHarness FastAPI backend package.

Exposes the REST API, Server-Sent Events (SSE) hub, and bidirectional
Obsidian Vault synchronization.
"""

from learnharness.api.app import create_app
from learnharness.api.sse import SseHub
from learnharness.api.state import AppState, get_app_state

__all__ = [
    "AppState",
    "SseHub",
    "create_app",
    "get_app_state",
]
