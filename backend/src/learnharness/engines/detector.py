"""Local discovery is not an authentication probe and never spends provider quota."""

import os
import shutil
from importlib.util import find_spec
from pathlib import Path

from learnharness.core.contracts.config import ConnectorStatus, EngineKind

SUPPORTED_MODELS: list[
    str
] = []  # Availability is account/provider-specific; accept user model IDs.
KNOWN_AGY_PATHS = [str(Path.home() / ".local/bin/agy")]
KNOWN_GEMINI_PATHS = [
    str(Path.home() / ".local/share/mise/installs/gemini/latest/node_modules/.bin/gemini"),
    str(Path.home() / ".nvm/versions/node/current/bin/gemini"),
]


def _find_executable(binary_name, fallback_paths):
    for candidate in [shutil.which(binary_name), *fallback_paths]:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def detect_connectors():
    results = []
    for engine, name, paths in [
        (EngineKind.GEMINI_CLI, "gemini", KNOWN_GEMINI_PATHS),
        (EngineKind.AGY, "agy", KNOWN_AGY_PATHS),
    ]:
        binary = _find_executable(name, paths)
        results.append(
            ConnectorStatus(
                engine=engine,
                available=bool(binary),
                binary_path=binary,
                authenticated=False,
                models=[],
                detail=f"{name} installed; authentication unverified. Run {name} to authenticate."
                if binary
                else f"{name} executable not found.",
            )
        )
    try:
        installed = find_spec("google.genai") is not None
    except (ImportError, ModuleNotFoundError):
        installed = False
    results.append(
        ConnectorStatus(
            engine=EngineKind.GENAI_SDK,
            available=installed,
            authenticated=False,
            models=[],
            detail="SDK installed; credentials unverified. Configure API key or Vertex ADC."
            if installed
            else "google-genai is not installed.",
        )
    )
    return results


def get_default_engine():
    return EngineKind.GEMINI_CLI
