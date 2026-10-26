"""Repair LaTeX that a model escaped twice inside tool-call JSON (pure, no I/O).

Models told to "double the backslashes in JSON" sometimes double them again, so a tool
argument arrives as ``\\\\cdot`` instead of ``\\cdot`` and KaTeX renders it as a line
break followed by the word "cdot". A LaTeX line break (``\\\\``) is never directly
followed by a letter in real markup, so collapsing exactly that case is safe.
"""

from __future__ import annotations

import re

_DOUBLED_COMMAND = re.compile(r"\\\\(?=[A-Za-z])")


def heal_latex(text: str) -> str:
    return _DOUBLED_COMMAND.sub(lambda _: "\\", text)
