"""OAuth login for remote content MCP servers (http / sse).

Built on the MCP SDK's ``OAuthClientProvider`` (discovery, dynamic client registration, PKCE,
state check, refresh) that fastmcp itself wraps. We do not use fastmcp's ``OAuth`` class because
it opens the browser from the backend and keeps tokens in a generic key-value store; here the
backend only *captures* the authorization URL (the UI opens it, Electron routes it to the system
browser), receives the redirect on a loopback-only listener, and persists tokens outside the
Vault (``services/mcp_oauth_store.py``).

Login runs in a background task with a staging (in-memory) storage; the stored login is replaced
only when it completes, so a failed attempt never destroys a working one.
"""

from __future__ import annotations

import asyncio
import contextlib
import html
import logging
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import parse_qs, urlsplit

from fastmcp import Client
from fastmcp.client.transports import SSETransport, StreamableHttpTransport
from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import AuthorizationCodeResult, OAuthClientMetadata
from pydantic import AnyHttpUrl

from learnharness.core.contracts.config import McpServerConfig
from learnharness.services.mcp_oauth_store import FileOAuthStorage, MemoryOAuthStorage

logger = logging.getLogger(__name__)

CALLBACK_PATH = "/callback"
CALLBACK_TIMEOUT = 300.0
START_TIMEOUT = 30.0
LOGIN_REQUIRED = "Faça login neste servidor MCP (OAuth)"

OAuthStatus = Literal["signed_out", "pending", "signed_in", "error"]


class OAuthLoginRequired(RuntimeError):
    """Stored OAuth credentials are missing or no longer usable."""


class OAuthLoginError(RuntimeError):
    """The login could not be started or was refused (message is safe to show)."""


class _LoginStateError(RuntimeError):
    pass


def _contains(exc: BaseException, kind: type[BaseException]) -> bool:
    if isinstance(exc, BaseExceptionGroup):
        return any(_contains(e, kind) for e in exc.exceptions)
    return isinstance(exc, kind)


def contains_login_required(exc: BaseException) -> bool:
    return _contains(exc, OAuthLoginRequired)


def _describe(exc: BaseException) -> str:
    if isinstance(exc, BaseExceptionGroup):
        return "; ".join(_describe(e) for e in exc.exceptions)
    if isinstance(exc, TimeoutError):
        return "tempo esgotado"
    if isinstance(exc, (_LoginStateError, OAuthLoginError)):
        return str(exc)
    return f"{type(exc).__name__}: {exc}".strip()


def _metadata(server: McpServerConfig, redirect_uri: str) -> OAuthClientMetadata:
    return OAuthClientMetadata(
        client_name="Lapidare",
        redirect_uris=[AnyHttpUrl(redirect_uri)],
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        scope=" ".join(server.oauth_scopes) or None,
        token_endpoint_auth_method="none",
    )


class _Provider(OAuthClientProvider):
    """Honors the absolute expiry stored with the tokens (``expires_in`` is relative)."""

    async def _initialize(self) -> None:
        await super()._initialize()
        expiry = getattr(self.context.storage, "token_expiry", lambda: None)()
        if self.context.current_tokens and expiry:
            self.context.token_expiry_time = float(expiry)


def stored_provider(server: McpServerConfig, storage: FileOAuthStorage) -> OAuthClientProvider:
    """Provider for list/read calls: refreshes silently, never starts a browser flow."""

    async def redirect(_url: str) -> None:
        raise OAuthLoginRequired(LOGIN_REQUIRED)

    async def callback() -> AuthorizationCodeResult:
        raise OAuthLoginRequired(LOGIN_REQUIRED)

    return _Provider(
        server_url=(server.url or "").rstrip("/"),
        client_metadata=_metadata(server, f"http://127.0.0.1{CALLBACK_PATH}"),
        storage=storage,
        redirect_handler=redirect,
        callback_handler=callback,
    )


Connect = Callable[[McpServerConfig, OAuthClientProvider], Awaitable[None]]


async def _default_connect(server: McpServerConfig, provider: OAuthClientProvider) -> None:
    cls = StreamableHttpTransport if server.transport == "http" else SSETransport
    limit = CALLBACK_TIMEOUT + 60
    async with Client(cls(server.url or "", auth=provider), timeout=limit, init_timeout=limit) as client:
        await client.list_tools()


