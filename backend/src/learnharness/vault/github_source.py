"""GitHub repositories as read-only educational sources (shallow clone cache + import).

Security model:
* Only ``https://github.com/<owner>/<repo>[.git][/tree/<ref>[/<subpath>]|/blob/<ref>/<path>]``
  is accepted; every component is validated before it reaches ``git`` (argv only, never a
  shell, with ``--`` before positional arguments).
* ``git`` runs with a scrubbed environment (no inherited ``GIT_*``, no askpass,
  ``GIT_TERMINAL_PROMPT=0``), only the URL's protocol allowed, symlinks checked out as
  plain files, no submodules, a timeout and a size budget enforced while cloning.
* A token (``GITHUB_TOKEN``/``GH_TOKEN`` or ``gh auth token``) is passed through
  ``GIT_CONFIG_*`` environment variables scoped to ``https://github.com/``: it never
  appears in argv, in ``.git/config`` or in error messages (redacted).
* Repository content is data: it is copied verbatim into ``Fontes/`` and never executed.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlsplit
from uuid import uuid4

from learnharness.child_env import child_env
from learnharness.core.frontmatter import frontmatter_data, strip_frontmatter
from learnharness.core.repo_paths import GENERIC_STEMS, LANGUAGE_STEMS
from learnharness.vault.safety import folder_map, safe_component, safe_path
from learnharness.vault.transcript_importer import import_transcript_text

CLONE_TIMEOUT_SECONDS = 120.0
LS_REMOTE_TIMEOUT_SECONDS = 30.0
MAX_REPO_BYTES = 500 * 1024 * 1024  # curricula ship images/notebooks; 200 MB was too tight
MAX_FILE_BYTES = 1024 * 1024
MAX_FILES = 10000  # real curricula (e.g. ai-engineering-from-scratch) exceed 3k docs
TEXT_EXTENSIONS = {".md", ".markdown", ".txt", ".ipynb"}
SKIPPED_DIRS = {"node_modules", "__pycache__"}
REPOS_DIR = ".harness/repos"

_OWNER = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_REPO = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$")
_REF_CHARS = re.compile(r"^[A-Za-z0-9._/+-]{1,255}$")
_SHA = re.compile(r"^[0-9a-f]{40}$")


class GitHubSourceError(Exception):
    """Import failure with an HTTP-friendly status; messages are always redacted."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(redact(message))
        self.status_code = status_code


@dataclass(frozen=True)
class GitHubUrl:
    owner: str
    repo: str
    kind: str  # "repo" | "tree" | "blob"
    tail: tuple[str, ...] = ()


@dataclass
class RepoFile:
    path: str
    title: str
    size: int


@dataclass
class RepoClone:
    owner: str
    repo: str
    ref: str | None  # requested ref (None = default branch)
    resolved_ref: str  # branch/tag/sha actually checked out
    commit: str
    subpath: str
    is_file: bool
    root: Path
    files: list[RepoFile] = field(default_factory=list)
    truncated: bool = False

    def preview(self) -> dict[str, Any]:
        return {
            "repo": {
                "owner": self.owner,
                "name": self.repo,
                "ref": self.resolved_ref,
                "commit": self.commit,
                "subpath": self.subpath,
            },
            "files": [{"path": f.path, "title": f.title, "size": f.size} for f in self.files],
            "truncated": self.truncated,
        }

    @property
    def content_root(self) -> Path:
        """Directory a curriculum track should read (the subpath when it is a folder)."""
        if self.subpath and not self.is_file:
            return safe_path(self.root, self.subpath)
        return self.root


# ---------------------------------------------------------------------------
# URL parsing (pure)
# ---------------------------------------------------------------------------


def _valid_ref(ref: str) -> bool:
    if not _REF_CHARS.match(ref) or ref.startswith(("-", "/")) or ref.endswith(("/", ".lock", ".")):
        return False
    return ".." not in ref and "//" not in ref and not any(c.startswith(".") for c in ref.split("/"))


def _valid_path_segment(segment: str) -> bool:
    return (
        bool(segment)
        and segment not in {".", ".."}
        and not any(ord(c) < 32 or c in "\\\x7f" for c in segment)
    )


