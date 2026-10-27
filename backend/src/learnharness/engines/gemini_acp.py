"""Persistent ``gemini --acp`` adapter: Agent Client Protocol, JSON-RPC 2.0 over stdio.

Protocol facts verified against gemini-cli 0.62.0 (see ``tests/fixtures/acp/``):

* Framing: one JSON object per line on stdin/stdout (``ndJsonStream``).
* ``initialize {protocolVersion: 1, clientCapabilities}`` -> ``{protocolVersion: 1,
  agentCapabilities: {loadSession: true, mcpCapabilities: {http: true, sse: true}, ...},
  authMethods, agentInfo}``. We advertise no ``fs``/``terminal`` capabilities.
* ``session/new {cwd, mcpServers: [{type: "http", name, url, headers: [{name, value}]}]}``
  -> ``{sessionId, modes, models}``. Authentication errors surface here (code -32000).
* ``session/load {sessionId, cwd, mcpServers}`` re-binds MCP servers on a live session.
* ``session/prompt {sessionId, prompt: [{type: "text", text}]}`` -> ``{stopReason}``
  (``end_turn`` | ``cancelled`` | ``max_tokens`` | ``max_turn_requests`` | ``refusal``).
* Notifications ``session/update {sessionId, update: {sessionUpdate, ...}}`` with
  ``agent_message_chunk`` / ``agent_thought_chunk`` (``content: {type: "text", text}``),
  ``tool_call`` (``toolCallId``, ``status``, ``title``, ``kind``) and ``tool_call_update``.
* Agent -> client request ``session/request_permission {sessionId, toolCall, options:
  [{optionId, name, kind}]}`` answered with ``{outcome: {outcome: "selected", optionId}}``
  or ``{outcome: {outcome: "cancelled"}}``. MCP tool ids look like
  ``mcp_<server>_<tool>-<ts>-<n>`` (``fc.id`` when the model provides one).
* ``session/cancel {sessionId}`` is a notification; the pending prompt then resolves
  with ``stopReason: "cancelled"``.
"""

import asyncio
import contextlib
import itertools
import json
import logging
import os
import re
import signal
from dataclasses import dataclass
from typing import ClassVar

from learnharness.engines.cli_protocol import EngineError, idle_wait
from learnharness.engines.detector import KNOWN_GEMINI_PATHS, _find_executable
from learnharness.engines.gemini_engine import GeminiHeadlessEngine, write_workspace_settings
from learnharness.engines.usage import acp_usage, report_usage

logger = logging.getLogger(__name__)

ACP_PROTOCOL_VERSION = 1
HARNESS_SERVER = "harness"
# Mirrors learnharness.mcp.runtime_server.HARNESS_TOOL_NAMES (asserted by tests).
HARNESS_TOOLS = frozenset({
    "probe", "recall", "quiz", "explain", "ask_user_question", "probe_done", "plan_init",
    "grade_recall", "plan_advance", "track_foundation", "spawn_demo", "problem", "conclude", "graph_search",
    "research", "read_pdf", "visual", "leveling_done",
})
IDLE_CLOSE_SECONDS = 600
CANCEL_GRACE_SECONDS = 2.0
HISTORY_MAX_MESSAGES = 24
HISTORY_MAX_CHARS_PER_MESSAGE = 1200
HISTORY_MAX_CHARS = 16000
METHOD_NOT_FOUND = -32601
_ACTIVE_TOOL_STATUSES = {"pending", "in_progress"}
_FINAL_TOOL_STATUSES = {"completed", "failed"}
_CALL_SUFFIX = re.compile(r"-\d+-\d+$")


class AcpRpcError(EngineError):
    """JSON-RPC error returned by the agent (e.g. authentication or quota)."""

    def __init__(self, method, error):
        self.code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message", "") if isinstance(error, dict) else str(error)
        super().__init__(f"Gemini ACP {method} failed: {message}")


# --------------------------------------------------------------------------- pure helpers


