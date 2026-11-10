"""Authentication subprocess never inherits the desktop secret."""
import asyncio

import pytest

from learnharness.services.notebook import NotebookService


@pytest.mark.asyncio
async def test_login_and_disconnect(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("LEARNHARNESS_DESKTOP_SECRET", "must-not-leak")
    changes = []
    calls = []
    done = asyncio.Event()

    class Process:
        async def wait(self):
            await done.wait()
            return 0

        def terminate(self):
            done.set()

    async def spawn(*args, **kwargs):
        calls.append((args, kwargs))
        return Process()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    service = NotebookService(lambda: changes.append(True))
    await service.login()
    assert service.status()["connecting"]
    assert "LEARNHARNESS_DESKTOP_SECRET" not in calls[0][1]["env"]
    assert calls[0][1]["env"]["NOTEBOOKLM_HOME"] == str(service.home)
    assert service.home.stat().st_mode & 0o777 == 0o700
    service.storage.write_text("credentials")
    await service.logout()
    assert not service.home.exists()
    assert not service.status()["connected"]
    assert changes
