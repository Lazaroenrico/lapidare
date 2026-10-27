"""One backend per Vault; machine-data snapshot when the app version changes."""

import subprocess
import sys
import textwrap
import time

from learnharness.vault.ownership import (
    acquire_vault,
    release_vault,
    snapshot_on_version_change,
)


def _try_acquire_elsewhere(vault) -> int:
    code = textwrap.dedent(
        """
        import sys
        from pathlib import Path
        from learnharness.vault.ownership import VaultBusy, acquire_vault
        try:
            acquire_vault(Path(sys.argv[1]))
        except VaultBusy:
            sys.exit(75)
        """
    )
    return subprocess.run([sys.executable, "-c", code, str(vault)], timeout=30).returncode


def test_second_process_is_refused_until_released(tmp_path):
    acquire_vault(tmp_path)
    try:
        assert _try_acquire_elsewhere(tmp_path) == 75
    finally:
        release_vault(tmp_path)
    assert _try_acquire_elsewhere(tmp_path) == 0


def test_reentrant_in_one_process_and_counts_releases(tmp_path):
    acquire_vault(tmp_path)
    acquire_vault(tmp_path)
    release_vault(tmp_path)
    assert _try_acquire_elsewhere(tmp_path) == 75  # still held by the first reference
    release_vault(tmp_path)
    assert _try_acquire_elsewhere(tmp_path) == 0
    release_vault(tmp_path)  # extra release is a no-op


def test_vault_busy_message_names_the_vault(tmp_path):
    code = (
        "import sys; from pathlib import Path; from learnharness.vault.ownership import acquire_vault; "
        "acquire_vault(Path(sys.argv[1]))"
    )
    acquire_vault(tmp_path)
    try:
        result = subprocess.run([sys.executable, "-c", code, str(tmp_path)], capture_output=True, text=True, timeout=30)
    finally:
        release_vault(tmp_path)
    assert "VaultBusy" in result.stderr and str(tmp_path) in result.stderr


def _machine_data(vault, config="{}"):
    harness = vault / ".harness"
    harness.mkdir(exist_ok=True)
    import sqlite3

    db = sqlite3.connect(harness / "langgraph.sqlite")
    db.execute("create table if not exists t (v text)")
    db.execute("insert into t values ('row')")
    db.commit()
    db.close()
    (harness / "config.json").write_text(config)
    return harness


def test_snapshot_without_harness_is_a_noop(tmp_path):
    assert snapshot_on_version_change(tmp_path, "1.0.0") is None
    assert not (tmp_path / ".harness").exists()


def test_first_run_records_version_without_backup(tmp_path):
    harness = _machine_data(tmp_path)
    assert snapshot_on_version_change(tmp_path, "1.0.0") is None
    assert (harness / "app-version").read_text().strip() == "1.0.0"
    assert not (harness / "backups").exists()


def test_same_version_is_a_noop(tmp_path):
    harness = _machine_data(tmp_path)
    snapshot_on_version_change(tmp_path, "1.0.0")
    assert snapshot_on_version_change(tmp_path, "1.0.0") is None
    assert not (harness / "backups").exists()


def test_version_change_backs_up_previous_and_keeps_two(tmp_path):
    harness = _machine_data(tmp_path, config='{"a": 1}')
    snapshot_on_version_change(tmp_path, "1.0.0")
    for version in ("1.1.0", "1.2.0", "1.3.0"):
        time.sleep(0.01)
        target = snapshot_on_version_change(tmp_path, version)
        assert target is not None
        assert (target / "config.json").read_text() == '{"a": 1}'
        import sqlite3

        assert sqlite3.connect(target / "langgraph.sqlite").execute("select v from t").fetchone() == ("row",)
    kept = sorted(p.name for p in (harness / "backups").iterdir())
    assert kept == ["1.1.0", "1.2.0"]
    assert (harness / "app-version").read_text().strip() == "1.3.0"
    assert (harness / "config.json").read_text() == '{"a": 1}'  # the live files are untouched
