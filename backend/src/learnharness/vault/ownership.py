"""One backend per Vault, and a snapshot of the machine data whenever the app version changes.

Startup recovery (``jobs.recover`` / ``sessions.recover``) assumes this process owns the
Vault: a second backend on the same Vault would mark the first one's live work as
interrupted, and both would append to the same ``.jsonl`` files and SQLite database.
"""

from __future__ import annotations

import fcntl
import os
import shutil
import sqlite3
import tempfile
import threading
from pathlib import Path

from learnharness.vault.safety import atomic_write, revision, safe_path


class VaultBusy(RuntimeError):
    """Another Lapidare process (desktop app or dev server) already has this Vault open."""


_held: dict[str, tuple[int, int]] = {}  # vault key -> (fd, references in this process)
_guard = threading.Lock()


def _lock_file(key: str) -> Path:
    # Same directory as ``locked_path``: nothing new is written into the Vault.
    lock_dir = Path(tempfile.gettempdir()) / f"learnharness-locks-{os.getuid()}"
    lock_dir.mkdir(mode=0o700, exist_ok=True)
    return lock_dir / f"vault-{revision(key)}"


def acquire_vault(vault: Path) -> None:
    """Take the process-lifetime ownership lock; re-entrant within one process."""
    key = str(Path(vault).absolute())
    with _guard:
        if key in _held:
            fd, refs = _held[key]
            _held[key] = (fd, refs + 1)
            return
        fd = os.open(_lock_file(key), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise VaultBusy(
                f"The Vault {vault} is already open in another Lapidare process "
                "(desktop app or dev server). Close it and try again."
            ) from None
        _held[key] = (fd, 1)


def release_vault(vault: Path) -> None:
    key = str(Path(vault).absolute())
    with _guard:
        if key not in _held:
            return
        fd, refs = _held[key]
        if refs > 1:
            _held[key] = (fd, refs - 1)
            return
        del _held[key]
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


BACKUPS_KEPT = 2


def snapshot_on_version_change(vault: Path, version: str, keep: int = BACKUPS_KEPT) -> Path | None:
    """Back up ``langgraph.sqlite`` and ``config.json`` when ``version`` differs from the
    last one that opened this Vault. The ``.jsonl`` logs are append-only and need no copy."""
    harness = safe_path(vault, ".harness")
    if not harness.is_dir():
        return None
    marker = harness / "app-version"
    previous = marker.read_text(encoding="utf-8").strip() if marker.is_file() else ""
    if previous == version:
        return None
    target = None
    if previous:
        target = harness / "backups" / previous
        target.mkdir(parents=True, exist_ok=True)
        database = harness / "langgraph.sqlite"
        if database.is_file():
            # The backup API reads a consistent snapshot even with a WAL in use.
            source = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
            copy = sqlite3.connect(target / "langgraph.sqlite")
            try:
                source.backup(copy)
            finally:
                copy.close()
                source.close()
        config = harness / "config.json"
        if config.is_file():
            shutil.copy2(config, target / "config.json")
        os.utime(target)  # a reused folder must count as the newest for pruning
        _prune(harness / "backups", keep)
    atomic_write(marker, version + "\n")
    return target


def _prune(backups: Path, keep: int) -> None:
    entries = sorted((p for p in backups.iterdir() if p.is_dir()), key=lambda p: (p.stat().st_mtime_ns, p.name))
    for old in entries[:-keep] if keep else entries:
        shutil.rmtree(old)
