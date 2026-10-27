"""OAuth token storage for content MCP servers, kept OUTSIDE the Vault.

One JSON file per (server name, url) under ``$XDG_CONFIG_HOME/learnharness/mcp-oauth/``
(directory 0700, files 0600, atomic replace). It holds the access/refresh tokens and the
dynamic-client-registration result. Nothing here ever reaches ``.harness/config.json``, logs
or error messages. Implements the ``TokenStorage`` protocol of the MCP SDK.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from mcp.shared.auth import OAuthClientInformationFull, OAuthToken


def oauth_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base).expanduser() / "learnharness" / "mcp-oauth"


def store_key(server_name: str, url: str | None) -> str:
    """Stable file stem: renaming the server or changing its URL starts a fresh login."""
    digest = hashlib.sha256(f"{server_name}\n{(url or '').rstrip('/')}".encode()).hexdigest()
    return digest[:32]


class MemoryOAuthStorage:
    """Staging storage for a login in progress: committed to disk only if the login succeeds."""

    def __init__(self) -> None:
        self.tokens: OAuthToken | None = None
        self.client_info: OAuthClientInformationFull | None = None
        self.expires_at: float | None = None

    async def get_tokens(self) -> OAuthToken | None:
        return self.tokens

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self.tokens = tokens
        self.expires_at = time.time() + int(tokens.expires_in) if tokens.expires_in else None

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        return self.client_info

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self.client_info = client_info

    def token_expiry(self) -> float | None:
        return self.expires_at


class FileOAuthStorage:
    def __init__(self, server_name: str, url: str | None) -> None:
        self.path = oauth_dir() / f"{store_key(server_name, url)}.json"

    # -- raw file --------------------------------------------------------------------------
    def _read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, data: dict[str, Any]) -> None:
        directory = self.path.parent
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(directory, 0o700)
        fd, tmp = tempfile.mkstemp(prefix=".oauth-", suffix=".tmp", dir=directory)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    # -- TokenStorage ----------------------------------------------------------------------
    async def get_tokens(self) -> OAuthToken | None:
        raw = self._read().get("tokens")
        try:
            return OAuthToken.model_validate(raw) if raw else None
        except ValueError:
            return None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        data = self._read()
        data["tokens"] = tokens.model_dump(mode="json", exclude_none=True)
        data["expires_at"] = time.time() + int(tokens.expires_in) if tokens.expires_in else None
        self._write(data)

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        raw = self._read().get("client_info")
        try:
            return OAuthClientInformationFull.model_validate(raw) if raw else None
        except ValueError:
            return None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        data = self._read()
        data["client_info"] = client_info.model_dump(mode="json", exclude_none=True)
        self._write(data)

    # -- extras ----------------------------------------------------------------------------
    def token_expiry(self) -> float | None:
        value = self._read().get("expires_at")
        return float(value) if isinstance(value, (int, float)) else None

    def has_tokens(self) -> bool:
        tokens = self._read().get("tokens")
        return isinstance(tokens, dict) and bool(tokens.get("access_token"))

    def usable(self) -> bool:
        """Tokens that can still authenticate: unexpired, or expired but refreshable."""
        data = self._read()
        tokens = data.get("tokens")
        if not (isinstance(tokens, dict) and tokens.get("access_token")):
            return False
        expires_at = data.get("expires_at")
        if not isinstance(expires_at, (int, float)) or time.time() < expires_at:
            return True
        return bool(tokens.get("refresh_token")) and isinstance(data.get("client_info"), dict)

    def secrets(self) -> list[str]:
        tokens = self._read().get("tokens")
        if not isinstance(tokens, dict):
            return []
        return [str(tokens[k]) for k in ("access_token", "refresh_token") if tokens.get(k)]

    def commit(self, staged: MemoryOAuthStorage) -> None:
        """Replace the stored login with a successfully completed one."""
        data: dict[str, Any] = {}
        if staged.tokens is not None:
            data["tokens"] = staged.tokens.model_dump(mode="json", exclude_none=True)
            data["expires_at"] = staged.expires_at
        if staged.client_info is not None:
            data["client_info"] = staged.client_info.model_dump(mode="json", exclude_none=True)
        self._write(data)

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)
