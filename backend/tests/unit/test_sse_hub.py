"""SseHub: a subscriber evicted for falling behind gets its stream closed (and reconnects)."""

import asyncio

from learnharness.api.sse import SseHub
from learnharness.core.events import SseEventType


class _Request:
    async def is_disconnected(self) -> bool:
        return False


async def test_evicted_subscriber_stream_ends():
    hub = SseHub()
    queue = await hub.subscribe()
    for _ in range(queue.maxsize + 1):  # One more than fits: the slow client is evicted.
        hub.broadcast(SseEventType.SESSION_UPDATED, {"session_id": "s"})
    frames = []
    async with asyncio.timeout(2):
        async for frame in hub.event_generator(_Request(), queue, heartbeat_interval=0.05):
            frames.append(frame)
    assert frames == [": connected\n\n"]


async def test_live_subscriber_keeps_receiving():
    hub = SseHub()
    queue = await hub.subscribe()
    hub.broadcast(SseEventType.GRAPH_UPDATED, {})
    stream = hub.event_generator(_Request(), queue, heartbeat_interval=0.05)
    assert await anext(stream) == ": connected\n\n"
    assert "graph:updated" in await anext(stream)
    assert await anext(stream) == ": heartbeat\n\n"
    await stream.aclose()
