"""Spot model output that carries no content (pure, no I/O).

After a tool call with nothing left to say, Gemini models sometimes emit a lone stray
token (observed: "詰"). Such a fragment must not become a transcript message.
"""

from __future__ import annotations

import re

_LATIN_OR_DIGIT = re.compile(r"[A-Za-z0-9À-ɏ]")


def is_stray_fragment(text: str) -> bool:
    visible = text.strip()
    return len(visible) <= 2 and not _LATIN_OR_DIGIT.search(visible)