def harness_tool_call(tool_call):
    """True when an ACP ``toolCall`` belongs to the harness MCP server.

    Combined with ``--allowed-mcp-server-names harness`` (no other MCP server is loaded)
    and the native-tool exclusion, a harness tool name cannot be impersonated.
    """
    if not isinstance(tool_call, dict):
        return False
    call_id = str(tool_call.get("toolCallId") or "")
    if call_id.startswith(f"mcp_{HARNESS_SERVER}_"):
        return True
    if _CALL_SUFFIX.sub("", call_id) in HARNESS_TOOLS:
        return True
    title = str(tool_call.get("title") or "")
    if f"({HARNESS_SERVER} MCP Server)" in title:
        return True
    head = re.split(r"[\s(:]", title.strip(), maxsplit=1)[0] if title.strip() else ""
    return head in HARNESS_TOOLS


def _pick_option(options, kinds):
    for kind in kinds:
        for option in options:
            if isinstance(option, dict) and option.get("kind") == kind and option.get("optionId"):
                return option["optionId"]
    return None


def permission_response(params):
    """Auto-approve harness MCP tools (once), deny everything else."""
    options = (params or {}).get("options") or []
    if harness_tool_call((params or {}).get("toolCall")):
        option_id = _pick_option(options, ("allow_once", "allow_always"))
    else:
        option_id = _pick_option(options, ("reject_once", "reject_always"))
    if option_id is None:
        return {"outcome": {"outcome": "cancelled"}}
    return {"outcome": {"outcome": "selected", "optionId": option_id}}


def handle_agent_request(method, params):
    """Answer an agent -> client request. Returns ``(result, error)``."""
    if method == "session/request_permission":
        return permission_response(params), None
    if method.startswith(("fs/", "terminal/")):
        return None, {
            "code": METHOD_NOT_FOUND,
            "message": "File system and terminal access are disabled by the learning harness",
        }
    return None, {"code": METHOD_NOT_FOUND, "message": f"Unsupported method: {method}"}


def parse_update(message):
    """Normalise a ``session/update`` notification into ``(kind, payload)``.

    kinds: ``text`` (str), ``tool`` (dict with id/status/harness), ``event`` (ignored).
    """
    update = ((message or {}).get("params") or {}).get("update") or {}
    kind = update.get("sessionUpdate")
    if kind == "agent_message_chunk":
        content = update.get("content") or {}
        text = content.get("text", "") if content.get("type") == "text" else ""
        # Gemini CLI injects approval-mode changes as fake message chunks.
        if text.startswith("[MODE_UPDATE]"):
            return "event", update
        return "text", text
    if kind in {"tool_call", "tool_call_update"}:
        return "tool", {
            "id": update.get("toolCallId"),
            "status": update.get("status"),
            "harness": harness_tool_call(update),
        }
    return "event", update


def compact_history(history):
    """Bounded plain-text summary of persisted messages for rehydrating a fresh process."""
    lines, total = [], 0
    for message in reversed(list(history or [])[-HISTORY_MAX_MESSAGES:]):
        role = getattr(message, "role", None) or (message.get("role") if isinstance(message, dict) else "")
        content = getattr(message, "content", None)
        if content is None and isinstance(message, dict):
            content = message.get("content", "")
        text = " ".join(str(content or "").split())
        if len(text) > HISTORY_MAX_CHARS_PER_MESSAGE:
            text = text[: HISTORY_MAX_CHARS_PER_MESSAGE - 1] + "…"
        line = f"{role}: {text}"
        if total + len(line) > HISTORY_MAX_CHARS:
            break
        lines.append(line)
        total += len(line)
    return "\n".join(reversed(lines))


def compose_prompt(prompt, history=None, system_instruction=None, fresh=True):
    """Fresh process: instructions + compact history + prompt. Live process: prompt only."""
    parts = []
    if fresh:
        if system_instruction:
            parts.append("SYSTEM INSTRUCTIONS:\n" + system_instruction)
        summary = compact_history(history)
        if summary:
            parts.append("CONVERSATION SO FAR (compact summary):\n" + summary)
    parts.append(prompt)
    text = "\n\n".join(parts)
    # Leading "/" or "$" would be dispatched as a Gemini CLI slash command.
    if text.lstrip().startswith(("/", "$")):
        text = "User message:\n" + text
    return text


