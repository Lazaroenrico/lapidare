"""Generic content-MCP import against REAL FastMCP servers (HTTP, SSE and stdio).

Each HTTP server runs under uvicorn on an ephemeral loopback port in its own thread, so the
synchronous TestClient driving the LearnHarness API never shares an event loop with it.
"""

from __future__ import annotations

import json
import socket
import stat
import sys
import textwrap
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import uvicorn
import yaml
from fastmcp import FastMCP
from starlette.testclient import TestClient

from learnharness.services.secrets import secrets_path

TOKEN = "s3cr3t-token-value-XYZ"


@pytest.fixture(autouse=True)
def isolated_secrets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    return tmp_path / "xdg"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class BearerGate:
    """Records Authorization headers and rejects requests without the expected token."""

    def __init__(self, app: Any, token: str | None) -> None:
        self.app = app
        self.token = token
        self.seen: list[str] = []

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            headers = dict(scope.get("headers") or [])
            auth = headers.get(b"authorization", b"").decode("latin-1")
            self.seen.append(auth)
            if self.token and auth != f"Bearer {self.token}":
                await send({"type": "http.response.start", "status": 401, "headers": []})
                await send({"type": "http.response.body", "body": b"unauthorized"})
                return
        await self.app(scope, receive, send)


class ServedMcp:
    def __init__(self, app: Any, path: str) -> None:
        self.port = _free_port()
        self.url = f"http://127.0.0.1:{self.port}{path}"
        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning", lifespan="on")
        )
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> ServedMcp:
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("MCP test server did not start")
            time.sleep(0.02)
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


RESOURCE_TEXT = {
    "intro": "Atenção compara consultas e chaves.\n\nO softmax normaliza os pesos.",
    "kv": "O KV cache guarda chaves e valores.\n\nIsso evita recomputar o prefixo.",
}


def _resources_server(texts: dict[str, str], page_size: int | None = None) -> FastMCP:
    mcp = FastMCP("res", list_page_size=page_size)

    def reader(key: str):
        return lambda: texts[key]

    for key in texts:
        mcp.resource(f"lesson://{key}", name=key, title=f"Aula {key}", description=f"desc {key}")(
            reader(key)
        )
    mcp.resource("lesson://image", name="image", mime_type="image/png")(lambda: b"\x89PNG\x00\x01")
    for i in range(3):
        texts.setdefault(f"extra{i}", f"Extra {i}")
        mcp.resource(f"extra://{i}", name=f"extra{i}")(reader(f"extra{i}"))
    return mcp


def _catalog_server() -> FastMCP:
    mcp = FastMCP("praxis-like")
    lessons = {
        "s01": ("S01 Tokens", "Tokens são unidades.\n\nEmbeddings são vetores."),
        "s02": ("S02 Evals", "Avaliação offline usa dataset fixo.\n\nOnline monitora produção."),
    }

    @mcp.tool
    def list_lessons() -> list[dict[str, str]]:
        return [{"id": k, "titulo": t, "tipo": "aula"} for k, (t, _) in lessons.items()]

    @mcp.tool
    def get_lesson(lesson_id: str) -> str:
        return lessons[lesson_id][1]

    return mcp


@pytest.fixture
def resource_texts() -> dict[str, str]:
    return dict(RESOURCE_TEXT)


@pytest.fixture
def resources_http(resource_texts: dict[str, str]) -> Iterator[ServedMcp]:
    app = _resources_server(resource_texts, page_size=2).http_app(path="/mcp")
    with ServedMcp(app, "/mcp") as served:
        yield served


@pytest.fixture
def catalog_http() -> Iterator[tuple[ServedMcp, BearerGate]]:
    gate = BearerGate(_catalog_server().http_app(path="/mcp"), TOKEN)
    with ServedMcp(gate, "/mcp") as served:
        yield served, gate


def _sources(vault: Path) -> Path:
    return vault / json.loads((vault / ".harness/config.json").read_text())["folders"]["sources_dir"]


