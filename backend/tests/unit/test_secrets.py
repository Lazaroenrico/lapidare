import pytest

from learnharness.services import secrets


def test_corrupt_store_is_never_overwritten(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    path = secrets.secrets_path()
    path.parent.mkdir(parents=True)
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(secrets.SecretStoreCorrupt):
        secrets.set_secret("mcp:x", "token")
    assert path.read_text(encoding="utf-8") == "{not json"


def test_roundtrip_and_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    secrets.set_secret("mcp:a", "t1")
    secrets.set_secret("mcp:b", "t2")
    secrets.delete_secret("mcp:a")
    assert secrets.get_secret("mcp:b") == "t2" and secrets.get_secret("mcp:a") is None
    assert secrets.secrets_path().stat().st_mode & 0o777 == 0o600
