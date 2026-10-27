"""Warn (never block) when the Vault lives where SQLite's WAL is unsafe."""

from __future__ import annotations

import os
from pathlib import Path

from learnharness.core.sync_hint import is_network_fstype, mount_for, sync_folder_in


def _mounts(source: Path = Path("/proc/self/mounts")) -> list[tuple[str, str]]:
    try:
        lines = source.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    mounts = []
    for line in lines:
        fields = line.split()
        if len(fields) >= 3:
            # Mount points encode spaces as \040.
            mounts.append((fields[1].replace("\\040", " "), fields[2]))
    return mounts


def vault_location_warning(vault: Path, mounts_file: Path | None = None) -> str | None:
    path = os.path.realpath(vault)
    folder = sync_folder_in(Path(path).parts)
    if folder:
        return (
            f"The Vault is inside '{folder}', which looks like a synced folder. "
            "The sync client can corrupt the SQLite database in .harness/; "
            "prefer a local folder and sync the notes some other way."
        )
    fstype = mount_for(path, _mounts(mounts_file) if mounts_file else _mounts())
    if fstype and is_network_fstype(fstype):
        return (
            f"The Vault is on a network or FUSE filesystem ({fstype}). "
            "SQLite's write-ahead log is not safe there; prefer a local disk."
        )
    return None
