"""GitHub and local-file import routes, against a local bare git repository (no network).

``github_source.clone_url_resolver`` is the test-only hook mapping ``acme/course`` to a
``file://`` bare repository; user-facing URL parsing still rejects ``file://``.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml
from starlette.testclient import TestClient

from learnharness.core.contracts.config import TrackConfig, TrackItem
from learnharness.services.tracks import GeneratedTrack
from learnharness.vault import github_source
from learnharness.vault.bootstrap import load_config, save_config
from tests.conftest import FakeEngine, poll_until

REPO_URL = "https://github.com/acme/course"

LESSON = """# Introdução a Tokens

Um token é a unidade mínima que o modelo processa.

```python
tokens = tokenize("olá")

print(tokens)
```

Fim da lição."""


def _git(cwd: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_NOSYSTEM": "1", "HOME": str(cwd)})
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True,
                          text=True).stdout


@pytest.fixture(scope="module")
def bare_repo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    work = tmp_path_factory.mktemp("work")
    _git(work, "init", "-q", "-b", "main")
    files = {
        "README.md": "# Curso de IA\n\nBem-vindo ao curso.",
        "lessons/01-intro.md": LESSON,
        "lessons/notes.txt": "Notas soltas.\n\nSegundo parágrafo.",
        "lessons/big.md": "# Grande\n\n" + ("x" * (github_source.MAX_FILE_BYTES + 10)),
        "node_modules/pkg/readme.md": "# Dependência",
        ".hidden/secret.md": "# Oculto",
        "assets/logo.png": "\x89PNG binary",
        "notebooks/nb.ipynb": json.dumps({
            "metadata": {"kernelspec": {"language": "python"}},
            "cells": [
                {"cell_type": "markdown", "source": ["# Notebook de Embeddings\n", "Explicação."]},
                {"cell_type": "code", "source": ["import os\n", "os.system('rm -rf /')"],
                 "outputs": []},
            ],
        }),
    }
    for rel, content in files.items():
        path = work / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    # A symlink pointing outside the repository must never be followed.
    os.symlink("/etc/passwd", work / "lessons" / "evil.md")
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", "init")
    _git(work, "checkout", "-q", "-b", "feature/x")
    (work / "lessons" / "extra.md").write_text("# Extra\n\nSó na feature.", encoding="utf-8")
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", "feature")
    _git(work, "checkout", "-q", "main")
    bare = tmp_path_factory.mktemp("remote") / "course.git"
    _git(work, "clone", "-q", "--bare", str(work), str(bare))
    return bare


@pytest.fixture(autouse=True)
def local_remote(monkeypatch: pytest.MonkeyPatch, bare_repo: Path) -> None:
    def resolver(owner: str, repo: str) -> str:
        if (owner, repo) == ("acme", "course"):
            return bare_repo.as_uri()
        return (bare_repo.parent / "missing.git").as_uri()

    async def no_token() -> None:
        return None

    monkeypatch.setattr(github_source, "clone_url_resolver", resolver)
    monkeypatch.setattr(github_source, "github_token", no_token)


def _frontmatter(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8").split("---", 2)[1])


def test_preview_lists_filtered_text_files(api_client: TestClient, configured_vault: Path) -> None:
    res = api_client.post("/api/import/github/preview", json={"url": REPO_URL})
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["repo"]["owner"] == "acme" and data["repo"]["name"] == "course"
    assert data["repo"]["ref"] == "main" and len(data["repo"]["commit"]) == 40
    assert data["truncated"] is False
    paths = {f["path"]: f for f in data["files"]}
    assert set(paths) == {"README.md", "lessons/01-intro.md", "lessons/notes.txt",
                          "lessons/evil.md", "notebooks/nb.ipynb"}
    assert paths["lessons/01-intro.md"]["title"] == "Introdução a Tokens"
    assert paths["notebooks/nb.ipynb"]["title"] == "Notebook de Embeddings"
    assert paths["lessons/notes.txt"]["title"] == "notes"
    clone = configured_vault / ".harness/repos/acme__course@default"
    assert (clone / ".git").is_dir()
    # Symlinks are checked out as plain files holding the link text, never followed.
    evil = clone / "lessons/evil.md"
    assert not evil.is_symlink() and "root:" not in evil.read_text()


def test_preview_truncates_and_handles_slashed_refs(api_client: TestClient,
                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github_source, "MAX_FILES", 2)
    data = api_client.post("/api/import/github/preview", json={"url": REPO_URL}).json()
    assert data["truncated"] is True and len(data["files"]) == 2
    monkeypatch.setattr(github_source, "MAX_FILES", 2000)
    res = api_client.post("/api/import/github/preview",
                          json={"url": f"{REPO_URL}/tree/feature/x/lessons"})
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["repo"]["ref"] == "feature/x" and data["repo"]["subpath"] == "lessons"
    assert {f["path"] for f in data["files"]} >= {"lessons/extra.md", "lessons/01-intro.md"}
    assert all(f["path"].startswith("lessons/") for f in data["files"])


def test_preview_rejects_bad_urls_and_missing_repos(api_client: TestClient) -> None:
    for url in ("file:///etc", "git@github.com:acme/course.git", "https://evil.com/acme/course",
                "https://github.com/acme/course/tree/--upload-pack=x"):
        assert api_client.post("/api/import/github/preview", json={"url": url}).status_code == 422
    res = api_client.post("/api/import/github/preview", json={"url": "https://github.com/acme/missing"})
    assert res.status_code in (404, 502)
    res = api_client.post("/api/import/github/preview", json={"url": f"{REPO_URL}/tree/nope/x"})
    assert res.status_code == 404


def test_size_limit_deletes_clone(api_client: TestClient, configured_vault: Path,
                                  monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github_source, "MAX_REPO_BYTES", 1000)
    res = api_client.post("/api/import/github/preview", json={"url": REPO_URL})
    assert res.status_code == 413
    repos = configured_vault / ".harness/repos"
    assert not any(repos.iterdir()) if repos.exists() else True


def test_token_is_redacted_from_errors(api_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "ghp_TestSecretToken123"

    async def token() -> str:
        return secret

    monkeypatch.setattr(github_source, "github_token", token)
    monkeypatch.setattr(github_source, "clone_url_resolver",
                        lambda o, r: f"file:///nonexistent/{secret}/repo.git")
    res = api_client.post("/api/import/github/preview", json={"url": REPO_URL})
    assert res.status_code >= 400
    assert secret not in res.text and "[redacted]" in res.text


def test_import_writes_sources_with_provenance(api_client: TestClient, configured_vault: Path) -> None:
    preview = api_client.post("/api/import/github/preview", json={"url": REPO_URL}).json()
    commit = preview["repo"]["commit"]
    res = api_client.post("/api/import/github/import", json={
        "url": REPO_URL, "paths": ["lessons/01-intro.md", "notebooks/nb.ipynb"],
        "start_session": True, "use_as_track": False,
    })
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["session_id"] is None and data["track_job_id"] is None
    by_path = {i["source_path"]: i for i in data["imported"]}
    lesson_rel = "Fontes/GitHub/acme-course/lessons/01-intro.md"
    assert set(by_path) == {lesson_rel, "Fontes/GitHub/acme-course/notebooks/nb.md"}
    lesson = configured_vault / lesson_rel
    fm = _frontmatter(lesson)
    assert fm["source_kind"] == "github" and fm["repo"] == "acme/course"
    assert fm["commit"] == commit and fm["repo_path"] == "lessons/01-intro.md"
    assert fm["source_url"] == f"https://github.com/acme/course/blob/{commit}/lessons/01-intro.md"
    assert fm["origem"] == "GitHub" and fm["imported_at"]
    body = lesson.read_text(encoding="utf-8")
    assert "Um token é a unidade mínima que o modelo processa. ^p2" in body
    # The fenced block (with a blank line inside) stays intact; its anchor sits on its own line.
    assert 'tokens = tokenize("olá")\n\nprint(tokens)\n```\n^p3' in body
    assert by_path[lesson_rel]["paragraph_count"] == 4
    nb = (configured_vault / "Fontes/GitHub/acme-course/notebooks/nb.md").read_text(encoding="utf-8")
    assert "```python\nimport os\nos.system('rm -rf /')\n```" in nb

    # Re-import of unchanged content is idempotent (no new versions).
    again = api_client.post("/api/import/github/import", json={
        "url": REPO_URL, "paths": ["lessons/01-intro.md"], "start_session": False, "use_as_track": False,
    })
    assert again.json()["imported"][0]["source_path"] == lesson_rel
    assert sorted(p.name for p in lesson.parent.iterdir()) == ["01-intro.md"]


def test_import_single_file_starts_teach_session(api_client: TestClient) -> None:
    res = api_client.post("/api/import/github/import", json={
        "url": REPO_URL, "paths": ["README.md"], "start_session": True, "use_as_track": False,
    })
    assert res.status_code == 200, res.text
    session_id = res.json()["session_id"]
    assert session_id
    chat = api_client.get(f"/api/chats/{session_id}").json()
    assert chat["mode"] == "TEACH" and chat["source_file"] == "Fontes/GitHub/acme-course/README.md"


def test_import_rejects_paths_outside_listing(api_client: TestClient, configured_vault: Path) -> None:
    for path in ("../../.harness/config.json", "lessons/big.md", "assets/logo.png",
                 "node_modules/pkg/readme.md", ".hidden/secret.md", "/etc/passwd"):
        res = api_client.post("/api/import/github/import", json={
            "url": REPO_URL, "paths": [path], "start_session": False, "use_as_track": False,
        })
        assert res.status_code == 422, (path, res.text)
    assert not (configured_vault / "Fontes/GitHub").exists()


def test_use_as_track_creates_a_new_track_and_keeps_the_others(
        api_client: TestClient, configured_vault: Path, fake_engine: FakeEngine) -> None:
    config = load_config(configured_vault)
    config.tracks = [TrackConfig(id="trk-old", title="Trilha existente", source="manual",
                                 queue=[TrackItem(id="old", title="Passo antigo")])]
    config.active_track_id = "trk-old"
    save_config(configured_vault, config)

    fake_engine.program(GeneratedTrack, {"items": [
        {"id": "intro", "title": "Introdução", "kind": "curriculo", "source_ref": "lessons/01-intro.md"},
        {"id": "readme", "title": "Visão geral", "kind": "curriculo", "source_ref": "README.md",
         "prerequisites": ["intro"]},
    ]})
    body = {"url": REPO_URL, "paths": [], "start_session": False, "use_as_track": True}
    # replace_track is accepted and ignored: nothing is replaced anymore.
    res = api_client.post("/api/import/github/import", json={**body, "replace_track": True})
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["track_job_id"] and data["track_id"]
    track_id = data["track_id"]
    config = poll_until(lambda: load_config(configured_vault),
                        lambda c: bool(c.find_track(track_id) and c.find_track(track_id).queue))
    clone = (configured_vault / ".harness/repos/acme__course@default").resolve()
    track = config.find_track(track_id)
    assert [t.id for t in config.tracks] == ["trk-old", track_id]
    assert config.find_track("trk-old").queue[0].id == "old"
    assert config.active_track_id == track_id
    assert (track.source, track.title, track.mode) == ("github", "acme/course", "repo_leveling")
    assert track.github_url == REPO_URL
    assert Path(track.repo_path) == clone
    assert track.queue[0].source_ref == str(clone / "lessons/01-intro.md")
    assert state_job_key(api_client, data["track_job_id"]) == f"track:{track_id}"
    assert "lessons/01-intro.md — Introdução a Tokens" in fake_engine.structured_calls[0]["prompt"]


def state_job_key(client: TestClient, job_id: str) -> str:
    return client.app.state.learnharness_state.active_jobs[job_id]["dedup_key"]


def test_create_github_track_clones_and_generates(api_client: TestClient, configured_vault: Path,
                                                  fake_engine: FakeEngine) -> None:
    fake_engine.program(GeneratedTrack, {"items": [
        {"id": "intro", "title": "Introdução", "kind": "curriculo", "source_ref": "lessons/01-intro.md"},
    ]})
    res = api_client.post("/api/tracks", json={"source": "github", "github_url": REPO_URL, "title": ""})
    assert res.status_code == 200, res.text
    created = res.json()
    assert created["title"] == "acme/course" and created["source"] == "github" and created["active"]
    config = poll_until(lambda: load_config(configured_vault),
                        lambda c: bool(c.find_track(created["id"]).queue))
    clone = (configured_vault / ".harness/repos/acme__course@default").resolve()
    assert Path(config.find_track(created["id"]).repo_path) == clone


def _tiny_pdf(text_lines: list[str]) -> bytes:
    stream = "BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(f"({t}) Tj T*" for t in text_lines) + " ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        "/Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def test_local_pdf_import(api_client: TestClient, configured_vault: Path) -> None:
    pdf = _tiny_pdf(["Attention is all you need.", "Transformers use self attention."])
    res = api_client.post("/api/import/local", files={"file": ("paper.pdf", pdf, "application/pdf")},
                          data={"title": "Paper", "start_session": "false"})
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["session_id"] is None
    item = data["imported"][0]
    assert item["source_path"] == "Fontes/Local/Paper.md" and item["paragraph_count"] == 2
    path = configured_vault / item["source_path"]
    fm = _frontmatter(path)
    assert fm["source_kind"] == "local" and fm["original_filename"] == "paper.pdf"
    text = path.read_text(encoding="utf-8")
    assert "Attention is all you need. ^p1" in text and "Transformers use self attention. ^p2" in text


def test_local_markdown_import_with_session_and_limits(api_client: TestClient,
                                                       configured_vault: Path) -> None:
    res = api_client.post("/api/import/local",
                          files={"file": ("../../notas.md", b"# Notas\n\nPrimeiro.\n\nSegundo.", "text/markdown")},
                          data={"start_session": "true"})
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["imported"][0]["source_path"] == "Fontes/Local/notas.md"
    assert data["session_id"]
    bad = api_client.post("/api/import/local", files={"file": ("x.exe", b"MZ", "application/octet-stream")})
    assert bad.status_code == 415
    broken = api_client.post("/api/import/local", files={"file": ("x.pdf", b"not a pdf", "application/pdf")})
    assert broken.status_code == 422
