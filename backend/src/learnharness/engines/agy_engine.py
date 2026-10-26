"""Official Antigravity stdin/stdout NDJSON envelopes."""

import json
from pathlib import Path

from learnharness.engines.cli_protocol import EngineError
from learnharness.engines.detector import KNOWN_AGY_PATHS
from learnharness.engines.gemini_engine import GeminiAcpEngine


class AgyStreamEngine(GeminiAcpEngine):
    binary_name = "agy"
    known_paths = KNOWN_AGY_PATHS

    def __init__(self, binary_path=None, default_model="", default_effort=None, **kwargs):
        super().__init__(binary_path, default_model, **kwargs)
        self.default_effort = default_effort

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        self.work_dir = str(work_dir)
        self.runtime_config.update(work_dir=str(work_dir), mcp_url=mcp_url, mcp_token=mcp_token)
        directory = Path(work_dir) / ".agents"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "mcp_config.json"
        path.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "harness": {
                            "serverUrl": mcp_url,
                            "headers": {"Authorization": f"Bearer {mcp_token}"},
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        path.chmod(0o600)

    def _command(self, prompt, slot=None, schema=None):
        if not self.binary_path:
            raise EngineError("agy executable not found; install and authenticate it")
        command = [
            self.binary_path,
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
        ]
        model = slot.model_id if slot else self.default_model
        effort = slot.effort if slot else self.default_effort
        if model:
            command += ["--model", model]
        if effort:
            command += ["--effort", str(effort)]
        if schema:
            command += ["--json-schema", json.dumps(schema.model_json_schema())]
        return command, (
            json.dumps({"event": "user", "message": {"content": prompt}}) + "\n"
        ).encode()

    def _parse(self, event):
        kind = event.get("event")
        if kind == "result":
            result = event.get("result", {})
            if result.get("status") != "SUCCESS" or result.get("error"):
                raise EngineError("Antigravity CLI turn failed")
            return "result", result
        if kind == "step_update":
            step = event.get("step_update", {})
            if step.get("step_type") == "agent_response":
                return "text", step.get("text_delta", "")
        if kind == "error":
            raise EngineError("Antigravity CLI reported a provider error")
        return "event", event
