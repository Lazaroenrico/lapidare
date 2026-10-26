"""Safety regression tests use only temporary vaults, never user data."""

import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from learnharness.core.contracts.graph import ConceptNode
from learnharness.vault.bootstrap import bootstrap_vault, save_config
from learnharness.vault.excalidraw import create_retrieval_drawing, load_drawing, save_drawing
from learnharness.vault.jsonl_store import append_session_event, load_session
from learnharness.vault.markdown_ast import _parse_sections, merge_concept_note, merge_lesson_note
from learnharness.vault.safety import RevisionConflictError, revision
from learnharness.vault.transcript_importer import get_source_paragraph, import_transcript_text


@pytest.mark.parametrize(
    "relative",
    ["../outside.md", "/tmp/outside.md", "Aulas/../../outside.md", "Aulas/../Fontes/source.md"],
)
def test_reject_traversal(tmp_path, relative):
    with pytest.raises(PermissionError):
        merge_lesson_note(tmp_path, relative, "Unsafe")


def test_reject_symlink_sources_and_machine_files(tmp_path):
    vault = tmp_path / "vault"
    outside = tmp_path / "outside"
    vault.mkdir()
    outside.mkdir()
    (vault / "Fontes").symlink_to(outside, target_is_directory=True)
    with pytest.raises(PermissionError):
        import_transcript_text(vault, "secret", "Unsafe")
    (vault / ".harness").symlink_to(outside, target_is_directory=True)
    with pytest.raises(PermissionError):
        append_session_event(vault, "session", {"event": "test"})
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize("session_id", ["../../outside", "/tmp/outside", "a/b", ".."])
def test_session_ids_are_components(tmp_path, session_id):
    with pytest.raises(ValueError):
        append_session_event(tmp_path, session_id, {})
    with pytest.raises(ValueError):
        load_session(tmp_path, session_id)


def test_configured_folders_and_readonly_sources(tmp_path):
    config = bootstrap_vault(tmp_path, language="en")
    config.folders.sources_dir = "Library/Originals"
    config.folders.concepts_dir = "Notes/Concepts"
    config.folders.drawings_dir = "Sketches"
    save_config(tmp_path, config)
    source, _ = import_transcript_text(tmp_path, "Original", "Document", tipo="text")
    assert source.parent == tmp_path / "Library/Originals"
    with pytest.raises(PermissionError):
        merge_lesson_note(tmp_path, str(source.relative_to(tmp_path)), "No")
    concept = merge_concept_note(tmp_path, ConceptNode(id="x", title="X"))
    assert concept.parent == tmp_path / "Notes/Concepts"
    _, drawing = create_retrieval_drawing(tmp_path, "X", "Recall")
    assert drawing.parent == tmp_path / "Sketches"
    assert bootstrap_vault(tmp_path).folders == config.folders


def test_import_idempotency_and_force_versions(tmp_path):
    original, _ = import_transcript_text(tmp_path, "Original words", "Title")
    original_bytes = original.read_bytes()
    repeated, _ = import_transcript_text(tmp_path, "Original words", "Title")
    assert repeated == original
    version, _ = import_transcript_text(tmp_path, "Changed words", "Title", force=True)
    assert version != original
    assert original.read_bytes() == original_bytes
    assert import_transcript_text(tmp_path, "Changed words", "Title", force=True)[0] == version
    assert get_source_paragraph(tmp_path, version.stem, "p1")["target_text"] == "Changed words ^p1"
    with pytest.raises(PermissionError):
        get_source_paragraph(tmp_path, "../../secret", "p1")


def test_legacy_lesson_bytes_and_fenced_headings_survive(tmp_path):
    path = tmp_path / "Aulas/Test.md"
    path.parent.mkdir()
    legacy = '---\r\ncustom: "quoted" # comment\r\n---\r\n# Test\r\n\r\n```md\r\n## Fake\r\n### Node\r\n```\r\n## Desdobrando\r\n### Node\r\nPersonal text  \r\n'
    path.write_bytes(legacy.encode())
    merge_lesson_note(
        tmp_path, "Aulas/Test.md", "Test", node_section_title="Node", node_section_md="First"
    )
    first = path.read_bytes()
    assert first.startswith(legacy.encode())
    merge_lesson_note(
        tmp_path, "Aulas/Test.md", "Test", node_section_title="Node", node_section_md="Second"
    )
    after = path.read_bytes()
    assert after.startswith(legacy.encode())
    assert b"First" not in after and b"Second" in after
    with pytest.raises(RevisionConflictError):
        merge_lesson_note(
            tmp_path, "Aulas/Test.md", "Test", status="done", expected_revision=revision(first)
        )
    assert path.read_bytes() == after
    assert [h for h, _ in _parse_sections("```md\n## Fake\n```\n## Real\nBody")[1]] == ["## Real"]


def test_concurrent_merges_retain_distinct_nodes(tmp_path):
    def update(i):
        merge_lesson_note(
            tmp_path,
            "Aulas/Test.md",
            "Test",
            node_section_title=f"Node {i}",
            node_section_md=f"Payload {i}",
        )

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(update, range(20)))
    text = (tmp_path / "Aulas/Test.md").read_text()
    for i in range(20):
        assert f"### Node {i}\nPayload {i}\n" in text


def test_concurrent_jsonl_appends_are_complete(tmp_path):
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(
            pool.map(lambda i: append_session_event(tmp_path, "test", {"sequence": i}), range(100))
        )
    rows = [
        json.loads(row)
        for row in (tmp_path / ".harness/sessions/test.jsonl").read_text().splitlines()
    ]
    assert sorted(row["sequence"] for row in rows) == list(range(100))


def test_drawing_preserves_user_prose_files_metadata_and_revisions(tmp_path):
    slug, path = create_retrieval_drawing(tmp_path, "Memory", "Recall")
    initial = load_drawing(tmp_path, slug)
    scene = initial["scene"]
    scene["files"] = {"image": {"dataURL": "data:image/png;base64,abc"}}
    scene["custom_metadata"] = {"keep": True}
    save_drawing(tmp_path, slug, scene)
    content = path.read_text().replace("## Text Elements\n", "## Text Elements\nMy personal text\n")
    content = (
        content.replace("---\n", "---\n# YAML comment\n", 1)
        + '\n## User notes\nKeep everything.\n```json\n{"example": true}\n```\n'
    )
    path.write_text(content)
    loaded = load_drawing(tmp_path, slug)
    save_drawing(tmp_path, slug, {"elements": []}, expected_revision=loaded["revision"])
    after = load_drawing(tmp_path, slug)
    assert after["scene"]["files"] == scene["files"]
    assert after["scene"]["custom_metadata"] == {"keep": True}
    assert "# YAML comment" in path.read_text()
    assert "My personal text" in path.read_text()
    assert path.read_text().endswith(
        '## User notes\nKeep everything.\n```json\n{"example": true}\n```\n'
    )
    with pytest.raises(RevisionConflictError):
        save_drawing(tmp_path, slug, {"elements": []}, expected_revision=loaded["revision"])
    slug2, path2 = create_retrieval_drawing(tmp_path, "Memory", "Recall again")
    assert slug2 != slug and path2 != path


def test_folder_mapping_cannot_grant_write_access_to_sources(tmp_path):
    config = bootstrap_vault(tmp_path)
    for forbidden in ["Fontes", "Fontes/Nested", ".harness", "."]:
        changed = config.model_copy(deep=True)
        changed.folders.concepts_dir = forbidden
        with pytest.raises((PermissionError, ValueError)):
            save_config(tmp_path, changed)
