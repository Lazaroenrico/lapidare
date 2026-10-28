"""Context window of known model families (pure). Unknown models have no window (``None``)."""

from __future__ import annotations

# Headroom kept below the window for the next reply and tool output.
WINDOW_RESERVE = 16_000

# Longest matching prefix wins. Input-token limits published by Google for each Gemini
# family (ai.google.dev model pages); ids of other vendors are deliberately absent.
_WINDOWS: dict[str, int] = {
    "gemini-1.5-pro": 2_097_152,
    "gemini-1.5-flash": 1_048_576,
    "gemini-2.0": 1_048_576,
    "gemini-2.5": 1_048_576,
    "gemini-2.5-flash-image": 32_768,
    "gemini-3": 1_048_576,
}


def context_window(model_id: str | None) -> int | None:
    """Input window in tokens of ``model_id`` (by family prefix), or ``None`` when unknown."""
    name = (model_id or "").strip().lower().removeprefix("models/")
    matches = [prefix for prefix in _WINDOWS if name.startswith(prefix)]
    return _WINDOWS[max(matches, key=len)] if matches else None


def context_limit(compaction_tokens: int, window: int | None) -> tuple[int, str]:
    """``(limit, kind)``: where the context meter ends and which bound that is.

    ``kind`` is ``"window"`` when the model's window (minus the reserve) is reached before
    the compaction threshold, else ``"compaction"``.
    """
    if window is not None and window - WINDOW_RESERVE < compaction_tokens:
        return max(window - WINDOW_RESERVE, 0), "window"
    return compaction_tokens, "compaction"
