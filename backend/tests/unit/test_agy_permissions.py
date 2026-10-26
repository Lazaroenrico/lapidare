import json

import pytest

from learnharness.services import agy_permissions


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def test_grant_adds_only_the_harness_rule_and_backs_up(home):
    path = agy_permissions.settings_path()
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"model": "x", "permissions": {"allow": ["command(ls)"]}, "trustedWorkspaces": ["/a"]}))
    path.chmod(0o600)
    assert agy_permissions.status()["granted"] is False
    result = agy_permissions.grant()
    data = json.loads(path.read_text())
    assert result["granted"] is True
    assert data["permissions"]["allow"] == ["command(ls)", "mcp(harness/*)"]
    assert data["model"] == "x" and data["trustedWorkspaces"] == ["/a"]
    assert path.stat().st_mode & 0o777 == 0o600
    assert len(list(path.parent.glob("settings.json.bak-*"))) == 1
    agy_permissions.grant()  # idempotent: no second backup, no duplicate rule
    assert json.loads(path.read_text())["permissions"]["allow"].count("mcp(harness/*)") == 1
    assert len(list(path.parent.glob("settings.json.bak-*"))) == 1


def test_corrupt_settings_are_never_rewritten(home):
    path = agy_permissions.settings_path()
    path.parent.mkdir(parents=True)
    path.write_text("{broken")
    with pytest.raises(agy_permissions.AgySettingsError):
        agy_permissions.grant()
    assert path.read_text() == "{broken"
    assert agy_permissions.status()["error"]


def test_route_requires_explicit_consent(home, tmp_path):
    from starlette.testclient import TestClient

    from learnharness.api.app import create_app

    client = TestClient(create_app(vault_path=tmp_path / "V"))
    assert client.post("/api/setup/agy-permission", json={}).status_code == 422
    assert client.post("/api/setup/agy-permission", json={"consent": True}).json()["granted"] is True
    assert client.get("/api/setup/agy-permission").json()["granted"] is True
