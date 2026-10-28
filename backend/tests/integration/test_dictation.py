"""Dictation backend (Fase 22): settings, token minting and health. No network."""

from __future__ import annotations

import json

import httpx
import pytest

from learnharness.core.events import SseEventType
from learnharness.services import dictation
from learnharness.services.secrets import secrets_path

SECRET = "dg-super-secret-key-123"
BASE = "/api/settings/dictation"


@pytest.fixture(autouse=True)
def _isolated_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.delenv("LEARNHARNESS_APP_VERSION", raising=False)


def _deepgram(api_client, handler):
    api_client.app.state.dictation_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _ok(request: httpx.Request) -> httpx.Response:
    assert request.headers["authorization"] == f"Token {SECRET}"
    assert json.loads(request.content) == {"ttl_seconds": 60}
    return httpx.Response(200, json={"access_token": "tok-abc", "expires_in": 60})


def test_defaults_not_configured(api_client):
    assert api_client.get(BASE).json() == {"configured": False, "language": "multi"}


def test_put_key_and_language_never_leaks_key(api_client, app_state, configured_vault):
    events = []
    original = app_state.sse_hub.broadcast
    app_state.sse_hub.broadcast = lambda e, d=None: (events.append((str(SseEventType(e)), d)), original(e, d))
    response = api_client.put(BASE, json={"api_key": SECRET, "language": "pt-BR"})
    assert response.status_code == 200
    assert response.json() == {"configured": True, "language": "pt-BR"}
    assert (str(SseEventType.CONFIG_UPDATED), {"section": "dictation"}) in events
    assert api_client.get(BASE).json() == {"configured": True, "language": "pt-BR"}
    assert SECRET not in response.text
    assert SECRET not in (configured_vault / ".harness/config.json").read_text()
    assert dictation.get_key() == SECRET
    assert oct(secrets_path().stat().st_mode & 0o777) == "0o600"


def test_put_null_deletes_key_and_keeps_language(api_client):
    api_client.put(BASE, json={"api_key": SECRET, "language": "en"})
    response = api_client.put(BASE, json={"api_key": None})
    assert response.json() == {"configured": False, "language": "en"}
    assert dictation.get_key() is None


def test_partial_put_language_only_keeps_key(api_client):
    api_client.put(BASE, json={"api_key": SECRET})
    assert api_client.put(BASE, json={"language": "ja"}).json() == {"configured": True, "language": "ja"}


@pytest.mark.parametrize("body", [{"api_key": ""}, {"api_key": "   "}, {"language": "klingon"}, {"x": 1}])
def test_put_validation_is_422(api_client, body):
    assert api_client.put(BASE, json=body).status_code == 422


def test_token_happy_path(api_client):
    api_client.put(BASE, json={"api_key": SECRET})
    _deepgram(api_client, _ok)
    response = api_client.post("/api/dictation/token")
    assert response.status_code == 200
    assert response.json() == {"access_token": "tok-abc", "expires_in": 60}
    assert api_client.post("/api/dictation/test").json() == {"ok": True}


def test_token_without_key_is_409(api_client):
    for path in ("/api/dictation/token", "/api/dictation/test"):
        response = api_client.post(path)
        assert response.status_code == 409
        assert response.json() == {"detail": "ditado não configurado"}


@pytest.mark.parametrize(("upstream", "expected"), [(401, 401), (403, 403), (500, 502), (429, 502)])
def test_error_mapping_and_no_key_in_response(api_client, upstream, expected):
    api_client.put(BASE, json={"api_key": SECRET})
    _deepgram(api_client, lambda r: httpx.Response(upstream, text=f"echo {SECRET}"))
    for path in ("/api/dictation/token", "/api/dictation/test"):
        response = api_client.post(path)
        assert response.status_code == expected
        assert SECRET not in response.text
        assert isinstance(response.json()["detail"], str)


def test_network_failure_is_502(api_client):
    api_client.put(BASE, json={"api_key": SECRET})

    def boom(request):
        raise httpx.ConnectError(f"cannot reach {SECRET}")

    _deepgram(api_client, boom)
    response = api_client.post("/api/dictation/token")
    assert response.status_code == 502
    assert SECRET not in response.text


async def test_mint_token_maps_exceptions():
    def client(status):
        return httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(status)))

    with pytest.raises(dictation.DictationKeyInvalid):
        await dictation.mint_token("k", client(401))
    with pytest.raises(dictation.DictationRoleInsufficient):
        await dictation.mint_token("k", client(403))
    with pytest.raises(dictation.DictationUnavailable):
        await dictation.mint_token("k", client(503))
    with pytest.raises(dictation.DictationUnavailable):
        await dictation.mint_token("k", client(200))  # body is not JSON


def test_health_version(api_client, monkeypatch):
    assert api_client.get("/api/health").json() == {"status": "ok", "version": None}
    monkeypatch.setenv("LEARNHARNESS_APP_VERSION", "1.2.3")
    assert api_client.get("/api/health").json() == {"status": "ok", "version": "1.2.3"}
