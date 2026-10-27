"""Drawing review through agy: a vision workspace whose gate allows only reading the PNG.

The fixture is a real agy 1.4.8 capture (gemini-3.8-flash-low) of a review of a TCP
handshake sketch with two deliberate errors; the workspace path is replaced by
``{{WORKSPACE}}`` and the fake binary puts its own cwd back.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from learnharness.core.contracts.drawing import DrawingReviewResult
from learnharness.engines import agy_gate
from learnharness.engines.agy_engine import AgyStreamEngine, write_agy_workspace
from learnharness.engines.cli_protocol import EngineError

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "agy" / "agy-1.4.8-vision-read-file-real.ndjson"


@pytest.mark.parametrize(
    ("name", "args", "decision"),
    [
        ("read_file", {"Path": "{ws}/drawing.png"}, "allow"),
        ("view_file", {"AbsolutePath": "file://{ws}/drawing.png"}, "allow"),
        ("finish", {}, "allow"),
        ("read_file", {"Path": "/etc/passwd"}, "deny"),
        ("read_file", {"Path": "{ws}/../secret.png"}, "deny"),
        ("read_file", {}, "deny"),
        ("call_mcp_tool", {"ServerName": "harness"}, "deny"),
        ("search_web", {"query": "x"}, "deny"),
        ("run_command", {"CommandLine": "ls"}, "deny"),
    ],
)
def test_vision_gate_allows_only_reads_inside_the_workspace(tmp_path, name, args, decision):
    ws = str(tmp_path / "ws")
    args = {k: v.format(ws=ws) for k, v in args.items()}
    payload = {"toolCall": {"name": name, "args": args}}
    assert agy_gate.decide(payload, policy="vision", workspace=ws)["decision"] == decision


def test_vision_gate_without_workspace_denies_reads():
    payload = {"toolCall": {"name": "read_file", "args": {"Path": "/tmp/x.png"}}}
    assert agy_gate.decide(payload, policy="vision")["decision"] == "deny"


def test_vision_workspace_gate_runs_standalone(tmp_path):
    write_agy_workspace(tmp_path, policy="vision")
    gate = tmp_path / ".agents" / "harness_gate.py"

    def run(name, path):
        out = subprocess.run(
            [sys.executable, "-I", str(gate)],
            input=json.dumps({"toolCall": {"name": name, "args": {"Path": path}}}),
            capture_output=True, text=True, check=True,
        )
        return json.loads(out.stdout)["decision"]

    assert run("read_file", str(tmp_path / "drawing.png")) == "allow"
    assert run("read_file", str(Path.home() / ".bashrc")) == "deny"
    with pytest.raises(ValueError):
        write_agy_workspace(tmp_path / "bad", "http://127.0.0.1:1/mcp", policy="vision")


FAKE_AGY = """
import json, os, sys
from pathlib import Path
log = Path(os.environ["FAKE_AGY_LOG"])
cwd = os.getcwd()
policy = json.loads((Path(cwd) / ".agents" / "gate_policy.json").read_text())["policy"]
request = json.loads(sys.stdin.readline())
image = Path(cwd) / "drawing.png"
log.write_text(json.dumps({"argv": sys.argv[1:], "cwd": cwd, "policy": policy,
                           "prompt": request["message"]["content"],
                           "image": image.read_bytes().decode("latin-1")}))
mode = os.environ.get("FAKE_AGY_MODE", "replay")
for line in Path(os.environ["FAKE_AGY_FIXTURE"]).read_text().splitlines():
    event = json.loads(line.replace("{{WORKSPACE}}", cwd))
    if mode == "no_read" and event.get("step_update", {}).get("tool_name") == "read_file":
        continue
    print(json.dumps(event), flush=True)
"""


def _fake_agy(tmp_path, mode="replay"):
    path = tmp_path / "agy"
    path.write_text(f"#!{sys.executable}\n{FAKE_AGY}")
    path.chmod(0o700)
    log = tmp_path / "agy-log.json"
    env = {"FAKE_AGY_LOG": str(log), "FAKE_AGY_FIXTURE": str(FIXTURE), "FAKE_AGY_MODE": mode}
    return AgyStreamEngine(str(path), default_model="gemini-3.8-flash-low", env=env, timeout=5), log


async def test_agy_reviews_the_drawing_from_the_real_capture(tmp_path):
    engine, log = _fake_agy(tmp_path)
    review = await engine.review_drawing_multimodal(b"\x89PNG-bytes", "TCP handshake", "<note>SYN, SYN-ACK, ACK</note>")
    assert isinstance(review, DrawingReviewResult)
    assert review.incorrect_points and any("FIN" in p for p in review.incorrect_points)
    assert review.follow_up_quiz is not None
    assert review.follow_up_quiz.choices[review.follow_up_quiz.correct_index] == "SYN, SYN-ACK, ACK"
    started = json.loads(log.read_text())
    assert started["policy"] == "vision" and "learnharness-agy-vision-" in started["cwd"]
    assert started["image"] == "\x89PNG-bytes"
    assert str(Path(started["cwd"]) / "drawing.png") in started["prompt"]
    assert "<note>SYN, SYN-ACK, ACK</note>" in started["prompt"]
    assert "--json-schema" in started["argv"] and "--model" in started["argv"]
    assert not Path(started["cwd"]).exists()  # the throwaway workspace is gone
    assert engine.work_dir is None


async def test_agy_review_without_reading_the_image_fails(tmp_path):
    engine, _ = _fake_agy(tmp_path, mode="no_read")
    with pytest.raises(EngineError, match="without opening the drawing"):
        await engine.review_drawing_multimodal(b"png", "t")


async def test_agy_review_refuses_an_empty_png(tmp_path):
    engine, _ = _fake_agy(tmp_path)
    with pytest.raises(ValueError):
        await engine.review_drawing_multimodal(b"", "t")
