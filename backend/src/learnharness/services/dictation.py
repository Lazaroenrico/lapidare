"""Dictation: short-lived Deepgram tokens for the renderer (the audio never touches us).

The user's own Deepgram key lives in the secret store (outside the Vault). The renderer only
ever receives a 60 s access token minted here.
"""

from __future__ import annotations

from typing import Any

import httpx

from learnharness.services.secrets import delete_secret, get_secret, set_secret

DEEPGRAM_GRANT_URL = "https://api.deepgram.com/v1/auth/grant"
TOKEN_TTL_SECONDS = 60
REQUEST_TIMEOUT = 10.0
SECRET_NAME = "deepgram_api_key"


class DictationNotConfigured(RuntimeError):
    """No Deepgram key stored."""


class DictationKeyInvalid(RuntimeError):
    """Deepgram answered 401."""


class DictationRoleInsufficient(RuntimeError):
    """Deepgram answered 403: the key needs the Member role or higher."""


class DictationUnavailable(RuntimeError):
    """Network failure or any other Deepgram status."""


def get_key() -> str | None:
    return get_secret(SECRET_NAME) or None


def set_key(key: str | None) -> None:
    if key is None:
        delete_secret(SECRET_NAME)
    else:
        set_secret(SECRET_NAME, key)


async def mint_token(key: str, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """POST /v1/auth/grant -> ``{access_token, expires_in}``. Errors never echo the key."""
    owns = client is None
    http = client or httpx.AsyncClient(timeout=REQUEST_TIMEOUT)
    try:
        response = await http.post(
            DEEPGRAM_GRANT_URL,
            headers={"Authorization": f"Token {key}"},
            json={"ttl_seconds": TOKEN_TTL_SECONDS},
            timeout=REQUEST_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        raise DictationUnavailable(type(exc).__name__) from None
    finally:
        if owns:
            await http.aclose()
    if response.status_code == 401:
        raise DictationKeyInvalid("Deepgram rejected the key")
    if response.status_code == 403:
        raise DictationRoleInsufficient("The Deepgram key needs the Member role or higher")
    if response.status_code != 200:
        raise DictationUnavailable(f"Deepgram status {response.status_code}")
    try:
        body = response.json()
        return {"access_token": str(body["access_token"]), "expires_in": int(body["expires_in"])}
    except (ValueError, KeyError, TypeError):
        raise DictationUnavailable("Unexpected Deepgram response") from None
