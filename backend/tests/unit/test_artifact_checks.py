"""Fase 17: demos tested in headless Chromium, visuals checked by eye (vision)."""

from __future__ import annotations

import pytest

from learnharness.core.contracts.demo import GeneratedDemo
from learnharness.core.contracts.jobs import VisualCheck, VisualDraft
from learnharness.engines.cli_protocol import EngineError
from learnharness.services import browser_check, demos, visuals
from learnharness.services.browser_check import (
    PROBE_ATTR,
    READY_ATTR,
    BrowserUnavailable,
    PageReport,
    find_chromium,
    parse_report,
    svg_render_size,
)
from learnharness.services.demos import (
    MAX_RUNTIME_FIXES,
    DemoRuntimeError,
    build_verified_demo,
    submit_demo,
)
from learnharness.services.visuals import MAX_VISUAL_EDITS, produce_visual
from tests.conftest import FakeEngine, wait_until

CHROMIUM = find_chromium()  # collection time: the autouse "off" fixture is not active yet

WORKING_HTML = """<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>Seno</title></head>
<body><canvas id="c" width="200" height="100"></canvas>
<input type="range" id="freq" min="1" max="5" step="1" value="2">
<script>
(function () {
  var ctx = document.getElementById("c").getContext("2d"), freq = document.getElementById("freq");
  function draw() {
    ctx.clearRect(0, 0, 200, 100);
    for (var x = 0; x < 200; x++) ctx.fillRect(x, 50 + 40 * Math.sin(x / 200 * Math.PI * 2 * freq.value), 1, 1);
  }
  freq.addEventListener("input", draw);
  draw();
})();
</script></body></html>"""

# Loads fine; breaks only when the slider moves (the probe moves every slider).
BROKEN_HTML = WORKING_HTML.replace('freq.addEventListener("input", draw);',
                                   'freq.addEventListener("input", function () { redraw(); });')

SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" '
       'fill="#1a1430"/><text x="20" y="100" fill="#efeaff" font-size="24">A → B</text></svg>')


def _demo(html: str) -> dict:
    return {"title": "Seno", "html": html, "learning_goal": "Ver a frequência.",
            "parameters": [{"id": "freq", "label": "Frequência", "min": 1, "max": 5, "step": 1, "default": 2}]}


# --- parsing (pure) ------------------------------------------------------------------------------

def test_report_reads_the_probe_attribute_and_quotes_the_source_line() -> None:
    document = "<html>\n<body>\n<script>boom();</script>\n</body></html>"
    dom = (f'<html {READY_ATTR}="exercised" {PROBE_ATTR}="[{{&quot;m&quot;:&quot;Uncaught ReferenceError: '
           f'boom is not defined&quot;,&quot;l&quot;:3}}]"><body></body></html>')
    report = parse_report(dom, "", document)
    assert report.errors == ["Uncaught ReferenceError: boom is not defined — at: <script>boom();</script>"]


def test_report_is_clean_only_when_the_probe_exercised_the_page() -> None:
    assert parse_report(f'<html {READY_ATTR}="exercised"></html>', "", "").clean
    unfinished = parse_report(f'<html {READY_ATTR}="loaded"></html>', "", "")
    assert not unfinished.clean and "time budget" in unfinished.errors[0]


def test_report_falls_back_to_stderr_when_the_probe_never_ran() -> None:
    stderr = ('[1:1:1027/1.0:INFO:CONSOLE:4] "Uncaught TypeError: x is null", source: file:///t/demo.html (2)\n'
              '[1:1:1027/1.0:INFO:CONSOLE:5] "hello", source: file:///t/demo.html (3)\n')
    report = parse_report("<html><body></body></html>", stderr, "line1\nx.go()\n")
    assert report.errors == ["Uncaught TypeError: x is null — at: x.go()"]
    assert not parse_report("<html></html>", "", "").clean


def test_chromium_detection_honours_the_off_switch(monkeypatch) -> None:
    monkeypatch.setenv(browser_check.CHROMIUM_ENV, "off")
    assert find_chromium() is None


def test_svg_render_size_keeps_the_viewbox_aspect() -> None:
    assert svg_render_size(SVG) == (1200, 600)
    assert svg_render_size('<svg viewBox="0 0 10 1000"/>')[1] == browser_check.SVG_MAX_HEIGHT
    assert svg_render_size("<svg/>") == (1200, 750)


# --- real Chromium ------------------------------------------------------------------------------

needs_chromium = pytest.mark.skipif(CHROMIUM is None, reason="no system Chromium")