@dataclass
class _Flow:
    server: McpServerConfig
    staged: MemoryOAuthStorage = field(default_factory=MemoryOAuthStorage)
    url: asyncio.Future[str] = field(default_factory=lambda: asyncio.get_running_loop().create_future())
    code: asyncio.Future[AuthorizationCodeResult] = field(
        default_factory=lambda: asyncio.get_running_loop().create_future()
    )
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    expected_state: str | None = None
    port: int = 0
    error: str | None = None
    listener: asyncio.AbstractServer | None = None
    task: asyncio.Task[None] | None = None


def _page(ok: bool, message: str) -> bytes:
    title = "Login concluído" if ok else "Login não concluído"
    body = "Pode voltar ao Lapidare." if ok else html.escape(message)
    text = (
        '<!doctype html><html lang="pt-BR"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{title}</title>"
        "<body style=\"margin:0;min-height:100vh;display:grid;place-items:center;background:#1a1430;"
        'color:#efeaff;font-family:system-ui,sans-serif"><main style="text-align:center;padding:24px">'
        f"<h1 style=\"font-size:20px\">{title} — {body if ok else ''}</h1>"
        f"{'' if ok else f'<p style=\"color:#a99cd0\">{body}</p>'}"
        "</main></body></html>"
    )
    return text.encode()


async def _respond(writer: asyncio.StreamWriter, status: str, body: bytes) -> None:
    head = (
        f"HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {len(body)}\r\n"
        "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n"
        "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n"
    )
    writer.write(head.encode() + body)
    with contextlib.suppress(ConnectionError, OSError):
        await writer.drain()
    writer.close()