# --------------------------------------------------------------------------- transport


class AcpConnection:
    """One ``gemini --acp`` child process with JSON-RPC 2.0 line framing."""

    def __init__(self, command, *, cwd=None, env=None, on_request=handle_agent_request):
        self.command = command
        self.cwd = cwd
        self.env = env
        self.on_request = on_request
        self.process = None
        self.agent_capabilities = {}
        self.listeners = {}
        self._pending = {}
        self._ids = itertools.count()
        self._write_lock = asyncio.Lock()
        self._tasks = []
        self._eof = False
        self._closed = False

    @property
    def alive(self):
        return (
            self.process is not None
            and self.process.returncode is None
            and not self._eof
            and not self._closed
        )

    @property
    def returncode(self):
        return self.process.returncode if self.process else None

    async def start(self):
        try:
            self.process = await asyncio.create_subprocess_exec(
                *self.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.cwd,
                env=self.env,
                start_new_session=True,
                limit=16 * 1024 * 1024,
            )
        except OSError as exc:
            raise EngineError(f"Could not start {os.path.basename(self.command[0])} --acp") from exc
        self._tasks = [
            asyncio.create_task(self._read_loop()),
            asyncio.create_task(self._drain_stderr()),
        ]

    async def _drain_stderr(self):
        # Stderr may contain credentials or user data; keep it out of errors and the UI.
        while await self.process.stderr.read(8192):
            pass

    async def _read_loop(self):
        try:
            while line := await self.process.stdout.readline():
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    logger.warning("Ignoring non-JSON line from gemini --acp")
                    continue
                if not isinstance(message, dict):
                    continue
                await self._dispatch(message)
        except (ConnectionError, ValueError, asyncio.LimitOverrunError):
            logger.warning("gemini --acp stdout closed unexpectedly", exc_info=True)
        finally:
            self._eof = True
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.process.wait(), 2)
            error = EngineError(
                f"gemini --acp process exited (code {self.returncode})"
                if self.returncode is not None
                else "gemini --acp closed its output"
            )
            for _method, future in self._pending.values():
                if not future.done():
                    future.set_exception(error)
            self._pending.clear()
            for listener in list(self.listeners.values()):
                listener(None)

    async def _dispatch(self, message):
        method = message.get("method")
        if method and "id" in message:
            try:
                result, error = self.on_request(method, message.get("params") or {})
            except Exception:
                logger.exception("ACP request handler failed for %s", method)
                result, error = None, {"code": -32603, "message": "Internal client error"}
            reply = {"jsonrpc": "2.0", "id": message["id"]}
            reply.update({"error": error} if error else {"result": result})
            with contextlib.suppress(EngineError):
                await self._send(reply)
            # Requests are also visible to the active turn (permission => tool will run).
            session_id = (message.get("params") or {}).get("sessionId")
            if session_id in self.listeners:
                self.listeners[session_id](message)
        elif method:
            session_id = (message.get("params") or {}).get("sessionId")
            listener = self.listeners.get(session_id)
            if listener:
                listener(message)
        elif "id" in message:
            method, future = self._pending.pop(message["id"], (None, None))
            if future is None or future.done():
                return
            if "error" in message:
                future.set_exception(AcpRpcError(method, message["error"]))
            else:
                future.set_result(message.get("result") or {})

    async def _send(self, payload):
        if not self.alive:
            raise EngineError("gemini --acp process is not running")
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode()
        async with self._write_lock:
            try:
                self.process.stdin.write(data)
                await self.process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                raise EngineError("gemini --acp stdin closed") from exc

    async def start_request(self, method, params):
        request_id = next(self._ids)
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = (method, future)
        try:
            await self._send(
                {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            )
        except BaseException:
            self._pending.pop(request_id, None)
            future.cancel()
            raise
        return future

    async def request(self, method, params, *, timeout):
        future = await self.start_request(method, params)
        return await idle_wait(future, timeout=timeout, what=f"Gemini ACP {method}")

    async def notify(self, method, params):
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def initialize(self, *, timeout):
        result = await self.request(
            "initialize",
            {
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "terminal": False,
                },
            },
            timeout=timeout,
        )
        if result.get("protocolVersion") != ACP_PROTOCOL_VERSION:
            raise EngineError(
                f"Unsupported ACP protocol version {result.get('protocolVersion')!r}"
            )
        self.agent_capabilities = result.get("agentCapabilities") or {}
        return result

    async def close(self):
        if self._closed:
            return
        self._closed = True
        process = self.process
        if process is not None:
            with contextlib.suppress(Exception):
                process.stdin.close()
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)


