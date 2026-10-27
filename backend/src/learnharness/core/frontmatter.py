"""Obsidian frontmatter: one rule for every reader and writer of vault notes (pure).

A note has frontmatter when its first line is exactly ``---`` (after an optional UTF-8
BOM; trailing spaces allowed) and a later line is exactly ``---``. LF and CRLF both work,
and a ``---`` inside a value never closes the block (it is not at the start of a line).
A block whose YAML does not parse, or is not a mapping, is still a block (``data is
None``): the learner's text beats our metadata, so callers must not rewrite it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, cast

import yaml

_BLOCK = re.compile(r"\A(﻿?)---[ \t]*(\r?\n)(?:(.*?)\r?\n)?---[ \t]*(?:\r?\n|\Z)", re.DOTALL)


@dataclass(frozen=True)
class Frontmatter:
    bom: str  # "﻿" when the file starts with one (writers keep it in front)
    block: str  # opening fence through the closing fence and its newline ("" when absent)
    yaml: str  # the text between the fences
    body: str  # everything after the block (the whole content when there is none)
    newline: str  # the opening fence's line ending ("\n" when there is no block)
    data: dict[str, Any] | None  # the parsed mapping; None when absent or unparseable

    @property
    def present(self) -> bool:
        return bool(self.block)


def split_frontmatter(content: str) -> Frontmatter:
    match = _BLOCK.match(content)
    if match is None:
        return Frontmatter("", "", "", content, "\n", None)
    raw = match.group(3) or ""
    try:
        loaded: object = yaml.safe_load(raw) if raw.strip() else {}
    except yaml.YAMLError:
        loaded = None
    data = cast("dict[str, Any]", loaded) if isinstance(loaded, dict) else None
    bom = match.group(1)
    return Frontmatter(bom, match.group(0)[len(bom):], raw, content[match.end():], match.group(2), data)


def frontmatter_data(content: str) -> dict[str, Any]:
    """The parsed mapping, or ``{}`` when there is no block or it does not parse."""
    return split_frontmatter(content).data or {}


def strip_frontmatter(content: str) -> str:
    """The note without its frontmatter block (and BOM); unchanged when it has none."""
    return split_frontmatter(content).body