class McpOAuthManager:
    """Owns the login flows (one per server at a time) and answers status queries."""

    def __init__(
        self,
        notify: Callable[[str], None] | None = None,
        *,
        callback_timeout: float = CALLBACK_TIMEOUT,
        connect: Connect | None = None,
    ) -> None:
        self._notify = notify or (lambda _name: None)
        self._timeout = callback_timeout
        self._connect = connect or _default_connect
        self._flows: dict[str, _Flow] = {}
        self._errors: dict[str, str] = {}
        self._tasks: set[asyncio.Task[None]] = set()

    # ------------------------------------------------------------------ queries
    @staticmethod
    def storage_for(server: McpServerConfig) -> FileOAuthStorage:
        return FileOAuthStorage(server.name, server.url)

    def status(self, server: McpServerConfig) -> dict[str, Any]:
        flow = self._flows.get(server.name)
        if flow is not None and not flow.finished.is_set():
            return {"status": "pending"}
        if server.name in self._errors:
            return {"status": "error", "error": self._errors[server.name]}
        if self.storage_for(server).usable():
            return {"status": "signed_in"}
        return {"status": "signed_out"}

    # ------------------------------------------------------------------ login
    async def start(self, server: McpServerConfig) -> str:
        if server.auth_mode != "oauth" or server.transport == "stdio":
            raise OAuthLoginError("Este servidor não usa login OAuth")
        existing = self._flows.get(server.name)
        if existing is not None and not existing.finished.is_set():
            return await asyncio.shield(existing.url)  # single flow per server
        flow = _Flow(server)
        self._flows[server.name] = flow
        self._errors.pop(server.name, None)
        try:
            flow.listener = await asyncio.start_server(
                lambda r, w: self._handle(flow, r, w), host="127.0.0.1", port=0
            )
            flow.port = flow.listener.sockets[0].getsockname()[1]
        except OSError:
            self._flows.pop(server.name, None)
            raise OAuthLoginError("Não foi possível abrir o receptor local do login") from None
        flow.task = asyncio.create_task(self._run(flow))
        self._tasks.add(flow.task)
        flow.task.add_done_callback(self._tasks.discard)
        self._notify(server.name)
        try:
            return await asyncio.wait_for(asyncio.shield(flow.url), START_TIMEOUT)
        except Exception as exc:  # noqa: BLE001 - surfaced as a clean login error
            message = flow.error or ("tempo esgotado ao contatar o servidor" if isinstance(exc, TimeoutError) else str(exc))
            await self._abort(flow, message)
            raise OAuthLoginError(message) from None

    async def logout(self, server: McpServerConfig) -> None:
        flow = self._flows.get(server.name)
        if flow is not None and not flow.finished.is_set():
            await self._abort(flow, "Login cancelado")
        self._errors.pop(server.name, None)
        self.storage_for(server).clear()
        self._notify(server.name)

    async def _abort(self, flow: _Flow, message: str) -> None:
        flow.error = flow.error or message
        if flow.task is not None:
            flow.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await flow.task
        self._finish(flow)

    def _finish(self, flow: _Flow) -> None:
        flow.finished.set()
        if flow.listener is not None:
            flow.listener.close()
        for future in (flow.url, flow.code):
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()  # mark retrieved

    async def _run(self, flow: _Flow) -> None:
        server = flow.server
        secrets_seen: list[str] = []

        async def redirect(authorization_url: str) -> None:
            query = parse_qs(urlsplit(authorization_url).query)
            flow.expected_state = (query.get("state") or [None])[0]
            if not flow.url.done():
                flow.url.set_result(authorization_url)

        async def callback() -> AuthorizationCodeResult:
            try:
                return await asyncio.wait_for(asyncio.shield(flow.code), self._timeout)
            except TimeoutError:
                raise _LoginStateError(f"o login expirou após {int(self._timeout // 60) or 1} min sem resposta") from None

        provider = _Provider(
            server_url=(server.url or "").rstrip("/"),
            client_metadata=_metadata(server, f"http://127.0.0.1:{flow.port}{CALLBACK_PATH}"),
            storage=flow.staged,
            redirect_handler=redirect,
            callback_handler=callback,
        )
        try:
            await self._connect(server, provider)
            if flow.staged.tokens is None:
                raise _LoginStateError("o servidor não pediu autenticação OAuth")
            secrets_seen = [t for t in (flow.staged.tokens.access_token, flow.staged.tokens.refresh_token) if t]
            self.storage_for(server).commit(flow.staged)
        except asyncio.CancelledError:
            raise
        except (Exception, BaseExceptionGroup) as exc:  # noqa: BLE001
            detail = _describe(exc)
            for secret in secrets_seen + ([flow.staged.tokens.access_token] if flow.staged.tokens else []):
                detail = detail.replace(secret, "[redacted]")
            flow.error = flow.error or detail[:300]
            if not flow.url.done():
                flow.url.set_exception(OAuthLoginError(flow.error))
        finally:
            if flow.error:
                self._errors[server.name] = flow.error
            self._finish(flow)
            self._notify(server.name)

    # ------------------------------------------------------------------ loopback listener
    async def _handle(self, flow: _Flow, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            lines = raw.decode("latin-1").split("\r\n")
            method, target, *_ = [*lines[0].split(" "), "", ""]
            headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:] if ln)}
            if headers.get("host", "") not in (f"127.0.0.1:{flow.port}", f"localhost:{flow.port}"):
                await _respond(writer, "403 Forbidden", _page(False, "Host inválido"))
                return
            split = urlsplit(target)
            if method != "GET" or split.path != CALLBACK_PATH:
                await _respond(writer, "404 Not Found", _page(False, "Não encontrado"))
                return
            if flow.finished.is_set() or flow.code.done():
                await _respond(writer, "409 Conflict", _page(False, "Este login já foi concluído"))
                return
            query = {k: v[0] for k, v in parse_qs(split.query).items()}
            state = query.get("state")
            if not (flow.expected_state and state and secrets.compare_digest(state, flow.expected_state)):
                # Stray or forged request: refuse it and keep waiting for the genuine redirect.
                await _respond(writer, "400 Bad Request", _page(False, "Parâmetro state inválido"))
                return
            if query.get("error"):
                reason = f"O servidor recusou o login ({query['error'][:60]})"
                flow.code.set_exception(_LoginStateError(reason))
            elif not query.get("code"):
                flow.code.set_exception(_LoginStateError("Resposta de login sem código de autorização"))
            else:
                flow.code.set_result(
                    AuthorizationCodeResult(code=query["code"], state=state, iss=query.get("iss"))
                )
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(flow.finished.wait(), 30)
            ok = flow.error is None and flow.finished.is_set()
            await _respond(writer, "200 OK" if ok else "400 Bad Request", _page(ok, flow.error or "Falha no login"))
        except (TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError, OSError):
            writer.close()
