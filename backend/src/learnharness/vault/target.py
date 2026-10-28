"""Validate the Vault folder chosen in the setup before adopting (or creating) it."""

from __future__ import annotations

import os
from pathlib import Path


class VaultTargetError(ValueError):
    """A Vault path the setup must refuse; ``code`` lets the UI localize the message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def resolve_vault_target(raw: str) -> Path:
    """Expand ``~`` and resolve; refuse empty, relative and non-folder paths.

    A relative path would resolve against the server's working directory, never what
    the user meant, so it is rejected instead of silently creating a Vault there.
    """
    text = (raw or "").strip()
    if not text:
        raise VaultTargetError("empty", "Choose a folder for the Vault")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise VaultTargetError("relative", "The Vault path must be absolute (for example ~/Documents/MyVault)")
    path = path.resolve()
    if path.exists() and not path.is_dir():
        raise VaultTargetError("not_dir", "The Vault path points to a file, not a folder")
    if not os.access(_nearest_existing(path), os.W_OK):
        raise VaultTargetError("not_writable", "Lapidare cannot write to this folder")
    return path


def describe_vault_target(raw: str) -> dict:
    """What adopting ``raw`` would mean: create a new folder, adopt an Obsidian vault, reopen a Lapidare one."""
    try:
        path = resolve_vault_target(raw)
    except VaultTargetError as exc:
        return {"ok": False, "error": exc.code, "message": str(exc), "path": None,
                "exists": False, "obsidian": False, "lapidare": False}
    return {
        "ok": True,
        "error": None,
        "message": None,
        "path": str(path),
        "exists": path.is_dir(),
        "obsidian": (path / ".obsidian").is_dir(),
        "lapidare": (path / ".harness" / "config.json").is_file(),
    }


def _nearest_existing(path: Path) -> Path:
    while not path.exists() and path != path.parent:
        path = path.parent
    return path
