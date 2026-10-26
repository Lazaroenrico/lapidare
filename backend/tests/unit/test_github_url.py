"""Strict GitHub URL parsing, notebook conversion and secret redaction (no network)."""

from __future__ import annotations

import json

import pytest

from learnharness.vault import github_source as gs
from learnharness.vault.github_source import GitHubSourceError, parse_github_url, ref_candidates


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://github.com/rohitg00/ai-engineering-from-scratch", ("rohitg00", "ai-engineering-from-scratch", "repo", ())),
        ("https://github.com/acme/course.git", ("acme", "course", "repo", ())),
        ("https://github.com/acme/course/", ("acme", "course", "repo", ())),
        ("https://www.github.com/acme/course?tab=readme#top", ("acme", "course", "repo", ())),
        ("https://github.com/acme/course/tree/main", ("acme", "course", "tree", ("main",))),
        ("https://github.com/acme/course/tree/feature/x/docs", ("acme", "course", "tree", ("feature", "x", "docs"))),
        ("https://github.com/acme/.github/blob/main/README.md", ("acme", ".github", "blob", ("main", "README.md"))),
        ("https://github.com/acme/course/tree/main/M%C3%B3dulo%201", ("acme", "course", "tree", ("main", "Módulo 1"))),
    ],
)
def test_parse_accepts_github_urls(url, expected):
    parsed = parse_github_url(url)
    assert (parsed.owner, parsed.repo, parsed.kind, parsed.tail) == expected


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/acme/course",
        "git@github.com:acme/course.git",
        "ssh://git@github.com/acme/course",
        "file:///tmp/repo",
        "https://gitlab.com/acme/course",
        "https://github.com.evil.com/acme/course",
        "https://user:pw@github.com/acme/course",
        "https://github.com:443/acme/course",
        "https://github.com/acme",
        "https://github.com/-acme/course",
        "https://github.com/acme/-course",
        "https://github.com/acme/..",
        "https://github.com/acme/course/issues/1",
        "https://github.com/acme/course/tree/--upload-pack=evil",
        "https://github.com/acme/course/tree/-x",
        "https://github.com/acme/course/tree/main/../../etc",
        "https://github.com/acme/course/tree/a..b",
        "https://github.com/acme/course/blob/main",
        "https://github.com/acme/course/tree/main/%2e%2e/x",
        "https://github.com/acme/co urse",
        "",
    ],
)
def test_parse_rejects_everything_else(url):
    with pytest.raises(GitHubSourceError):
        parse_github_url(url)


def test_ref_candidates_split_slashed_refs():
    parsed = parse_github_url("https://github.com/acme/course/tree/feature/x/docs")
    assert ref_candidates(parsed) == [("feature", "x/docs"), ("feature/x", "docs"), ("feature/x/docs", "")]
    blob = parse_github_url("https://github.com/acme/course/blob/release/1.0/a.md")
    assert ref_candidates(blob) == [("release", "1.0/a.md"), ("release/1.0", "a.md")]


def test_notebook_to_markdown_never_executes_and_fences_code():
    nb = {
        "metadata": {"kernelspec": {"language": "python"}},
        "cells": [
            {"cell_type": "markdown", "source": ["# Título\n", "Texto **verbatim**."]},
            {"cell_type": "code", "source": "import os\n\nprint(1)", "outputs": [{"text": "1"}]},
            {"cell_type": "raw", "source": "ignored"},
        ],
    }
    md = gs.notebook_to_markdown(json.dumps(nb))
    assert md == "# Título\nTexto **verbatim**.\n\n```python\nimport os\n\nprint(1)\n```"


def test_redact_hides_tokens_and_their_basic_auth_form():
    gs._remember_secret("ghp_supersecret")
    import base64

    basic = base64.b64encode(b"x-access-token:ghp_supersecret").decode()
    text = gs.redact(f"fatal: ghp_supersecret {basic} Authorization: Bearer abc https://u:ghp_x@github.com/a")
    assert "ghp_supersecret" not in text and basic not in text and "abc" not in text
    assert "ghp_x" not in text
    assert "ghp_supersecret" not in str(GitHubSourceError("boom ghp_supersecret"))


def test_generic_lesson_files_get_readable_names():
    from learnharness.vault.github_source import source_basename

    assert source_basename("phases/07-t/02-self-attention/docs/en.md") == "02-self-attention (en)"
    assert source_basename("book/README.md") == "book"
    assert source_basename("phases/07-t/README.md") == "07-t"
    assert source_basename("guides/attention-intuition.md") == "attention-intuition"
    assert source_basename("README.md") == "README"
