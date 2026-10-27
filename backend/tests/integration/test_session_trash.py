"""Session trash over the real app: listing (incl. legacy files), restore, id clash,
permanent deletion behind ``confirm=true`` and traversal rejection."""

from __future__ import annotations

import json
from pathlib import Path

from starlette.testclient import TestClient

from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.vault.jsonl_store import append_session_event
from tests.conftest import poll_until


def _seed(vault: Path, session_id: str, title: str, *, status: str = "idle", messages: int = 2,
          mode: str = "TEACH") -> None:
    record = SessionRecord(id=session_id, title=title, mode=mode, execution_status=status,
                           updated_at="2026-10-20T10:00:00+00:00")
    record.messages = [SessionMessage(id=f"m{i}", role="user" if i % 2 == 0 else "assistant",
                                      content=f"msg {i}", created_at="2026-10-20T10:00:00+00:00")
                       for i in range(messages)]
    append_session_event(vault, session_id, record)


def _trash(client: TestClient) -> list[dict]:
    res = client.get("/api/chats/trash")
    assert res.status_code == 200, res.text
    return res.json()


def test_trash_lists_deleted_sessions_with_recorded_mode(api_client: TestClient, configured_vault: Path) -> None:
    assert _trash(api_client) == []
    _seed(configured_vault, "sess-a", "Produto escalar", messages=3)
    _seed(configured_vault, "sess-b", "Softmax", mode="PRACTICE", messages=1)
    assert api_client.delete("/api/chats/sess-a").status_code == 200
    assert api_client.delete("/api/chats/sess-b?mode=delete-nodes").status_code == 200

    entries = _trash(api_client)
    assert [e["id"] for e in entries] == ["sess-b", "sess-a"]  # most recently deleted first
    b, a = entries
    assert a == {**a, "file": "sess-a.jsonl", "title": "Produto escalar", "mode": "TEACH",
                 "message_count": 3, "graph_unlinked": False, "delete_mode": "preserve-graph",
                 "updated_at": "2026-10-20T10:00:00+00:00"}
    assert b["mode"] == "PRACTICE" and b["graph_unlinked"] is True and b["delete_mode"] == "delete-nodes"
    assert a["deleted_at"] and a["deleted_at"] <= b["deleted_at"]
    # The deletion is an appended event, never a rewrite of the history.
    lines = (configured_vault / ".harness/trash/sess-a.jsonl").read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[-1])["event"] == "trashed"
    assert json.loads(lines[0])["id"] == "sess-a"


def test_legacy_trash_files_without_event_are_listed(api_client: TestClient, configured_vault: Path) -> None:
    trash = configured_vault / ".harness/trash"
    trash.mkdir(parents=True, exist_ok=True)
    legacy = SessionRecord(id="sess-old", title="Antiga")
    (trash / "sess-old.20260101T000000000000.jsonl").write_text(
        legacy.model_dump_json() + "\n", encoding="utf-8")
    (trash / "garbage.jsonl").write_text("not json\n", encoding="utf-8")
    (trash / "notes.txt").write_text("ignored", encoding="utf-8")

    entries = _trash(api_client)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["id"] == "sess-old" and entry["file"] == "sess-old.20260101T000000000000.jsonl"
    assert entry["graph_unlinked"] is False and entry["delete_mode"] is None
    assert entry["deleted_at"] and entry["message_count"] == 0

    res = api_client.post("/api/chats/trash/sess-old.20260101T000000000000.jsonl/restore")
    assert res.status_code == 200, res.text
    assert (configured_vault / ".harness/sessions/sess-old.jsonl").exists()


