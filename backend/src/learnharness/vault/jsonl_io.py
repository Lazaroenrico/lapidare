"""Cached readers for the append-only JSONL files in ``.harness/``.

The files only grow, so what was folded up to a byte offset stays valid: a call parses
only the lines appended since the last one. A cache entry is keyed on the file's inode,
size and mtime and re-checks the bytes just before its offset, so a file rewritten in
place (an external edit) is read again from the start.

Only complete lines (ending in a newline) are folded into the cache. A trailing fragment
(an append in progress, or a crash mid-append) is applied on top of each result and read
again next time.
"""

from __future__ import annotations

import json
import logging
import threading
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_GUARD_BYTES = 64
_CHUNK = 1 << 20
_MAX_ENTRIES = 256


@dataclass
class _Entry:
    ino: int
    size: int
    mtime_ns: int
    offset: int  # bytes folded so far: always right after a newline (or 0)
    guard: bytes  # the bytes just before ``offset``
    lineno: int  # complete lines folded so far
    base: Any  # folded state at ``offset`` (owned by the cache)
    result: Any  # ``base`` plus the trailing fragment (what callers receive)


class _AppendOnlyCache:
    """Per-path folded state of an append-only file, extended one tail at a time."""

    def __init__(
        self,
        cold: Callable[[Path, int], Any],
        fold: Callable[[Any, bytes, int, Path], Any],
        finish: Callable[[Any, bytes, int, Path], Any],
    ) -> None:
        self._cold = cold  # (path, offset) -> state for the first ``offset`` bytes
        self._fold = fold  # (state, line, lineno, path) -> state (may mutate state)
        self._finish = finish  # (state, fragment, lineno, path) -> result (must not mutate)
        self._entries: OrderedDict[Path, _Entry] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, path: Path) -> Any | None:
        try:
            st = path.stat()
        except FileNotFoundError:
            with self._lock:
                self._entries.pop(path, None)
            return None
        with self._lock:
            entry = self._entries.get(path)
            if entry and (entry.ino, entry.size, entry.mtime_ns) == (st.st_ino, st.st_size, st.st_mtime_ns):
                self._entries.move_to_end(path)
                return entry.result
            with path.open("rb") as handle:
                if entry and entry.ino == st.st_ino and st.st_size > entry.size and _guard_holds(handle, entry):
                    handle.seek(entry.offset)
                    tail = handle.read(st.st_size - entry.offset)
                    cut = tail.rfind(b"\n") + 1
                    base, lineno = entry.base, entry.lineno
                    for line in tail[:cut].split(b"\n")[:-1]:
                        lineno += 1
                        base = self._fold(base, line, lineno, path)
                    offset, fragment = entry.offset + cut, tail[cut:]
                else:
                    data_end = _last_newline_end(handle, st.st_size)
                    base, lineno = self._cold(path, data_end)
                    handle.seek(data_end)
                    offset, fragment = data_end, handle.read(st.st_size - data_end)
                handle.seek(max(0, offset - _GUARD_BYTES))
                guard = handle.read(min(offset, _GUARD_BYTES))
            result = self._finish(base, fragment.strip(), lineno + 1, path) if fragment.strip() else base
            self._entries[path] = _Entry(st.st_ino, st.st_size, st.st_mtime_ns, offset, guard,
                                         lineno, base, result)
            self._entries.move_to_end(path)
            while len(self._entries) > _MAX_ENTRIES:
                self._entries.popitem(last=False)
            return result


def _guard_holds(handle, entry: _Entry) -> bool:
    handle.seek(max(0, entry.offset - _GUARD_BYTES))
    return handle.read(min(entry.offset, _GUARD_BYTES)) == entry.guard


def _last_newline_end(handle, size: int) -> int:
    """Offset right after the file's last newline (0 when there is none)."""
    pos = size
    while pos > 0:
        step = min(_CHUNK, pos)
        pos -= step
        handle.seek(pos)
        index = handle.read(step).rfind(b"\n")
        if index >= 0:
            return pos + index + 1
    return 0


def lines_backward(path: Path, end: int) -> Iterator[bytes]:
    """The complete lines of ``path[:end]``, last first (``end`` is right after a newline)."""
    with path.open("rb") as handle:
        pos, carry = end, b""
        first = True
        while pos > 0:
            step = min(_CHUNK, pos)
            pos -= step
            handle.seek(pos)
            chunk = handle.read(step) + carry
            if first:
                chunk, first = chunk[:-1], False  # The newline that ends the last line.
            parts = chunk.split(b"\n")
            carry = parts[0]
            yield from reversed(parts[1:])
        if not first:
            yield carry


def parse_object(line: bytes, lineno: int, path: Path) -> dict[str, Any] | None:
    """One JSON object line, or None (blank, malformed or not an object; the last two are logged)."""
    if not line.strip():
        return None
    try:
        entry = json.loads(line)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        # A truncated/corrupt line (e.g. crash mid-append) must not hide the
        # rest of the append-only history; skip it but leave a trace.
        logger.warning("Skipping malformed JSONL line %d in %s: %s", lineno, path, exc)
        return None
    if not isinstance(entry, dict):
        logger.warning("Skipping non-object JSONL line %d in %s", lineno, path)
        return None
    return entry


def _cold_objects(path: Path, end: int) -> tuple[list[dict[str, Any]], int]:
    records: list[dict[str, Any]] = []
    if end == 0:
        return records, 0
    with path.open("rb") as handle:
        lines = handle.read(end).split(b"\n")[:-1]
    for lineno, line in enumerate(lines, start=1):
        if (entry := parse_object(line, lineno, path)) is not None:
            records.append(entry)
    return records, len(lines)


def _fold_object(records: list[dict[str, Any]], line: bytes, lineno: int, path: Path) -> list[dict[str, Any]]:
    if (entry := parse_object(line, lineno, path)) is not None:
        records.append(entry)
    return records


def _finish_objects(records: list[dict[str, Any]], fragment: bytes, lineno: int, path: Path) -> list[dict[str, Any]]:
    entry = parse_object(fragment, lineno, path)
    return [*records, entry] if entry is not None else records


_objects = _AppendOnlyCache(_cold_objects, _fold_object, _finish_objects)


def read_objects(path: Path) -> list[dict[str, Any]]:
    """Every JSON object line of ``path`` ([] when it does not exist).

    The dicts are shared with the cache: callers must treat them as read-only.
    """
    records = _objects.get(path)
    return list(records) if records is not None else []


def cached_fold(
    cold: Callable[[Path, int], Any],
    fold: Callable[[Any, bytes, int, Path], Any],
    finish: Callable[[Any, bytes, int, Path], Any],
) -> Callable[[Path], Any | None]:
    """A cached reader with a custom fold (see ``_AppendOnlyCache``); None when the file is absent."""
    return _AppendOnlyCache(cold, fold, finish).get