def parse_github_url(url: str) -> GitHubUrl:
    """Strictly parse a public GitHub web URL; raise ``GitHubSourceError`` on anything else."""
    if not isinstance(url, str) or len(url) > 2048:
        raise GitHubSourceError("Invalid GitHub URL")
    url = url.strip()
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise GitHubSourceError("Invalid GitHub URL") from exc
    if parts.scheme != "https" or parts.netloc.lower() not in {"github.com", "www.github.com"}:
        raise GitHubSourceError("Only https://github.com/<owner>/<repo> URLs are supported")
    raw_segments = parts.path.split("/")
    if raw_segments and raw_segments[0] == "":
        raw_segments = raw_segments[1:]
    if raw_segments and raw_segments[-1] == "":
        raw_segments = raw_segments[:-1]
    segments = [unquote(s) for s in raw_segments]
    if len(segments) < 2:
        raise GitHubSourceError("URL must name an owner and a repository")
    owner, repo = segments[0], segments[1]
    if len(segments) == 2 and repo.endswith(".git"):
        repo = repo[:-4]
    if not _OWNER.match(owner) or not _REPO.match(repo) or repo in {".", ".."}:
        raise GitHubSourceError("Invalid GitHub owner or repository name")
    rest = segments[2:]
    if not rest:
        return GitHubUrl(owner, repo, "repo")
    kind = rest[0]
    tail = tuple(rest[1:])
    if kind not in {"tree", "blob"} or not tail:
        raise GitHubSourceError("Only repository, /tree/<ref> and /blob/<ref>/<path> URLs are supported")
    if not all(_valid_path_segment(s) for s in tail):
        raise GitHubSourceError("Invalid path in GitHub URL")
    if kind == "blob" and len(tail) < 2:
        raise GitHubSourceError("A /blob/ URL must include a file path")
    if not any(_valid_ref("/".join(tail[:i])) for i in range(1, len(tail) + 1)):
        raise GitHubSourceError("Invalid git ref in GitHub URL")
    return GitHubUrl(owner, repo, kind, tail)


def ref_candidates(parsed: GitHubUrl) -> list[tuple[str, str]]:
    """All valid (ref, subpath) splits of the URL tail, shortest ref first."""
    result = []
    limit = len(parsed.tail) - 1 if parsed.kind == "blob" else len(parsed.tail)
    for i in range(1, limit + 1):
        ref = "/".join(parsed.tail[:i])
        if _valid_ref(ref):
            result.append((ref, "/".join(parsed.tail[i:])))
    return result


# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

_known_secrets: set[str] = set()


def redact(text: str) -> str:
    for secret in sorted(_known_secrets, key=len, reverse=True):
        text = text.replace(secret, "[redacted]")
    text = re.sub(r"(?i)(authorization:\s*(?:basic|bearer)\s+)\S+", r"\1[redacted]", text)
    text = re.sub(r"https://[^/\s:@]+:[^/\s@]+@", "https://[redacted]@", text)
    return text[:2000]


def _remember_secret(token: str) -> None:
    _known_secrets.add(token)
    _known_secrets.add(base64.b64encode(f"x-access-token:{token}".encode()).decode())