def test_restore_moves_back_and_normalizes_midturn(api_client: TestClient, configured_vault: Path) -> None:
    _seed(configured_vault, "sess-r", "Atenção", messages=4)
    assert api_client.delete("/api/chats/sess-r?mode=delete-nodes").status_code == 200
    assert api_client.get("/api/chats/sess-r").status_code == 404

    res = api_client.post("/api/chats/trash/sess-r.jsonl/restore")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["graph_restored"] is False
    session = body["session"]
    assert session["id"] == "sess-r" and session["title"] == "Atenção"
    assert len(session["messages"]) == 4 and "effective_slot" in session
    assert not (configured_vault / ".harness/trash/sess-r.jsonl").exists()
    assert api_client.get("/api/chats/sess-r").status_code == 200
    assert "sess-r" in {s["id"] for s in api_client.get("/api/chats").json()}
    assert _trash(api_client) == []

    # A session trashed while marked mid-turn comes back interrupted, as recover() would.
    trash = configured_vault / ".harness/trash"
    running = SessionRecord(id="sess-m", title="No meio", execution_status="running")
    (trash / "sess-m.jsonl").write_text(running.model_dump_json() + "\n", encoding="utf-8")
    res = api_client.post("/api/chats/trash/sess-m.jsonl/restore")
    assert res.status_code == 200, res.text
    assert res.json()["session"]["execution_status"] == "interrupted"
    assert poll_until(lambda: api_client.get("/api/chats/sess-m").json(),
                      lambda d: d["execution_status"] == "interrupted")


def test_restore_clash_with_live_session_is_409(api_client: TestClient, configured_vault: Path) -> None:
    _seed(configured_vault, "sess-c", "Original")
    assert api_client.delete("/api/chats/sess-c").status_code == 200
    _seed(configured_vault, "sess-c", "Recriada")  # a live session takes the id again

    res = api_client.post("/api/chats/trash/sess-c.jsonl/restore")
    assert res.status_code == 409, res.text
    assert (configured_vault / ".harness/trash/sess-c.jsonl").exists()
    assert api_client.get("/api/chats/sess-c").json()["title"] == "Recriada"
    assert api_client.post("/api/chats/trash/missing.jsonl/restore").status_code == 404


def test_second_delete_of_same_id_gets_suffix_and_both_list(api_client: TestClient, configured_vault: Path) -> None:
    _seed(configured_vault, "sess-d", "Primeira")
    assert api_client.delete("/api/chats/sess-d").status_code == 200
    _seed(configured_vault, "sess-d", "Segunda")
    second = api_client.delete("/api/chats/sess-d").json()["trash_path"]
    assert second != ".harness/trash/sess-d.jsonl"
    files = {e["file"] for e in _trash(api_client)}
    assert files == {"sess-d.jsonl", Path(second).name}


def test_permanent_delete_requires_confirm(api_client: TestClient, configured_vault: Path) -> None:
    _seed(configured_vault, "sess-p", "Some")
    assert api_client.delete("/api/chats/sess-p").status_code == 200
    target = configured_vault / ".harness/trash/sess-p.jsonl"

    assert api_client.delete("/api/chats/trash/sess-p.jsonl").status_code == 422
    assert api_client.delete("/api/chats/trash/sess-p.jsonl?confirm=false").status_code == 422
    assert target.exists()
    res = api_client.delete("/api/chats/trash/sess-p.jsonl?confirm=true")
    assert res.status_code == 200, res.text
    assert not target.exists()
    assert _trash(api_client) == []
    assert api_client.delete("/api/chats/trash/sess-p.jsonl?confirm=true").status_code == 404


def test_trash_routes_reject_traversal(api_client: TestClient, configured_vault: Path) -> None:
    _seed(configured_vault, "sess-live", "Viva")
    live = configured_vault / ".harness/sessions/sess-live.jsonl"
    config = configured_vault / ".harness/config.json"
    for name in ["..", "%2E%2E", "..%2Fsessions%2Fsess-live.jsonl", "%2E%2E%2Fconfig.json",
                 ".hidden.jsonl", "config.json", "..%5Csessions%5Csess-live.jsonl"]:
        res = api_client.delete(f"/api/chats/trash/{name}?confirm=true")
        assert res.status_code in (403, 404, 405), (name, res.status_code, res.text)
        res = api_client.post(f"/api/chats/trash/{name}/restore")
        assert res.status_code in (403, 404, 405), (name, res.status_code, res.text)
    assert live.exists() and config.exists()
    assert api_client.delete("/api/chats/trash/.hidden.jsonl?confirm=true").status_code == 403
    assert api_client.delete("/api/chats/trash/config.json?confirm=true").status_code == 403
