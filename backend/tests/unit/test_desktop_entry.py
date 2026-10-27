"""desktop.py maps startup failures to the exit codes the Electron shell understands."""

import os
import subprocess
import sys

from learnharness import desktop
from learnharness.core.schema_gate import SchemaTooNew
from learnharness.vault.ownership import VaultBusy, acquire_vault, release_vault


def test_exit_code_mapping():
    assert desktop.exit_code_for(VaultBusy("x")) == desktop.EXIT_VAULT_BUSY == 75
    assert desktop.exit_code_for(SchemaTooNew("x")) == desktop.EXIT_SCHEMA_TOO_NEW == 76
    assert desktop.exit_code_for(RuntimeError("x")) is None
    assert desktop.exit_code_for(None) is None


def _run(vault, port, extra_env=None):
    env = {**os.environ, "LEARNHARNESS_VAULT_PATH": str(vault), "LEARNHARNESS_PORT": str(port), **(extra_env or {})}
    env.pop("LEARNHARNESS_DESKTOP_SECRET", None)
    return subprocess.run([sys.executable, "-m", "learnharness.desktop"], env=env, capture_output=True, text=True, timeout=60)


def test_missing_port_exits_with_2(tmp_path):
    env = {k: v for k, v in os.environ.items() if k != "LEARNHARNESS_PORT"}
    result = subprocess.run([sys.executable, "-m", "learnharness.desktop"], env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == desktop.EXIT_BAD_ENV


def test_vault_busy_exits_75(tmp_path):
    acquire_vault(tmp_path)
    try:
        result = _run(tmp_path, 8765)
    finally:
        release_vault(tmp_path)
    assert result.returncode == 75
    assert "could not start" in result.stderr


def test_schema_too_new_exits_76(tmp_path):
    from learnharness.vault.bootstrap import bootstrap_vault, save_config

    config = bootstrap_vault(tmp_path)
    config.schema_version = 99
    config.configured = True
    save_config(tmp_path, config)
    result = _run(tmp_path, 8766)
    assert result.returncode == 76
    assert "schema 99" in result.stderr