@needs_chromium
async def test_real_chromium_detects_a_broken_handler_and_passes_the_fixed_demo() -> None:
    broken = await browser_check.run_html(BROKEN_HTML, binary=CHROMIUM)
    assert any("redraw is not defined" in e for e in broken.errors), broken.errors
    fixed = await browser_check.run_html(WORKING_HTML, binary=CHROMIUM)
    assert fixed.clean, fixed.errors


@needs_chromium
async def test_real_chromium_screenshots_an_svg() -> None:
    png = await browser_check.screenshot_svg(SVG, binary=CHROMIUM)
    assert png.startswith(b"\x89PNG")


@needs_chromium
async def test_verified_demo_loop_with_real_chromium(monkeypatch) -> None:
    monkeypatch.setenv(browser_check.CHROMIUM_ENV, CHROMIUM)
    engine = FakeEngine().program(GeneratedDemo, [_demo(BROKEN_HTML), _demo(WORKING_HTML)])
    activity: list[str] = []
    demo, verified, warnings = await build_verified_demo(engine, None, title="Seno", topic="seno", description="",
                                                         context={}, progress=activity.append)
    assert verified and not warnings and demo.html == WORKING_HTML
    assert "redraw is not defined" in engine.structured_calls[1]["prompt"]
    assert "testando no navegador" in activity


# --- demo loop (simulated browser) --------------------------------------------------------------

def _fake_browser(monkeypatch, reports):
    seen: list[str] = []

    async def run_html(html):
        seen.append(html)
        report = reports.pop(0)
        if isinstance(report, BaseException):
            raise report
        return report

    monkeypatch.setattr(demos, "run_html", run_html)
    return seen


async def test_runtime_errors_are_fed_back_until_the_demo_runs_clean(monkeypatch) -> None:
    seen = _fake_browser(monkeypatch, [PageReport(["Uncaught ReferenceError: a"]),
                                       PageReport(["Uncaught TypeError: b"]), PageReport()])
    engine = FakeEngine().program(GeneratedDemo, [_demo(BROKEN_HTML), _demo(BROKEN_HTML), _demo(WORKING_HTML)])
    activity: list[str] = []
    demo, verified, _warnings = await build_verified_demo(engine, None, title="Seno", topic="seno", description="",
                                                         context={}, progress=activity.append)
    assert verified and demo.html == WORKING_HTML and len(seen) == 3
    assert "Uncaught ReferenceError: a" in engine.structured_calls[1]["prompt"]
    assert "Uncaught TypeError: b" in engine.structured_calls[2]["prompt"]
    assert activity[:2] == ["gerando o simulador", "testando no navegador"]
    assert "corrigindo erros do navegador (1/3)" in activity


async def test_demo_still_broken_after_three_fixes_fails_with_the_errors(monkeypatch) -> None:
    _fake_browser(monkeypatch, [PageReport([f"Uncaught Error: e{i}"]) for i in range(MAX_RUNTIME_FIXES + 1)])
    engine = FakeEngine().program(GeneratedDemo, lambda prompt: _demo(BROKEN_HTML))
    with pytest.raises(DemoRuntimeError, match="e3"):
        await build_verified_demo(engine, None, title="Seno", topic="seno", description="", context={},
                                  progress=lambda _a: None)
    assert len(engine.structured_calls) == MAX_RUNTIME_FIXES + 1


async def test_without_chromium_the_validated_demo_ships_with_a_warning(monkeypatch) -> None:
    _fake_browser(monkeypatch, [BrowserUnavailable("Chromium not found")])
    engine = FakeEngine().program(GeneratedDemo, _demo(WORKING_HTML))
    _demo_out, verified, warnings = await build_verified_demo(engine, None, title="Seno", topic="seno", description="",
                                                         context={}, progress=lambda _a: None)
    assert not verified and "Chromium not found" in warnings[0]


async def test_demo_job_fails_and_saves_nothing_when_the_browser_keeps_failing(app_state, fake_engine,
                                                                                monkeypatch) -> None:
    _fake_browser(monkeypatch, [PageReport(["Uncaught Error: boom"]) for _ in range(MAX_RUNTIME_FIXES + 1)])
    fake_engine.program(GeneratedDemo, lambda prompt: _demo(BROKEN_HTML))
    record = submit_demo(app_state, "Seno", "seno")
    await wait_until(lambda: app_state.active_jobs[record["job_id"]]["status"] == "failed")
    assert "boom" in app_state.active_jobs[record["job_id"]]["error"]
    assert not list((app_state.vault_path / "viz").glob("demos/*.html"))


