"""Source paragraphs and MCP content ingestion routes (/api/sources/* & /api/import/*)."""

from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, ValidationError

from learnharness.api.routes.chats import CreateChatPayload, create_chat
from learnharness.api.state import get_app_state
from learnharness.core.contracts.config import McpServerConfig
from learnharness.core.events import SseEventType
from learnharness.mcp.content_client import ContentMcpError, UnknownMcpServer
from learnharness.mcp.oauth_flow import McpOAuthManager, OAuthLoginError
from learnharness.services.secrets import (
    ENV_PREFIX,
    delete_secret,
    mcp_secret_key,
    resolve_auth,
    set_secret,
)
from learnharness.vault.bootstrap import save_config
from learnharness.vault.transcript_importer import (
    get_source_paragraph,
    import_transcript_text,
)

import_router = APIRouter(tags=["sources_and_import"])

_SERVER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


class IngestPayload(BaseModel):
    item_id: str | None = None
    server: str | None = None
    file_content: str | None = None
    file_name: str | None = None
    title: str


class McpServerPayload(BaseModel):
    name: str
    transport: Literal["http", "sse", "stdio"] = "http"
    url: str | None = None
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    # Write-only. Omitted/None keeps the stored token; "" removes it.
    auth_token: str | None = None
    # Alternative to auth_token: "env:VAR_NAME" reads the token from the backend environment.
    auth_ref: str | None = None
    # stdio only: env var through which the token is handed to the child process.
    auth_env_var: str | None = None
    # "oauth" is only valid for http/sse. Omitted: keep the stored mode (or derive from the token).
    auth_mode: Literal["none", "token", "oauth"] | None = None
    oauth_scopes: list[str] | None = None
    catalog_tool: str | None = None
    content_tool: str | None = None
    content_id_argument: str | None = None


class McpImportPayload(BaseModel):
    item_ids: list[str] = Field(min_length=1, max_length=200)
    start_session: bool = False


@import_router.get("/api/sources/paragraph")
@import_router.get("/api/sources/{source_name}/paragraph/{paragraph_id}")
async def get_paragraph(
    request: Request,
    source: str | None = Query(None),
    p: str | None = Query(None),
    source_name: str | None = None,
    paragraph_id: str | None = None,
) -> dict[str, Any]:
    """Retrieve an anchored paragraph (^pN) with context for citation drawers."""
    state = get_app_state(request.app)
    src = source or source_name
    pid = p or paragraph_id

    if not src or not pid:
        raise HTTPException(status_code=400, detail="Missing source or paragraph identifier")

    try:
        data = get_source_paragraph(state.vault_path, src, pid)
    except (FileNotFoundError, KeyError) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    ctx_before = "\n\n".join(data.get("context_before", []))
    ctx_after = "\n\n".join(data.get("context_after", []))

    return {
        # Frontend keys
        "sourceName": data.get("source", src),
        "paragraphId": data.get("target_paragraph_id", pid),
        "content": data.get("target_text", ""),
        "context_before": ctx_before,
        "context_after": ctx_after,
        "paragraphs": data.get("total_paragraphs"),
        # Backend keys
        "source": data.get("source", src),
        "target_text": data.get("target_text", ""),
        "full_context": data.get("full_context", ""),
    }


# --------------------------------------------------------------------------- helpers
def _public_server(server: McpServerConfig, oauth: McpOAuthManager | None = None) -> dict[str, Any]:
    """Serialize a server for API responses. Tokens never leave the backend."""
    return {
        "auth_mode": server.auth_mode,
        "oauth_scopes": list(server.oauth_scopes),
        "oauth": oauth.status(server) if oauth is not None and server.auth_mode == "oauth" else None,
        "name": server.name,
        "transport": server.transport,
        "url": server.url,
        "command": server.command,
        "args": list(server.args),
        "enabled": server.enabled,
        "has_auth": bool(resolve_auth(server.auth_ref)) if server.auth_mode != "oauth" else False,
        "auth_env_var": server.auth_env_var,
        "catalog_tool": server.catalog_tool,
        "content_tool": server.content_tool,
        "content_id_argument": server.content_id_argument,
    }


def _server_or_404(state: Any, name: str) -> McpServerConfig:
    try:
        return state.content_mcp_client.get_server(name)
    except UnknownMcpServer as exc:
        raise HTTPException(status_code=404, detail=f"Unknown MCP server '{name}'") from exc


def _bad_gateway(state: Any, exc: ContentMcpError) -> HTTPException:
    return HTTPException(status_code=502, detail=state.redact(str(exc)))


def _persist_servers(state: Any, servers: list[McpServerConfig]) -> None:
    config = state.get_config()
    config.content_mcps = servers
    save_config(state.vault_path, config)
    state.refresh_content_mcp_client()


def _clean_title(title: str, fallback: str) -> str:
    title = re.sub(r'[\\/*?:"<>|\x00-\x1f]', " ", title or "")
    title = re.sub(r"\s+", " ", title).strip(" .")
    return (title or re.sub(r"[^\w.-]+", "-", fallback).strip("-.") or "item")[:150]


