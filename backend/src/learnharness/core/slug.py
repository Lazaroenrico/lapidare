"""ASCII slugs for ids and file names (pure).

Persisted ids (older concept notes, track items, drawings) were built with exactly this
rule, so it must not change: accented letters are dropped, not folded ("Atenção" ->
"aten-o"). New code that wants readable slugs folds accents first (``services.visuals``).
"""

from __future__ import annotations

import re

_NON_ALNUM = re.compile(r"[^a-zA-Z0-9]+")


def ascii_slug(text: str) -> str:
    return _NON_ALNUM.sub("-", text.strip().lower()).strip("-")