async def github_token() -> str | None:
    """GITHUB_TOKEN / GH_TOKEN, else ``gh auth token`` when the GitHub CLI is logged in."""
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token and shutil.which("gh"):
        try:
            proc = await asyncio.create_subprocess_exec(
                "gh", "auth", "token",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=child_env(),
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            token = out.decode().strip() if proc.returncode == 0 else None
        except (OSError, TimeoutError):
            token = None
    return token or None


# ---------------------------------------------------------------------------
# Clone source resolution (tests replace this hook to map to a local bare repo)
# ---------------------------------------------------------------------------


def default_clone_url(owner: str, repo: str) -> str:
    return f"https://github.com/{owner}/{repo}.git"


# Test-only override point: ``(owner, repo) -> url``. Production never sets it, and
# ``parse_github_url`` still rejects any non-GitHub URL coming from users.
clone_url_resolver = default_clone_url


# ---------------------------------------------------------------------------
# git subprocesses
# ---------------------------------------------------------------------------


def _dir_size(root: Path) -> int:
    total = 0
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
        except FileNotFoundError:
            continue
    return total


def _base_env() -> dict[str, str]:
    env = {k: v for k, v in child_env().items() if not k.startswith(("GIT_", "SSH_ASKPASS"))}
    env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1", "LC_ALL": "C"})
    return env


async def _git_env(url: str) -> dict[str, str]:
    env = _base_env()
    scheme = urlsplit(url).scheme or "file"
    # Only the protocol of the validated URL is allowed (https in production).
    config = [("protocol.allow", "never"), (f"protocol.{scheme}.allow", "always")]
    token = await github_token()
    if token:
        _remember_secret(token)
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        config.append(("http.https://github.com/.extraHeader", f"Authorization: Basic {basic}"))
    env["GIT_CONFIG_COUNT"] = str(len(config))
    for i, (key, value) in enumerate(config):
        env[f"GIT_CONFIG_KEY_{i}"] = key
        env[f"GIT_CONFIG_VALUE_{i}"] = value
    return env


async def _run_git(
    args: list[str],
    *,
    env: dict[str, str],
    cwd: Path | None = None,
    timeout: float = CLONE_TIMEOUT_SECONDS,
    watch: Path | None = None,
) -> str:
    git = shutil.which("git")
    if not git:
        raise GitHubSourceError("git is not installed", 500)
    proc = await asyncio.create_subprocess_exec(
        git, *args,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    task = asyncio.ensure_future(proc.communicate())
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    failure: GitHubSourceError | None = None
    while not task.done():
        await asyncio.wait({task}, timeout=min(1.0, max(0.0, deadline - loop.time())))
        if task.done():
            break
        if loop.time() >= deadline:
            failure = GitHubSourceError("git timed out", 504)
        elif watch is not None and _dir_size(watch) > MAX_REPO_BYTES:
            failure = GitHubSourceError("Repository exceeds the size limit", 413)
        if failure:
            with contextlib.suppress(ProcessLookupError):  # git may have just exited
                proc.kill()
            await asyncio.gather(task, return_exceptions=True)
            raise failure
    stdout, stderr = task.result()
    if proc.returncode != 0:
        message = stderr.decode("utf-8", "replace").strip().splitlines()
        fatal = [line for line in message if line.startswith(("fatal:", "error:"))]
        detail = (fatal or message or [f"exit {proc.returncode}"])[0]
        missing = r"not found|could not read Username|couldn't find remote ref|does not appear to be a git repository"
        status = 404 if re.search(missing, detail, re.I) else 502
        raise GitHubSourceError(f"git {args[0]} failed: {detail}", status)
    return stdout.decode("utf-8", "replace")


async def resolve_ref(parsed: GitHubUrl) -> tuple[str | None, str]:
    """Return (ref, subpath). Slashed refs are disambiguated with ``git ls-remote``."""
    if parsed.kind == "repo":
        return None, ""
    candidates = ref_candidates(parsed)
    if not candidates:
        raise GitHubSourceError("Invalid git ref in GitHub URL")
    if len(candidates) == 1 or _SHA.match(candidates[0][0]):
        return candidates[0]
    url = clone_url_resolver(parsed.owner, parsed.repo)
    env = await _git_env(url)
    output = await _run_git(
        ["ls-remote", "--heads", "--tags", "--", url], env=env, timeout=LS_REMOTE_TIMEOUT_SECONDS
    )
    names = set()
    for line in output.splitlines():
        _, _, name = line.partition("\t")
        name = name.removesuffix("^{}")
        for prefix in ("refs/heads/", "refs/tags/"):
            if name.startswith(prefix):
                names.add(name[len(prefix):])
    for ref, subpath in candidates:
        if ref in names:
            return ref, subpath
    raise GitHubSourceError("Branch or tag not found in repository", 404)


_locks: dict[str, asyncio.Lock] = {}


def _cache_dir(vault: Path, owner: str, repo: str, ref: str | None) -> Path:
    name = safe_component(f"{owner}__{repo}@{quote(ref, safe='') if ref else 'default'}")
    return safe_path(vault, f"{REPOS_DIR}/{name}")


async def _clone_into(url: str, target: Path, ref: str | None) -> None:
    env = await _git_env(url)
    if ref and _SHA.match(ref):
        await _run_git(["init", "-q", "--", str(target)], env=env)
        await _run_git(["config", "core.symlinks", "false"], env=env, cwd=target)
        await _run_git(
            ["fetch", "-q", "--depth", "1", "--no-recurse-submodules", "--no-tags", "--", url, ref],
            env=env, cwd=target, watch=target,
        )
        await _run_git(["checkout", "-q", "--detach", "FETCH_HEAD"], env=env, cwd=target, watch=target)
        return
    args = [
        "clone", "-q", "--depth", "1", "--single-branch", "--no-recurse-submodules", "--no-tags",
        "--config", "core.symlinks=false",
    ]
    if ref:
        args += ["--branch", ref]
    await _run_git([*args, "--", url, str(target)], env=env, watch=target)


async def remote_commit(url: str, ref: str | None) -> str | None:
    """Commit the remote currently serves for ``ref`` (default branch when ``None``).

    One cheap ``git ls-remote`` call; ``None`` when the ref is not advertised. A 40-hex ``ref``
    is immutable and is returned as-is without touching the network.
    """
    if ref and _SHA.match(ref):
        return ref
    env = await _git_env(url)
    patterns = ["HEAD"] if not ref else [f"refs/heads/{ref}", f"refs/tags/{ref}", f"refs/tags/{ref}^{{}}"]
    output = await _run_git(["ls-remote", "--", url, *patterns], env=env, timeout=LS_REMOTE_TIMEOUT_SECONDS)
    advertised: dict[str, str] = {}
    for line in output.splitlines():
        sha, _, name = line.partition("\t")
        if _SHA.match(sha.strip()):
            advertised[name.strip()] = sha.strip()
    # A clone of an annotated tag checks out the peeled commit, so prefer ``^{}``.
    for name in ([*patterns[2:], *patterns[:2]] if ref else patterns):
        if name in advertised:
            return advertised[name]
    return None


async def _cached_commit(target: Path) -> str | None:
    """HEAD of a cached checkout, or ``None`` when the cache is missing or corrupt."""
    if not (target / ".git").is_dir():
        return None
    try:
        commit = (await _run_git(["rev-parse", "--verify", "HEAD"], env=_base_env(), cwd=target, timeout=15)).strip()
    except GitHubSourceError:
        return None
    return commit if _SHA.match(commit) else None


_LISTING_CACHE_SIZE = 16
_LISTINGS: dict[tuple[str, str, str], tuple[list[RepoFile], bool]] = {}


async def ensure_clone(
    vault: Path, url: str, *, refresh: bool = False, revalidate: bool = False
) -> RepoClone:
    """Clone (or reuse) the repository behind a GitHub URL and list its text files.

    * ``refresh=True`` always re-clones.
    * ``revalidate=True`` asks the remote (one ``git ls-remote``) which commit the ref points
      to and re-clones only when it differs from the cached checkout; when the remote cannot
      be reached the cached checkout is reused (local-first).
    * otherwise an existing, healthy cache is reused without any network call.

    Re-clones go into a temporary directory that is swapped in atomically under a per-cache
    lock, so a concurrent reader never observes a half-written checkout.
    """
    vault = Path(vault).resolve()
    parsed = parse_github_url(url)
    ref, subpath = await resolve_ref(parsed)
    target = _cache_dir(vault, parsed.owner, parsed.repo, ref)
    clone_url = clone_url_resolver(parsed.owner, parsed.repo)
    lock = _locks.setdefault(str(target), asyncio.Lock())
    async with lock:
        cached = await _cached_commit(target)
        stale = refresh or cached is None
        if not stale and revalidate:
            try:
                upstream = await remote_commit(clone_url, ref)
            except GitHubSourceError:
                upstream = cached  # offline or transient failure: keep serving the cache
            stale = upstream != cached
        if stale:
            repos = safe_path(vault, REPOS_DIR)
            repos.mkdir(parents=True, exist_ok=True)
            tmp = repos / f".tmp-{uuid4().hex}"
            try:
                await _clone_into(clone_url, tmp, ref)
                if _dir_size(tmp) > MAX_REPO_BYTES:
                    raise GitHubSourceError("Repository exceeds the size limit", 413)
                trash = repos / f".trash-{uuid4().hex}"
                if target.exists():
                    target.rename(trash)
                tmp.rename(target)
                shutil.rmtree(trash, ignore_errors=True)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        env = _base_env()
        commit = (await _run_git(["rev-parse", "HEAD"], env=env, cwd=target, timeout=15)).strip()
        resolved = ref
        if not resolved:
            branch = (await _run_git(["rev-parse", "--abbrev-ref", "HEAD"], env=env, cwd=target, timeout=15)).strip()
            resolved = branch if branch != "HEAD" else commit
    clone = RepoClone(
        owner=parsed.owner, repo=parsed.repo, ref=ref, resolved_ref=resolved, commit=commit,
        subpath=subpath, is_file=parsed.kind == "blob", root=target,
    )
    key = (str(target), commit, subpath)
    if key not in _LISTINGS:
        # A clone at a fixed commit never changes: list (and title) its files once, off the
        # event loop, instead of on every preview/import/track request.
        _LISTINGS[key] = await asyncio.to_thread(list_repo_files, target, subpath)
        while len(_LISTINGS) > _LISTING_CACHE_SIZE:
            _LISTINGS.pop(next(iter(_LISTINGS)))
    files, clone.truncated = _LISTINGS[key]
    clone.files = list(files)
    if subpath and not clone.files and not safe_path(target, subpath).exists():
        raise GitHubSourceError("Path not found in repository", 404)
    return clone


# ---------------------------------------------------------------------------
# Listing and conversion (filesystem only, nothing is executed)
# ---------------------------------------------------------------------------


def _first_heading(text: str) -> str | None:
    in_fence = False
    for line in strip_frontmatter(text).splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        match = re.match(r"^#\s+(.+?)\s*#*\s*$", line)
        if match and not in_fence:
            return match.group(1).strip()
    return None


def notebook_to_markdown(raw: str) -> str:
    """Markdown cells verbatim, code cells fenced; outputs are dropped and nothing runs."""
    data = json.loads(raw)
    if not isinstance(data, dict) or not isinstance(data.get("cells"), list):
        raise ValueError("Not a Jupyter notebook")
    metadata = data.get("metadata") or {}
    language = (
        (metadata.get("kernelspec") or {}).get("language")
        or (metadata.get("language_info") or {}).get("name")
        or "python"
    )
    language = re.sub(r"[^A-Za-z0-9_+-]", "", str(language)) or "python"
    blocks = []
    for cell in data["cells"]:
        if not isinstance(cell, dict):
            continue
        source = cell.get("source", "")
        text = "".join(source) if isinstance(source, list) else str(source)
        if not text.strip():
            continue
        if cell.get("cell_type") == "markdown":
            blocks.append(text.strip("\n"))
        elif cell.get("cell_type") == "code":
            fence = "````" if "```" in text else "```"
            blocks.append(f"{fence}{language}\n{text.strip(chr(10))}\n{fence}")
    return "\n\n".join(blocks)


def read_repo_text(root: Path, relative: str) -> str:
    path = safe_path(root, relative)
    if path.is_symlink() or not path.is_file():
        raise GitHubSourceError("File not found in repository", 404)
    if path.stat().st_size > MAX_FILE_BYTES:
        raise GitHubSourceError("File exceeds the size limit", 413)
    raw = path.read_bytes().decode("utf-8", "replace")
    if path.suffix.lower() == ".ipynb":
        return notebook_to_markdown(raw)
    return raw


def _title_for(root: Path, relative: str) -> str:
    stem = Path(relative).stem
    try:
        text = read_repo_text(root, relative)
    except (GitHubSourceError, ValueError, OSError):
        return stem
    if Path(relative).suffix.lower() == ".txt":
        return stem
    return _first_heading(text) or stem


def list_repo_files(root: Path, subpath: str = "") -> tuple[list[RepoFile], bool]:
    """Eligible text files under ``subpath`` (repo-relative POSIX paths, sorted)."""
    root = Path(root).resolve()
    base = safe_path(root, subpath) if subpath else root
    if base.is_symlink():
        return [], False
    candidates: list[Path] = []
    if base.is_file():
        candidates = [base]
    elif base.is_dir():
        for current, dirs, files in os.walk(base):
            dirs[:] = sorted(
                d for d in dirs
                if not d.startswith(".") and d not in SKIPPED_DIRS and not Path(current, d).is_symlink()
            )
            candidates.extend(Path(current, name) for name in sorted(files))
    result: list[RepoFile] = []
    truncated = False
    for path in candidates:
        if path.suffix.lower() not in TEXT_EXTENSIONS or path.name.startswith(".") or path.is_symlink():
            continue
        size = path.stat().st_size
        if size > MAX_FILE_BYTES or not path.resolve().is_relative_to(root):
            continue
        if len(result) >= MAX_FILES:
            truncated = True
            break
        relative = path.relative_to(root).as_posix()
        result.append(RepoFile(path=relative, title=_title_for(root, relative), size=size))
    return result, truncated


# ---------------------------------------------------------------------------
# Import into Fontes/
# ---------------------------------------------------------------------------


# GENERIC_STEMS / LANGUAGE_STEMS (core/repo_paths): basenames that say nothing about the
# lesson. Obsidian resolves [[name#^pN]] by basename, so hundreds of "docs/en.md" would clash.


def source_basename(relative: str) -> str:
    """Readable, mostly vault-unique note name for a repository file."""
    parts = [p for p in Path(relative).with_suffix("").parts]
    stem = parts[-1]
    lang = stem.lower() if stem.lower() in LANGUAGE_STEMS else None
    meaningful = [p for p in parts if p.lower() not in GENERIC_STEMS | LANGUAGE_STEMS]
    if not meaningful:
        return stem
    if stem.lower() in GENERIC_STEMS | LANGUAGE_STEMS:
        # e.g. phases/07-x/02-self-attention/docs/en.md -> "02-self-attention (en)"
        name = meaningful[-1]
        return f"{name} ({lang})" if lang else name
    return stem


def _repo_path_of(note: Path) -> str | None:
    value = frontmatter_data(note.read_text(encoding="utf-8", errors="replace")).get("repo_path")
    return value if isinstance(value, str) else None


def _source_index(vault: Path) -> dict[str, list[Path]]:
    """Basename (stem) → source files, built once per import (one walk of ``Fontes/``)."""
    sources = safe_path(vault, folder_map(vault).sources_dir)
    index: dict[str, list[Path]] = {}
    if sources.exists():
        for f in sources.rglob("*.md"):
            index.setdefault(f.stem, []).append(f)
    return index


def _unique_basename(index: dict[str, list[Path]], name: str, relative: str) -> str:
    """Prefix the nearest meaningful ancestor while another source already uses the name.

    Exact stem lookup in ``index`` (no glob: names may contain ``[`` ``*`` ``?``).
    """
    ancestors = [p for p in Path(relative).parent.parts if p.lower() not in GENERIC_STEMS | LANGUAGE_STEMS]
    if ancestors and name.split(" (")[0] == ancestors[-1]:
        ancestors.pop()  # already the basis of the name (generic stem case)
    candidate = name
    while ancestors:
        clash = [f for f in index.get(candidate, []) if _repo_path_of(f) != relative]
        if not clash:
            return candidate
        candidate = f"{ancestors.pop()} - {candidate}"
    return candidate


def import_repo_files(vault: Path, clone: RepoClone, paths: list[str]) -> list[dict[str, Any]]:
    """Copy listed files verbatim into ``Fontes/GitHub/<owner>-<repo>/<dirs>/<stem>.md``."""
    listed = {f.path: f for f in clone.files}
    unknown = [p for p in paths if p not in listed]
    if unknown:
        raise GitHubSourceError(f"Paths are not in the repository listing: {unknown[:5]}", 422)
    vault = Path(vault).resolve()
    index = _source_index(vault)
    imported = []
    for relative in dict.fromkeys(paths):
        text = read_repo_text(clone.root, relative)
        if not text.strip():
            continue
        parent = Path(relative).parent.parts
        subdir = "/".join(["GitHub", f"{clone.owner}-{clone.repo}", *parent])
        entry = listed[relative]
        target, count = import_transcript_text(
            vault,
            text,
            entry.title,
            tipo="fonte",
            force=True,
            subdir=subdir,
            filename=_unique_basename(index, source_basename(relative), relative),
            provenance={
                "source_kind": "github",
                "source_url": f"https://github.com/{clone.owner}/{clone.repo}/blob/{clone.commit}/{quote(relative)}",
                "repo": f"{clone.owner}/{clone.repo}",
                "commit": clone.commit,
                "repo_path": relative,
                "origem": "GitHub",
            },
        )
        index.setdefault(target.stem, []).append(target)
        imported.append({
            "source_path": target.relative_to(vault).as_posix(),
            "paragraph_count": count,
            "title": entry.title,
        })
    return imported