def _import_text(state: Any, server_name: str, item_id: str, title: str, text: str) -> dict[str, Any]:
    target, count = import_transcript_text(
        vault_path=state.vault_path,
        raw_text=text,
        title=title,
        force=True,
        subdir=f"MCP/{server_name}",
        mcp_server=server_name,
        mcp_item_id=item_id,
        provenance={"source_kind": "mcp"},
    )
    return {
        "source_path": str(target.relative_to(state.vault_path)),
        "paragraph_count": count,
        "title": title,
    }


async def _teach_session(request: Request, title: str, source_path: str) -> str | None:
    chat = await create_chat(
        payload=CreateChatPayload(mode="TEACH", topic=title, source_file=source_path),
        request=request,
    )
    return chat.get("id")


# --------------------------------------------------------------------------- MCP servers
@import_router.get("/api/import/mcp/servers")
async def list_mcp_servers(request: Request) -> list[dict[str, Any]]:
    state = get_app_state(request.app)
    return [_public_server(s, state.mcp_oauth) for s in state.get_config().content_mcps]


@import_router.post("/api/import/mcp/servers")
async def upsert_mcp_server(payload: McpServerPayload, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    if not _SERVER_NAME.match(payload.name):
        raise HTTPException(status_code=422, detail="Invalid server name (letters, digits, _ . -; max 64)")
    if payload.auth_env_var and not _ENV_NAME.match(payload.auth_env_var):
        raise HTTPException(status_code=422, detail="Invalid auth_env_var")
    if payload.auth_ref and not (
        payload.auth_ref.startswith(ENV_PREFIX) and _ENV_NAME.match(payload.auth_ref[len(ENV_PREFIX):])
    ):
        raise HTTPException(status_code=422, detail="auth_ref must be 'env:VAR_NAME'")
    if payload.transport != "stdio" and payload.url and not payload.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="url must be http(s)")

    servers = list(state.get_config().content_mcps)
    existing = next((s for s in servers if s.name == payload.name), None)
    secret_key = mcp_secret_key(payload.name)
    auth_ref = existing.auth_ref if existing else None
    if payload.auth_ref:
        auth_ref = payload.auth_ref
    if payload.auth_mode:
        auth_mode = payload.auth_mode
    elif existing is not None:
        auth_mode = "token" if existing.auth_mode == "none" and payload.auth_token else existing.auth_mode
    else:
        auth_mode = "token" if payload.auth_token or payload.auth_ref else "none"
    if auth_mode != "token":
        auth_ref = None  # only token servers carry a token reference
    fields: dict[str, Any] = {
        "name": payload.name,
        "transport": payload.transport,
        "url": payload.url if payload.transport != "stdio" else None,
        "command": payload.command if payload.transport == "stdio" else None,
        "args": payload.args,
        "env": payload.env,
        "enabled": payload.enabled,
        "auth_ref": secret_key if payload.auth_token and auth_mode == "token" else auth_ref,
        "auth_env_var": payload.auth_env_var,
        "auth_mode": auth_mode,
        "oauth_scopes": (
            payload.oauth_scopes if payload.oauth_scopes is not None else (existing.oauth_scopes if existing else [])
        ),
    }
    if payload.auth_token == "" and auth_ref == secret_key:
        fields["auth_ref"] = None
    for key in ("catalog_tool", "content_tool", "content_id_argument"):
        value = getattr(payload, key)
        if value is not None:
            fields[key] = value
        elif existing is not None:
            fields[key] = getattr(existing, key)
    try:
        server = McpServerConfig.model_validate(fields)
    except ValidationError as exc:
        errors = "; ".join(str(e.get("msg", "")) for e in exc.errors())
        raise HTTPException(status_code=422, detail=errors or "Invalid MCP server") from None

    # Secrets are written only after validation, and never into the Vault.
    if auth_mode != "token":
        delete_secret(secret_key)
    elif payload.auth_token:
        set_secret(secret_key, payload.auth_token)
    elif payload.auth_token == "":
        delete_secret(secret_key)
    if existing is not None and existing.auth_mode == "oauth" and (
        server.auth_mode != "oauth" or server.url != existing.url
    ):
        await state.mcp_oauth.logout(existing)  # stale login: other mode or another endpoint
    servers = [s for s in servers if s.name != payload.name] + [server]
    _persist_servers(state, servers)
    return _public_server(server, state.mcp_oauth)


@import_router.delete("/api/import/mcp/servers/{name}", status_code=204)
async def delete_mcp_server(name: str, request: Request) -> Response:
    state = get_app_state(request.app)
    servers = list(state.get_config().content_mcps)
    if not any(s.name == name for s in servers):
        raise HTTPException(status_code=404, detail=f"Unknown MCP server '{name}'")
    removed = next(s for s in servers if s.name == name)
    _persist_servers(state, [s for s in servers if s.name != name])
    delete_secret(mcp_secret_key(name))
    if removed.auth_mode == "oauth":
        await state.mcp_oauth.logout(removed)
    return Response(status_code=204)


