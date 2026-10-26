"""Consent-based permission rule that lets headless ``agy`` call the harness MCP tools.

Headless agy soft-denies MCP calls that would need an interactive prompt, and it only reads
permission rules from the user's GLOBAL settings (``~/.gemini/antigravity-cli/settings.json``);
workspace hooks do not override that refusal. The harness therefore asks the user once and adds
a single narrow rule, ``mcp(harness/*)``: only the pedagogical server named ``harness`` (which
exists only in harness work dirs and requires a per-session Bearer token). Nothing else in the
user's settings is changed; a timestamped backup is written first.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

HARNESS_RULE = "mcp(harness/*)"


class AgySettingsError(RuntimeError):
    """The agy settings file exists but cannot be safely edited."""


def settings_path() -> Path:
    return Path.home() / ".gemini" / "antigravity-cli" / "settings.json"


def _read(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        # Never rewrite a file we cannot parse: it would drop the user's own rules.
        raise AgySettingsError(f"Cannot parse {path}; fix it manually before granting") from exc
    if not isinstance(data, dict):
        raise AgySettingsError(f"{path} must contain a JSON object")
    return data


def _allow_list(data: dict) -> list:
    permissions = data.get("permissions")
    if permissions is None:
        return []
    if not isinstance(permissions, dict) or not isinstance(permissions.get("allow", []), list):
        raise AgySettingsError("Unexpected 'permissions' shape in agy settings")
    return permissions.get("allow", [])


def status() -> dict:
    path = settings_path()
    try:
        granted = HARNESS_RULE in _allow_list(_read(path))
        error = None
    except AgySettingsError as exc:
        granted, error = False, str(exc)
    return {"granted": granted, "rule": HARNESS_RULE, "settings_path": str(path), "error": error}


def grant() -> dict:
    path = settings_path()
    data = _read(path)
    allow = _allow_list(data)
    if HARNESS_RULE in allow:
        return status()
    if path.is_file():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, path.with_name(f"{path.name}.bak-{stamp}"))
    data.setdefault("permissions", {})["allow"] = [*allow, HARNESS_RULE]
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, tmp = tempfile.mkstemp(prefix=".settings-", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return status()
