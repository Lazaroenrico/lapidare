"""OAuth login for content MCP servers: config, storage outside the Vault, loopback flow, client.

The authorization server is faked at the ``connect`` seam (no network); the loopback listener,
the staging/commit of tokens, the SSE notification and the stored-token path of the content
client are all real.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest
from fastmcp import FastMCP
from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import ValidationError
from starlette.testclient import TestClient

from learnharness.api.state import AppState
from learnharness.core.contracts.config import McpServerConfig
from learnharness.mcp.content_client import ContentMcpClient, ContentMcpError
from learnharness.services.mcp_oauth_store import FileOAuthStorage, oauth_dir, store_key
from tests.integration.test_import_mcp import BearerGate, ServedMcp

ACCESS = "AT-very-secret-access"
REFRESH = "RT-very-secret-refresh"
URL = "https://mcp.example.com/mcp"


@pytest.fixture(autouse=True)
def isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    return tmp_path / "xdg"


def _oauth_server(name: str = "remote", url: str = URL, **extra: Any) -> McpServerConfig:
    return McpServerConfig(name=name, transport="http", url=url, auth_mode="oauth", **extra)


# ------------------------------------------------------------------------------- config
def test_auth_mode_is_derived_for_old_configs() -> None:
    assert McpServerConfig.model_validate({"name": "a", "url": URL}).auth_mode == "none"
    assert McpServerConfig.model_validate({"name": "a", "url": URL, "auth_ref": "mcp:a"}).auth_mode == "token"
    assert McpServerConfig.model_validate({"name": "a", "url": URL, "auth_mode": "oauth"}).oauth_scopes == []


def test_oauth_requires_http_or_sse() -> None:
    with pytest.raises(ValidationError, match="OAuth"):
        McpServerConfig(name="a", command="uvx", transport="stdio", auth_mode="oauth")
    assert McpServerConfig(name="a", url=URL, transport="sse", auth_mode="oauth").transport == "sse"


# ------------------------------------------------------------------------------ storage
def test_store_lives_outside_the_vault_with_private_permissions(
    isolated_config: Path, configured_vault: Path
) -> None:
    store = FileOAuthStorage("remote", URL)
    asyncio.run(store.set_tokens(OAuthToken(access_token=ACCESS, refresh_token=REFRESH, expires_in=60)))
    asyncio.run(store.set_client_info(OAuthClientInformationFull(client_id="cid", redirect_uris=["http://127.0.0.1:1/callback"])))
    assert store.path.parent == oauth_dir() == isolated_config / "learnharness" / "mcp-oauth"
    assert store.path.name == f"{store_key('remote', URL)}.json"
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(store.path.parent.stat().st_mode) == 0o700
    assert not store.path.is_relative_to(configured_vault)
    assert not list(store.path.parent.glob(".oauth-*"))  # atomic write leaves no temp file
    assert store.usable() and set(store.secrets()) == {ACCESS, REFRESH}
    assert store_key("remote", URL) != store_key("remote", URL + "/other")
    assert store_key("other", URL) != store_key("remote", URL)
    for path in configured_vault.rglob("*"):
        if path.is_file():
            assert ACCESS not in path.read_text(errors="ignore")
    store.clear()
    assert not store.usable()


def test_expired_tokens_without_refresh_are_not_usable() -> None:
    store = FileOAuthStorage("remote", URL)
    asyncio.run(store.set_tokens(OAuthToken(access_token=ACCESS, expires_in=-5)))
    assert store.has_tokens() and not store.usable()


# ---------------------------------------------------------------------------- the flow
def _fake_connect(
    seen: dict[str, Any], tokens: bool = True
) -> Callable[[McpServerConfig, OAuthClientProvider], Awaitable[None]]:
    async def connect(server: McpServerConfig, provider: OAuthClientProvider) -> None:
        ctx = provider.context
        redirect_uri = str(ctx.client_metadata.redirect_uris[0])  # type: ignore[index]
        seen["redirect_uri"] = redirect_uri
        seen["scope"] = ctx.client_metadata.scope
        await ctx.storage.set_client_info(OAuthClientInformationFull(client_id="cid", redirect_uris=[redirect_uri]))  # type: ignore[list-item]
        url = f"https://auth.example.com/authorize?client_id=cid&state=STATE123&redirect_uri={redirect_uri}"
        await ctx.redirect_handler(url)  # type: ignore[misc]
        result = await ctx.callback_handler()  # type: ignore[misc]
        seen["code"] = result.code
        if tokens:
            await ctx.storage.set_tokens(OAuthToken(access_token=ACCESS, refresh_token=REFRESH, expires_in=3600))
    return connect


@pytest.fixture
def events(app_state: AppState, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    seen: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(app_state.sse_hub, "broadcast", lambda e, d=None: seen.append((str(e), d or {})))
    return seen


def _add(client: TestClient, **extra: Any) -> None:
    body = {"name": "remote", "transport": "http", "url": URL, "auth_mode": "oauth", **extra}
    res = client.post("/api/import/mcp/servers", json=body)
    assert res.status_code == 200, res.text


def _status(client: TestClient) -> dict[str, Any]:
    server = next(s for s in client.get("/api/import/mcp/servers").json() if s["name"] == "remote")
    return server["oauth"]


def _wait_status(client: TestClient, wanted: str) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status = _status(client)
        if status["status"] == wanted:
            return status
        time.sleep(0.02)
    raise AssertionError(f"status never became {wanted}: {_status(client)}")


def _callback(redirect_uri: str, **query: str) -> httpx.Response:
    return httpx.get(redirect_uri, params=query, timeout=10)


def test_login_returns_url_and_callback_signs_in(
    api_client: TestClient, app_state: AppState, configured_vault: Path, events: list[tuple[str, dict[str, Any]]]
) -> None:
    seen: dict[str, Any] = {}
    app_state.mcp_oauth._connect = _fake_connect(seen)
    _add(api_client, oauth_scopes=["read", "write"])
    stored = json.loads((configured_vault / ".harness/config.json").read_text())["content_mcps"][0]
    assert stored["auth_mode"] == "oauth" and stored["auth_ref"] is None
    assert _status(api_client) == {"status": "signed_out"}

    res = api_client.post("/api/import/mcp/servers/remote/oauth/login")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["authorization_url"].startswith("https://auth.example.com/authorize")
    assert body["oauth"] == {"status": "pending"}
    assert _status(api_client) == {"status": "pending"}
    # Same pending flow is reused, not duplicated.
    assert api_client.post("/api/import/mcp/servers/remote/oauth/login").json()["authorization_url"] == body["authorization_url"]

    redirect = seen["redirect_uri"]
    assert redirect.startswith("http://127.0.0.1:") and redirect.endswith("/callback")
    page = _callback(redirect, code="CODE1", state="STATE123")
    assert page.status_code == 200 and "Login concluído" in page.text and "Lapidare" in page.text
    assert _wait_status(api_client, "signed_in") == {"status": "signed_in"}
    assert seen["code"] == "CODE1" and seen["scope"] == "read write"
    assert any(e == "config:updated" and d == {"kind": "mcp_oauth", "server": "remote"} for e, d in events)
    assert FileOAuthStorage("remote", URL).usable()
    assert ACCESS not in api_client.get("/api/import/mcp/servers").text

    # The listener is closed once the flow is over.
    with pytest.raises(httpx.TransportError):
        _callback(redirect, code="CODE2", state="STATE123")

    out = api_client.post("/api/import/mcp/servers/remote/oauth/logout")
    assert out.status_code == 200 and out.json()["oauth"] == {"status": "signed_out"}
    assert not FileOAuthStorage("remote", URL).path.exists()


def test_state_mismatch_is_rejected_and_flow_keeps_waiting(api_client: TestClient, app_state: AppState) -> None:
    seen: dict[str, Any] = {}
    app_state.mcp_oauth._connect = _fake_connect(seen)
    _add(api_client)
    api_client.post("/api/import/mcp/servers/remote/oauth/login")
    bad = _callback(seen["redirect_uri"], code="EVIL", state="WRONG")
    assert bad.status_code == 400
    assert _status(api_client) == {"status": "pending"}
    assert not FileOAuthStorage("remote", URL).path.exists()
    # A request with a foreign Host header (DNS rebinding) is refused too.
    port = urlsplit(seen["redirect_uri"]).port
    rebound = httpx.get(seen["redirect_uri"], params={"code": "x", "state": "STATE123"}, headers={"Host": f"evil.test:{port}"})
    assert rebound.status_code == 403
    assert _callback(seen["redirect_uri"], code="OK", state="STATE123").status_code == 200
    _wait_status(api_client, "signed_in")


def test_authorization_server_error_shows_error_page(api_client: TestClient, app_state: AppState) -> None:
    seen: dict[str, Any] = {}
    app_state.mcp_oauth._connect = _fake_connect(seen)
    _add(api_client)
    api_client.post("/api/import/mcp/servers/remote/oauth/login")
    page = _callback(seen["redirect_uri"], error="access_denied", state="STATE123")
    assert page.status_code == 400 and "access_denied" in page.text
    status = _wait_status(api_client, "error")
    assert "access_denied" in status["error"]
    assert not FileOAuthStorage("remote", URL).path.exists()


def test_timeout_ends_in_error(api_client: TestClient, app_state: AppState, events: list[tuple[str, dict[str, Any]]]) -> None:
    app_state.mcp_oauth._timeout = 0.3
    app_state.mcp_oauth._connect = _fake_connect({})
    _add(api_client)
    assert api_client.post("/api/import/mcp/servers/remote/oauth/login").status_code == 200
    status = _wait_status(api_client, "error")
    assert "expirou" in status["error"]
    assert sum(1 for e, _ in events if e == "config:updated") >= 2  # started + failed
    # A new attempt is possible afterwards.
    app_state.mcp_oauth._timeout = 300
    assert api_client.post("/api/import/mcp/servers/remote/oauth/login").status_code == 200
    api_client.post("/api/import/mcp/servers/remote/oauth/logout")
    assert _status(api_client) == {"status": "signed_out"}


def test_failed_login_keeps_previous_tokens(api_client: TestClient, app_state: AppState) -> None:
    _add(api_client)
    store = FileOAuthStorage("remote", URL)
    asyncio.run(store.set_tokens(OAuthToken(access_token=ACCESS, expires_in=3600)))
    seen: dict[str, Any] = {}
    app_state.mcp_oauth._connect = _fake_connect(seen)
    api_client.post("/api/import/mcp/servers/remote/oauth/login")
    _callback(seen["redirect_uri"], error="access_denied", state="STATE123")
    _wait_status(api_client, "error")
    assert store.usable()


def test_login_errors(api_client: TestClient, app_state: AppState) -> None:
    api_client.post("/api/import/mcp/servers", json={"name": "plain", "transport": "http", "url": URL})
    assert api_client.post("/api/import/mcp/servers/plain/oauth/login").status_code == 400
    assert api_client.post("/api/import/mcp/servers/nope/oauth/login").status_code == 404

    async def broken(server: McpServerConfig, provider: OAuthClientProvider) -> None:
        raise RuntimeError(f"boom {ACCESS}")

    app_state.mcp_oauth._connect = broken
    _add(api_client)
    res = api_client.post("/api/import/mcp/servers/remote/oauth/login")
    assert res.status_code == 502 and "boom" in res.json()["detail"]
    assert _status(api_client)["status"] == "error"


def test_oauth_rejected_for_stdio_and_mode_switch_clears_login(api_client: TestClient) -> None:
    bad = api_client.post(
        "/api/import/mcp/servers", json={"name": "s", "transport": "stdio", "command": "uvx", "auth_mode": "oauth"}
    )
    assert bad.status_code == 422
    _add(api_client)
    asyncio.run(FileOAuthStorage("remote", URL).set_tokens(OAuthToken(access_token=ACCESS, expires_in=3600)))
    res = api_client.post("/api/import/mcp/servers", json={"name": "remote", "transport": "http", "url": URL, "auth_mode": "none"})
    assert res.json()["auth_mode"] == "none" and res.json()["oauth"] is None
    assert not FileOAuthStorage("remote", URL).path.exists()
    assert api_client.delete("/api/import/mcp/servers/remote").status_code == 204


# --------------------------------------------------------------------- content client
def _gate_server() -> FastMCP:
    mcp = FastMCP("oauth-protected")

    @mcp.tool
    def list_lessons() -> list[dict[str, str]]:
        return [{"id": "s01", "titulo": "S01"}]

    return mcp


def test_content_client_uses_stored_oauth_tokens() -> None:
    gate = BearerGate(_gate_server().http_app(path="/mcp"), ACCESS)
    with ServedMcp(gate, "/mcp") as served:
        server = _oauth_server(url=served.url)
        client = ContentMcpClient(servers=[server])
        with pytest.raises(ContentMcpError, match=r"Faça login neste servidor MCP \(OAuth\)"):
            asyncio.run(client.list_items(server))

        asyncio.run(FileOAuthStorage("remote", served.url).set_tokens(OAuthToken(access_token=ACCESS, expires_in=3600)))
        items = asyncio.run(client.list_items(server))
        assert [i["id"] for i in items] == ["s01"]
        assert f"Bearer {ACCESS}" in gate.seen

        # Wrong token: error is clean and never echoes the secrets.
        asyncio.run(FileOAuthStorage("remote", served.url).set_tokens(OAuthToken(access_token="stale-token", expires_in=3600)))
        with pytest.raises(ContentMcpError) as info:
            asyncio.run(client.list_items(server))
        assert "stale-token" not in str(info.value)


def test_content_client_expired_without_refresh_asks_for_login() -> None:
    server = _oauth_server()
    asyncio.run(FileOAuthStorage("remote", URL).set_tokens(OAuthToken(access_token=ACCESS, expires_in=-10)))
    with pytest.raises(ContentMcpError, match="Faça login"):
        asyncio.run(ContentMcpClient(servers=[server]).list_items(server))
    assert os.path.exists(FileOAuthStorage("remote", URL).path)
