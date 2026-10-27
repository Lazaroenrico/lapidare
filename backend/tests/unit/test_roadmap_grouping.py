"""core.roadmap: modules/submodules of track steps for the ⇶ Roteiro constellation."""
from __future__ import annotations

from learnharness.core.contracts.config import TrackConfig, TrackItem
from learnharness.core.roadmap import item_grouping, prettify_segment, roadmap_layout


def test_prettify_segment_strips_prefixes_and_keeps_acronyms() -> None:
    assert prettify_segment("03-deep-learning") == "Deep learning"
    assert prettify_segment("02_self_attention") == "Self attention"
    assert prettify_segment("01-llm-basics") == "LLM basics"
    assert prettify_segment("07-rnns-and-LSTM") == "RNNs and LSTM"
    assert prettify_segment("intro-to-PyTorch") == "Intro to PyTorch"
    assert prettify_segment("1.2-math") == "Math"
    assert prettify_segment("42") == "42"


def test_repo_track_modules_come_from_meaningful_directories() -> None:
    track = TrackConfig(id="trk-r", source="github", queue=[
        TrackItem(id="a", title="A", source_ref="phases/03-deep-learning/02-attention/docs/en.md"),
        TrackItem(id="b", title="B", source_ref="phases/03-deep-learning/02-attention/code/main.py"),
        TrackItem(id="c", title="C", source_ref="phases/03-deep-learning/03-transformers/docs/en.md"),
        TrackItem(id="d", title="D", source_ref="phases/01-foundations/README.md"),
        TrackItem(id="e", title="E", source_ref="docs/en.md", stage_label="Extras"),
        TrackItem(id="f", title="F"),
    ])
    layout = roadmap_layout(track)
    assert layout["a"] == {"order": 0,
                           "module": {"id": "path:phases/03-deep-learning", "title": "Deep learning", "order": 0},
                           "submodule": {"id": "path:phases/03-deep-learning/02-attention", "title": "Attention"}}
    assert layout["b"]["submodule"] == layout["a"]["submodule"]
    assert layout["c"]["submodule"]["title"] == "Transformers"
    assert layout["d"]["module"] == {"id": "path:phases/01-foundations", "title": "Foundations", "order": 1}
    assert layout["d"]["submodule"] is None
    # No meaningful directory: the stage label, then the default module.
    assert layout["e"]["module"] == {"id": "stage:extras", "title": "Extras", "order": 2}
    assert layout["f"] == {"order": 5, "module": {"id": "track", "title": "", "order": 3}, "submodule": None}


def test_goal_track_modules_are_stage_labels_in_first_appearance_order() -> None:
    track = TrackConfig(id="trk-g", source="goal", queue=[
        TrackItem(id="1", title="x", stage_label="Fundamentos", source_ref="a/b/c.md"),
        TrackItem(id="2", title="y", stage_label="  Redes   neurais "),
        TrackItem(id="3", title="z", stage_label="fundamentos"),
    ])
    layout = roadmap_layout(track)
    assert layout["1"]["module"] == {"id": "stage:fundamentos", "title": "Fundamentos", "order": 0}
    assert layout["2"]["module"] == {"id": "stage:redes neurais", "title": "Redes neurais", "order": 1}
    assert layout["3"]["module"]["order"] == 0
    assert item_grouping(track, track.queue[0])[1] is None
