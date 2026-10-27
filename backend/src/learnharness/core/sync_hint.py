"""Classify Vault locations where SQLite's WAL is not safe (pure)."""

from __future__ import annotations

from collections.abc import Iterable, Sequence

# Lower-cased folder-name prefixes used by file-sync clients.
SYNC_FOLDER_PREFIXES = (
    "dropbox",
    "onedrive",
    "google drive",
    "googledrive",
    "my drive",
    "syncthing",
    "icloud",
    "nextcloud",
    "megasync",
)
SYNC_FOLDER_NAMES = ("sync", "mega", "mobile documents", "cloudstation")
NETWORK_FSTYPES = {"nfs", "nfs4", "cifs", "smb", "smb2", "smb3", "smbfs", "sshfs", "9p", "afs", "ceph", "glusterfs"}


def sync_folder_in(parts: Sequence[str]) -> str | None:
    """The first path component that names a sync client's folder, if any."""
    for part in parts:
        lowered = part.lower()
        if lowered in SYNC_FOLDER_NAMES or lowered.startswith(SYNC_FOLDER_PREFIXES):
            return part
    return None


def is_network_fstype(fstype: str) -> bool:
    lowered = fstype.lower()
    return lowered in NETWORK_FSTYPES or (lowered.startswith("fuse.") and lowered != "fuse.portal")


def mount_for(path: str, mounts: Iterable[tuple[str, str]]) -> str | None:
    """Filesystem type of the longest mount point containing ``path``."""
    best: tuple[int, str] | None = None
    for point, fstype in mounts:
        prefix = point.rstrip("/")
        inside = path == point or path.startswith(prefix + "/")
        if inside and (best is None or len(point) > best[0]):
            best = (len(point), fstype)
    return best[1] if best else None
