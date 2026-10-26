"""Official Gemini CLI headless stream-json adapter (legacy class name retained)."""

import json
from contextlib import aclosing
from pathlib import Path

from learnharness.engines.cli_protocol import EngineError, json_events, transcript
from learnharness.engines.detector import KNOWN_GEMINI_PATHS, _find_executable


class GeminiAcpEngine:
    binary_name = "gemini"
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
        **kwargs,
    ):
        if simulate:
            raise ValueError("Inject a test engine instead of enabling production simulation")
        self.binary_path = binary_path or _find_executable(self.binary_name, self.known_paths)
        self.default_model = default_model
        self.timeout = timeout
        self.runtime_config = dict(runtime_config or {})
        self.work_dir = work_dir or self.runtime_config.get("work_dir")
        if mcp_url:
            self.configure_runtime(self.work_dir, mcp_url, token)

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        self.work_dir = str(work_dir)
        self.runtime_config.update(work_dir=str(work_dir), mcp_url=mcp_url, mcp_token=mcp_token)
        directory = Path(work_dir) / ".gemini"
        directory.mkdir(parents=True, exist_ok=True)
        settings = {
            "mcpServers": {
                "harness": {
                    "httpUrl": mcp_url,
                    "trust": True,
                    "headers": {"Authorization": f"Bearer {mcp_token}"},
                }
            },
            "tools": {
                "exclude": [
                    "run_shell_command",
                    "write_file",
                    "replace",
                    "read_file",
                    "read_many_files",
                    "list_directory",
                    "glob",
                    "search_file_content",
                    "web_fetch",
                    "google_web_search",
                    "save_memory",
                    "delegate_to_agent",
                ]
            },
        }
        path = directory / "settings.json"
        path.write_text(json.dumps(settings), encoding="utf-8")
        path.chmod(0o600)

    def _command(self, prompt, slot=None, schema=None):
        if not self.binary_path:
            raise EngineError(
                f"{self.binary_name} executable not found; install and authenticate it"
            )
        command = [self.binary_path, "--output-format", "stream-json", "-p", prompt]
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

    async def _events(self, prompt, slot=None, schema=None):
        command, stdin = self._command(prompt, slot, schema)
        async with aclosing(
            json_events(command, stdin=stdin, cwd=self.work_dir, timeout=self.timeout)
        ) as events:
            async for event in events:
                yield self._parse(event)

    async def stream_turn(
        self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None
    ):
        if tools:
            raise EngineError("CLI tools must be registered through the bound MCP server")
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
        return schema.model_validate_json(text)

    async def review_drawing_multimodal(self, png_bytes, drawing_title, context_notes=""):
        raise EngineError(
            "Image review requires the google-genai SDK connector; CLI image transport is not configured"
        )
