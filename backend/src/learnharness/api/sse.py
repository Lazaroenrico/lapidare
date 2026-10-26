"""Server-Sent Events (SSE) Hub and streaming handler.

Maintains connected subscribers, handles broadcast multiplexing,
and serves GET /api/events following the notify -> fetch pattern.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from learnharness.core.events import SseEventType, SseFrame

logger = logging.getLogger(__name__)

sse_router = APIRouter(tags=["sse"])


class SseHub:
    """Manages active SSE subscriber queues and dispatches broadcast frames."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[SseFrame]] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue[SseFrame]:
        """Register a new client subscriber queue."""
        queue: asyncio.Queue[SseFrame] = asyncio.Queue(maxsize=128)
        async with self._lock:
            self._subscribers.add(queue)
        logger.debug("SSE client connected. Active subscribers: %d", len(self._subscribers))
        return queue

    async def unsubscribe(self, queue: asyncio.Queue[SseFrame]) -> None:
        """Remove a client subscriber queue upon disconnect."""
        async with self._lock:
            self._subscribers.discard(queue)
        logger.debug("SSE client disconnected. Active subscribers: %d", len(self._subscribers))

    def broadcast(self, event: SseEventType | str, data: dict[str, Any] | None = None) -> None:
        """Enqueue an event frame to all active client queues without blocking."""
        if isinstance(event, str):
            try:
                event_type = SseEventType(event)
            except ValueError:
                event_type = SseEventType.SESSION_UPDATED
        else:
            event_type = event

        frame = SseFrame(event=event_type, data=data or {})
        dead_subscribers: list[asyncio.Queue[SseFrame]] = []

        for queue in list(self._subscribers):
            try:
                queue.put_nowait(frame)
            except asyncio.QueueFull:
                logger.warning("Subscriber queue is full. Evicting slowest subscriber.")
                dead_subscribers.append(queue)

        for dead in dead_subscribers:
            self._subscribers.discard(dead)

    async def event_generator(
        self, request: Request, queue: asyncio.Queue[SseFrame], heartbeat_interval: float = 15.0
    ) -> AsyncIterator[str]:
        """Yield formatted SSE wire frames with periodic comments to keep connection alive."""
        # Initial greeting frame confirming active stream
        yield ": connected\n\n"

        try:
            while True:
                if await request.is_disconnected():
                    break

                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=heartbeat_interval)
                    yield frame.to_wire()
                except TimeoutError:
                    # Heartbeat comment keeps browser connection open without triggering fetch
                    yield ": heartbeat\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            await self.unsubscribe(queue)


default_sse_hub = SseHub()


@sse_router.get("/api/events")
async def sse_events(request: Request) -> StreamingResponse:
    """Single persistent Server-Sent Events stream for the client."""
    from learnharness.api.state import get_app_state

    state = get_app_state(request.app)
    hub = state.sse_hub
    queue = await hub.subscribe()

    return StreamingResponse(
        hub.event_generator(request, queue),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
