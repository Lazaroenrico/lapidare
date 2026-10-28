"""Settings → Agente routes (Fase 13)."""

from __future__ import annotations

import json

from learnharness.core.events import SseEventType

BASE = "/api/settings/agent"


def _capture(app_state):
    events: list[tuple[str, dict]] = []
    original = app_state.sse_hub.broadcast

    def record(event, data=None):
        events.append((str(SseEventType(event)), data or {}))
        original(event, data)

    app_state.sse_hub.broadcast = record
    return events


def test_get_returns_defaults(api_client):
    response = api_client.get(BASE)
    assert response.status_code == 200
    assert response.json() == {
        "tools": {"research": True, "pdf": True, "visual": True, "demo": True},
        "compaction_tokens": 150_000,
        "extraction_chunk_tokens": 4096,
        "extraction_enabled": True,
    }


def test_partial_put_persists_and_emits_config_updated(api_client, app_state, configured_vault):
    events = _capture(app_state)
    response = api_client.put(BASE, json={"tools": {"demo": False}, "compaction_tokens": 64_000})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tools"] == {"research": True, "pdf": True, "visual": True, "demo": False}
    assert body["compaction_tokens"] == 64_000 and body["extraction_chunk_tokens"] == 4096

    saved = json.loads((configured_vault / ".harness/config.json").read_text())
    assert saved["agent"]["tools"]["demo"] is False
    assert saved["agent"]["compaction_tokens"] == 64_000
    assert app_state.get_config().agent.tools.research is True
    assert ("config:updated", {"section": "agent"}) in events

    second = api_client.put(BASE, json={"extraction_chunk_tokens": 800})
    assert second.status_code == 200
    assert second.json()["extraction_chunk_tokens"] == 800
    assert second.json()["tools"]["demo"] is False
    assert app_state.get_config().graph.extraction_chunk_tokens == 800
    assert api_client.get(BASE).json() == second.json()


def test_validation_minimums_and_unknown_fields(api_client, app_state):
    events = _capture(app_state)
    for bad in (
        {"compaction_tokens": 31_999},
        {"extraction_chunk_tokens": 499},
        {"tools": {"teleport": True}},
        {"unknown": 1},
    ):
        response = api_client.put(BASE, json=bad)
        assert response.status_code == 422, (bad, response.status_code)
    assert events == []
    edge = api_client.put(BASE, json={"compaction_tokens": 32_000, "extraction_chunk_tokens": 500})
    assert edge.status_code == 200
    assert app_state.get_config().agent.compaction_tokens == 32_000
