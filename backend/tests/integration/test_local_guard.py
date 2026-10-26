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
