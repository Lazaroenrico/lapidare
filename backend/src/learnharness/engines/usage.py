"""Per-call token usage reported by engines, without widening ``AgentEnginePort``.

Design: an ambient sink in a ``ContextVar``. Engines call ``report_usage(...)`` once per
provider call whose final event carries counts (agy ``result.usage``, Gemini CLI headless
``result.stats``, ACP ``session/prompt`` ``_meta.quota.token_count``, google-genai
``usage_metadata``). Whoever drives the engine (``SessionService.run``, ``JobManager.run``)
installs a sink for the duration of that work with ``set_usage_sink`` / ``reset_usage_sink``
(``usage_sink`` as a context manager). The variable is task-local, so concurrent sessions
and jobs never see each other's reports, tasks spawned inside inherit the sink, and code
that never installs one (tests, one-off HTTP calls) simply drops the report.

``stream_turn`` / ``run_structured`` keep their signatures; reports arrive when the
provider's terminal event is read, i.e. before the stream ends or the call returns.
A sink failure is logged and never fails a turn.
"""
from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from typing import Any

from learnharness.core.contracts.session import TurnUsage

logger = logging.getLogger(__name__)

UsageSink = Callable[[TurnUsage], None]

_SINK: ContextVar[UsageSink | None] = ContextVar("learnharness_usage_sink", default=None)


def set_usage_sink(sink: UsageSink | None) -> Token:
    return _SINK.set(sink)


def reset_usage_sink(token: Token) -> None:
    _SINK.reset(token)


@contextmanager
def usage_sink(sink: UsageSink | None) -> Iterator[None]:
    token = set_usage_sink(sink)
    try:
        yield
    finally:
        reset_usage_sink(token)


def _count(value: Any) -> int:
    try:
        return max(int(value or 0), 0)
    except (TypeError, ValueError):
        return 0


def _optional_count(value: Any) -> int | None:
    return None if value is None else _count(value)


def report_usage(model_id: str | None, counts: dict[str, Any] | None) -> TurnUsage | None:
    """Hand one call's counts (``input_tokens``/``output_tokens``/``thinking_tokens``, and
    ``cached_tokens`` when the provider reports it) to the sink."""
    if not counts:
        return None
    usage = TurnUsage(
        model_id=str(model_id or ""),
        input_tokens=_count(counts.get("input_tokens")),
        output_tokens=_count(counts.get("output_tokens")),
        thinking_tokens=_count(counts.get("thinking_tokens")),
        cached_tokens=_optional_count(counts.get("cached_tokens")),
    )
    sink = _SINK.get()
    if sink is not None:
        try:
            sink(usage)
        except Exception:
            logger.warning("Usage sink failed; usage for this call is lost", exc_info=True)
    return usage


# ----------------------------------------------------------------- provider shapes


def agy_usage(result: dict[str, Any] | None) -> dict[str, Any] | None:
    """agy 1.4.7 ``result.usage`` (per turn, not cumulative: see the fixtures)."""
    usage = (result or {}).get("usage")
    if not isinstance(usage, dict):
        return None
    if "cache_read_tokens" in usage:
        return {**usage, "cached_tokens": usage["cache_read_tokens"]}
    return usage


def gemini_cli_usage(event: dict[str, Any] | None) -> dict[str, Any] | None:
    """Gemini CLI headless stream-json ``result.stats`` (no thinking count)."""
    stats = (event or {}).get("stats")
    if not isinstance(stats, dict) or "input_tokens" not in stats:
        return None
    counts = {"input_tokens": stats.get("input_tokens"), "output_tokens": stats.get("output_tokens")}
    if stats.get("cached") is not None:
        counts["cached_tokens"] = stats["cached"]
    return counts


def acp_usage(result: dict[str, Any] | None) -> dict[str, Any] | None:
    """ACP ``session/prompt`` reply ``_meta.quota.token_count`` when the CLI sends it."""
    meta = (result or {}).get("_meta")
    quota = meta.get("quota") if isinstance(meta, dict) else None
    counts = quota.get("token_count") if isinstance(quota, dict) else None
    return counts if isinstance(counts, dict) else None


def genai_usage(metadata: Any) -> dict[str, Any] | None:
    """google-genai ``GenerateContentResponseUsageMetadata``."""
    if metadata is None:
        return None
    return {
        "input_tokens": getattr(metadata, "prompt_token_count", None),
        "output_tokens": getattr(metadata, "candidates_token_count", None),
        "thinking_tokens": getattr(metadata, "thoughts_token_count", None),
        "cached_tokens": getattr(metadata, "cached_content_token_count", None),
    }
