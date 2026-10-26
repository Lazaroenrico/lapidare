"""Local discovery is not an authentication probe and never spends provider quota."""

import os
import shutil
from importlib.util import find_spec
from pathlib import Path

from learnharness.core.contracts.config import ConnectorStatus, EngineKind, recommend_engine

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


def sdk_credentials_configured(environ=None, home=None):
    """Cheap, offline check for an API key or Application Default Credentials file."""
    environ = os.environ if environ is None else environ
    if environ.get("GEMINI_API_KEY") or environ.get("GOOGLE_API_KEY"):
        return True
    adc = environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if adc and os.path.isfile(adc):
        return True
    home = Path.home() if home is None else Path(home)
    return (home / ".config/gcloud/application_default_credentials.json").is_file()


GEMINI_DETAIL = (
    "gemini installed; authentication unverified. Individual Gemini Code Assist accounts "
    "are no longer accepted by gemini --acp (migrate to Antigravity / agy)."
)


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
                detail=(
                    GEMINI_DETAIL
                    if engine == EngineKind.GEMINI_CLI
                    else f"{name} installed; authentication unverified. Run {name} to authenticate."
                )
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
    recommended = recommend_engine(results, sdk_credentials=sdk_credentials_configured())
    for status in results:
        status.recommended = status.engine == recommended
    return results


def get_default_engine():
    """agy if installed, else google-genai with credentials, else gemini CLI."""
    return next(s.engine for s in detect_connectors() if s.recommended)
