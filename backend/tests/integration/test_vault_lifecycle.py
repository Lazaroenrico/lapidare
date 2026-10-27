"""AppState owns the Vault for its lifetime and refuses data from a newer build."""

import subprocess
import sys

import pytest

from learnharness.api.state import AppState
from learnharness.core.schema_gate import SchemaTooNew
from learnharness.vault.bootstrap import bootstrap_vault, save_config
from learnharness.vault.ownership import VaultBusy


def _held_elsewhere(vault) -> bool:
    code = "import sys; from pathlib import Path; from learnharness.vault.ownership import acquire_vault; acquire_vault(Path(sys.argv[1]))"
    return subprocess.run([sys.executable, "-c", code, str(vault)], capture_output=True, timeout=30).returncode != 0


def _configured(vault, **changes):
    config = bootstrap_vault(vault)
    config.configured = True
    for key, value in changes.items():
        setattr(config, key, value)
    save_config(vault, config)


async def test_start_holds_the_lock_even_unconfigured_and_close_releases(tmp_path):
    state = AppState(vault_path=tmp_path)
    await state.start()
    assert _held_elsewhere(tmp_path)
    await state.close()
    assert not _held_elsewhere(tmp_path)


async def test_two_states_in_one_process_release_in_step(tmp_path):
    first, second = AppState(vault_path=tmp_path), AppState(vault_path=tmp_path)
    await first.start()
    await second.start()
    await first.close()
    assert _held_elsewhere(tmp_path)
    await second.close()
    assert not _held_elsewhere(tmp_path)


async def test_start_is_idempotent_and_close_without_start_is_safe(tmp_path):
    state = AppState(vault_path=tmp_path)
    await state.close()
    await state.start()
    await state.start()
    await state.close()
    assert not _held_elsewhere(tmp_path)


async def test_schema_too_new_refuses_and_releases(tmp_path):
    _configured(tmp_path, schema_version=99)
    state = AppState(vault_path=tmp_path)
    with pytest.raises(SchemaTooNew):
        await state.start()
    assert isinstance(state.startup_error, SchemaTooNew)
    assert not state.started
    assert not _held_elsewhere(tmp_path)


async def test_busy_vault_raises_vault_busy(tmp_path):
    holder = subprocess.Popen(
        [sys.executable, "-c", "import sys, time; from pathlib import Path; from learnharness.vault.ownership import acquire_vault; acquire_vault(Path(sys.argv[1])); print('ok', flush=True); time.sleep(60)", str(tmp_path)],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        assert holder.stdout.readline().strip() == "ok"
        state = AppState(vault_path=tmp_path)
        with pytest.raises(VaultBusy):
            await state.start()
        assert isinstance(state.startup_error, VaultBusy)
    finally:
        holder.kill()
        holder.wait()


async def test_switch_vault_moves_the_lock(tmp_path):
    old, new = tmp_path / "old", tmp_path / "new"
    old.mkdir()
    new.mkdir()
    state = AppState(vault_path=old)
    await state.start()
    await state.switch_vault(new)
    assert not _held_elsewhere(old)
    assert _held_elsewhere(new)
    await state.close()
    assert not _held_elsewhere(new)


async def test_app_version_env_snapshots_on_change(tmp_path, monkeypatch):
    _configured(tmp_path)
    monkeypatch.setenv("LEARNHARNESS_APP_VERSION", "1.0.0")
    state = AppState(vault_path=tmp_path)
    await state.start()
    await state.close()
    monkeypatch.setenv("LEARNHARNESS_APP_VERSION", "1.1.0")
    state = AppState(vault_path=tmp_path)
    await state.start()
    await state.close()
    assert (tmp_path / ".harness/backups/1.0.0/config.json").is_file()
    assert (tmp_path / ".harness/app-version").read_text().strip() == "1.1.0"
