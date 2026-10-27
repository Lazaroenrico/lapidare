"""Official Gemini CLI headless (``-p`` + ``--output-format stream-json``) adapter.

Used for one-shot calls (``run_structured``, drawing review). Conversational turns go
through the persistent ``gemini --acp`` adapter in ``gemini_acp.py``.
"""

import contextlib
import json
import tempfile
from contextlib import aclosing
from pathlib import Path
from uuid import uuid4

from learnharness.engines.cli_protocol import EngineError, json_events, transcript
from learnharness.engines.detector import KNOWN_GEMINI_PATHS, _find_executable
from learnharness.engines.usage import gemini_cli_usage, report_usage

# Native tools the learning harness never wants the CLI to run on the learner's machine.
EXCLUDED_NATIVE_TOOLS = [
    "run_shell_command",
    "write_file",
    "replace",
    "read_file",
    "read_many_files",
    "list_directory",
    "glob",
    "search_file_content",
    "grep_search",
    "web_fetch",
    "google_web_search",
    "save_memory",
    "delegate_to_agent",
]

DRAWING_REVIEW_INSTRUCTION = "Evaluate correct, missing and incorrect concepts rigorously."


def write_workspace_settings(work_dir, mcp_servers=None):
    """Write ``<work_dir>/.gemini/settings.json``; holds secrets only if ``mcp_servers`` does."""
    directory = Path(work_dir) / ".gemini"
    directory.mkdir(parents=True, exist_ok=True)
    settings = {"tools": {"exclude": EXCLUDED_NATIVE_TOOLS}}
    if mcp_servers:
        settings["mcpServers"] = mcp_servers
    path = directory / "settings.json"
    path.write_text(json.dumps(settings), encoding="utf-8")
    path.chmod(0o600)
    return path


WEB_SEARCH_TOOL = "google_web_search"


def write_research_settings(work_dir):
    """Workspace settings for a research call: ``google_web_search`` is the only native tool.

    ``tools.core`` is the CLI's allow-list of built-in tools and ``tools.allowed`` lets the
    read-only search run headless without a confirmation prompt; everything else stays
    excluded. No MCP server is configured here.
    """
    directory = Path(work_dir) / ".gemini"
    directory.mkdir(parents=True, exist_ok=True)
    settings = {
        "tools": {
            "core": [WEB_SEARCH_TOOL],
            "allowed": [WEB_SEARCH_TOOL],
            "exclude": [t for t in EXCLUDED_NATIVE_TOOLS if t != WEB_SEARCH_TOOL],
        }
    }
    path = directory / "settings.json"
    path.write_text(json.dumps(settings), encoding="utf-8")
    return path


