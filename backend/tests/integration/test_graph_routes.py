"""Fase 8B graph routes and triggers over the real app with the scripted FakeEngine.

GET /api/graph (shape, clusters, roadmap with a track, legacy notes), DELETE node,
PUT positions, graph_context in the session prompt, and the extraction triggers
(token threshold at the end of a run, session completion).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from learnharness.api.state import AppState
from learnharness.core.contracts.config import TrackConfig, TrackItem, TrackMode
from learnharness.core.contracts.graph import ExtractionPayload
from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.pipelines.extraction import refresh_notes
from learnharness.vault.bootstrap import load_config, save_config
from learnharness.vault.graph_store import append_records, load_graph_chains, load_nodes
from learnharness.vault.jsonl_store import append_session_event
from learnharness.vault.markdown_ast import read_frontmatter
from tests.conftest import FakeEngine, poll_until

A = "n_aaaaaaaaaaaa"
B = "n_bbbbbbbbbbbb"
C = "n_cccccccccccc"


@pytest.fixture
def client_vault(api_client: TestClient, configured_vault: Path):
    return api_client, configured_vault


def _seed(vault: Path) -> None:
    """Two sessions (one on track item ``t1``), three nodes, one chain and their notes."""
    append_session_event(vault, "sess-1", SessionRecord(id="sess-1", title="Álgebra linear", track_item_id="t1",
                                                         lesson_vault_path="Aulas/2026-10-27 Álgebra linear.md"))
    append_session_event(vault, "sess-2", SessionRecord(id="sess-2", title="Atenção"))
    append_records(vault, "nodes.jsonl", [
        {"id": A, "name": "Produto escalar", "statement": "Soma dos produtos das coordenadas.", "aliases": [],
         "created_at": "t1", "provenance": [{"session_id": "sess-1", "message_id": "msg-1"}], "vault_rel_path": ""},
        {"id": B, "name": "Softmax", "statement": "Normaliza escores em probabilidades.", "aliases": [],
         "created_at": "t2", "provenance": [{"session_id": "sess-1", "message_id": "msg-2"}], "vault_rel_path": ""},
        {"id": C, "name": "Atenção", "statement": "Pondera valores pelo softmax dos produtos escalares.",
         "aliases": ["Attention"], "created_at": "t3",
         "provenance": [{"session_id": "sess-2", "message_id": "msg-9"}], "vault_rel_path": ""},
    ])
    append_records(vault, "chains.jsonl", [{"id": "arg_000000000001", "premises": [A, B], "conclusion": C,
                                            "provenance": [{"session_id": "sess-2", "message_id": "msg-9"}],
                                            "created_at": "t4"}])
    refresh_notes(vault, [A, B, C], "pt-BR")


def test_graph_snapshot_shape_clusters_and_legacy(client_vault) -> None:
    client, vault = client_vault
    (vault / "Conceitos" / "Vetor.md").write_text(
        "---\ntags: [conceito]\n---\n# Vetor\n\n**Verdade incondicional / definição:** Lista ordenada de números.\n",
        encoding="utf-8")
    _seed(vault)
    data = client.get("/api/graph").json()
    assert set(data) >= {"nodes", "edges", "chains", "clusters", "roadmap", "updated_at"}
    nodes = {n["id"]: n for n in data["nodes"]}
    a = nodes[A]
    assert a["name"] == a["title"] == "Produto escalar"
    assert a["statement"] == a["summary"] == "Soma dos produtos das coordenadas."
    assert a["cluster"] == "sess-1" and a["ghost"] is False
    assert a["sessions"] == [{"session_id": "sess-1", "title": "Álgebra linear", "message_id": "msg-1"}]
    assert a["vault_rel_path"] == a["file_path"] == "Conceitos/Produto escalar.md"
    assert "x" not in a and nodes[C]["aliases"] == ["Attention"]
    assert data["chains"] == [{
        "id": "arg_000000000001", "chain_id": "arg_000000000001", "premises": [A, B], "conclusion": C,
        "expression": "Produto escalar ∧ Softmax ⟹ Atenção", "formula": "Produto escalar ∧ Softmax ⟹ Atenção",
        "created_at": "t4", "session_id": "sess-2", "source_session_id": "sess-2"}]
    assert {(e["source"], e["target"], e["kind"]) for e in data["edges"]} >= {(A, C, "chain"), (B, C, "chain")}
    clusters = {c["id"]: c for c in data["clusters"]}
    assert clusters["sess-1"] == {"id": "sess-1", "label": "Álgebra linear", "kind": "session", "size": 2}
    assert clusters["sess-2"]["size"] == 1
    # The old user note (no harness_id) stays on the graph as a legacy node.
    assert nodes["vetor"]["cluster"] == "legacy" and nodes["vetor"]["statement"] == "Lista ordenada de números."
    assert clusters["legacy"]["kind"] == "legacy"
    assert data["roadmap"] == []  # no track configured

    note = client.get(f"/api/graph/concepts/{C}/note").json()
    assert note["path"] == "Conceitos/Atenção.md"
    assert "- [[Produto escalar]] ∧ [[Softmax]]" in note["markdown"]
    assert client.get("/api/graph/concepts/vetor/note").json()["path"] == "Conceitos/Vetor.md"


def test_roadmap_links_track_items_to_session_nodes(client_vault) -> None:
    client, vault = client_vault
    config = load_config(vault)
    config.tracks = [
        TrackConfig(id="trk-a", title="IA", mode=TrackMode.GOAL_GENERATED, active_item_id="t2",
                    queue=[TrackItem(id="t1", title="Álgebra", completed=True),
                           TrackItem(id="t2", title="Atenção", prerequisites=["t1"])]),
        # Same item id in another track: ids are unique only within a track.
        TrackConfig(id="trk-b", title="Cálculo", source="manual", active_item_id="t1",
                    queue=[TrackItem(id="t1", title="Limites")]),
        TrackConfig(id="trk-z", title="Arquivada", archived=True, queue=[TrackItem(id="x", title="X")]),
    ]
    config.active_track_id = "trk-a"
    save_config(vault, config)
    _seed(vault)  # sess-1 predates Fase 14 (no track_id): it belongs to the active track
    roadmap = client.get("/api/graph").json()["roadmap"]
    assert roadmap == [
        {"id": "track:trk-a:t1", "title": "Álgebra", "status": "completed", "track_id": "trk-a",
         "track_title": "IA", "linked_node_ids": [A, B], "depends_on": []},
        {"id": "track:trk-a:t2", "title": "Atenção", "status": "active", "track_id": "trk-a",
         "track_title": "IA", "linked_node_ids": [], "depends_on": ["track:trk-a:t1"]},
        {"id": "track:trk-b:t1", "title": "Limites", "status": "active", "track_id": "trk-b",
         "track_title": "Cálculo", "linked_node_ids": [], "depends_on": []},
    ]

    # A session explicitly on (trk-b, t1) links its nodes there, not to (trk-a, t1).
    append_session_event(vault, "sess-1", SessionRecord(id="sess-1", title="Álgebra linear", track_item_id="t1",
                                                         track_id="trk-b", sequence=5,
                                                         lesson_vault_path="Aulas/2026-10-27 Álgebra linear.md"))
    linked = {r["id"]: r["linked_node_ids"] for r in client.get("/api/graph").json()["roadmap"]}
    assert linked["track:trk-b:t1"] == [A, B] and linked["track:trk-a:t1"] == []


def test_delete_node_tombstones_and_keeps_user_text(client_vault) -> None:
    client, vault = client_vault
    _seed(vault)
    a_note = vault / "Conceitos" / "Produto escalar.md"
    a_note.write_text(a_note.read_text(encoding="utf-8") + "\nMinha anotação.\n", encoding="utf-8")

    res = client.delete(f"/api/graph/nodes/{A}")
    assert res.status_code == 200 and res.json()["deleted_chain_ids"] == ["arg_000000000001"]
    assert A not in load_nodes(vault) and load_graph_chains(vault) == []
    # The user's note survives without the managed section.
    text = a_note.read_text(encoding="utf-8")
    assert "Minha anotação." in text and "**Afirmação:**" not in text and "harness:" not in text
    # B's harness-created note had nothing else: it is removed.
    assert client.delete(f"/api/graph/nodes/{B}").status_code == 200
    assert not (vault / "Conceitos" / "Softmax.md").exists()
    # C lost its premises line.
    assert "Premissas" not in (vault / "Conceitos" / "Atenção.md").read_text(encoding="utf-8")
    snapshot = client.get("/api/graph").json()
    assert [n["id"] for n in snapshot["nodes"]] == [C] and snapshot["chains"] == []
    assert client.delete(f"/api/graph/nodes/{A}").status_code == 404


def test_positions_persist_into_snapshot(client_vault) -> None:
    client, vault = client_vault
    _seed(vault)
    assert client.put("/api/graph/positions", json={A: {"x": 10.5, "y": -3}}).status_code == 200
    assert client.put("/api/graph/positions", json={B: {"x": 1, "y": 2}}).json()["positions"][A] == {"x": 10.5, "y": -3}
    nodes = {n["id"]: n for n in client.get("/api/graph").json()["nodes"]}
    assert (nodes[A]["x"], nodes[A]["y"]) == (10.5, -3) and (nodes[B]["x"], nodes[B]["y"]) == (1, 2)
    assert client.put("/api/graph/positions", json={A: {"x": "nope"}}).status_code == 422


def test_graph_context_reaches_session_prompt(client_vault, fake_engine: FakeEngine) -> None:
    client, vault = client_vault
    _seed(vault)
    fake_engine.script_turn("Ok.")
    res = client.post("/api/chats", json={"mode": "TEACH", "topic": "Multi-cabeça", "graph_context": [A, B, C]})
    assert res.status_code == 200, res.text
    assert res.json()["graph_context"] == [A, B, C]
    poll_until(lambda: fake_engine.stream_calls, bool)
    prompt = fake_engine.stream_calls[0]["prompt"]
    assert f"[{A}] Produto escalar: Soma dos produtos das coordenadas." in prompt
    assert f"[{C}] Atenção: Pondera valores pelo softmax dos produtos escalares." in prompt
    assert "[arg_000000000001] Produto escalar ∧ Softmax ⟹ Atenção" in prompt
    assert "do not re-teach" in prompt

    assert client.post("/api/chats", json={"topic": "x", "graph_context": ["n_000000000000"]}).status_code == 422
    too_many = [f"n_{i:012x}" for i in range(65)]
    assert client.post("/api/chats", json={"topic": "x", "graph_context": too_many}).status_code == 422


def test_end_of_run_trigger_respects_token_threshold(client_vault, fake_engine: FakeEngine) -> None:
    client, vault = client_vault
    fake_engine.program(ExtractionPayload, {"propositions": [
        {"key": "p1", "name": "Produto escalar", "statement": "Soma dos produtos das coordenadas."}]})
    fake_engine.script_turn("Texto curto.")
    short = client.post("/api/chats", json={"topic": "Curto"}).json()["id"]
    poll_until(lambda: client.get(f"/api/chats/{short}").json(), lambda c: c["execution_status"] == "idle")
    assert not any(j["kind"] == "extraction" for j in client.get("/api/jobs").json())

    config = load_config(vault)
    config.graph.extraction_chunk_tokens = 10
    save_config(vault, config)
    fake_engine.script_turn("O produto escalar soma os produtos das coordenadas de dois vetores.")
    chat_id = client.post("/api/chats", json={"topic": "Longo"}).json()["id"]
    jobs = poll_until(lambda: client.get("/api/jobs").json(),
                      lambda js: any(j["kind"] == "extraction" and j["status"] == "completed" for j in js))
    job = next(j for j in jobs if j["kind"] == "extraction")
    assert job["payload"] == {"session_id": chat_id, "topic": "Longo", "reason": "threshold"}
    assert job["dedup_key"] == f"extract:{chat_id}"
    assert [n["name"] for n in client.get("/api/graph").json()["nodes"]] == ["Produto escalar"]
    assert read_frontmatter((vault / "Conceitos" / "Produto escalar.md").read_text(encoding="utf-8"))["sessions"] == [chat_id]


async def test_completion_always_triggers_extraction(configured_vault: Path) -> None:
    engine = FakeEngine().program(ExtractionPayload, {"propositions": []})
    state = AppState(vault_path=configured_vault, engine_factory=lambda slot: engine)
    try:
        record = SessionRecord(id="sess-done", title="Fim", phase="teaching", messages=[
            SessionMessage(id="m1", role="assistant", content="Pouco texto.", created_at="t")])
        append_session_event(configured_vault, record.id, record)
        assert state.graph.maybe_extract(record) is None  # below 4096 tokens, still teaching
        record.phase = "completed"
        job = state.graph.maybe_extract(record)
        assert job is not None and job["payload"]["reason"] == "completed"
        assert state.graph.maybe_extract(record)["job_id"] in {job["job_id"], *state.active_jobs}
        record.mode = "PRACTICE"
        assert state.graph.maybe_extract(record) is None  # only TEACH feeds the graph
    finally:
        await state.close()


