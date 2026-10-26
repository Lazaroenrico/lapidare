"""Lesson simulators persisted under viz/demos/ and announced over SSE."""
from __future__ import annotations

from typing import Any

from learnharness.core.events import SseEventType
from learnharness.mcp.demo_builder import save_demo_to_vault


async def create_demo(state, title: str, topic: str, description: str = "", lesson_rel_path: str | None = None) -> dict[str, Any]:
    result = save_demo_to_vault(
        vault_path=state.vault_path,
        title=title,
        topic=topic,
        description=description,
        lesson_rel_path=lesson_rel_path,
    )
    state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"demo": result["slug"]})
    return result