class GeminiHeadlessEngine:
    binary_name = "gemini"
    tool_transport = "mcp"
    known_paths = KNOWN_GEMINI_PATHS

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
        **kwargs,
    ):
        if simulate:
            raise ValueError("Inject a test engine instead of enabling production simulation")
        self.binary_path = binary_path or _find_executable(self.binary_name, self.known_paths)
        self.default_model = default_model
        # IDLE timeout (seconds without provider events), not a total cap.
        self.timeout = timeout
        # Optional ``(session_id) -> bool``; while True the idle clock is suspended.
        self.is_waiting_on_learner = is_waiting_on_learner
        self._session_id = None
        self.runtime_config = dict(runtime_config or {})
        self.work_dir = work_dir or self.runtime_config.get("work_dir")
        if mcp_url:
            self.configure_runtime(self.work_dir, mcp_url, token)

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        self.work_dir = str(work_dir)
        self.runtime_config.update(work_dir=str(work_dir), mcp_url=mcp_url, mcp_token=mcp_token)
        # Headless has no other channel for MCP config, so the per-execution token is
        # written (0600) into the throwaway work dir. The ACP engine avoids this.
        write_workspace_settings(
            work_dir,
            {
                "harness": {
                    "httpUrl": mcp_url,
                    "trust": True,
                    "headers": {"Authorization": f"Bearer {mcp_token}"},
                }
            },
        )

    def _command(self, prompt, slot=None, schema=None):
        if not self.binary_path:
            raise EngineError(
                f"{self.binary_name} executable not found; install and authenticate it"
            )
        # The work dir is ours; without --skip-trust headless exits on untrusted folders
        # (folder trust is on by default since 0.6x) and ignores the workspace settings.
        command = [
            self.binary_path,
            "--skip-trust",
            "--output-format",
            "stream-json",
            "-p",
            prompt,
        ]
        model = slot.model_id if slot else self.default_model
        if model:
            command += ["--model", model]
        return command, b""

    def _parse(self, event):
        kind = event.get("type")
        if kind == "error" and event.get("severity") != "warning":
            raise EngineError("Gemini CLI reported a provider error")
        if kind == "result":
            if event.get("status") != "success" or event.get("error"):
                raise EngineError("Gemini CLI turn failed")
            return "result", event
        if kind == "message" and event.get("role") == "assistant":
            return "text", event.get("content", "")
        return "event", event

    def _usage_counts(self, result):
        """Token counts carried by this CLI's terminal ``result`` event (``engines.usage``)."""
        return gemini_cli_usage(result)

    def _learner_pending(self):
        if self.is_waiting_on_learner is None or self._session_id is None:
            return False
        return bool(self.is_waiting_on_learner(self._session_id))

    async def _events(self, prompt, slot=None, schema=None):
        command, stdin = self._command(prompt, slot, schema)
        async with aclosing(
            json_events(
                command,
                stdin=stdin,
                cwd=self.work_dir,
                timeout=self.timeout,
                is_suspended=self._learner_pending,
            )
        ) as events:
            async for event in events:
                kind, value = self._parse(event)
                if kind == "result":
                    report_usage(slot.model_id if slot else self.default_model,
                                 self._usage_counts(value))
                yield kind, value

    async def stream_turn(
        self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None
    ):
        if tools:
            raise EngineError("CLI tools must be registered through the bound MCP server")
        self._session_id = session_id
        finished = False
        async with aclosing(
            self._events(transcript(prompt, history, system_instruction), slot)
        ) as events:
            async for kind, value in events:
                if kind == "text" and value:
                    yield value
                elif kind == "result":
                    finished = True
        if not finished:
            raise EngineError("Provider stream ended without a successful result")

    async def run_structured(self, prompt, schema, slot=None, system_instruction=None):
        directive = "Return ONLY JSON matching this schema: " + json.dumps(
            schema.model_json_schema()
        )
        parts, result = [], None
        async with aclosing(
            self._events(
                transcript(
                    prompt, system_instruction=(system_instruction or "") + "\n" + directive
                ),
                slot,
                schema,
            )
        ) as events:
            async for kind, value in events:
                if kind == "text":
                    parts.append(value)
                elif kind == "result":
                    result = value
        if result is None:
            raise EngineError("Provider stream ended without a result")
        if "structured_output" in result:
            return schema.model_validate(result["structured_output"])
        text = "".join(parts) or result.get("response", "")
        return schema.model_validate_json(_strip_fence(text))

    def research_ready(self):
        return bool(self.binary_path)

    async def research(self, prompt, slot=None):
        """Web research through ``google_web_search`` in a throwaway allow-list workspace.

        Fails unless the search tool actually ran and succeeded.
        """
        from learnharness.core.contracts.jobs import ResearchResult

        directive = "Return ONLY JSON matching this schema: " + json.dumps(
            ResearchResult.model_json_schema()
        )
        searches, succeeded, parts, result = set(), 0, [], None
        with tempfile.TemporaryDirectory(prefix="learnharness-gemini-research-") as directory:
            write_research_settings(directory)
            command, stdin = self._command(transcript(prompt, system_instruction=directive), slot)
            async with aclosing(json_events(command, stdin=stdin, cwd=directory,
                                            timeout=self.timeout)) as events:
                async for event in events:
                    kind = event.get("type")
                    if kind == "tool_use" and event.get("tool_name") == WEB_SEARCH_TOOL:
                        searches.add(event.get("tool_id"))
                    elif kind == "tool_result" and event.get("tool_id") in searches:
                        succeeded += event.get("status") == "success"
                    else:
                        parsed, value = self._parse(event)
                        if parsed == "text":
                            parts.append(value)
                        elif parsed == "result":
                            result = value
        if result is None:
            raise EngineError("Gemini CLI research ended without a result")
        report_usage(slot.model_id if slot else self.default_model, self._usage_counts(result))
        if not succeeded:
            raise EngineError(f"Gemini CLI answered without a successful {WEB_SEARCH_TOOL} call")
        text = "".join(parts) or result.get("response", "")
        return ResearchResult.model_validate_json(_strip_fence(text))

    async def review_drawing_multimodal(self, png_bytes, drawing_title, context_notes=""):
        """Attach the PNG through the CLI's ``@<path>`` file reference.

        Gemini CLI expands ``@path`` with a directly-constructed ReadManyFiles tool (images
        become inline data), so the workspace tool exclusion does not block it. The path
        must live inside the workspace (cwd).
        """
        from learnharness.core.contracts.drawing import DrawingReviewResult

        if not png_bytes:
            raise ValueError("Drawing PNG is empty")
        with contextlib.ExitStack() as stack:
            if self.work_dir:
                directory = Path(self.work_dir)
                directory.mkdir(parents=True, exist_ok=True)
            else:
                directory = Path(stack.enter_context(tempfile.TemporaryDirectory()))
                self.work_dir = str(directory)
                stack.callback(setattr, self, "work_dir", None)
            if not (directory / ".gemini" / "settings.json").exists():
                write_workspace_settings(directory)
            image = directory / f"drawing-{uuid4().hex}.png"
            image.write_bytes(png_bytes)
            stack.callback(image.unlink, missing_ok=True)
            # The reference must be followed by whitespace: the prompt is JSON-embedded and a
            # trailing quote or escape sequence would become part of the path.
            prompt = (
                f"Review the learner diagram {drawing_title}. Context: {context_notes} "
                f"Image: @{image.name} (attached PNG)."
            )
            return await self.run_structured(
                prompt, schema=DrawingReviewResult, system_instruction=DRAWING_REVIEW_INSTRUCTION
            )


def _strip_fence(text):
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        stripped = stripped.rsplit("```", 1)[0]
    return stripped.strip()


def __getattr__(name):
    # Legacy import path: ``GeminiAcpEngine`` now names the real ACP adapter.
    if name == "GeminiAcpEngine":
        from learnharness.engines.gemini_acp import GeminiAcpEngine

        return GeminiAcpEngine
    raise AttributeError(name)
