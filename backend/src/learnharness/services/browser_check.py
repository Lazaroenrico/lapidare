"""Headless Chromium checks for generated artifacts (Fase 17).

Two uses, both through the system Chromium detected at runtime (never downloaded):

* ``run_html(html)`` loads a demo in ``--headless=new --dump-dom`` with a probe script
  injected as the first thing in ``<head>``. The probe records uncaught exceptions,
  unhandled rejections, CSP violations, failed resource loads and ``console.error`` into an
  attribute of ``<html>``, then nudges every slider (min, max, back) and clicks every button
  so handler bugs surface too. ``--dump-dom`` serializes that attribute after the virtual
  time budget. Chromium also logs console messages to stderr (``INFO:CONSOLE``), but without
  the level (``console.log`` and ``console.error`` look the same there), so stderr is only
  the fallback for ``Uncaught`` lines when the probe itself never ran.
* ``screenshot_svg(svg)`` renders an SVG as ``<img src="data:image/svg+xml…">`` (exactly how
  the UI shows it) and returns the PNG from ``--screenshot``.

Every run uses a throwaway ``--user-data-dir`` (never the user's profile), runs as an
asyncio subprocess in its own process group and is killed on timeout.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import html as html_lib
import json
import os
import re
import shutil
import signal
import tempfile
import weakref
from dataclasses import dataclass, field
from pathlib import Path

from learnharness.child_env import child_env
from learnharness.core.demo_validation import harden_demo_html

CHROMIUM_NAMES = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable")
CHROMIUM_FALLBACKS = ("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome")
# Path to a Chromium binary, or "off" to disable the browser checks (tests, CI without one).
CHROMIUM_ENV = "LEARNHARNESS_CHROMIUM"

RUN_TIMEOUT_SECONDS = 30.0
VIRTUAL_TIME_BUDGET_MS = 4000
MAX_ERRORS = 12
SVG_RENDER_WIDTH = 1200
SVG_MAX_HEIGHT = 1600

_BASE_FLAGS = ("--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
               "--no-default-browser-check", "--disable-extensions", "--disable-sync",
               "--disable-background-networking", "--mute-audio", "--hide-scrollbars",
               "--force-device-scale-factor=1")

# At most two Chromium runs at once, per event loop (a Semaphore binds to one loop).
_SEMAPHORES: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    return _SEMAPHORES.setdefault(loop, asyncio.Semaphore(2))


class BrowserUnavailable(RuntimeError):
    """No usable Chromium (missing, disabled or failed to start): the check cannot run."""


@dataclass
class PageReport:
    errors: list[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.errors


def find_chromium() -> str | None:
    """The Chromium to use, detected at call time: env override, PATH, then /usr/bin."""
    override = os.environ.get(CHROMIUM_ENV, "").strip()
    if override.lower() in ("off", "0", "none", "disabled"):
        return None
    if override:
        return override if os.access(override, os.X_OK) else shutil.which(override)
    for name in CHROMIUM_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return next((p for p in CHROMIUM_FALLBACKS if os.access(p, os.X_OK)), None)


# ----------------------------------------------------------------- probe

PROBE_ATTR = "data-lh-errors"
READY_ATTR = "data-lh-probe"

PROBE_SCRIPT = """<script>(function () {
  var root = document.documentElement, errors = [];
  function record(message, line) {
    if (errors.length >= __MAX__) return;
    errors.push({m: String(message).slice(0, 400), l: line || 0});
    try { root.setAttribute("__ATTR__", JSON.stringify(errors)); } catch (_) {}
  }
  root.setAttribute("__READY__", "loaded");
  window.addEventListener("error", function (e) {
    if (e.target && e.target !== window && e.target.tagName) {
      record("Failed to load resource <" + e.target.tagName.toLowerCase() + ">", 0);
    } else {
      var text = String(e.message || e.error || "error");
      record(text.indexOf("Uncaught") === 0 ? text : "Uncaught " + text, e.lineno);
    }
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    record("Unhandled promise rejection: " + (r && r.message ? r.message : r), 0);
  });
  document.addEventListener("securitypolicyviolation", function (e) {
    record("Blocked by the CSP (" + e.violatedDirective + "): " + (e.blockedURI || "inline"), e.lineNumber);
  });
  var original = console.error;
  console.error = function () {
    record("console.error: " + Array.prototype.map.call(arguments, String).join(" "), 0);
    return original.apply(console, arguments);
  };
  function fire(el, type) { el.dispatchEvent(new Event(type, {bubbles: true})); }
  window.addEventListener("load", function () {
    setTimeout(function () {
      var ranges = document.querySelectorAll("input[type=range]");
      Array.prototype.forEach.call(ranges, function (el) {
        var initial = el.value;
        [el.min || "0", el.max || "100", initial].forEach(function (v) {
          el.value = v; fire(el, "input"); fire(el, "change");
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll("button"), function (b) { b.click(); });
      window.dispatchEvent(new Event("resize"));
      root.setAttribute("__READY__", "exercised");
    }, 300);
  });
})();</script>"""
PROBE_SCRIPT = (PROBE_SCRIPT.replace("__MAX__", str(MAX_ERRORS)).replace("__ATTR__", PROBE_ATTR)
                .replace("__READY__", READY_ATTR))


def instrument(html: str) -> str:
    """The demo as it is saved (strict CSP) with the probe as the first script of <head>."""
    hardened = harden_demo_html(html)
    head = re.search(r"<head\b[^>]*>", hardened, re.I)
    assert head is not None  # harden_demo_html always leaves a <head>
    return f"{hardened[:head.end()]}{PROBE_SCRIPT}{hardened[head.end():]}"


_HTML_TAG = re.compile(r"<html\b[^>]*>", re.I)
_STDERR_UNCAUGHT = re.compile(r'CONSOLE[^\]]*\]\s*"(Uncaught [^"]*)", source: [^(]*\((\d+)\)')


def _attr(tag: str, name: str) -> str | None:
    match = re.search(rf'\s{re.escape(name)}="([^"]*)"', tag)
    return html_lib.unescape(match.group(1)) if match else None


def _with_source(message: str, line: int, lines: list[str]) -> str:
    if 0 < line <= len(lines):
        snippet = lines[line - 1].strip()
        if snippet:
            return f"{message} — at: {snippet[:160]}"
    return message


def parse_report(dom: str, stderr: str, document: str) -> PageReport:
    """Errors from the probe attribute in the dumped DOM; stderr only when the probe never ran."""
    lines = document.splitlines()
    tag_match = _HTML_TAG.search(dom)
    tag = tag_match.group(0) if tag_match else ""
    ready = _attr(tag, READY_ATTR)
    errors: list[str] = []
    raw = _attr(tag, PROBE_ATTR)
    if raw:
        try:
            for item in json.loads(raw):
                errors.append(_with_source(str(item.get("m", "")), int(item.get("l") or 0), lines))
        except (ValueError, TypeError, AttributeError):
            errors.append("The page's error report could not be read")
    if ready is None:
        for message, line in _STDERR_UNCAUGHT.findall(stderr):
            errors.append(_with_source(message, int(line), lines))
        if not errors:
            errors.append("The page never ran its scripts (the document did not load or was replaced)")
    elif ready != "exercised":
        errors.append("The page did not finish loading within the time budget (an endless loop or a blocking load?)")
    unique = list(dict.fromkeys(errors))
    return PageReport(errors=unique[:MAX_ERRORS])


# ----------------------------------------------------------------- process


async def _run(binary: str, args: list[str], timeout: float) -> tuple[int | None, str, str]:
    """Run Chromium in its own process group; kill the whole group on timeout."""
    process = await asyncio.create_subprocess_exec(
        binary, *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, start_new_session=True, env=child_env())
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except (TimeoutError, asyncio.CancelledError):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(process.wait(), 5)
        raise
    return process.returncode, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")


async def run_html(html: str, *, binary: str | None = None, timeout: float = RUN_TIMEOUT_SECONDS) -> PageReport:
    """Load the demo headless (with the probe) and report its runtime errors."""
    binary = binary or find_chromium()
    if not binary:
        raise BrowserUnavailable("Chromium not found")
    document = instrument(html)
    async with _semaphore():
        with tempfile.TemporaryDirectory(prefix="learnharness-chromium-", ignore_cleanup_errors=True) as work:
            page = Path(work) / "demo.html"
            page.write_text(document, encoding="utf-8")
            args = [*_BASE_FLAGS, f"--user-data-dir={work}/profile", "--enable-logging=stderr", "--v=0",
                    f"--virtual-time-budget={VIRTUAL_TIME_BUDGET_MS}", "--dump-dom", page.as_uri()]
            try:
                code, dom, stderr = await _run(binary, args, timeout)
            except TimeoutError:
                return PageReport(errors=[f"The page did not finish within {int(timeout)} s "
                                          "(an endless loop in the script?)"])
            except OSError as exc:
                raise BrowserUnavailable(f"Chromium could not start: {exc}") from exc
    if code != 0 and not dom.strip():
        raise BrowserUnavailable(f"Chromium exited with code {code}: {stderr.strip()[-300:]}")
    return parse_report(dom, stderr, document)


_VIEWBOX = re.compile(r"<svg\b[^>]*\bviewBox\s*=\s*[\"']\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([\d.eE+]+)[\s,]+([\d.eE+]+)",
                      re.I | re.S)


def svg_render_size(svg: str) -> tuple[int, int]:
    """Fixed width, height from the viewBox aspect (bounded)."""
    match = _VIEWBOX.search(svg)
    width = SVG_RENDER_WIDTH
    try:
        vw, vh = (float(match.group(3)), float(match.group(4))) if match else (0.0, 0.0)
    except ValueError:
        vw, vh = 0.0, 0.0
    if vw <= 0 or vh <= 0:
        return width, int(width * 0.625)
    return width, max(200, min(SVG_MAX_HEIGHT, round(width * vh / vw)))


async def screenshot_svg(svg: str, *, binary: str | None = None,
                         timeout: float = RUN_TIMEOUT_SECONDS) -> bytes:
    """PNG of the SVG as the UI shows it (an ``<img>`` with a data URI), at a fixed width."""
    binary = binary or find_chromium()
    if not binary:
        raise BrowserUnavailable("Chromium not found")
    width, height = svg_render_size(svg)
    data = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    page_html = ("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0;"
                 f"background:#141414}}img{{display:block;width:{width}px;height:{height}px}}</style>"
                 f"</head><body><img src=\"data:image/svg+xml;base64,{data}\"></body></html>")
    async with _semaphore():
        with tempfile.TemporaryDirectory(prefix="learnharness-chromium-", ignore_cleanup_errors=True) as work:
            page = Path(work) / "visual.html"
            page.write_text(page_html, encoding="utf-8")
            target = Path(work) / "visual.png"
            args = [*_BASE_FLAGS, f"--user-data-dir={work}/profile", f"--window-size={width},{height}",
                    "--virtual-time-budget=1000", f"--screenshot={target}", page.as_uri()]
            try:
                code, _, stderr = await _run(binary, args, timeout)
            except TimeoutError as exc:
                raise BrowserUnavailable(f"Chromium did not render the figure within {int(timeout)} s") from exc
            except OSError as exc:
                raise BrowserUnavailable(f"Chromium could not start: {exc}") from exc
            if not target.is_file() or target.stat().st_size == 0:
                raise BrowserUnavailable(f"Chromium produced no screenshot (exit {code}): {stderr.strip()[-300:]}")
            return target.read_bytes()
