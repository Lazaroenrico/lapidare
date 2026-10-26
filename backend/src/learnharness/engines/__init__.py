"""Google connectors: explicit selection, without silent provider substitution."""

from learnharness.core.contracts.config import EngineKind
from learnharness.engines.agy_engine import AgyStreamEngine
from learnharness.engines.detector import detect_connectors
from learnharness.engines.gemini_engine import GeminiAcpEngine
from learnharness.engines.genai_sdk_engine import GenAiSdkEngine


def get_engine(slot=None, **kwargs):
    target = slot.engine if slot else EngineKind.GEMINI_CLI
    if slot:
        kwargs.setdefault("default_model", slot.model_id)
    if target == EngineKind.AGY:
        return AgyStreamEngine(default_effort=slot.effort if slot else None, **kwargs)
    if target == EngineKind.GEMINI_CLI:
        return GeminiAcpEngine(**kwargs)
    if target == EngineKind.GENAI_SDK:
        return GenAiSdkEngine(**kwargs)
    raise ValueError(f"Unsupported engine: {target}")


__all__ = [
    "AgyStreamEngine",
    "GeminiAcpEngine",
    "GenAiSdkEngine",
    "detect_connectors",
    "get_engine",
]
