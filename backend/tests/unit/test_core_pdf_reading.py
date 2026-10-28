"""Pure helpers of the PDF agent."""
from __future__ import annotations

from learnharness.core.pdf_reading import select_visual_pages, validate_page_citations


def test_requested_pages_are_clipped_to_existing_and_keep_order() -> None:
    assert select_visual_pages([5, 2, 9, 2, 0], 6, [], [900] * 6) == [5, 2]
    assert select_visual_pages([1, 2, 3, 4, 5, 6], 6, [], [900] * 6) == [1, 2, 3, 4]
    assert select_visual_pages([3, 4, 5], 6, [], [900] * 6, limit=2) == [3, 4]


def test_nothing_requested_with_enough_text_sees_nothing() -> None:
    assert select_visual_pages([], 3, [True, False, True], [900, 900, 900]) == []


def test_nothing_requested_with_scarce_text_uses_image_or_sparse_pages() -> None:
    assert select_visual_pages([], 4, [False, True, False, False], [10, 50, 300, 10]) == [1, 2, 4]
    assert select_visual_pages([], 6, [True] * 6, [0] * 6) == [1, 2, 3, 4]
    assert select_visual_pages([], 0, [], []) == []


def test_validate_page_citations_returns_the_pages_outside_allowed() -> None:
    answer = "Veja (p. 2) e (p.7); de novo (p. 7) e (p. 3)."
    assert validate_page_citations(answer, {2, 3}) == [7]
    assert validate_page_citations(answer, [2, 3, 7]) == []
    assert validate_page_citations("sem citações", {1}) == []
