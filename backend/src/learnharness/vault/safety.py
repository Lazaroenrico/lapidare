"""Confinement, cooperative locks and atomic writes for vault adapters."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

from learnharness.core.contracts.config import VaultFolderMap


class RevisionConflictError(RuntimeError):
    """The document changed since the caller read it."""


def safe_path(root: Path, relative: str | Path) -> Path:
    root = Path(root).resolve()
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative):
        raise PermissionError("Vault paths must be relative and cannot traverse parents")
    candidate = root / relative
    # Reject symlinks, including internal aliases, so writes cannot cross ownership boundaries.
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise PermissionError(f"Symlinks are not writable vault paths: {relative}")
    if not candidate.resolve().is_relative_to(root):
        raise PermissionError("Path escapes vault")
    return candidate


def safe_component(value: str) -> str:
    if not value.strip() or value in {".", ".."} or any(c in value for c in "/\\\x00"):
        raise ValueError("Expected a nonempty filename component")
    return value


def validate_folders(root: Path, folders: VaultFolderMap) -> None:
    """Keep machine state, immutable sources and editable documents disjoint."""
    paths = {}
    for key, value in folders.model_dump().items():
        if not value.strip() or Path(value) == Path("."):
            raise ValueError("Folder mappings cannot name the vault root")
        paths[key] = safe_path(root, value)
    machine = safe_path(root, ".harness")
    sources = {safe_path(root, name) for name in (folders.sources_dir, "Fontes", "Sources")}
    for key, path in paths.items():
        if path.is_relative_to(machine) or machine.is_relative_to(path):
            raise PermissionError("Human folders cannot overlap machine storage")
        if key != "sources_dir":
            for source in sources:
                if path.is_relative_to(source) or source.is_relative_to(path):
                    raise PermissionError("Writable folders cannot overlap immutable sources")


def ensure_not_source(root: Path, target: Path, folders: VaultFolderMap) -> None:
    """Refuse any write under the immutable sources folder (configured, ``Fontes`` or ``Sources``)."""
    for source in {folders.sources_dir, "Fontes", "Sources"}:
        if target.is_relative_to(safe_path(root, source)):
            raise PermissionError("Fontes/ is strictly read-only")


_FOLDERS_CACHE: dict[Path, tuple[tuple[int, int, int], VaultFolderMap]] = {}


def folder_map(root: Path) -> VaultFolderMap:
    config = safe_path(root, ".harness/config.json")
    try:
        st = config.stat()
    except FileNotFoundError:
        st = None
    if st is not None:
        # Re-read only when config.json was replaced (every save is an atomic rename).
        key = (st.st_ino, st.st_size, st.st_mtime_ns)
        cached = _FOLDERS_CACHE.get(config)
        if cached is None or cached[0] != key:
            folders = VaultFolderMap.model_validate(json.loads(config.read_text()).get("folders", {}))
            validate_folders(root, folders)
            cached = _FOLDERS_CACHE[config] = (key, folders)
        return cached[1].model_copy()
    folders = VaultFolderMap()
    for name, english in [
        ("lessons_dir", "Lessons"),
        ("concepts_dir", "Concepts"),
        ("sources_dir", "Sources"),
        ("drawings_dir", "Drawings"),
    ]:
        if not (Path(root) / getattr(folders, name)).exists() and (Path(root) / english).exists():
            setattr(folders, name, english)
    validate_folders(root, folders)
    return folders


def revision(content: str | bytes) -> str:
    return hashlib.sha256(
        content.encode("utf-8") if isinstance(content, str) else content
    ).hexdigest()


_locks: dict[str, threading.RLock] = {}
_lock_guard = threading.Lock()
_held = threading.local()


@contextmanager
def locked_path(path: Path):
    """Serialize cooperating writers across threads and processes without touching the note."""
    key = str(path.absolute())
    with _lock_guard:
        lock = _locks.setdefault(key, threading.RLock())
    with lock:
        held = getattr(_held, 'paths', None)
        if held is None:
            held = _held.paths = set()
        if key in held:
            yield
            return
        lock_dir = Path(tempfile.gettempdir()) / f"learnharness-locks-{os.getuid()}"
        lock_dir.mkdir(mode=0o700, exist_ok=True)
        lock_path = lock_dir / revision(key)
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            held.add(key)
            yield
        finally:
            held.discard(key)
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def atomic_write(
    path: Path,
    content: str | bytes,
    *,
    expected_revision: str | None = None,
    create_only: bool = False,
) -> None:
    """Atomically publish; callers hold locked_path around read/modify/write operations."""
    # Validate every ancestor, even for internal callers without an explicit vault root.
    safe_path(Path(path.anchor), path.relative_to(path.anchor))
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = content.encode("utf-8") if isinstance(content, str) else content
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if expected_revision is not None:
            actual = revision(path.read_bytes()) if path.exists() else None
            if actual != expected_revision:
                raise RevisionConflictError("Document changed; reload before saving")
        if create_only:
            os.link(temporary, path)
        else:
            if path.exists():
                os.chmod(temporary, path.stat().st_mode & 0o777)
            os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def append_line(path: Path, line: str) -> None:
    with locked_path(path):
        safe_path(Path(path.anchor), path.relative_to(path.anchor))
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            payload = line.encode("utf-8")
            while payload:
                written = os.write(fd, payload)
                payload = payload[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
