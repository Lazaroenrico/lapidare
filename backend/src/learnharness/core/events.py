"""Server-Sent Events (SSE) contracts and wire formatting for LearnHarness.

Pure Pydantic models with ZERO I/O.
Product Invariant: Single SSE channel (EventSource("/api/events")) with notify -> fetch pattern.
"""

import json
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class SseEventType(StrEnum):
    """Event types pushed over the single /api/events SSE channel."""
    SESSION_UPDATED = "session:updated"
    DOCK_OPENED = "dock:opened"
    DOCK_RESOLVED = "dock:resolved"
    PLAN_UPDATED = "plan:updated"
    VAULT_CHANGED = "vault:changed"
    GRAPH_UPDATED = "graph:updated"
    JOBS_UPDATED = "jobs:updated"


class BackgroundJobStatus(BaseModel):
    """Status frame for background LangGraph agents (extraction, practice generation, demo builder)."""
    job_id: str
    kind: Literal["extraction", "practice_gen", "demo_builder"]
    status: Literal["running", "completed", "failed"]
    label: str
    session_id: str | None = None
    updated_at: str = ""


class SseFrame(BaseModel):
    """Server-Sent Event frame formatted for the wire according to SSE specification."""
    event: SseEventType
    data: dict[str, Any]
    timestamp: str = Field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )

    def to_wire(self) -> str:
        """Serialize into SSE wire protocol format: event: <event>\ndata: <json>\n\n."""
        payload = json.dumps(self.data, ensure_ascii=False)
        return f"event: {self.event.value}\ndata: {payload}\n\n"
