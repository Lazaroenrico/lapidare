"""The local API must refuse DNS-rebinding hosts and cross-site writes."""

from starlette.testclient import TestClient

from learnharness.api.app import create_app


def test_foreign_host_is_rejected(tmp_path):
    client = TestClient(create_app(vault_path=tmp_path))
    assert client.get("/api/setup/status", headers={"host": "evil.example:8000"}).status_code == 421
    assert client.get("/api/setup/status", headers={"host": "127.0.0.1:8000"}).status_code == 200


def test_cross_site_write_is_rejected_but_frontend_origin_allowed(tmp_path):
    client = TestClient(create_app(vault_path=tmp_path))
    body = {"name": "x", "transport": "stdio", "command": "touch", "args": ["/tmp/pwned"]}
    hostile = client.post("/api/import/mcp/servers", json=body, headers={"origin": "https://evil.example"})
    assert hostile.status_code == 403
    allowed = client.post("/api/chats", json={"mode": "TEACH", "topic": "t"}, headers={"origin": "http://localhost:3000"})
    assert allowed.status_code != 403


def test_desktop_secret_gates_api_but_not_mcp_or_static(tmp_path, monkeypatch):
    monkeypatch.setenv("LEARNHARNESS_DESKTOP_SECRET", "s3cret")
    monkeypatch.delenv("LEARNHARNESS_APP_VERSION", raising=False)
    client = TestClient(create_app(vault_path=tmp_path))
    assert client.get("/api/health").status_code == 403
    assert client.get("/api/setup/status", headers={"x-lapidare-desktop": "wrong"}).status_code == 403
    assert client.get("/api/setup/status", headers={"x-lapidare-desktop": "s3cret"}).status_code == 200
    assert client.get("/api/health", headers={"x-lapidare-desktop": "s3cret"}).json() == {"status": "ok", "version": None}
    assert client.post("/api/chats", json={"mode": "TEACH", "topic": "t"}).status_code == 403
    # The MCP mount keeps its own Bearer gate: never the desktop header.
    mcp = client.post("/internal/mcp/", json={})
    assert mcp.status_code != 403 or mcp.json().get("detail") != "Desktop session required"
    assert client.get("/apix").status_code == 404  # only /api and /api/* are gated


def test_without_desktop_secret_api_is_open(tmp_path, monkeypatch):
    monkeypatch.delenv("LEARNHARNESS_DESKTOP_SECRET", raising=False)
    monkeypatch.delenv("LEARNHARNESS_APP_VERSION", raising=False)
    client = TestClient(create_app(vault_path=tmp_path))
    assert client.get("/api/health").json() == {"status": "ok", "version": None}
