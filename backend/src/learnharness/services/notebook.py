"""Read-only adapter for the unofficial Gemini Notebook client."""
from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from learnharness.child_env import child_env


class NotebookService:
    def __init__(self, notify: Any):
        self.home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "learnharness" / "notebooklm"
        self.storage = self.home / "storage_state.json"
        self.notify = notify
        self.process: asyncio.subprocess.Process | None = None
        self.task: asyncio.Task | None = None
        self.login_error = False

    def status(self) -> dict[str, Any]:
        return {"connected": self.storage.is_file(), "connecting": self.process is not None, "login_error": self.login_error}

    async def login(self) -> None:
        if self.process is not None:
            return
        self.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.home.chmod(0o700)
        self.login_error = False
        env = child_env({"NOTEBOOKLM_HOME": str(self.home), "PYTHONUNBUFFERED": "1"})
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "notebooklm", "login", "--storage", str(self.storage),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, env=env,
        )
        self.task = asyncio.create_task(self._wait_login(self.process))
        self.notify()

    async def _wait_login(self, process: asyncio.subprocess.Process) -> None:
        code = await process.wait()
        if self.process is not process:
            return
        self.process = None
        self.login_error = code != 0
        if self.storage.exists():
            self.storage.chmod(0o600)
        self.notify()

    async def stop(self) -> None:
        if self.process is not None:
            process, self.process = self.process, None
            process.terminate()
            await process.wait()

    async def logout(self) -> None:
        await self.stop()
        # This dedicated directory is created and managed only by this connector.
        if self.home.exists():
            shutil.rmtree(self.home)
        self.login_error = False
        self.notify()

    def client(self):
        from notebooklm import NotebookLMClient
        if not self.storage.is_file():
            raise PermissionError("Connect Gemini Notebook first.")
        return NotebookLMClient.from_storage(str(self.storage))

    async def notebooks(self) -> list[dict[str, str]]:
        async with self.client() as client:
            rows = await client.notebooks.list()
            return [{"id": str(row.id), "title": row.title or str(row.id)} for row in rows]

    async def sources(self, notebook_id: str) -> list[dict[str, str]]:
        async with self.client() as client:
            rows = await client.sources.list(notebook_id)
            return [{"id": str(row.id), "title": row.title or str(row.id), "status": str(row.status)} for row in rows]

    async def fulltext(self, notebook_id: str, source_id: str) -> str:
        async with self.client() as client:
            result = await client.sources.get_fulltext(notebook_id, source_id)
            return result.content
