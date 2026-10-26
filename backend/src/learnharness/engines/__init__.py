"""Google connectors: explicit selection, without silent provider substitution."""

from learnharness.core.contracts.config import EngineKind
from learnharness.engines.agy_engine import AgyStreamEngine
from learnharness.engines.detector import detect_connectors
from learnharness.engines.gemini_acp import ACP_POOL, GeminiAcpEngine, GeminiCliAcpEngine
from learnharness.engines.gemini_engine import GeminiHeadlessEngine
from learnharness.engines.genai_sdk_engine import GenAiSdkEngine


def get_engine(slot=None, **kwargs):
    target = slot.engine if slot else EngineKind.GEMINI_CLI
    if slot:
        kwargs.setdefault("default_model", slot.model_id)
    if target == EngineKind.AGY:
        return AgyStreamEngine(default_effort=slot.effort if slot else None, **kwargs)
    if target == EngineKind.GEMINI_CLI:
        return GeminiCliAcpEngine(**kwargs)
    if target == EngineKind.GENAI_SDK:
        return GenAiSdkEngine(**kwargs)
    raise ValueError(f"Unsupported engine: {target}")


async def close_engine_processes(session_id=None):
    """Close persistent CLI processes (one session, or all on app shutdown)."""
    if session_id is None:
        await ACP_POOL.close_all()
    else:
        await ACP_POOL.close(session_id)


__all__ = [
    "ACP_POOL",
    "AgyStreamEngine",
    "GeminiAcpEngine",
    "GeminiCliAcpEngine",
    "GeminiHeadlessEngine",
    "GenAiSdkEngine",
    "close_engine_processes",
    "detect_connectors",
    "get_engine",
]
