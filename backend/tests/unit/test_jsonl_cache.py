"""Cached append-only JSONL reads: same results as a full replay, without re-reading the file."""

import json

from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.vault.jsonl_io import read_objects
from learnharness.vault.jsonl_store import (
    append_session_event,
    list_sessions,
    load_session,
    load_session_file,
)


def _message(i: int) -> SessionMessage:
    return SessionMessage(id=f"m{i}", role="user", content=f"text {i}", created_at="2026-10-27T00:00:00Z")


def _session_file(vault):
    return vault / ".harness/sessions/s1.jsonl"


def _append_raw(path, text: str) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(text)


def test_last_snapshot_wins_and_cache_follows_appends(tmp_path):
    record = SessionRecord(id="s1", title="first")
    for i in range(3):
        record.messages.append(_message(i))
        append_session_event(tmp_path, "s1", record)
    assert [m.id for m in load_session(tmp_path, "s1").messages] == ["m0", "m1", "m2"]

    record.title = "second"
    record.messages.append(_message(3))
    append_session_event(tmp_path, "s1", record)
    loaded = load_session(tmp_path, "s1")
    assert loaded.title == "second" and len(loaded.messages) == 4


def test_callers_get_independent_copies(tmp_path):
    append_session_event(tmp_path, "s1", SessionRecord(id="s1", title="t"))
    first = load_session(tmp_path, "s1")
    first.messages.append(_message(0))
    first.title = "mutated"
    again = load_session(tmp_path, "s1")
    assert again.title == "t" and again.messages == []


def test_legacy_events_after_the_last_snapshot_are_replayed(tmp_path):
    append_session_event(tmp_path, "s1", SessionRecord(id="s1", title="t"))
    path = _session_file(tmp_path)
    message = _message(7).model_dump(mode="json")
    _append_raw(path, json.dumps({"event": "message", "message": message}) + "\n")
    _append_raw(path, json.dumps({"event": "quiz_pending", "quiz_id": "q1"}) + "\n")
    cold = load_session_file(path)
    assert [m.id for m in cold.messages] == ["m7"] and cold.pending_quiz_id == "q1"

    # The same events arriving after the cache was filled are folded incrementally.
    _append_raw(path, json.dumps({"event": "message", "message": _message(8).model_dump(mode="json")}) + "\n")
    assert [m.id for m in load_session_file(path).messages] == ["m7", "m8"]


def test_invalid_last_snapshot_falls_back_to_the_previous_one(tmp_path):
    append_session_event(tmp_path, "s1", SessionRecord(id="s1", title="good"))
    _append_raw(_session_file(tmp_path), json.dumps({"id": "s1", "mode": "NOPE"}) + "\n")
    assert load_session(tmp_path, "s1").title == "good"


def test_truncated_tail_is_skipped_then_completed(tmp_path):
    append_session_event(tmp_path, "s1", SessionRecord(id="s1", title="before"))
    path = _session_file(tmp_path)
    line = SessionRecord(id="s1", title="after").model_dump_json() + "\n"
    _append_raw(path, line[:20])  # A crash (or a write in progress) mid-append.
    assert load_session(tmp_path, "s1").title == "before"
    _append_raw(path, line[20:])
    assert load_session(tmp_path, "s1").title == "after"


def test_file_rewritten_in_place_is_read_again(tmp_path):
    append_session_event(tmp_path, "s1", SessionRecord(id="s1", title="old"))
    assert load_session(tmp_path, "s1").title == "old"
    path = _session_file(tmp_path)
    # Same inode, longer content: the bytes before the cached offset changed.
    path.write_text(SessionRecord(id="s1", title="rewritten, and longer").model_dump_json() + "\n")
    assert load_session(tmp_path, "s1").title == "rewritten, and longer"


def test_reads_do_not_create_harness_folders(tmp_path):
    assert load_session(tmp_path, "missing") is None
    assert list_sessions(tmp_path) == []
    assert not (tmp_path / ".harness").exists()


def test_read_objects_appends_and_skips_bad_lines(tmp_path):
    path = tmp_path / "log.jsonl"
    assert read_objects(path) == []
    path.write_text('{"a": 1}\nnot json\n[1]\n')
    assert read_objects(path) == [{"a": 1}]
    _append_raw(path, '{"a": 2}\n{"a": 3')
    assert read_objects(path) == [{"a": 1}, {"a": 2}]
    _append_raw(path, "}\n")
    assert read_objects(path) == [{"a": 1}, {"a": 2}, {"a": 3}]
    path.unlink()
    assert read_objects(path) == []
