"""Asynchronous vault file watcher with debouncing and change filtering.

Monitors user Obsidian Vault in the background. Emits change notifications
for SSE broadcasting (e.g. "vault:changed", "graph:updated").
Filters out temporary files, obsidian workspace states, and langgraph SQLite checkpoints.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path

try:
    from watchfiles import Change, awatch
    _WATCHFILES_AVAILABLE = True
except ImportError:
    _WATCHFILES_AVAILABLE = False
    Change = None


def is_ignored_path(path_str: str) -> bool:
    """Check if the changed path should be filtered out from notifications."""
    normalized = path_str.replace("\\", "/")
    if ".obsidian/workspace" in normalized:
        return True
    if normalized.endswith(".tmp") or ".tmp." in normalized:
        return True
    if ".harness/langgraph.sqlite" in normalized:
        return True
    if "/.git" in normalized or normalized.endswith("/.git"):
        return True
    return False


class VaultWatcher:
    """Monitors a vault path asynchronously and dispatches debounced change events."""

    def __init__(
        self,
        vault_path: Path,
        on_change: Callable[[list[str]], Awaitable[None]],
        debounce_ms: int = 250,
    ) -> None:
        self.vault_path = Path(vault_path).resolve()
        self.on_change = on_change
        self.debounce_seconds = max(debounce_ms, 50) / 1000.0
        self._stop_event = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """Start the background watching task."""
        if self._task is not None and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._watch_loop())

    async def stop(self) -> None:
        """Gracefully stop the background watching task."""
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _watch_loop(self) -> None:
        """Main watching loop using awatch or fallback polling."""
        if _WATCHFILES_AVAILABLE:
            try:
                async for changes in awatch(
                    str(self.vault_path),
                    stop_event=self._stop_event,
                    debounce=int(self.debounce_seconds * 1000),
                    step=50,
                ):
                    valid_paths: list[str] = []
                    for _, raw_path in changes:
                        if not is_ignored_path(raw_path):
                            valid_paths.append(raw_path)

                    if valid_paths and not self._stop_event.is_set():
                        try:
                            await self.on_change(sorted(list(set(valid_paths))))
                        except Exception:
                            pass
            except asyncio.CancelledError:
                return
            except Exception:
                pass
        else:
            # Fallback polling loop when watchfiles is not yet available
            try:
                while not self._stop_event.is_set():
                    await asyncio.sleep(self.debounce_seconds * 2)
            except asyncio.CancelledError:
                return