# --------------------------------------------------------------------------- pool


@dataclass
class AcpSession:
    connection: AcpConnection
    cwd: str
    mcp_key: tuple
    model: str | None
    acp_session_id: str | None = None


class AcpProcessPool:
    """Live ``gemini --acp`` processes keyed by harness session id.

    Idle entries are closed after ``idle_close`` seconds; ``close_all`` on app shutdown.
    """

    def __init__(self, idle_close=IDLE_CLOSE_SECONDS):
        self.idle_close = idle_close
        self._entries = {}
        self._locks = {}
        self._timers = {}
        self._closing = set()

    def __len__(self):
        return len(self._entries)

    def __contains__(self, key):
        return key in self._entries

    def lock(self, key):
        return self._locks.setdefault(key, asyncio.Lock())

    def get(self, key):
        return self._entries.get(key)

    def put(self, key, entry):
        self._entries[key] = entry

    def hold(self, key):
        timer = self._timers.pop(key, None)
        if timer:
            timer.cancel()

    def release(self, key):
        self.hold(key)
        if key in self._entries and self.idle_close is not None:
            loop = asyncio.get_running_loop()
            self._timers[key] = loop.call_later(self.idle_close, self._expire, key)

    def _expire(self, key):
        self._timers.pop(key, None)
        lock = self._locks.get(key)
        if lock is not None and lock.locked():
            return  # a turn is running; it re-arms the timer when it finishes
        task = asyncio.get_running_loop().create_task(self.close(key))
        self._closing.add(task)
        task.add_done_callback(self._closing.discard)

    async def close(self, key):
        self.hold(key)
        entry = self._entries.pop(key, None)
        if entry is not None:
            await entry.connection.close()

    async def close_all(self):
        for timer in self._timers.values():
            timer.cancel()
        self._timers.clear()
        entries = list(self._entries.values())
        self._entries.clear()
        await asyncio.gather(*(e.connection.close() for e in entries), return_exceptions=True)
        if self._closing:
            await asyncio.gather(*self._closing, return_exceptions=True)
        self._locks.clear()


ACP_POOL = AcpProcessPool()


# --------------------------------------------------------------------------- engine


