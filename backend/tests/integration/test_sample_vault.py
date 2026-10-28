"""The generated sample Vault (scripts/make_sample_vault.py) opens through the real readers.

A format change that the readers no longer accept fails here; regenerate the fixture with the
script in the same commit.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from learnharness.api.app import create_app
from learnharness.api.state import AppState
from learnharness.core.schema_gate import SUPPORTED_SCHEMA_VERSION, check_schema
from learnharness.vault.bootstrap import load_config
from learnharness.vault.graph_store import load_graph_chains, load_nodes
from learnharness.vault.jsonl_store import load_practice_log

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "sample-vault"


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    copy = tmp_path / "SampleVault"
    shutil.copytree(FIXTURE, copy)
    for name in ("Fontes", "Desenhos", "viz"):  # empty folders do not survive git
        (copy / name).mkdir(exist_ok=True)
    return copy


@pytest.fixture
def client(vault: Path):
    with TestClient(create_app(state=AppState(vault_path=vault))) as test_client:
        yield test_client


def _session_snapshots(vault: Path) -> dict[str, dict]:
    last = {}
    for path in sorted((vault / ".harness/sessions").glob("*.jsonl")):
        records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
        last[records[-1]["mode"]] = records[-1]
    return last


def test_schema_gate_accepts_the_vault(vault: Path) -> None:
    config = load_config(vault)
    check_schema(config.schema_version)
    assert config.schema_version <= SUPPORTED_SCHEMA_VERSION
    assert config.configured and config.language == "pt-BR"


def test_chats_lists_both_sessions(client: TestClient) -> None:
    chats = client.get("/api/chats").json()
    assert sorted(c["mode"] for c in chats) == ["PRACTICE", "TEACH"]
    teach = next(c for c in chats if c["mode"] == "TEACH")
    detail = client.get(f"/api/chats/{teach['id']}").json()
    assert detail["phase"] == "completed"
    assert [n["status"] for n in detail["plan"]["nodes"]] == ["mastered", "mastered"]


def test_graph_has_nodes_and_chains(client: TestClient, vault: Path) -> None:
    snapshot = client.get("/api/graph").json()
    assert {n["name"] for n in snapshot["nodes"]} >= {"Produto Escalar", "Escores de Atenção"}
    assert len(snapshot["chains"]) == 1
    nodes = load_nodes(vault)
    chains = load_graph_chains(vault, set(nodes))
    assert len(nodes) == 2 and len(chains) == 1
    assert chains[0].premises == [n for n in nodes if nodes[n].name == "Produto Escalar"]


def test_expected_messages_and_events_are_present(vault: Path) -> None:
    sessions = _session_snapshots(vault)
    teach, practice = sessions["TEACH"], sessions["PRACTICE"]

    assert any(m["role"] == "assistant" for m in teach["messages"])
    assert any(m.get("steer_kind") == "job" for m in teach["messages"])  # finished research job
    assert any(m.get("quiz_id") for m in teach["messages"])  # answered quiz
    assert len(teach["answers"]) == 2 and teach["assessment"]["strands"]
    assert any(m.get("practice_kind") == "attempt" for m in practice["messages"])
    [problem] = practice["practice"]["problems"]
    assert problem["outcome"] == "solved" and problem["attempts"]

    quiz_log = (vault / ".harness/quiz-log.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(quiz_log) == 2
    assert [e.outcome for e in load_practice_log(vault)] == ["solved"]
    jobs = [json.loads(line) for line in (vault / ".harness/jobs.jsonl").read_text(encoding="utf-8").splitlines()]
    final = {j["kind"]: j["status"] for j in jobs}
    assert final == {"research": "completed", "extraction": "completed"}
    assert (vault / "Conceitos/Produto Escalar.md").is_file()


def test_fixture_has_no_machine_specific_content() -> None:
    for path in FIXTURE.rglob("*"):
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            assert "/home/" not in text and "/tmp/" not in text, path
