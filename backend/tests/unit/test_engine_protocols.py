"""Protocol fixtures execute controlled processes; no Google account/network involved."""

import asyncio
import json
import os
from types import SimpleNamespace

import pytest
from pydantic import BaseModel, ValidationError

from learnharness.engines.agy_engine import AgyStreamEngine
from learnharness.engines.cli_protocol import EngineError
from learnharness.engines.gemini_engine import GeminiHeadlessEngine
from learnharness.engines.genai_sdk_engine import GenAiSdkEngine


class Answer(BaseModel):
    answer: int


def executable(tmp_path, body):
    path = tmp_path / "provider"
    path.write_text("#!/usr/bin/env python3\n" + body)
    path.chmod(0o700)
    return str(path)


async def collect(engine, **kwargs):
    return "".join([part async for part in engine.stream_turn("question", "session", **kwargs)])


async def test_gemini_protocol_history_tools_stderr(tmp_path):
    binary = executable(
        tmp_path,
        """import json,sys,os
assert '--output-format' in sys.argv and 'stream-json' in sys.argv
assert 'earlier' in sys.argv[sys.argv.index('-p')+1]
assert os.getcwd() == os.path.dirname(__file__)
sys.stderr.write('diagnostic' * 100000)
for e in [{'type':'init'}, {'type':'message','role':'user','content':'ignore'},
 {'type':'tool_use','parameters':{'secret':'ignore'}}, {'type':'tool_result','output':'ignore'},
 {'type':'message','role':'assistant','content':'Hello '},
 {'type':'message','role':'assistant','content':'world'}, {'type':'result','status':'success'}]:
 print(json.dumps(e),flush=True)
""",
    )
    engine = GeminiHeadlessEngine(binary, work_dir=tmp_path)
    assert (
        await collect(engine, history=[SimpleNamespace(role="user", content="earlier")])
        == "Hello world"
    )


async def test_agy_stdin_and_structured_envelope(tmp_path):
    binary = executable(
        tmp_path,
        """import json,sys
assert '--input-format' in sys.argv
request=json.loads(sys.stdin.readline())
assert request['event']=='user' and request['message']['content']
print(json.dumps({'event':'step_update','step_update':{'step_type':'tool','text_delta':'ignore'}}))
print(json.dumps({'event':'result','result':{'status':'SUCCESS','structured_output':{'answer':42}}}))
""",
    )
    assert (await AgyStreamEngine(binary).run_structured("task", Answer)).answer == 42


@pytest.mark.parametrize(
    "events",
    [
        [{"type": "result", "status": "error"}],
        [{"type": "message", "role": "assistant", "content": "partial"}],
        [{"type": "error", "severity": "error", "message": "bad"}],
    ],
)
async def test_gemini_failure_is_not_success(tmp_path, events):
    binary = executable(tmp_path, "print(" + repr("\n".join(map(json.dumps, events))) + ")")
    with pytest.raises(EngineError):
        await collect(GeminiHeadlessEngine(binary))


async def test_invalid_structured_output_raises(tmp_path):
    binary = executable(
        tmp_path,
        """print('{"type":"message","role":"assistant","content":"{}"}')
print('{"type":"result","status":"success"}')
""",
    )
    with pytest.raises(ValidationError):
        await GeminiHeadlessEngine(binary).run_structured("task", Answer)


@pytest.mark.parametrize("cancel", [False, True])
async def test_timeout_and_cancellation_reap_child(tmp_path, cancel):
    pidfile = tmp_path / "pid"
    binary = executable(
        tmp_path,
        f"import os,time\nopen({str(pidfile)!r},'w').write(str(os.getpid()))\ntime.sleep(30)\n",
    )
    task = asyncio.create_task(collect(GeminiHeadlessEngine(binary, timeout=0.3)))
    for _ in range(100):
        if pidfile.exists():
            break
        await asyncio.sleep(0.01)
    if cancel:
        task.cancel()
    with pytest.raises(asyncio.CancelledError if cancel else EngineError):
        await task
    with pytest.raises(ProcessLookupError):
        os.kill(int(pidfile.read_text()), 0)


async def test_nonzero_exit_and_malformed_json(tmp_path):
    for body in ["import sys;sys.exit(2)", "print('not json')"]:
        with pytest.raises(EngineError):
            await collect(GeminiHeadlessEngine(executable(tmp_path, body)))


