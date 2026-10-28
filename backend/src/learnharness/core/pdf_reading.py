"""Pure helpers of the PDF reading agent (Fase 20): which pages to look at, which citations hold."""
from __future__ import annotations

import re

MAX_VISUAL_PAGES = 4
SPARSE_TEXT_CHARS = 200  # Fewer extracted characters per page than this means the page is mostly not text.
_PAGE_CITE = re.compile(r"\(p\.\s*(\d+)\)")


def select_visual_pages(requested: list[int], page_count: int, hints: list[bool], text_lens: list[int],
                        limit: int = MAX_VISUAL_PAGES) -> list[int]:
    """1-based pages to render, at most ``limit``.

    ``requested`` (the triage's choice) is intersected with the pages that exist, keeping the
    requested order. With nothing requested and scarce text (a scan, a slide deck) the pages
    with images or little text are used instead; with enough text nothing needs to be seen.
    """
    existing = [n for n in dict.fromkeys(requested) if 1 <= n <= page_count]
    if existing:
        return existing[:limit]
    if page_count <= 0 or sum(text_lens[:page_count]) >= SPARSE_TEXT_CHARS * page_count:
        return []
    sparse = [
        n for n in range(1, page_count + 1)
        if (n <= len(hints) and hints[n - 1]) or (text_lens[n - 1] if n <= len(text_lens) else 0) < SPARSE_TEXT_CHARS
    ]
    return sparse[:limit]


def validate_page_citations(answer: str, allowed: set[int] | frozenset[int] | list[int]) -> list[int]:
    """Pages cited as ``(p. N)`` in ``answer`` that are not in ``allowed``, sorted."""
    permitted = set(allowed)
    return sorted({int(n) for n in _PAGE_CITE.findall(answer)} - permitted)
