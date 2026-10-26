"""Model catalogs per connector, read from the provider itself (no prompt quota spent)."""

from __future__ import annotations

import asyncio
import time

from learnharness.core.contracts.config import EngineKind
from learnharness.engines.detector import KNOWN_AGY_PATHS, _find_executable

CACHE_SECONDS = 600
# gemini CLI has no list command; these are the ids its docs accept.
GEMINI_CLI_MODELS = [
    {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
    {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
]
_cache: dict[str, tuple[float, dict]] = {}


def parse_agy_models(output: str) -> list[dict[str, str]]:
    """``agy models`` prints ``<id>\\t<label>`` lines after a progress line."""
    models = []
    for line in output.splitlines():
        if "\t" not in line:
            continue
        model_id, label = (part.strip() for part in line.split("\t", 1))
        if model_id and " " not in model_id:
            models.append({"id": model_id, "label": label or model_id})
    return models


async def _agy_models() -> dict:
    binary = _find_executable("agy", KNOWN_AGY_PATHS)
    if not binary:
        return {"models": [], "source": "agy", "error": "agy não encontrado no PATH"}
    process = await asyncio.create_subprocess_exec(
        binary, "models", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 30)
    except TimeoutError:
        process.kill()
        await process.wait()
        return {"models": [], "source": "agy", "error": "agy models não respondeu em 30 s"}
    models = parse_agy_models(stdout.decode("utf-8", "replace"))
    if process.returncode or not models:
        # stderr may mention auth state; never include tokens (agy prints none here).
        detail = stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["sem modelos"]
        return {"models": models, "source": "agy", "error": f"agy models falhou: {detail[0][:200]}"}
    return {"models": models, "source": "agy", "error": None}


async def _sdk_models(api_key: str | None) -> dict:
    from learnharness.engines.genai_sdk_engine import GenAiSdkEngine

    engine = GenAiSdkEngine(api_key=api_key)
    if engine.client is None:
        return {"models": [], "source": "api", "error": "Configure GEMINI_API_KEY ou Vertex ADC para listar modelos"}
    models = []
    try:
        async for model in await engine.client.aio.models.list():
            actions = getattr(model, "supported_actions", None) or []
            name = (model.name or "").removeprefix("models/")
            if name and (not actions or "generateContent" in actions):
                models.append({"id": name, "label": getattr(model, "display_name", None) or name})
    except Exception as exc:  # noqa: BLE001 - provider SDK raises many types; surfaced to the UI
        return {"models": [], "source": "api", "error": f"Falha ao listar modelos: {type(exc).__name__}"}
    return {"models": models, "source": "api", "error": None}


async def list_models(engine: EngineKind, api_key: str | None = None) -> dict:
    key = f"{engine.value}:{bool(api_key)}"
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1]
    if engine == EngineKind.AGY:
        result = await _agy_models()
    elif engine == EngineKind.GENAI_SDK:
        result = await _sdk_models(api_key)
    else:
        result = {"models": GEMINI_CLI_MODELS, "source": "static", "error": None}
    result = {"engine": engine.value, **result}
    if not result["error"]:
        _cache[key] = (time.monotonic(), result)
    return result