@import_router.post("/api/import/mcp/servers/{name}/oauth/login")
async def oauth_login(name: str, request: Request) -> dict[str, Any]:
    """Start the OAuth login in the background; the UI opens ``authorization_url`` itself."""
    state = get_app_state(request.app)
    server = _server_or_404(state, name)
    if server.auth_mode != "oauth":
        raise HTTPException(status_code=400, detail="This MCP server is not configured for OAuth login")
    try:
        url = await state.mcp_oauth.start(server)
    except OAuthLoginError as exc:
        raise HTTPException(status_code=502, detail=state.redact(str(exc))) from None
    return {"authorization_url": url, "oauth": state.mcp_oauth.status(server)}


@import_router.post("/api/import/mcp/servers/{name}/oauth/logout")
async def oauth_logout(name: str, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    server = _server_or_404(state, name)
    await state.mcp_oauth.logout(server)
    return {"oauth": state.mcp_oauth.status(server)}


@import_router.post("/api/import/mcp/servers/{name}/test")
async def test_mcp_server(name: str, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    result = await state.content_mcp_client.test(_server_or_404(state, name))
    if result.get("error"):
        result["error"] = state.redact(result["error"])
    return result


@import_router.get("/api/import/mcp/servers/{name}/items")
async def list_mcp_items(name: str, request: Request) -> list[dict[str, Any]]:
    state = get_app_state(request.app)
    server = _server_or_404(state, name)
    try:
        return await state.content_mcp_client.list_items(server)
    except ContentMcpError as exc:
        raise _bad_gateway(state, exc) from None


@import_router.post("/api/import/mcp/servers/{name}/import")
async def import_mcp_items(name: str, payload: McpImportPayload, request: Request) -> dict[str, Any]:
    state = get_app_state(request.app)
    server = _server_or_404(state, name)
    item_ids = list(dict.fromkeys(payload.item_ids))
    try:
        fetched = await state.content_mcp_client.fetch_items(server, item_ids)
    except ContentMcpError as exc:
        raise _bad_gateway(state, exc) from None

    imported = [
        _import_text(state, server.name, item["id"], _clean_title(item["title"], item["id"]), item["text"])
        for item in fetched
    ]
    state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"paths": [i["source_path"] for i in imported]})
    session_id = None
    if payload.start_session and len(imported) == 1:
        session_id = await _teach_session(request, imported[0]["title"], imported[0]["source_path"])
    return {"imported": imported, "session_id": session_id}


# --------------------------------------------------------------------------- legacy
@import_router.get("/api/import/catalog")
async def get_catalog(request: Request) -> dict[str, Any]:
    """Aggregate items of every enabled content MCP server (backward-compatible shape)."""
    state = get_app_state(request.app)
    client = state.content_mcp_client
    items: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    connected = False
    for server in client.enabled_servers():
        try:
            server_items = await client.list_items(server)
        except ContentMcpError as exc:
            errors.append({"server": server.name, "error": state.redact(str(exc))})
            continue
        connected = True
        for item in server_items:
            items.append(
                {
                    **item,
                    "server": server.name,
                    "week": None,
                    "category": item.get("kind", "item"),
                    "source_mcp": server.name,
                    "has_transcript": True,
                    "has_code": False,
                    "imported": not item.get("is_new", True),
                    "local_source_path": None,
                }
            )
    return {"mcp_connected": connected, "items": items, "errors": errors}


@import_router.post("/api/import/ingest")
@import_router.post("/api/import/source")
async def ingest_source(payload: IngestPayload, request: Request) -> dict[str, Any]:
    """Import a transcript into Fontes/ with ^pN anchors and start a TEACH session on it.

    ``file_content`` is imported directly; otherwise ``item_id`` is fetched from the MCP server
    named by ``server`` (or the only enabled one).
    """
    state = get_app_state(request.app)

    if payload.file_content:
        target_file, p_count = import_transcript_text(
            vault_path=state.vault_path,
            raw_text=payload.file_content,
            title=payload.title,
            mcp_server=payload.server if payload.item_id else None,
            mcp_item_id=payload.item_id,
            force=True,
        )
        source_path = str(target_file.relative_to(state.vault_path))
    elif payload.item_id:
        client = state.content_mcp_client
        if payload.server:
            server = _server_or_404(state, payload.server)
        else:
            enabled = client.enabled_servers()
            if len(enabled) != 1:
                raise HTTPException(status_code=400, detail="Specify 'server' to import an MCP item")
            server = enabled[0]
        try:
            text = await client.fetch_item(server, payload.item_id)
        except ContentMcpError as exc:
            raise _bad_gateway(state, exc) from None
        result = _import_text(
            state, server.name, payload.item_id, _clean_title(payload.title, payload.item_id), text
        )
        source_path, p_count = result["source_path"], result["paragraph_count"]
    else:
        raise HTTPException(status_code=400, detail="No content provided for ingestion")

    state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"paths": [source_path]})
    # Invariant 1: ingesting a dense source sets up a TEACH session anchored on it.
    session_id = await _teach_session(request, payload.title, source_path)
    return {
        "source_path": source_path,
        "session_id": session_id,
        "paragraph_count": p_count,
    }
