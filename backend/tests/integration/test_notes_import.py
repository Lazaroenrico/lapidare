"""Fase 16: notes -> graph over the real app with the scripted FakeEngine.

Uploads (``POST /api/graph/import``) and vault notes (``POST /api/graph/import-vault``)
run the extraction pipeline as a ``notes_import`` job with per-file status; coverage is
per (source, slice, fingerprint); provenance and concept notes cite the note; removing a
source unlinks it but never touches the note.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from learnharness.core.contracts.graph import AuditPayload, ExtractionPayload
from learnharness.core.note_sources import source_id_for
from learnharness.vault.graph_store import load_nodes
from tests.conftest import FakeEngine, poll_until

# Statement keyword -> proposition the fake extractor "finds" in a NOTE block.
FACTS = {
    "softmax": ("Softmax", "Softmax transforma escores em probabilidades que somam um."),
    "produto": ("Produto escalar", "O produto escalar soma os produtos das coordenadas."),
    "atenção": ("Atenção", "Atenção pondera valores pelo softmax dos produtos escalares."),
    "gradiente": ("Gradiente", "O gradiente aponta a direção de maior subida."),
}


def fake_extractor(prompt: str) -> dict:
    """One proposition per NOTE block whose text mentions a known keyword."""
    if "NOTE [" not in prompt:
        raise AssertionError("notes must be rendered as NOTE blocks")
    props = []
    for i, (block_id, body) in enumerate(re.findall(r"NOTE \[(\w+)\]\n(.*?)(?=\n\nNOTE \[|\Z)", prompt, re.S)):
        for key, (name, statement) in FACTS.items():
            if key in body.lower() and all(p["name"] != name for p in props):
                props.append({"key": f"k{i}{key[:3]}", "name": name, "statement": statement,
                              "message_id": block_id})
    return {"propositions": props, "chains": []}


@pytest.fixture
def client_vault(api_client: TestClient, configured_vault: Path, fake_engine: FakeEngine):
    fake_engine.program(ExtractionPayload, fake_extractor)
    fake_engine.program(AuditPayload, {"links": []})
    return api_client, configured_vault, fake_engine


def _wait_job(client: TestClient, job_id: str) -> dict:
    jobs = poll_until(lambda: client.get("/api/jobs").json(),
                      lambda js: any(j["job_id"] == job_id and j["status"] in ("completed", "failed") for j in js))
    return next(j for j in jobs if j["job_id"] == job_id)


def test_import_vault_note_feeds_the_graph_without_touching_the_note(client_vault) -> None:
    client, vault, engine = client_vault
    note = vault / "Estudos" / "Atenção.md"
    note.parent.mkdir()
    original = "---\ntags: [estudo]\n---\n# Atenção\n\n## Softmax\n\n- softmax normaliza\n\n## Produto\n\nproduto escalar\n"
    note.write_text(original, encoding="utf-8")

    res = client.post("/api/graph/import-vault", json={"paths": ["Estudos/Atenção.md"]})
    assert res.status_code == 202, res.text
    body = res.json()
    sid = source_id_for("Estudos/Atenção.md")
    assert body["files"] == [{"filename": "Estudos/Atenção.md", "status": "queued", "source_id": sid,
                              "path": "Estudos/Atenção.md", "title": "Atenção"}]
    job = _wait_job(client, body["job"]["job_id"])
    assert job["kind"] == "notes_import" and job["status"] == "completed", job
    assert [(f["source_id"], f["status"], f["batches"]) for f in job["files"]] == [(sid, "completed", 1)]
    assert note.read_text(encoding="utf-8") == original  # read-only, byte for byte

    # The registry line, the notes preamble and the provenance by slice.
    lines = (vault / ".harness/graph/sources.jsonl").read_text(encoding="utf-8").splitlines()
    assert [json.loads(line)["id"] for line in lines] == [sid]
    assert "NOT a tutoring conversation" in engine.structured_calls[0]["system_instruction"]
    nodes = {n.name: n for n in load_nodes(vault).values()}
    assert set(nodes) == {"Softmax", "Produto escalar"}
    assert [(p.session_id, p.message_id) for p in nodes["Softmax"].provenance] == [(sid, "s1")]

    # Snapshot: one petal of kind "notes" labelled by the note title; node origin points at the note.
    graph = client.get("/api/graph").json()
    cluster = next(c for c in graph["clusters"] if c["id"] == sid)
    assert cluster == {"id": sid, "label": "Atenção", "kind": "notes", "size": 2, "path": "Estudos/Atenção.md"}
    softmax = next(n for n in graph["nodes"] if n["name"] == "Softmax")
    assert softmax["sessions"] == []
    assert softmax["sources"] == [{"source_id": sid, "title": "Atenção", "path": "Estudos/Atenção.md",
                                   "paragraph": "s1", "deleted": False}]
    # The concept note cites the note (no ^pN anchor in a hand-written note).
    concept = (vault / nodes["Softmax"].vault_rel_path).read_text(encoding="utf-8")
    assert "[[Estudos/Atenção]]" in concept and sid not in concept

    # Same note again: every slice is covered, the engine is not called.
    calls = len(engine.structured_calls)
    again = client.post("/api/graph/import-vault", json={"paths": ["Estudos/Atenção.md"]}).json()
    job = _wait_job(client, again["job"]["job_id"])
    assert job["status"] == "completed" and job["files"][0]["batches"] == 0
    assert len(engine.structured_calls) == calls
    assert len((vault / ".harness/graph/sources.jsonl").read_text(encoding="utf-8").splitlines()) == 1

    # Editing one section re-extracts only that slice.
    note.write_text(original.replace("produto escalar", "produto escalar e gradiente"), encoding="utf-8")
    third = client.post("/api/graph/import-vault", json={"paths": ["Estudos/Atenção.md"]}).json()
    _wait_job(client, third["job"]["job_id"])
    last_prompt = engine.structured_calls[-1]["prompt"] if engine.structured_calls[-1]["schema"] is ExtractionPayload \
        else engine.structured_calls[-2]["prompt"]
    assert "NOTE [s2]" in last_prompt and "NOTE [s1]" not in last_prompt
    assert "Gradiente" in {n.name for n in load_nodes(vault).values()}


def test_upload_lands_in_fontes_notas_with_anchors_and_cites_paragraphs(client_vault) -> None:
    client, vault, _engine = client_vault
    files = [
        ("files[]", ("aula.md", "# Aula\n\nSoftmax normaliza escores.\n\nAtenção usa softmax.\n".encode(), "text/markdown")),
        ("files[]", ("imagem.png", b"\x89PNG", "image/png")),
    ]
    res = client.post("/api/graph/import", files=files)
    assert res.status_code == 202, res.text
    body = res.json()
    accepted, rejected = body["files"]
    assert rejected["status"] == "rejected" and rejected["filename"] == "imagem.png"
    assert accepted["status"] == "queued" and accepted["path"] == "Fontes/Notas/aula.md"
    stored = (vault / accepted["path"]).read_text(encoding="utf-8")
    assert "Softmax normaliza escores. ^p2" in stored and "source_kind: notes" in stored
    job = _wait_job(client, body["job"]["job_id"])
    assert job["status"] == "completed", job

    nodes = {n.name: n for n in load_nodes(vault).values()}
    assert nodes["Softmax"].provenance[0].message_id == "p2"
    assert nodes["Atenção"].provenance[0].message_id == "p3"
    concept = (vault / nodes["Atenção"].vault_rel_path).read_text(encoding="utf-8")
    assert "[[Fontes/Notas/aula#^p3]]" in concept

    note = client.get(f"/api/graph/sources/{accepted['source_id']}/note").json()
    assert note["path"] == "Fontes/Notas/aula.md" and "^p1" in note["markdown"]
    assert client.get("/api/graph/sources/src_000000000000/note").status_code == 404


def test_import_vault_refuses_machine_concept_and_escaping_paths(client_vault) -> None:
    client, vault, _engine = client_vault
    (vault / "Conceitos" / "Softmax.md").write_text("# Softmax\n", encoding="utf-8")
    (vault / "boa.md").write_text("# Boa\n\nsoftmax\n", encoding="utf-8")
    res = client.post("/api/graph/import-vault", json={"paths": [
        ".harness/config.json", "Conceitos/Softmax.md", "../fora.md", "nao-existe.md", "boa.md"]})
    files = {f["filename"]: f["status"] for f in res.json()["files"]}
    assert files == {".harness/config.json": "rejected", "Conceitos/Softmax.md": "rejected",
                     "../fora.md": "rejected", "nao-existe.md": "rejected", "boa.md": "queued"}
    only_bad = client.post("/api/graph/import-vault", json={"paths": ["Conceitos/Softmax.md"]}).json()
    assert only_bad["job"] is None


def test_importable_notes_lists_vault_markdown_outside_machine_and_concepts(client_vault) -> None:
    client, vault, _engine = client_vault
    (vault / "Conceitos" / "X.md").write_text("# X\n", encoding="utf-8")
    (vault / ".obsidian").mkdir(exist_ok=True)
    (vault / ".obsidian" / "y.md").write_text("y", encoding="utf-8")
    (vault / "Estudos").mkdir()
    (vault / "Estudos" / "z.md").write_text("z", encoding="utf-8")
    (vault / "Estudos" / "w.txt").write_text("w", encoding="utf-8")
    listing = client.get("/api/graph/importable-notes").json()
    paths = [n["path"] for n in listing["notes"]]
    assert "Estudos/z.md" in paths
    assert not any(p.startswith(("Conceitos/", ".obsidian/", ".harness/")) or p.endswith(".txt") for p in paths)
    entry = next(n for n in listing["notes"] if n["path"] == "Estudos/z.md")
    assert entry == {"path": "Estudos/z.md", "name": "z", "folder": "Estudos",
                     "source_id": source_id_for("Estudos/z.md"), "imported": False}
    assert listing["truncated"] is False


def test_delete_source_modes_never_delete_the_note(client_vault) -> None:
    client, vault, engine = client_vault
    (vault / "a.md").write_text("# A\n\nsoftmax\n", encoding="utf-8")
    sid = source_id_for("a.md")
    _wait_job(client, client.post("/api/graph/import-vault", json={"paths": ["a.md"]}).json()["job"]["job_id"])
    assert [s["id"] for s in client.get("/api/graph/sources").json()] == [sid]
    assert client.get("/api/graph/sources").json()[0]["node_count"] == 1

    # preserve-graph: the source goes, the node stays (still labelled by the note title).
    res = client.delete(f"/api/graph/sources/{sid}?mode=preserve-graph").json()
    assert res["deleted_node_ids"] == []
    assert client.get("/api/graph/sources").json() == []
    graph = client.get("/api/graph").json()
    assert [c["label"] for c in graph["clusters"] if c["id"] == sid] == ["A"]
    assert client.delete(f"/api/graph/sources/{sid}").status_code == 404

    # Re-register, then delete-nodes: provenance unlinked, node tombstoned, coverage reset.
    _wait_job(client, client.post("/api/graph/import-vault", json={"paths": ["a.md"]}).json()["job"]["job_id"])
    res = client.delete(f"/api/graph/sources/{sid}?mode=delete-nodes").json()
    assert len(res["deleted_node_ids"]) == 1
    assert load_nodes(vault) == {}
    assert (vault / "a.md").read_text(encoding="utf-8") == "# A\n\nsoftmax\n"
    calls = len(engine.structured_calls)
    job = _wait_job(client, client.post("/api/graph/import-vault", json={"paths": ["a.md"]}).json()["job"]["job_id"])
    assert job["files"][0]["batches"] == 1 and len(engine.structured_calls) > calls
    assert client.delete(f"/api/graph/sources/{sid}?mode=wipe").status_code == 422


def test_one_failing_file_fails_the_job_with_per_file_status(client_vault) -> None:
    client, vault, engine = client_vault

    def flaky(prompt: str) -> dict:
        if "quebra" in prompt:
            raise RuntimeError("provider exploded")
        return fake_extractor(prompt)

    engine.program(ExtractionPayload, flaky)
    (vault / "ok.md").write_text("# Ok\n\nsoftmax\n", encoding="utf-8")
    (vault / "ruim.md").write_text("# Ruim\n\nquebra\n", encoding="utf-8")
    body = client.post("/api/graph/import-vault", json={"paths": ["ok.md", "ruim.md"]}).json()
    job = _wait_job(client, body["job"]["job_id"])
    assert job["status"] == "failed" and "Ruim" in job["error"]
    status = {f["path"]: f["status"] for f in job["files"]}
    assert status == {"ok.md": "completed", "ruim.md": "failed"}
    assert job["label"] == "2 notas"

    # Retry after the fix: the finished file is covered, only the failed one runs.
    engine.program(ExtractionPayload, fake_extractor)
    calls = len(engine.structured_calls)
    client.post(f"/api/jobs/{job['job_id']}/retry")
    job = poll_until(lambda: client.get("/api/jobs").json(),
                     lambda js: any(j["job_id"] == body["job"]["job_id"] and j["status"] == "completed" for j in js))
    job = next(j for j in job if j["job_id"] == body["job"]["job_id"])
    assert {f["path"]: f["batches"] for f in job["files"]} == {"ok.md": 0, "ruim.md": 1}
    assert len(engine.structured_calls) == calls + 1
