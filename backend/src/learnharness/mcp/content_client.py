"""Client for external *content* MCP servers (any server: Praxis, docs servers, etc.).

Every call opens its own connection (streamable HTTP, SSE or stdio) with a hard timeout and
closes it afterwards. Items come from the configured ``catalog_tool`` when the server exposes
it, otherwise from ``resources/list``. Content fetched from remote servers is treated strictly
as data: it is only ever written verbatim into ``Fontes/`` and never interpreted.

No fake or fallback catalogs: an unreachable server raises :class:`ContentMcpError`.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import anyio
import yaml
from fastmcp import Client
from fastmcp.client.transports import SSETransport, StdioTransport, StreamableHttpTransport

from learnharness.core.contracts.config import McpServerConfig
from learnharness.services.secrets import resolve_auth
from learnharness.vault.safety import folder_map, safe_path

logger = logging.getLogger(__name__)

LIST_TIMEOUT = 10.0
READ_TIMEOUT = 60.0
_ID_KEYS = ("id", "item_id", "lesson_id", "slug", "uri", "key")
_TITLE_KEYS = ("title", "titulo", "name", "nome")
_KIND_KEYS = ("kind", "tipo", "type", "category")
_DESC_KEYS = ("description", "descricao", "summary", "resumo")
_LIST_KEYS = ("items", "lessons", "aulas", "resources", "results", "result", "data")
_TEXT_KEYS = ("content", "text", "transcript", "transcricao", "markdown", "body")


class ContentMcpError(RuntimeError):
    """A content MCP server could not be reached or returned unusable data (maps to HTTP 502)."""


class UnknownMcpServer(KeyError):
    """No content MCP server with the given name is configured (maps to HTTP 404)."""


def _first(data: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return None


def _describe(exc: BaseException) -> str:
    if isinstance(exc, BaseExceptionGroup):
        return "; ".join(_describe(e) for e in exc.exceptions)
    if isinstance(exc, TimeoutError):
        return "timed out"
    return f"{type(exc).__name__}: {exc}".strip()


class ContentMcpClient:
    """Lists and fetches educational content from configured MCP servers."""

    def __init__(
        self,
        servers: list[McpServerConfig] | None = None,
        vault_path: Path | None = None,
    ) -> None:
        self.servers = list(servers or [])
        self.vault_path = Path(vault_path) if vault_path else None

    # ------------------------------------------------------------------ helpers
    def get_server(self, name: str) -> McpServerConfig:
        for server in self.servers:
            if server.name == name:
                return server
        raise UnknownMcpServer(name)

    def enabled_servers(self) -> list[McpServerConfig]:
        return [s for s in self.servers if s.enabled]

    def _transport(self, server: McpServerConfig):
        token = resolve_auth(server.auth_ref)
        if server.transport in ("http", "sse"):
            if not server.url or not server.url.startswith(("http://", "https://")):
                raise ContentMcpError(f"MCP '{server.name}' has no valid http(s) URL")
            headers = {"Authorization": f"Bearer {token}"} if token else None
            cls = StreamableHttpTransport if server.transport == "http" else SSETransport
            return cls(server.url, headers=headers), token
        if not server.command:
            raise ContentMcpError(f"MCP '{server.name}' has no command")
        env = dict(server.env)
        if token and server.auth_env_var:
            # Tokens reach stdio servers only through the environment, never argv.
            env[server.auth_env_var] = token
        return StdioTransport(server.command, list(server.args), env=env or None, keep_alive=False), token

    def _error(self, server: McpServerConfig, action: str, exc: BaseException, token: str | None) -> ContentMcpError:
        detail = _describe(exc)
        if token:
            detail = detail.replace(token, "[redacted]")
        return ContentMcpError(f"MCP '{server.name}' {action} failed: {detail}"[:500])

    async def _run(self, server: McpServerConfig, action: str, timeout: float, op):
        transport, token = self._transport(server)
        try:
            with anyio.fail_after(timeout):
                async with Client(transport, timeout=timeout, init_timeout=timeout) as client:
                    return await op(client)
        except ContentMcpError:
            raise
        except (Exception, BaseExceptionGroup) as exc:  # noqa: BLE001 - every transport failure maps to 502
            raise self._error(server, action, exc, token) from None

    # ------------------------------------------------------------------ public API
    async def test(self, server: McpServerConfig) -> dict[str, Any]:
        async def op(client: Client) -> dict[str, Any]:
            tools = await client.list_tools()
            try:
                resources = len(await client.list_resources())
            except Exception:  # noqa: BLE001 - servers without the resources capability
                resources = 0
            return {"ok": True, "tools": [t.name for t in tools], "resources": resources}

        try:
            return await self._run(server, "test", LIST_TIMEOUT, op)
        except ContentMcpError as exc:
            return {"ok": False, "tools": [], "resources": 0, "error": str(exc)}

    async def list_items(self, server: McpServerConfig) -> list[dict[str, Any]]:
        items = await self._run(server, "list", LIST_TIMEOUT, lambda c: self._list(c, server))
        imported = self.imported_ids(server.name)
        for item in items:
            item["is_new"] = item["id"] not in imported
        return items

    async def fetch_item(self, server: McpServerConfig, item_id: str) -> str:
        async def op(client: Client) -> str:
            return await self._fetch(client, server, item_id, await _tool_names(client))

        return await self._run(server, "read", READ_TIMEOUT, op)

    async def fetch_items(self, server: McpServerConfig, item_ids: list[str]) -> list[dict[str, str]]:
        """Fetch several items over one connection; returns ``[{id, title, text}]``."""

        async def op(client: Client) -> list[dict[str, str]]:
            tools = await _tool_names(client)
            try:
                titles = {i["id"]: i["title"] for i in await self._list(client, server, tools)}
            except Exception:  # noqa: BLE001 - titles are cosmetic; fall back to ids
                titles = {}
            return [
                {"id": i, "title": titles.get(i) or i, "text": await self._fetch(client, server, i, tools)}
                for i in item_ids
            ]

        return await self._run(server, "read", READ_TIMEOUT + LIST_TIMEOUT, op)

    def imported_ids(self, server_name: str) -> set[str]:
        """Item ids of ``server_name`` already present in the sources folder (by frontmatter)."""
        if not self.vault_path:
            return set()
        try:
            root = safe_path(self.vault_path, folder_map(self.vault_path).sources_dir)
        except (OSError, ValueError):
            return set()
        found: set[str] = set()
        if not root.is_dir():
            return found
        for md in root.rglob("*.md"):
            meta = _frontmatter(md)
            if str(meta.get("mcp_server", "")) == server_name and meta.get("mcp_item_id") not in (None, ""):
                found.add(str(meta["mcp_item_id"]))
        return found

    # ------------------------------------------------------------------ internals
    async def _list(self, client: Client, server: McpServerConfig, tools: set[str] | None = None) -> list[dict[str, Any]]:
        tools = tools if tools is not None else await _tool_names(client)
        if server.catalog_tool and server.catalog_tool in tools:
            result = await client.call_tool(server.catalog_tool, {}, raise_on_error=False)
            if result.is_error:
                raise ContentMcpError(f"catalog tool '{server.catalog_tool}' returned an error")
            return _normalize_catalog(_tool_payload(result))
        resources = await client.list_resources()  # follows nextCursor pagination
        return [
            {
                "id": str(r.uri),
                "title": r.title or r.name or str(r.uri),
                "kind": "resource",
                "description": r.description or "",
            }
            for r in resources
        ]

    async def _fetch(self, client: Client, server: McpServerConfig, item_id: str, tools: set[str]) -> str:
        use_tool = (
            server.content_tool in tools
            and bool(server.catalog_tool)
            and server.catalog_tool in tools
        )
        if use_tool:
            result = await client.call_tool(
                server.content_tool, {server.content_id_argument: item_id}, raise_on_error=False
            )
            if result.is_error:
                raise ContentMcpError(f"content tool '{server.content_tool}' returned an error for '{item_id}'")
            texts, binary = _blocks_text(result.content)
            if not texts and isinstance(result.structured_content, dict):
                value = _first(result.structured_content, _TEXT_KEYS)
                if isinstance(value, str):
                    texts = [value]
        else:
            contents = await client.read_resource(item_id)
            texts, binary = _blocks_text(contents)
        text = "\n\n".join(t for t in texts if t.strip())
        if not text.strip():
            if binary:
                raise ContentMcpError(f"item '{item_id}' only has binary content; only text can be imported")
            raise ContentMcpError(f"item '{item_id}' returned no text content")
        return _unwrap_json_text(text)


async def _tool_names(client: Client) -> set[str]:
    return {t.name for t in await client.list_tools()}


def _blocks_text(blocks: list[Any]) -> tuple[list[str], bool]:
    texts: list[str] = []
    binary = False
    for block in blocks or []:
        inner = getattr(block, "resource", None) or block
        text = getattr(inner, "text", None)
        if isinstance(text, str):
            texts.append(text)
        elif getattr(inner, "blob", None) is not None or getattr(block, "data", None) is not None:
            binary = True
    return texts, binary


def _tool_payload(result: Any) -> Any:
    if result.structured_content is not None:
        payload = result.structured_content
        # FastMCP wraps non-object returns as {"result": ...}
        if isinstance(payload, dict) and set(payload) == {"result"}:
            return payload["result"]
        return payload
    texts, _ = _blocks_text(result.content)
    joined = "\n".join(texts).strip()
    try:
        return json.loads(joined)
    except ValueError as exc:
        raise ContentMcpError("catalog tool did not return JSON") from exc


def _normalize_catalog(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        for key in _LIST_KEYS:
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
    if not isinstance(payload, list):
        raise ContentMcpError("catalog tool returned an unexpected shape")
    items: list[dict[str, Any]] = []
    for raw in payload:
        if isinstance(raw, str):
            items.append({"id": raw, "title": raw, "kind": "item", "description": ""})
            continue
        if not isinstance(raw, dict):
            continue
        item_id = _first(raw, _ID_KEYS)
        if item_id is None:
            continue
        items.append(
            {
                "id": str(item_id),
                "title": str(_first(raw, _TITLE_KEYS) or item_id),
                "kind": str(_first(raw, _KIND_KEYS) or "item"),
                "description": str(_first(raw, _DESC_KEYS) or ""),
            }
        )
    return items


def _unwrap_json_text(text: str) -> str:
    """Tools often return ``{"content": "..."}`` as JSON text; keep only the text payload."""
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
        except ValueError:
            return text
        if isinstance(data, dict):
            value = _first(data, _TEXT_KEYS)
            if isinstance(value, str) and value.strip():
                return value
    return text


def _frontmatter(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            head = handle.read(8192)
    except OSError:
        return {}
    if not head.startswith("---"):
        return {}
    parts = head.split("---", 2)
    if len(parts) < 3:
        return {}
    try:
        meta = yaml.safe_load(parts[1])
    except yaml.YAMLError:
        return {}
    return meta if isinstance(meta, dict) else {}
