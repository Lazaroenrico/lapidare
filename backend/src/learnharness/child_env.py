"""The one environment every subprocess of the backend starts from.

Under the desktop build the backend itself runs inside an AppImage launched by Electron,
so ``os.environ`` carries packaging variables (``APPDIR``, ``ELECTRON_*``, a rewritten
``LD_LIBRARY_PATH``) that make gemini, agy, git or Chromium load the wrong libraries, plus
the per-launch desktop secret, which no child may ever see.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

DESKTOP_SECRET_ENV = "LEARNHARNESS_DESKTOP_SECRET"
# Electron stores the user's original value here before clearing it for the backend.
ORIGINAL_LD_LIBRARY_PATH_ENV = "LEARNHARNESS_ORIG_LD_LIBRARY_PATH"

_DROPPED = {
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "PYTHONHOME",
    "PYTHONPATH",
    "LD_LIBRARY_PATH",
    DESKTOP_SECRET_ENV,
    ORIGINAL_LD_LIBRARY_PATH_ENV,
}
_DROPPED_PREFIXES = ("ELECTRON_",)


def child_env(
    extra: Mapping[str, str] | None = None, base: Mapping[str, str] | None = None
) -> dict[str, str]:
    """Return ``base`` (default ``os.environ``) without packaging leaks, plus ``extra``."""
    source = os.environ if base is None else base
    env = {
        key: value
        for key, value in source.items()
        if key not in _DROPPED and not key.startswith(_DROPPED_PREFIXES)
    }
    original = source.get(ORIGINAL_LD_LIBRARY_PATH_ENV)
    if original:
        env["LD_LIBRARY_PATH"] = original
    elif "LD_LIBRARY_PATH" in source and ORIGINAL_LD_LIBRARY_PATH_ENV not in source:
        # Outside the desktop build the user's own value is legitimate.
        env["LD_LIBRARY_PATH"] = source["LD_LIBRARY_PATH"]
    env.update(extra or {})
    return env
