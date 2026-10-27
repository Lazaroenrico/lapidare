"""Serve the Next.js static export (desktop build) on the same origin as the API."""

from __future__ import annotations

from pathlib import Path

from starlette.responses import FileResponse, PlainTextResponse, Response
from starlette.types import Receive, Scope, Send

# Dynamic segments are exported once under a placeholder; the page reads the real value
# from the URL (frontend lib/route-param.ts). Client-side navigation asks for the RSC
# payload (``/chat/<id>.txt?_rsc=…``), which must be the placeholder's ``.txt``, not HTML.
PLACEHOLDER_ROUTES = {"chat": "chat/_", "draw": "draw/_"}
IMMUTABLE = "public, max-age=31536000, immutable"


def resolve(root: Path, url_path: str) -> tuple[Path | None, int]:
    """Map a request path to a file inside ``root``: exact, ``.html``, ``index.html``,
    placeholder route, then ``404.html``. Never returns a path outside ``root``."""
    root = root.resolve()
    relative = url_path.lstrip("/")
    parts = [part for part in relative.split("/") if part]
    if any(part in {".", ".."} or "\\" in part or "\0" in part for part in parts):
        return None, 404
    candidates = [relative] if relative else []
    candidates += [f"{relative}.html", f"{relative}/index.html" if relative else "index.html"]
    if len(parts) == 2 and parts[0] in PLACEHOLDER_ROUTES:
        suffix = ".txt" if parts[1].endswith(".txt") else ".html"
        candidates.append(PLACEHOLDER_ROUTES[parts[0]] + suffix)
    for candidate in candidates:
        path = (root / candidate).resolve()
        if path.is_file() and path.is_relative_to(root):
            return path, 200
    missing = root / "404.html"
    return (missing, 404) if missing.is_file() else (None, 404)


class StaticSite:
    def __init__(self, root: Path) -> None:
        self.root = root

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        response: Response
        if scope["method"] not in {"GET", "HEAD"}:
            response = PlainTextResponse("Method Not Allowed", status_code=405)
        else:
            path, status = resolve(self.root, scope["path"])
            if scope["path"] == "/api" or scope["path"].startswith("/api/"):
                # An unknown API route is a plain 404, never the site's HTML page.
                response = PlainTextResponse("Not Found", status_code=404)
            elif path is None:
                response = PlainTextResponse("Not Found", status_code=404)
            else:
                headers = {"Cache-Control": IMMUTABLE} if scope["path"].startswith("/_next/static/") else {}
                response = FileResponse(path, status_code=status, headers=headers)
        await response(scope, receive, send)
