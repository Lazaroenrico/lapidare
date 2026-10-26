"""Settings routes for prompt overrides."""

from __future__ import annotations

from learnharness.prompts.loader import build_system_prompt, load_overrides

BASE = "/api/settings/prompts"


def test_list_prompts(api_client):
    response = api_client.get(BASE)
    assert response.status_code == 200
    entries = {e["path"]: e for e in response.json()}
    assert "shared/20-voice.md" in entries and "handoff.md" in entries
    voice = entries["shared/20-voice.md"]
    assert voice["source"].strip() and voice["override"] is None and voice["enabled"] is False


def test_put_toggle_and_delete_override(api_client, app_state, configured_vault):
    path = "shared/20-voice.md"
    put = api_client.put(f"{BASE}/{path}", json={"text": "CUSTOM VOICE", "enabled": True})
    assert put.status_code == 200, put.text
    assert put.json()["override"] == "CUSTOM VOICE" and put.json()["enabled"] is True
    assert (configured_vault / ".harness/prompts" / path).read_text() == "CUSTOM VOICE"

    active = load_overrides(configured_vault, app_state.get_config())
    assert active == {path: "CUSTOM VOICE"}
    assert "CUSTOM VOICE" in build_system_prompt("TEACH", "free_topic", overrides=active)

    off = api_client.put(f"{BASE}/{path}", json={"text": "CUSTOM VOICE", "enabled": False})
    assert off.json()["enabled"] is False
    assert load_overrides(configured_vault, app_state.get_config()) == {}

    listed = {e["path"]: e for e in api_client.get(BASE).json()}
    assert listed[path]["override"] == "CUSTOM VOICE" and listed[path]["enabled"] is False

    deleted = api_client.delete(f"{BASE}/{path}")
    assert deleted.status_code == 200
    assert deleted.json()["override"] is None and deleted.json()["enabled"] is False
    assert not (configured_vault / ".harness/prompts" / path).exists()


def test_unknown_and_traversal_paths_are_rejected(api_client, configured_vault):
    for bad in ("shared/99-nope.md", "..%2F..%2Fconfig.json", "shared/..%2F..%2Fconfig.json",
                "%2E%2E/%2E%2E/escape.md", "config.json"):
        response = api_client.put(f"{BASE}/{bad}", json={"text": "x", "enabled": True})
        assert response.status_code in (404, 422), (bad, response.status_code)
        assert api_client.delete(f"{BASE}/{bad}").status_code in (404, 405, 422)
    assert not (configured_vault / "escape.md").exists()
    assert not (configured_vault / ".harness/prompts").exists()
