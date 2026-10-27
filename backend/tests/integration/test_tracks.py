"""Fase 14: several tracks (one in focus), legacy migration, routes, sessions and MCP provenance."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml
from starlette.testclient import TestClient

from learnharness.core.contracts.config import HarnessConfig, TrackConfig, TrackItem, TrackMode
from learnharness.core.contracts.quiz import CalibrationResult
from learnharness.core.contracts.session import PlanDag, PlanNode
from learnharness.core.events import SseEventType
from learnharness.mcp.content_client import ContentMcpClient
from learnharness.services.tracks import GeneratedTrack
from learnharness.vault.bootstrap import load_config, save_config
from learnharness.vault.transcript_importer import import_transcript_text
from tests.conftest import FakeEngine, poll_until

LEGACY_TRACK = {
    "mode": "repo_leveling", "repo_path": "/home/me/ai-course", "active_item_id": "s2",
    "queue": [{"id": "s1", "title": "Tokens", "completed": True}, {"id": "s2", "title": "Atenção"}],
}


def _write_raw_config(vault: Path, **changes) -> None:
    path = vault / ".harness/config.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data.pop("tracks", None)
    data.pop("active_track_id", None)
    data.update(changes)
    path.write_text(json.dumps(data), encoding="utf-8")


# ----------------------------------------------------------------- migration


def test_legacy_track_with_queue_becomes_the_active_track(configured_vault: Path) -> None:
    _write_raw_config(configured_vault, track=LEGACY_TRACK)
    first, second = load_config(configured_vault), load_config(configured_vault)
    assert len(first.tracks) == 1
    track = first.active_track()
    assert track is not None and track.id == second.tracks[0].id  # stable before any save
    assert track.id.startswith("trk-") and first.active_track_id == track.id
    assert (track.source, track.title, track.mode) == ("legacy", "ai-course", TrackMode.REPO_LEVELING)
    assert [i.id for i in track.queue] == ["s1", "s2"] and track.active_item_id == "s2"

    save_config(configured_vault, first)
    raw = json.loads((configured_vault / ".harness/config.json").read_text(encoding="utf-8"))
    assert "track" not in raw and raw["tracks"][0]["id"] == track.id
    assert load_config(configured_vault).tracks[0].id == track.id


def test_legacy_goal_track_without_queue_migrates_and_free_empty_does_not() -> None:
    goal = HarnessConfig.model_validate({"track": {"mode": "goal_generated", "goal_description": "Aprender RL\nmais"}})
    assert goal.active_track().title == "Aprender RL" and goal.active_track().source == "legacy"
    free = HarnessConfig.model_validate({"track": {"mode": "free", "queue": []}})
    assert free.tracks == [] and free.active_track() is None
    # A new-format config ignores a stray legacy key.
    both = HarnessConfig.model_validate({"track": LEGACY_TRACK, "tracks": []})
    assert both.tracks == []
    en = HarnessConfig.model_validate({"language": "en", "track": {"mode": "free", "queue": [{"id": "a", "title": "A"}]}})
    assert en.active_track().title == "Main track"


# ----------------------------------------------------------------- routes


def _spy_events(client: TestClient) -> list:
    hub = client.app.state.learnharness_state.sse_hub
    events: list = []
    original = hub.broadcast

    def spy(event, data):
        events.append(event)
        return original(event, data)

    hub.broadcast = spy
    return events


def test_tracks_crud_activation_and_archiving(api_client: TestClient, configured_vault: Path) -> None:
    events = _spy_events(api_client)
    map_path = configured_vault / "00 Mapa.md"
    map_path.write_text(map_path.read_text(encoding="utf-8") + "\n\nMinha anotação livre.\n", encoding="utf-8")

    res = api_client.post("/api/tracks", json={"title": "Cálculo I", "source": "manual",
                                               "items": ["Limites", "Derivadas\nIntegrais", "  "]})
    assert res.status_code == 200, res.text
    calc = res.json()
    assert calc == {
        "id": calc["id"], "title": "Cálculo I", "source": "manual", "mode": "free", "archived": False,
        "active": True, "created_at": calc["created_at"], "progress": {"done": 0, "total": 3},
        "next_item": {"id": "step-1", "title": "Limites"}, "generating": False, "error": None,
    }
    assert SseEventType.CONFIG_UPDATED in events
    state = api_client.app.state.learnharness_state
    assert not any(j["kind"] == "track_gen" for j in state.active_jobs.values())  # manual: no job

    other = api_client.post("/api/tracks", json={"title": "Física", "source": "manual", "items": ["Vetores"],
                                                 "activate": False}).json()
    listed = api_client.get("/api/tracks").json()
    assert [(t["title"], t["active"]) for t in listed] == [("Cálculo I", True), ("Física", False)]

    note = map_path.read_text(encoding="utf-8")
    assert "Minha anotação livre." in note
    assert "### ⇶ Cálculo I · ativa" in note and "### ⇶ Física <!--" in note
    assert "- [ ] Integrais <!-- step-3 -->" in note

    assert api_client.post(f"/api/tracks/{other['id']}/activate").json()["active"] is True
    assert load_config(configured_vault).active_track_id == other["id"]

    renamed = api_client.put(f"/api/tracks/{calc['id']}", json={"title": "Cálculo 1"}).json()
    assert renamed["title"] == "Cálculo 1"
    # Archiving the active track hands the focus to the next non-archived one.
    archived = api_client.put(f"/api/tracks/{other['id']}", json={"archived": True}).json()
    assert archived["archived"] is True and archived["active"] is False
    config = load_config(configured_vault)
    assert config.active_track_id == calc["id"]
    note = map_path.read_text(encoding="utf-8")
    assert "Física" not in note and "### ⇶ Cálculo 1 · ativa" in note and "Minha anotação livre." in note

    status = api_client.get("/api/setup/status").json()
    assert status["config"]["active_track_id"] == calc["id"]
    assert [t["id"] for t in status["config"]["tracks"]] == [calc["id"], other["id"]]
    assert status["tracks"] == status["config"]["tracks"]
    compat = status["config"]["track"]
    assert compat["id"] == calc["id"] and compat["active"] is True
    assert compat["current_step_id"] == "step-1" and [i["title"] for i in compat["items"]][:1] == ["Limites"]

    lesson_notes_before = sorted(p.name for p in (configured_vault / "Aulas").iterdir())
    res = api_client.delete(f"/api/tracks/{calc['id']}")
    assert res.json() == {"deleted": calc["id"], "active_track_id": None}  # the other one is archived
    assert api_client.get("/api/tracks").json()[0]["id"] == other["id"]
    assert sorted(p.name for p in (configured_vault / "Aulas").iterdir()) == lesson_notes_before
    assert api_client.get("/api/setup/status").json()["config"]["track"]["active"] is False
    assert api_client.delete(f"/api/tracks/{calc['id']}").status_code == 404
    assert api_client.post("/api/tracks", json={"source": "manual", "items": []}).status_code == 422


def test_goal_and_repo_tracks_generate_with_a_job_per_track(api_client: TestClient, configured_vault: Path,
                                                            fake_engine: FakeEngine, tmp_path: Path) -> None:
    fake_engine.program(GeneratedTrack, {"items": [
        {"id": "a", "title": "Introdução"}, {"id": "b", "title": "Aprofundamento", "prerequisites": ["a"]},
    ]})
    state = api_client.app.state.learnharness_state
    syllabus = "Ementa: Probabilidade\n" + "Conteúdo programático. " * 200
    goal = api_client.post("/api/tracks", json={"title": "", "source": "goal", "goal_description": syllabus}).json()
    assert goal["title"] == "Ementa: Probabilidade"
    repo = tmp_path / "curso"
    (repo / "lessons").mkdir(parents=True)
    (repo / "lessons/01.md").write_text("# Um\n\nTexto.", encoding="utf-8")
    second = api_client.post("/api/tracks", json={"source": "repo", "repo_path": str(repo)}).json()
    assert second["title"] == "curso"
    keys = {j["dedup_key"] for j in state.active_jobs.values() if j["kind"] == "track_gen"}
    assert keys == {f"track:{goal['id']}", f"track:{second['id']}"}
    config = poll_until(lambda: load_config(configured_vault),
                        lambda c: all(t.queue for t in c.tracks))
    assert [i.id for i in config.find_track(goal["id"]).queue] == ["a", "b"]
    assert syllabus[:40] in fake_engine.structured_calls[0]["prompt"]
    listed = {t["id"]: t for t in api_client.get("/api/tracks").json()}
    assert listed[goal["id"]]["generating"] is False and listed[goal["id"]]["next_item"]["id"] == "a"

    # Regenerate keeps "completed" for items with the same title.
    track = config.find_track(goal["id"])
    track.queue[0].completed = True
    save_config(configured_vault, config)
    fake_engine.program(GeneratedTrack, {"items": [
        {"id": "x", "title": "introdução"}, {"id": "y", "title": "Novo passo"},
    ]})
    res = api_client.post(f"/api/tracks/{goal['id']}/regenerate")
    assert res.status_code == 200, res.text
    config = poll_until(lambda: load_config(configured_vault),
                        lambda c: c.find_track(goal["id"]).queue[0].id == "x")
    regenerated = config.find_track(goal["id"])
    assert [(i.id, i.completed) for i in regenerated.queue] == [("x", True), ("y", False)]
    assert regenerated.active_item_id == "y"

    assert api_client.post("/api/tracks", json={"source": "repo", "repo_path": str(tmp_path / "nope")}).status_code == 422
    manual = api_client.post("/api/tracks", json={"source": "manual", "items": ["A"]}).json()
    assert api_client.post(f"/api/tracks/{manual['id']}/regenerate").status_code == 422


def test_failed_generation_reports_the_error_on_its_track(api_client: TestClient) -> None:
    created = api_client.post("/api/tracks", json={"title": "Sem resposta", "source": "goal",
                                                   "goal_description": "Objetivo"}).json()
    listed = poll_until(lambda: api_client.get("/api/tracks").json(), lambda ts: ts[0]["error"] is not None)
    assert listed[0]["id"] == created["id"] and listed[0]["generating"] is False


def test_setup_complete_adds_a_track_without_replacing_others(api_client: TestClient, configured_vault: Path,
                                                              fake_engine: FakeEngine) -> None:
    fake_engine.program(GeneratedTrack, {"items": [{"id": "a", "title": "A"}]})
    config = load_config(configured_vault)
    config.tracks = [TrackConfig(id="trk-old", title="Antiga", source="manual", queue=[TrackItem(id="o", title="O")])]
    config.active_track_id = "trk-old"
    save_config(configured_vault, config)
    payload = {"language": "pt-BR", "vault_path": str(configured_vault),
               "track": {"mode": "goal_generated", "goal_description": "Aprender estatística"}}
    res = api_client.post("/api/setup/complete", json=payload)
    assert res.status_code == 200, res.text
    config = poll_until(lambda: load_config(configured_vault), lambda c: len(c.tracks) == 2 and c.tracks[1].queue)
    assert config.tracks[0].id == "trk-old"
    assert config.active_track_id == config.tracks[1].id and config.tracks[1].source == "goal"
    # Re-running the same setup does not duplicate the track; a FREE track adds nothing.
    api_client.post("/api/setup/complete", json=payload)
    api_client.post("/api/setup/complete", json={"language": "pt-BR", "vault_path": str(configured_vault),
                                                 "track": {"mode": "free"}})
    assert len(load_config(configured_vault).tracks) == 2


# ----------------------------------------------------------------- sessions


async def test_session_on_a_track_completes_the_step_on_that_track(app_state, configured_vault, monkeypatch) -> None:
    config = load_config(configured_vault)
    config.tracks = [
        TrackConfig(id="trk-a", title="A", source="manual", active_item_id="t1",
                    queue=[TrackItem(id="t1", title="Passo A1"), TrackItem(id="t2", title="Passo A2")]),
        TrackConfig(id="trk-b", title="B", source="manual", active_item_id="t1",
                    queue=[TrackItem(id="t1", title="Passo B1"), TrackItem(id="t2", title="Passo B2")]),
    ]
    config.active_track_id = "trk-a"
    save_config(configured_vault, config)

    session = await app_state.sessions.create("TEACH", track_id="trk-b", track_item_id="t1", start=False)
    assert session.track_id == "trk-b" and session.title == "Passo B1"
    # Reuse is per (track_id, item_id): the same item id on the active track is another step.
    assert (await app_state.sessions.create("TEACH", track_id="trk-b", track_item_id="t1", start=False)).id == session.id
    on_active = await app_state.sessions.create("TEACH", track_item_id="t1", start=False)
    assert on_active.id != session.id and on_active.track_id == "trk-a" and on_active.title == "Passo A1"
    # track_id alone starts the track's current step.
    assert (await app_state.sessions.create("TEACH", track_id="trk-b", start=False)).id == session.id

    await app_state.sessions.set_plan(session.id, PlanDag(nodes=[PlanNode(id="n", label="N")]))
    record = app_state.sessions.get(session.id)
    record.phase = "teaching"
    record.answers = {"q": CalibrationResult(quiz_id="q", session_id=session.id, node_id="n", correct=True)}
    app_state.sessions.save(record)
    monkeypatch.setattr("learnharness.services.sessions.is_mastery_evidence", lambda answer, node: True)
    monkeypatch.setattr(app_state.graph, "maybe_extract", lambda s: None)
    result = await app_state.sessions.advance(session.id, "n", "mastered")
    assert result["phase"] == "completed"

    config = load_config(configured_vault)
    b, a = config.find_track("trk-b"), config.find_track("trk-a")
    assert b.item("t1").completed and b.active_item_id == "t2"
    assert not a.item("t1").completed and a.active_item_id == "t1"


# ----------------------------------------------------------------- MCP provenance


def test_mcp_frontmatter_is_generic_and_legacy_praxis_id_counts_as_imported(configured_vault: Path) -> None:
    target, _ = import_transcript_text(configured_vault, "Texto da aula.", "Aula 1", mcp_server="cursos",
                                       mcp_item_id="aula-1", force=True, subdir="MCP/cursos")
    meta = yaml.safe_load(target.read_text(encoding="utf-8").split("---", 2)[1])
    assert (meta["mcp_server"], meta["mcp_item_id"], meta["origem"]) == ("cursos", "aula-1", "MCP: cursos")
    assert "praxis_id" not in meta
    plain, _ = import_transcript_text(configured_vault, "Outro texto.", "Avulso", force=True)
    assert yaml.safe_load(plain.read_text(encoding="utf-8").split("---", 2)[1])["origem"] == "Import"

    legacy = configured_vault / "Fontes/Mentoria/Antiga.md"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text("---\npraxis_id: semana-3\norigem: Praxis\n---\n# Antiga\n\nTexto ^p1\n", encoding="utf-8")
    client = ContentMcpClient(servers=[], vault_path=configured_vault)
    assert client.imported_ids("cursos") == {"aula-1", "semana-3"}
    assert client.imported_ids("outro") == {"semana-3"}


@pytest.mark.parametrize("language,mark", [("pt-BR", "· ativa"), ("en", "· active")])
def test_track_block_marks_the_active_track(language: str, mark: str) -> None:
    from learnharness.services.tracks import render_track_block

    config = HarnessConfig(language=language, active_track_id="t", tracks=[
        TrackConfig(id="t", title="Um", queue=[TrackItem(id="i", title="Item", completed=True)]),
        TrackConfig(id="u", title="Dois"), TrackConfig(id="z", title="Velha", archived=True),
    ])
    block = render_track_block(config)
    assert f"### ⇶ Um {mark} <!-- t -->\n- [x] Item <!-- i -->" in block
    assert "### ⇶ Dois <!-- u -->" in block and "Velha" not in block