async def test_demo_job_without_chromium_completes_with_a_warning(app_state, fake_engine) -> None:
    fake_engine.program(GeneratedDemo, _demo(WORKING_HTML))
    record = submit_demo(app_state, "Seno", "seno")
    done = await wait_until(lambda: app_state.active_jobs[record["job_id"]]["status"] == "completed"
                            and app_state.active_jobs[record["job_id"]])
    assert done["result"]["verified"] is False
    assert done["warnings"] and "não testado no navegador" in done["warnings"][0]


# --- visual check (fake vision) -----------------------------------------------------------------

class VisionEngine(FakeEngine):
    """FakeEngine with a scripted ``review_image`` (one verdict or exception per call)."""

    def __init__(self, verdicts):
        super().__init__()
        self.verdicts = list(verdicts)
        self.image_calls: list[dict] = []

    async def review_image(self, png_bytes, instructions, schema, slot=None, **kwargs):
        self.image_calls.append({"png": png_bytes, "instructions": instructions, "schema": schema, **kwargs})
        verdict = self.verdicts.pop(0)
        if isinstance(verdict, BaseException):
            raise verdict
        return schema.model_validate(verdict)


@pytest.fixture
def fake_screenshot(monkeypatch):
    shots: list[str] = []

    async def screenshot_svg(svg):
        shots.append(svg)
        return b"\x89PNG-fake"

    monkeypatch.setattr(visuals, "screenshot_svg", screenshot_svg)
    return shots


def _drafts(n):
    return [{"title": "Fluxo", "alt": "a vira b", "svg": SVG.replace("A → B", f"versão {i}")} for i in range(n)]


async def test_visual_rejected_by_eye_is_edited_then_checked(fake_screenshot) -> None:
    engine = VisionEngine([{"communicates_brief": True, "problems": ["o rótulo 'B' está cortado na borda"]},
                           {"communicates_brief": True, "problems": [], "notes": "Mostra A virando B."}])
    engine.program(VisualDraft, _drafts(2))
    activity: list[str] = []
    draft, checked, notes, warnings = await produce_visual(engine, None, "A vira B", {}, activity.append)
    assert checked and notes == "Mostra A virando B." and not warnings
    assert "versão 1" in draft.svg and len(fake_screenshot) == 2
    edit = engine.structured_calls[1]["prompt"]
    assert "está cortado na borda" in edit and "versão 0" in edit
    assert engine.image_calls[0]["png"] == b"\x89PNG-fake" and engine.image_calls[0]["schema"] is VisualCheck
    assert "A vira B" in engine.image_calls[0]["context"]
    assert "conferindo o visual" in activity and "ajustando o visual (1/2)" in activity


async def test_visual_still_wrong_after_two_edits_ships_unchecked_with_notes(fake_screenshot) -> None:
    engine = VisionEngine([{"communicates_brief": False, "problems": [f"texto sobreposto {i}"]}
                           for i in range(MAX_VISUAL_EDITS + 1)])
    engine.program(VisualDraft, _drafts(MAX_VISUAL_EDITS + 1))
    _draft, checked, notes, warnings = await produce_visual(engine, None, "A vira B", {}, lambda _a: None)
    assert not checked and not warnings
    assert "texto sobreposto 2" in notes and "não comunica o brief" in notes
    assert len(engine.structured_calls) == MAX_VISUAL_EDITS + 1


async def test_vision_failure_ships_the_valid_svg_unchecked_with_a_warning(fake_screenshot) -> None:
    engine = VisionEngine([EngineError("agy answered without opening the figure image")])
    engine.program(VisualDraft, _drafts(1))
    draft, checked, _notes, warnings = await produce_visual(engine, None, "A vira B", {}, lambda _a: None)
    assert not checked and "versão 0" in draft.svg
    assert "without opening the figure image" in warnings[0]


async def test_engine_without_image_review_ships_unchecked(fake_screenshot) -> None:
    engine = FakeEngine().program(VisualDraft, _drafts(1))
    _, checked, _, warnings = await produce_visual(engine, None, "A vira B", {}, lambda _a: None)
    assert not checked and warnings


@needs_chromium
async def test_visual_check_renders_with_real_chromium(monkeypatch) -> None:
    monkeypatch.setenv(browser_check.CHROMIUM_ENV, CHROMIUM)
    engine = VisionEngine([{"communicates_brief": True, "problems": [], "notes": "ok"}])
    engine.program(VisualDraft, _drafts(1))
    _, checked, _, _ = await produce_visual(engine, None, "A vira B", {}, lambda _a: None)
    assert checked and engine.image_calls[0]["png"].startswith(b"\x89PNG")
