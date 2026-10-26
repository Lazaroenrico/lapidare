"""Pure validation and hardening of LLM-generated simulator HTML (ZERO I/O).

Demos run inside ``<iframe sandbox="allow-scripts">`` (opaque origin). These checks are a
second, explicit layer: the HTML must be fully self-contained and must not try to reach the
network, the embedding page or browser storage. A strict CSP is injected on save.
"""

from __future__ import annotations

import json
import re
from typing import Any

MAX_DEMO_HTML_BYTES = 200_000

DEMO_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"
CSP_META = f'<meta http-equiv="Content-Security-Policy" content="{DEMO_CSP}">'

_NOT_MEMBER = r"(?<![\w.$])"

# (compiled pattern, human-readable reason fed back to the engine on repair)
FORBIDDEN_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"<script\b[^>]*\bsrc\s*=", re.I), "external <script src=...> is forbidden; inline all JS"),
    (re.compile(r"<link\b", re.I), "<link> tags are forbidden; inline all CSS"),
    (re.compile(r"@import\b", re.I), "CSS @import is forbidden"),
    (re.compile(r"url\(\s*['\"]?\s*(?:https?:)?//", re.I), "remote url(http...) references are forbidden"),
    (re.compile(r"\bfetch\s*\(", re.I), "fetch() is forbidden (no network access)"),
    (re.compile(r"\bXMLHttpRequest\b"), "XMLHttpRequest is forbidden (no network access)"),
    (re.compile(r"\bWebSocket\b"), "WebSocket is forbidden (no network access)"),
    (re.compile(r"\bEventSource\b"), "EventSource is forbidden (no network access)"),
    (re.compile(r"\bsendBeacon\b"), "navigator.sendBeacon is forbidden (no network access)"),
    (re.compile(r"\bimport\s*\("), "dynamic import() is forbidden"),
    (re.compile(r"<iframe\b", re.I), "nested <iframe> is forbidden"),
    (re.compile(r"<(?:object|embed)\b", re.I), "<object>/<embed> are forbidden"),
    (re.compile(r"<form\b[^>]*\baction\s*=", re.I), "<form action=...> is forbidden"),
    (re.compile(r"<meta\b[^>]*http-equiv\s*=\s*['\"]?refresh", re.I), "meta refresh is forbidden"),
    (re.compile(r"<base\b", re.I), "<base> is forbidden"),
    (re.compile(_NOT_MEMBER + r"(?:window\s*\.\s*)?(?:parent|top|opener)\.[A-Za-z_$]"), "access to window.parent/top/opener is forbidden"),
    (re.compile(r"\bwindow\s*\.\s*(?:parent|top|opener)\b"), "access to window.parent/top/opener is forbidden"),
    (re.compile(r"\b(?:localStorage|sessionStorage|indexedDB)\b"), "browser storage (localStorage/sessionStorage/indexedDB) is forbidden"),
    (re.compile(r"\bdocument\s*\.\s*cookie\b"), "document.cookie is forbidden"),
]

_INTERACTIVE = re.compile(r"<canvas\b|<input\b|<select\b", re.I)


def validate_demo_html(html: str) -> list[str]:
    """Return every rule the HTML violates (empty list means valid)."""
    errors: list[str] = []
    if not html or not html.strip():
        return ["HTML is empty"]
    size = len(html.encode("utf-8"))
    if size > MAX_DEMO_HTML_BYTES:
        errors.append(f"HTML is {size} bytes; the maximum is {MAX_DEMO_HTML_BYTES} bytes")
    seen: set[str] = set()
    for pattern, reason in FORBIDDEN_PATTERNS:
        match = pattern.search(html)
        if match and reason not in seen:
            seen.add(reason)
            errors.append(f"{reason} (found {match.group(0)!r})")
    if not _INTERACTIVE.search(html):
        errors.append("HTML must contain a <canvas> or an interactive <input>/<select> control")
    return errors


def _json_for_script(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2).replace("</", "<\\/")


def harden_demo_html(html: str, meta: dict[str, Any] | None = None) -> str:
    """Inject the strict CSP as the first element of <head> (plus optional demo metadata)."""
    injected = CSP_META
    if meta is not None:
        injected += f'\n<script type="application/json" id="demo-meta">\n{_json_for_script(meta)}\n</script>'
    head = re.search(r"<head\b[^>]*>", html, re.I)
    if head:
        return f"{html[:head.end()]}\n{injected}\n{html[head.end():]}"
    opening = re.search(r"<html\b[^>]*>", html, re.I)
    if opening:
        return f"{html[:opening.end()]}\n<head>\n{injected}\n</head>\n{html[opening.end():]}"
    doctype = re.match(r"\s*<!doctype[^>]*>", html, re.I)
    cut = doctype.end() if doctype else 0
    return f"{html[:cut]}\n<head>\n{injected}\n</head>\n{html[cut:]}"