def _frontmatter(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8").split("---", 2)[1])


def _add(client: TestClient, **body: Any) -> dict[str, Any]:
    res = client.post("/api/import/mcp/servers", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def test_resources_server_list_import_and_versions(
    api_client: TestClient, configured_vault: Path, resources_http: ServedMcp, resource_texts: dict[str, str]
) -> None:
    server = _add(api_client, name="docs", transport="http", url=resources_http.url)
    assert server == {**server, "name": "docs", "transport": "http", "has_auth": False}

    test = api_client.post("/api/import/mcp/servers/docs/test").json()
    assert test["ok"] is True and test["resources"] == 6

    items = api_client.get("/api/import/mcp/servers/docs/items").json()
    # list_page_size=2 forces nextCursor pagination over 6 resources.
    assert len(items) == 6
    intro = next(i for i in items if i["id"] == "lesson://intro")
    assert intro == {"id": "lesson://intro", "title": "Aula intro", "kind": "resource",
                     "description": "desc intro", "is_new": True}

    res = api_client.post("/api/import/mcp/servers/docs/import",
                          json={"item_ids": ["lesson://intro"], "start_session": True})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session_id"]
    [imported] = body["imported"]
    assert imported["paragraph_count"] == 2 and imported["title"] == "Aula intro"
    target = configured_vault / imported["source_path"]
    assert target.parent == _sources(configured_vault) / "MCP" / "docs"
    text = target.read_text(encoding="utf-8")
    assert "Atenção compara consultas e chaves. ^p1" in text and "^p2" in text
    meta = _frontmatter(target)
    assert meta["source_kind"] == "mcp" and meta["mcp_server"] == "docs"
    assert meta["mcp_item_id"] == "lesson://intro" and meta["origem"] == "MCP: docs"

    items = {i["id"]: i for i in api_client.get("/api/import/mcp/servers/docs/items").json()}
    assert items["lesson://intro"]["is_new"] is False and items["lesson://kv"]["is_new"] is True

    # Same content: idempotent. Changed content: a new immutable version, the old one untouched.
    again = api_client.post("/api/import/mcp/servers/docs/import", json={"item_ids": ["lesson://intro"]})
    assert again.json()["imported"][0]["source_path"] == imported["source_path"]
    assert again.json()["session_id"] is None
    resource_texts["intro"] = "Versão nova da aula.\n\nCom outro parágrafo."
    newer = api_client.post("/api/import/mcp/servers/docs/import", json={"item_ids": ["lesson://intro"]})
    new_path = newer.json()["imported"][0]["source_path"]
    assert new_path != imported["source_path"] and "--" in Path(new_path).stem
    assert target.read_text(encoding="utf-8") == text

    catalog = api_client.get("/api/import/catalog").json()
    assert catalog["mcp_connected"] is True and catalog["errors"] == []
    assert {i["server"] for i in catalog["items"]} == {"docs"}


def test_binary_only_resource_is_rejected(api_client: TestClient, resources_http: ServedMcp) -> None:
    _add(api_client, name="docs", transport="http", url=resources_http.url)
    res = api_client.post("/api/import/mcp/servers/docs/import", json={"item_ids": ["lesson://image"]})
    assert res.status_code == 502
    assert "binary" in res.json()["detail"]


def test_catalog_tool_with_bearer_token(
    api_client: TestClient, configured_vault: Path, catalog_http: tuple[ServedMcp, BearerGate],
    isolated_secrets: Path,
) -> None:
    served, gate = catalog_http
    server = _add(api_client, name="praxis", transport="http", url=served.url, auth_token=TOKEN)
    assert server["has_auth"] is True
    assert TOKEN not in json.dumps(server)
    assert TOKEN not in api_client.get("/api/import/mcp/servers").text
    assert TOKEN not in (configured_vault / ".harness/config.json").read_text()
    stored = json.loads((configured_vault / ".harness/config.json").read_text())["content_mcps"][0]
    assert stored["auth_ref"] == "mcp:praxis"

    secrets = secrets_path()
    assert secrets.is_relative_to(isolated_secrets)
    assert stat.S_IMODE(secrets.stat().st_mode) == 0o600
    assert json.loads(secrets.read_text())["mcp:praxis"] == TOKEN

    items = api_client.get("/api/import/mcp/servers/praxis/items").json()
    assert [(i["id"], i["title"], i["kind"], i["is_new"]) for i in items] == [
        ("s01", "S01 Tokens", "aula", True), ("s02", "S02 Evals", "aula", True)]
    assert gate.seen and all(h == f"Bearer {TOKEN}" for h in gate.seen)

    res = api_client.post("/api/import/mcp/servers/praxis/import",
                          json={"item_ids": ["s01", "s02"], "start_session": True})
    body = res.json()
    assert res.status_code == 200 and body["session_id"] is None
    assert [i["title"] for i in body["imported"]] == ["S01 Tokens", "S02 Evals"]
    first = configured_vault / body["imported"][0]["source_path"]
    assert "Tokens são unidades. ^p1" in first.read_text(encoding="utf-8")
    assert TOKEN not in first.read_text(encoding="utf-8")
    assert all(not i["is_new"] for i in api_client.get("/api/import/mcp/servers/praxis/items").json())

    # Updating without auth_token keeps the stored token; "" removes it -> server rejects (502).
    assert _add(api_client, name="praxis", transport="http", url=served.url)["has_auth"] is True
    assert _add(api_client, name="praxis", transport="http", url=served.url, auth_token="")["has_auth"] is False
    denied = api_client.get("/api/import/mcp/servers/praxis/items")
    assert denied.status_code == 502
    assert TOKEN not in denied.text

    assert api_client.delete("/api/import/mcp/servers/praxis").status_code == 204
    assert api_client.get("/api/import/mcp/servers").json() == []
    assert api_client.get("/api/import/mcp/servers/praxis/items").status_code == 404


def test_env_auth_ref(api_client: TestClient, catalog_http: tuple[ServedMcp, BearerGate],
                      monkeypatch: pytest.MonkeyPatch) -> None:
    served, _ = catalog_http
    monkeypatch.setenv("PRAXIS_MCP_TOKEN", TOKEN)
    server = _add(api_client, name="praxis", transport="http", url=served.url, auth_ref="env:PRAXIS_MCP_TOKEN")
    assert server["has_auth"] is True
    assert len(api_client.get("/api/import/mcp/servers/praxis/items").json()) == 2
    bad = api_client.post("/api/import/mcp/servers", json={"name": "x", "url": served.url, "auth_ref": "../etc"})
    assert bad.status_code == 422


def test_sse_transport(api_client: TestClient, resource_texts: dict[str, str]) -> None:
    app = _resources_server(resource_texts).http_app(path="/sse", transport="sse")
    with ServedMcp(app, "/sse") as served:
        _add(api_client, name="sse-docs", transport="sse", url=served.url)
        ids = {i["id"] for i in api_client.get("/api/import/mcp/servers/sse-docs/items").json()}
        assert "lesson://kv" in ids
        res = api_client.post("/api/import/mcp/servers/sse-docs/import", json={"item_ids": ["lesson://kv"]})
        assert res.status_code == 200 and res.json()["imported"][0]["paragraph_count"] == 2


def test_stdio_transport_passes_token_via_env(
    api_client: TestClient, configured_vault: Path, tmp_path: Path
) -> None:
    script = tmp_path / "stdio_server.py"
    script.write_text(textwrap.dedent(
        """
        import os
        from fastmcp import FastMCP

        mcp = FastMCP("stdio-content")

        @mcp.resource("note://one", name="one", title="Nota Um")
        def one() -> str:
            ok = os.environ.get("CONTENT_TOKEN") == "__TOKEN__"
            return "Primeiro parágrafo.\\n\\nToken recebido: " + ("token-ok" if ok else "missing")

        if __name__ == "__main__":
            mcp.run(show_banner=False)
        """.replace("__TOKEN__", TOKEN)
    ))
    server = _add(api_client, name="local", transport="stdio", command=sys.executable,
                  args=[str(script)], auth_token=TOKEN, auth_env_var="CONTENT_TOKEN")
    assert TOKEN not in json.dumps(server["args"])
    items = api_client.get("/api/import/mcp/servers/local/items").json()
    assert items == [{"id": "note://one", "title": "Nota Um", "kind": "resource",
                      "description": "", "is_new": True}]
    res = api_client.post("/api/import/mcp/servers/local/import",
                          json={"item_ids": ["note://one"], "start_session": False})
    assert res.status_code == 200, res.text
    path = configured_vault / res.json()["imported"][0]["source_path"]
    assert "token-ok" in path.read_text(encoding="utf-8")
    assert TOKEN not in (configured_vault / ".harness/config.json").read_text()


def test_unreachable_server_maps_to_502(api_client: TestClient) -> None:
    url = f"http://127.0.0.1:{_free_port()}/mcp"
    _add(api_client, name="down", transport="http", url=url, auth_token=TOKEN)
    items = api_client.get("/api/import/mcp/servers/down/items")
    assert items.status_code == 502
    assert "down" in items.json()["detail"] and TOKEN not in items.text
    test = api_client.post("/api/import/mcp/servers/down/test").json()
    assert test["ok"] is False and test["error"]
    imported = api_client.post("/api/import/mcp/servers/down/import", json={"item_ids": ["a"]})
    assert imported.status_code == 502
    catalog = api_client.get("/api/import/catalog")
    assert catalog.status_code == 200
    assert catalog.json()["items"] == [] and catalog.json()["errors"][0]["server"] == "down"


def test_invalid_server_definitions_are_rejected(api_client: TestClient) -> None:
    assert api_client.post("/api/import/mcp/servers", json={"name": "../evil", "url": "http://x"}).status_code == 422
    assert api_client.post("/api/import/mcp/servers", json={"name": "a", "url": "file:///etc"}).status_code == 422
    assert api_client.post("/api/import/mcp/servers", json={"name": "a", "transport": "http"}).status_code == 422
    assert api_client.delete("/api/import/mcp/servers/nope").status_code == 404
