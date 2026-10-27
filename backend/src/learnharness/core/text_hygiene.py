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


# CJK ideographs, kana and hangul: scripts a pt-BR/en lesson never ends with by itself.
_CJK = "぀-ヿ㐀-䶿一-鿿가-힯豈-﫿"
_STRAY_TAIL = re.compile(rf"\s*[{_CJK}]\s*$")
_ANY_CJK = re.compile(rf"[{_CJK}]")


def strip_stray_tail(text: str) -> str:
    """Drop a lone ideograph glued to the end of otherwise non-CJK prose ("… brutos. 噓")."""
    match = _STRAY_TAIL.search(text)
    if not match or _ANY_CJK.search(text[: match.start()]):
        return text
    return text[: match.start()].rstrip() + ("\n" if text.endswith("\n") else "")
