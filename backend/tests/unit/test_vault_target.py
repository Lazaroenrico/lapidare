"""The setup refuses Vault paths that would create a Vault by accident."""

from __future__ import annotations

import os

import pytest
from starlette.testclient import TestClient

from learnharness.api.app import create_app
from learnharness.vault.target import VaultTargetError, describe_vault_target, resolve_vault_target


@pytest.mark.parametrize(("raw", "code"), [("", "empty"), ("   ", "empty"), ("relativo/Vault", "relative")])
def test_refuses_empty_and_relative(raw, code):
    with pytest.raises(VaultTargetError) as exc:
        resolve_vault_target(raw)
    assert exc.value.code == code


def test_refuses_a_file(tmp_path):
    (tmp_path / "nota.md").write_text("x", encoding="utf-8")
    with pytest.raises(VaultTargetError) as exc:
        resolve_vault_target(str(tmp_path / "nota.md"))
    assert exc.value.code == "not_dir"


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_refuses_unwritable_parent(tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o555)
    try:
        with pytest.raises(VaultTargetError) as exc:
            resolve_vault_target(str(locked / "Vault"))
        assert exc.value.code == "not_writable"
    finally:
        locked.chmod(0o755)


def test_expands_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert resolve_vault_target("~/Documents/My Vault") == tmp_path / "Documents" / "My Vault"


def test_describe_reports_obsidian_lapidare_and_missing(tmp_path):
    obsidian = tmp_path / "Obsidian"
    (obsidian / ".obsidian").mkdir(parents=True)
    lapidare = tmp_path / "Lapidare"
    (lapidare / ".harness").mkdir(parents=True)
    (lapidare / ".harness" / "config.json").write_text("{}", encoding="utf-8")

    assert describe_vault_target(str(obsidian)) == {
        "ok": True, "error": None, "message": None, "path": str(obsidian),
        "exists": True, "obsidian": True, "lapidare": False,
    }
    assert describe_vault_target(str(lapidare))["lapidare"] is True
    missing = describe_vault_target(str(tmp_path / "Novo"))
    assert missing["ok"] is True and missing["exists"] is False
    assert describe_vault_target("rel")["error"] == "relative"


def test_describe_never_writes(tmp_path):
    describe_vault_target(str(tmp_path / "Novo" / "Vault"))
    assert not (tmp_path / "Novo").exists()


def test_vault_check_route_and_complete_refuses_bad_paths(tmp_path):
    (tmp_path / "arquivo.txt").write_text("x", encoding="utf-8")
    client = TestClient(create_app(vault_path=tmp_path / "Current"))

    body = client.get("/api/setup/vault-check", params={"path": str(tmp_path / "Novo")}).json()
    assert body["ok"] is True and body["exists"] is False and "warning" in body
    assert client.get("/api/setup/vault-check", params={"path": "x/y"}).json()["error"] == "relative"

    for bad in ("relativo/Vault", str(tmp_path / "arquivo.txt")):
        res = client.post("/api/setup/complete", json={"language": "pt-BR", "vault_path": bad})
        assert res.status_code == 422, res.text
    assert not (tmp_path / "Current" / ".harness").exists()


def test_complete_adopts_obsidian_vault_without_touching_notes(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    vault = tmp_path / "My Obsidian"
    (vault / ".obsidian").mkdir(parents=True)
    (vault / ".obsidian" / "app.json").write_text('{"theme":"x"}', encoding="utf-8")
    (vault / "Pessoal").mkdir()
    (vault / "Pessoal" / "nota.md").write_text("diário\n", encoding="utf-8")

    client = TestClient(create_app(vault_path=tmp_path / "Current"))
    res = client.post("/api/setup/complete", json={"language": "pt-BR", "vault_path": str(vault)})
    assert res.status_code == 200, res.text
    assert res.json()["config"]["vault_path"] == str(vault)
    assert (vault / ".harness" / "config.json").is_file()
    assert (vault / ".obsidian" / "app.json").read_text(encoding="utf-8") == '{"theme":"x"}'
    assert (vault / "Pessoal" / "nota.md").read_text(encoding="utf-8") == "diário\n"
