"""The Next.js export is served on the API's origin; /api keeps priority."""

import pytest
from starlette.testclient import TestClient

from learnharness.api.app import create_app
from learnharness.api.static_site import resolve


@pytest.fixture
def site(tmp_path):
    root = tmp_path / "out"
    (root / "chat").mkdir(parents=True)
    (root / "draw").mkdir()
    (root / "_next/static").mkdir(parents=True)
    (root / "index.html").write_text("home")
    (root / "settings.html").write_text("settings")
    (root / "docs").mkdir()
    (root / "docs/index.html").write_text("docs")
    (root / "chat/_.html").write_text("chat-shell")
    (root / "draw/_.html").write_text("draw-shell")
    (root / "404.html").write_text("missing")
    (root / "_next/static/a.js").write_text("js")
    (tmp_path / "secret.txt").write_text("secret")
    return root


def test_resolution_order(site):
    assert resolve(site, "/") == (site / "index.html", 200)
    assert resolve(site, "/_next/static/a.js") == (site / "_next/static/a.js", 200)
    assert resolve(site, "/settings") == (site / "settings.html", 200)
    assert resolve(site, "/docs") == (site / "docs/index.html", 200)
    assert resolve(site, "/chat/abc123") == (site / "chat/_.html", 200)
    assert resolve(site, "/draw/some-slug") == (site / "draw/_.html", 200)
    assert resolve(site, "/nope") == (site / "404.html", 404)
    assert resolve(site, "/chat/a/b") == (site / "404.html", 404)


def test_traversal_is_refused(site):
    for hostile in ("/../secret.txt", "/%2e%2e/secret.txt", "/chat/../../secret.txt", "/..\\secret.txt", "//..//secret.txt"):
        path, status = resolve(site, hostile)
        assert status == 404 and path != site.parent / "secret.txt"


def test_symlink_escape_is_refused(site):
    (site / "leak.html").symlink_to(site.parent / "secret.txt")
    assert resolve(site, "/leak")[1] == 404


def test_mounted_app_serves_static_and_api_wins(site, tmp_path, monkeypatch):
    monkeypatch.setenv("LEARNHARNESS_STATIC_DIR", str(site))
    client = TestClient(create_app(vault_path=tmp_path / "vault"))
    assert client.get("/chat/abc").text == "chat-shell"
    assert client.get("/").text == "home"
    assert client.get("/nope").status_code == 404
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/setup/status").status_code == 200
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/api/does-not-exist").text != "missing"
    assert client.post("/anything").status_code == 405
    immutable = client.get("/_next/static/a.js")
    assert "immutable" in immutable.headers["cache-control"]
    assert "immutable" not in client.get("/").headers.get("cache-control", "")


def test_no_static_dir_means_no_catch_all(tmp_path, monkeypatch):
    monkeypatch.delenv("LEARNHARNESS_STATIC_DIR", raising=False)
    client = TestClient(create_app(vault_path=tmp_path / "vault"))
    assert client.get("/").status_code == 404