class GeminiCliAcpEngine:
    """Conversational Gemini CLI engine over a persistent ``gemini --acp`` process."""

    binary_name = "gemini"
    tool_transport = "mcp"
    known_paths = KNOWN_GEMINI_PATHS
    # The engine keeps conversation state between turns: callers may send only new content.
    session_persistent = True
    pool: ClassVar[AcpProcessPool] = ACP_POOL

    def __init__(
        self,
        binary_path=None,
        default_model="gemini-2.5-flash",
        simulate=False,
        runtime_config=None,
        work_dir=None,
        mcp_url=None,
        token=None,
        timeout=180,
        is_waiting_on_learner=None,
        pool=None,
        env=None,
        **kwargs,
    ):
        if simulate:
            raise ValueError("Inject a test engine instead of enabling production simulation")
        self.binary_path = binary_path or _find_executable(self.binary_name, self.known_paths)
        self.default_model = default_model
        # IDLE timeout: seconds without any ACP traffic, suspended while the learner answers.
        self.timeout = timeout
        self.is_waiting_on_learner = is_waiting_on_learner
        if pool is not None:
            self.pool = pool
        self.extra_env = dict(env or {})
        self.runtime_config = dict(runtime_config or {})
        self.work_dir = work_dir or self.runtime_config.get("work_dir")
        self.mcp_url = None
        self.mcp_token = None
        self._headless = GeminiHeadlessEngine(
            self.binary_path,
            default_model,
            runtime_config=runtime_config,
            work_dir=self.work_dir,
            timeout=timeout,
            is_waiting_on_learner=is_waiting_on_learner,
        )
        if mcp_url:
            self.configure_runtime(self.work_dir, mcp_url, token)

    # ----------------------------------------------------------------- configuration

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        self.work_dir = str(work_dir)
        self.mcp_url = mcp_url
        self.mcp_token = mcp_token
        self.runtime_config.update(work_dir=str(work_dir), mcp_url=mcp_url, mcp_token=mcp_token)
        # Tool exclusions only: the Bearer token travels in session/new, never to disk.
        write_workspace_settings(work_dir)
        self._headless.work_dir = self.work_dir

    def _mcp_servers(self):
        if not self.mcp_url:
            return []
        headers = []
        if self.mcp_token:
            headers.append({"name": "Authorization", "value": f"Bearer {self.mcp_token}"})
        return [{"type": "http", "name": HARNESS_SERVER, "url": self.mcp_url, "headers": headers}]

    def _mcp_key(self):
        return (self.mcp_url, self.mcp_token)

    def _command(self, model):
        if not self.binary_path:
            raise EngineError(
                f"{self.binary_name} executable not found; install and authenticate it"
            )
        command = [self.binary_path, "--acp", "--allowed-mcp-server-names", HARNESS_SERVER]
        if model:
            command += ["--model", model]
        return command

    def _env(self):
        env = dict(os.environ)
        # Our runtime dir is never in the user's trusted folders; without this the workspace
        # settings (tool exclusions) are ignored.
        env["GEMINI_CLI_TRUST_WORKSPACE"] = "true"
        env.update(self.extra_env)
        return env

    # ----------------------------------------------------------------- lifecycle

    async def _spawn(self, model):
        connection = AcpConnection(self._command(model), cwd=self.work_dir, env=self._env())
        try:
            await connection.start()
            await connection.initialize(timeout=self.timeout)
        except BaseException:
            await connection.close()
            raise
        return connection

    async def _new_session(self, entry):
        result = await entry.connection.request(
            "session/new",
            {"cwd": entry.cwd, "mcpServers": self._mcp_servers()},
            timeout=self.timeout,
        )
        if not result.get("sessionId"):
            raise EngineError("Gemini ACP session/new returned no sessionId")
        entry.acp_session_id = result["sessionId"]
        entry.mcp_key = self._mcp_key()

    async def _rebind_mcp(self, entry):
        """Swap MCP credentials on a live session, keeping the conversation."""
        if not entry.connection.agent_capabilities.get("loadSession"):
            return False
        try:
            await entry.connection.request(
                "session/load",
                {
                    "sessionId": entry.acp_session_id,
                    "cwd": entry.cwd,
                    "mcpServers": self._mcp_servers(),
                },
                timeout=self.timeout,
            )
        except AcpRpcError:
            logger.info("session/load unavailable; starting a fresh ACP session")
            return False
        entry.mcp_key = self._mcp_key()
        return True

    async def _ensure(self, session_id, model):
        """Return ``(entry, fresh)``; ``fresh`` means the agent has no conversation memory."""
        entry = self.pool.get(session_id)
        if entry is not None and (not entry.connection.alive or entry.model != model):
            await self.pool.close(session_id)
            entry = None
        if entry is not None:
            if entry.mcp_key == self._mcp_key():
                return entry, False
            if await self._rebind_mcp(entry):
                return entry, False
            await self._new_session(entry)
            return entry, True
        connection = await self._spawn(model)
        entry = AcpSession(
            connection=connection,
            cwd=str(self.work_dir or os.getcwd()),
            mcp_key=self._mcp_key(),
            model=model,
        )
        try:
            await self._new_session(entry)
        except BaseException:
            await connection.close()
            raise
        self.pool.put(session_id, entry)
        return entry, True

    @classmethod
    async def close_session(cls, session_id):
        await cls.pool.close(session_id)

    @classmethod
    async def close_all(cls):
        await cls.pool.close_all()

    # ----------------------------------------------------------------- turns

    async def stream_turn(
        self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None
    ):
        if tools:
            raise EngineError("CLI tools must be registered through the bound MCP server")
        model = slot.model_id if slot else self.default_model
        async with self.pool.lock(session_id):
            self.pool.hold(session_id)
            try:
                try:
                    entry, fresh = await self._ensure(session_id, model)
                except BaseException:
                    await self.pool.close(session_id)
                    raise
                text = compose_prompt(prompt, history, system_instruction, fresh=fresh)
                async for chunk in self._prompt(session_id, entry, text):
                    yield chunk
            finally:
                self.pool.release(session_id)

    async def _prompt(self, session_id, entry, text):
        connection = entry.connection
        acp_session = entry.acp_session_id
        queue = asyncio.Queue()
        connection.listeners[acp_session] = queue.put_nowait
        harness_inflight = set()

        def suspended():
            if harness_inflight:
                return True
            if self.is_waiting_on_learner is None:
                return False
            return bool(self.is_waiting_on_learner(session_id))

        reply = None
        clean = False
        try:
            reply = await connection.start_request(
                "session/prompt",
                {"sessionId": acp_session, "prompt": [{"type": "text", "text": text}]},
            )

            async def next_item():
                getter = asyncio.ensure_future(queue.get())
                try:
                    done, _ = await asyncio.wait(
                        {getter, reply}, return_when=asyncio.FIRST_COMPLETED
                    )
                finally:
                    if not getter.done():
                        getter.cancel()
                if getter in done:
                    return "message", getter.result()
                return "reply", None

            while True:
                kind, message = await idle_wait(
                    next_item(),
                    timeout=self.timeout,
                    is_suspended=suspended,
                    what="Gemini ACP turn",
                )
                if kind == "reply":
                    break
                if message is None:
                    raise EngineError(
                        f"gemini --acp process exited mid-turn (code {connection.returncode})"
                    )
                if message.get("method") != "session/update":
                    continue
                update_kind, payload = parse_update(message)
                if update_kind == "text" and payload:
                    yield payload
                elif update_kind == "tool":
                    if not payload["harness"] or not payload["id"]:
                        continue
                    if payload["status"] in _FINAL_TOOL_STATUSES:
                        harness_inflight.discard(payload["id"])
                    elif payload["status"] in _ACTIVE_TOOL_STATUSES:
                        harness_inflight.add(payload["id"])
            result = reply.result()
            stop = result.get("stopReason")
            if stop != "end_turn":
                raise EngineError(f"Gemini ACP turn ended with stopReason={stop!r}")
            report_usage(entry.model, acp_usage(result))
            clean = True
        except asyncio.CancelledError:
            clean = await self._cancel(connection, acp_session, reply)
            raise
        finally:
            connection.listeners.pop(acp_session, None)
            if not clean:
                # Unknown agent state (timeout, crash, protocol error): next turn respawns
                # and rehydrates from the persisted history.
                await self.pool.close(session_id)

    async def _cancel(self, connection, acp_session, reply):
        """Send ``session/cancel``; True if the agent acknowledged and stays reusable."""
        if reply is None or not connection.alive:
            return False
        try:
            async with asyncio.timeout(CANCEL_GRACE_SECONDS):
                await connection.notify("session/cancel", {"sessionId": acp_session})
                result = await asyncio.shield(reply)
            return result.get("stopReason") == "cancelled"
        except (TimeoutError, EngineError):
            return False

    # ----------------------------------------------------------------- one-shot calls

    async def run_structured(self, prompt, schema, slot=None, system_instruction=None):
        return await self._headless.run_structured(
            prompt, schema, slot=slot, system_instruction=system_instruction
        )

    def research_ready(self):
        return self._headless.research_ready()

    async def research(self, prompt, slot=None):
        return await self._headless.research(prompt, slot=slot)

    async def review_drawing_multimodal(self, png_bytes, drawing_title, context_notes=""):
        return await self._headless.review_drawing_multimodal(
            png_bytes, drawing_title, context_notes
        )


# Compatibility: older imports expect this name; it now really is the ACP adapter.
GeminiAcpEngine = GeminiCliAcpEngine
