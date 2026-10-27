"""``--json-schema`` answers: a lossy ``finish`` payload loses to the full JSON in the text.

Fixture: the real agy 1.4.8 ``result`` event of a Cálculo I track generation
(gemini-3.8-flash-low) whose text held 21 items while ``structured_output`` held one
("Trilha de Aprendizagem: MAT0111 ...", ``completed: true``).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pydantic import BaseModel

from learnharness.engines.agy_engine import AgyStreamEngine
from learnharness.engines.gemini_engine import pick_structured
from learnharness.services.track_generation import GeneratedTrack

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "agy" / "agy-1.4.8-track-collapsed-result-real.ndjson"


def _result():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["result"]


def test_real_collapsed_finish_payload_is_replaced_by_the_fenced_answer():
    result = _result()
    assert len(result["structured_output"]["items"]) == 1
    track = pick_structured(GeneratedTrack, result["structured_output"], result["response"])
    assert len(track.items) == 21
    assert track.items[0].id == "mat0111-diag-precalc"
    assert all(p in {i.id for i in track.items} for i in track.items for p in i.prerequisites)


class Answer(BaseModel):
    text: str


def test_structured_output_wins_without_a_richer_valid_block():
    assert pick_structured(Answer, {"text": "full answer"}, "no json here").text == "full answer"
    shorter = "```json\n{\"text\": \"x\"}\n```"
    assert pick_structured(Answer, {"text": "full answer"}, shorter).text == "full answer"
    invalid = "```json\n{\"other\": \"a much longer but invalid payload\"}\n```"
    assert pick_structured(Answer, {"text": "ok"}, invalid).text == "ok"


FAKE_AGY = """
import os, sys
from pathlib import Path
sys.stdin.readline()
print(Path(os.environ["FAKE_AGY_FIXTURE"]).read_text().strip(), flush=True)
"""


async def test_agy_run_structured_returns_the_full_track(tmp_path):
    path = tmp_path / "agy"
    path.write_text(f"#!{sys.executable}\n{FAKE_AGY}")
    path.chmod(0o700)
    engine = AgyStreamEngine(str(path), env={"FAKE_AGY_FIXTURE": str(FIXTURE)}, timeout=5)
    track = await engine.run_structured("ementa", GeneratedTrack)
    assert len(track.items) == 21
