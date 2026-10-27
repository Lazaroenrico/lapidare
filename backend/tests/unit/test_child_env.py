"""Subprocesses never inherit packaging variables or the desktop secret."""

from learnharness.child_env import child_env


def test_strips_packaging_and_secret_variables():
    base = {
        "PATH": "/usr/bin", "HOME": "/home/u", "APPDIR": "/tmp/.mount_x", "APPIMAGE": "/a.AppImage",
        "ARGV0": "x", "OWD": "/", "PYTHONHOME": "/py", "PYTHONPATH": "/py/lib", "LD_LIBRARY_PATH": "/tmp/.mount_x/lib",
        "ELECTRON_RUN_AS_NODE": "1", "ELECTRON_FOO": "2",
        "LEARNHARNESS_DESKTOP_SECRET": "s3cret", "LEARNHARNESS_ORIG_LD_LIBRARY_PATH": "",
    }
    env = child_env(base=base)
    assert env == {"PATH": "/usr/bin", "HOME": "/home/u"}


def test_restores_original_ld_library_path():
    base = {"LD_LIBRARY_PATH": "/bundle", "LEARNHARNESS_ORIG_LD_LIBRARY_PATH": "/usr/lib/custom"}
    assert child_env(base=base) == {"LD_LIBRARY_PATH": "/usr/lib/custom"}


def test_keeps_users_ld_library_path_in_dev():
    assert child_env(base={"LD_LIBRARY_PATH": "/opt/lib"}) == {"LD_LIBRARY_PATH": "/opt/lib"}


def test_extra_wins_and_default_base_is_os_environ(monkeypatch):
    monkeypatch.setenv("LEARNHARNESS_DESKTOP_SECRET", "s3cret")
    monkeypatch.setenv("PATH", "/usr/bin")
    env = child_env({"PATH": "/custom", "X": "1"})
    assert env["PATH"] == "/custom" and env["X"] == "1"
    assert "LEARNHARNESS_DESKTOP_SECRET" not in env
