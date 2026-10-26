"""Preview reuses the cached clone while ``git ls-remote`` reports the same commit."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from learnharness.vault import github_source

URL = "https://github.com/acme/cached"


def _git(cwd: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_NOSYSTEM": "1", "HOME": str(cwd)})
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True,
                          text=True).stdout


def _commit(work: Path, rel: str, text: str) -> None:
    path = work / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", rel)


@pytest.fixture
def remote(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, list[str]]:
    """Fresh upstream (work tree pushing to a bare repo) and a log of clone invocations."""
    work = tmp_path / "work"
    work.mkdir()
    _git(work, "init", "-q", "-b", "main")
    _commit(work, "README.md", "# Curso\n\nBem-vindo.")
    bare = tmp_path / "cached.git"
    _git(work, "clone", "-q", "--bare", str(work), str(bare))
    _git(work, "remote", "add", "origin", str(bare))

    clones: list[str] = []
    real_clone = github_source._clone_into

    async def counting_clone(url: str, target: Path, ref: str | None) -> None:
        clones.append(url)
        await real_clone(url, target, ref)

    async def no_token() -> None:
        return None

    monkeypatch.setattr(github_source, "clone_url_resolver", lambda owner, repo: bare.as_uri())
    monkeypatch.setattr(github_source, "github_token", no_token)
    monkeypatch.setattr(github_source, "_clone_into", counting_clone)
    return work, clones


def test_second_preview_reuses_cache(api_client: TestClient, remote: tuple[Path, list[str]]) -> None:
    _, clones = remote
    first = api_client.post("/api/import/github/preview", json={"url": URL})
    assert first.status_code == 200, first.text
    second = api_client.post("/api/import/github/preview", json={"url": URL})
    assert second.status_code == 200, second.text
    assert len(clones) == 1
    assert second.json() == first.json()


def test_new_upstream_commit_triggers_reclone(api_client: TestClient,
                                              remote: tuple[Path, list[str]]) -> None:
    work, clones = remote
    first = api_client.post("/api/import/github/preview", json={"url": URL}).json()
    _commit(work, "lessons/02.md", "# Nova lição\n\nTexto.")
    _git(work, "push", "-q", "origin", "main")
    second = api_client.post("/api/import/github/preview", json={"url": URL}).json()
    assert len(clones) == 2
    assert second["repo"]["commit"] != first["repo"]["commit"]
    assert "lessons/02.md" in {f["path"] for f in second["files"]}


def test_refresh_flag_and_corrupt_cache_force_reclone(api_client: TestClient, configured_vault: Path,
                                                      remote: tuple[Path, list[str]]) -> None:
    _, clones = remote
    assert api_client.post("/api/import/github/preview", json={"url": URL}).status_code == 200
    res = api_client.post("/api/import/github/preview", json={"url": URL, "refresh": True})
    assert res.status_code == 200 and len(clones) == 2
    # A cache whose .git lost HEAD is treated as missing.
    (configured_vault / ".harness/repos/acme__cached@default/.git/HEAD").unlink()
    res = api_client.post("/api/import/github/preview", json={"url": URL})
    assert res.status_code == 200, res.text
    assert len(clones) == 3


def test_import_reuses_cache_without_network(api_client: TestClient,
                                             remote: tuple[Path, list[str]]) -> None:
    _, clones = remote
    api_client.post("/api/import/github/preview", json={"url": URL})
    res = api_client.post("/api/import/github/import", json={"url": URL, "paths": ["README.md"]})
    assert res.status_code == 200, res.text
    assert len(clones) == 1
