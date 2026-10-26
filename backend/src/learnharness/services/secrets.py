"""Per-user secret store kept OUTSIDE the Vault.

Tokens for external content MCP servers live in ``$XDG_CONFIG_HOME/learnharness/secrets.json``
(default ``~/.config``) with mode 0600. ``.harness/config.json`` (inside the Vault, which may be
synced) only stores an ``auth_ref``: either a key into this file or ``env:VAR_NAME``.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

ENV_PREFIX = "env:"


def secrets_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base).expanduser() / "learnharness" / "secrets.json"


class SecretStoreCorrupt(RuntimeError):
    """secrets.json exists but cannot be parsed; never overwrite it blindly."""


def _load() -> dict[str, str]:
    path = secrets_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        # Returning {} here would let the next write erase every other stored token.
        raise SecretStoreCorrupt(f"Cannot read {path}; fix or remove it manually") from exc
    if not isinstance(data, dict):
        raise SecretStoreCorrupt(f"{path} must contain a JSON object")
    return {str(k): str(v) for k, v in data.items()}


def _store(data: dict[str, str]) -> None:
    path = secrets_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix=".secrets-", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)


def get_secret(key: str) -> str | None:
    return _load().get(key)


def set_secret(key: str, value: str) -> None:
    data = _load()
    data[key] = value
    _store(data)


def delete_secret(key: str) -> None:
    data = _load()
    if key in data:
        del data[key]
        _store(data)


def resolve_auth(auth_ref: str | None) -> str | None:
    """Resolve an ``auth_ref`` into the token value (``env:VAR`` or a secrets-file key)."""
    if not auth_ref:
        return None
    if auth_ref.startswith(ENV_PREFIX):
        return os.environ.get(auth_ref[len(ENV_PREFIX):]) or None
    return get_secret(auth_ref) or None


def mcp_secret_key(server_name: str) -> str:
    return f"mcp:{server_name}"