async def test_sdk_history_tools_and_image(monkeypatch):
    from learnharness.engines import genai_sdk_engine as module

    calls = []

    class Models:
        async def generate_content_stream(self, **kwargs):
            calls.append(kwargs)

            async def chunks():
                yield SimpleNamespace(text="real")

            return chunks()

        async def generate_content(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(text='{"slug":"diagram","summary_markdown":"Review"}')

    monkeypatch.setattr(
        module.genai,
        "Client",
        lambda **kwargs: SimpleNamespace(aio=SimpleNamespace(models=Models())),
    )
    engine = GenAiSdkEngine(api_key="test")

    def helper(value: str) -> str:
        return value

    assert (
        await collect(
            engine, history=[SimpleNamespace(role="assistant", content="prior")], tools=[helper]
        )
        == "real"
    )
    assert calls[0]["contents"][0].role == "model"
    assert calls[0]["config"].tools
    await engine.review_drawing_multimodal(b"PNG", "diagram")
    assert calls[1]["contents"][1].inline_data.data == b"PNG"
    from learnharness.core.contracts.drawing import DrawingReviewResult

    await engine.review_image(b"PNG2", "Judge.", DrawingReviewResult, None, context="brief",
                              system_instruction="Be strict.", image_name="figure.png", subject="figure")
    assert calls[2]["contents"][1].inline_data.data == b"PNG2"
    assert calls[2]["config"].system_instruction == "Be strict."


async def test_json_events_timeout_is_idle_not_total(tmp_path):
    from learnharness.engines.cli_protocol import json_events

    body = (
        "import time,json\nfor i in range(6):\n"
        " print(json.dumps({'i':i}),flush=True); time.sleep(0.15)\n"
    )
    events = [e async for e in json_events([executable(tmp_path, body)], timeout=0.5)]
    assert [e["i"] for e in events] == list(range(6))  # ~0.9s total > 0.5s idle budget


async def test_json_events_idle_clock_suspended_while_learner_answers(tmp_path, monkeypatch):
    from learnharness.engines import cli_protocol

    monkeypatch.setattr(cli_protocol, "SUSPEND_POLL_SECONDS", 0.05)
    body = "import time,json\ntime.sleep(0.8)\nprint(json.dumps({'ok':1}),flush=True)\n"
    binary = executable(tmp_path, body)
    events = [
        e async for e in cli_protocol.json_events([binary], timeout=0.3, is_suspended=lambda: True)
    ]
    assert events == [{"ok": 1}]
    with pytest.raises(EngineError, match="idle"):
        [e async for e in cli_protocol.json_events([binary], timeout=0.3)]


async def test_headless_drawing_review_attaches_png_reference(tmp_path):
    binary = executable(
        tmp_path,
        """import json,sys,os,re
prompt=sys.argv[sys.argv.index('-p')+1]
assert '--skip-trust' in sys.argv
name=re.search(r'@(drawing-[0-9a-f]+[.]png) ', prompt).group(1)
assert open(os.path.join(os.getcwd(), name),'rb').read()==b'PNGDATA'
print(json.dumps({'type':'result','status':'success',
 'structured_output':{'slug':'diagram','summary_markdown':'Review'}}))
""",
    )
    work = tmp_path / "work"
    result = await GeminiHeadlessEngine(binary, work_dir=work).review_drawing_multimodal(
        b"PNGDATA", "diagram"
    )
    assert result.slug == "diagram"
    assert not list(work.glob("drawing-*.png"))


def test_discovery_does_not_claim_authentication(monkeypatch):
    from learnharness.engines import detector

    monkeypatch.setattr(detector, "_find_executable", lambda *args: "/fake/bin")
    assert all(not item.authenticated and not item.models for item in detector.detect_connectors())


def test_agy_model_ids_with_effort_suffix_skip_effort_flag():
    from learnharness.core.contracts.config import EngineKind, ModelSlotConfig
    from learnharness.engines.agy_engine import AgyStreamEngine

    engine = AgyStreamEngine(binary_path="/bin/true")
    pinned = engine._base_command(ModelSlotConfig(engine=EngineKind.AGY, model_id="gemini-3.8-flash-low", effort="medium"))
    assert "--effort" not in pinned and pinned[pinned.index("--model") + 1] == "gemini-3.8-flash-low"
    auto = engine._base_command(ModelSlotConfig(engine=EngineKind.AGY, model_id="auto", effort="high"))
    assert "--model" not in auto and auto[auto.index("--effort") + 1] == "high"
