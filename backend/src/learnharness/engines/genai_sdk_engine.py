"""Official google-genai API-key / Vertex ADC adapter. Failures always propagate."""

import asyncio
import os

from learnharness.core.contracts.practice import DrawingReviewResult
from learnharness.engines.cli_protocol import EngineError

try:
    from google import genai
    from google.genai import types
except ImportError:
    genai = types = None


class GenAiSdkEngine:
    tool_transport = "inline"

    def __init__(
        self,
        api_key=None,
        default_model="gemini-2.5-flash",
        simulate=False,
        runtime_config=None,
        vertexai=None,
        project=None,
        location=None,
        timeout=180,
        **kwargs,
    ):
        if simulate:
            raise ValueError("Inject a test engine instead of enabling production simulation")
        config = dict(runtime_config or {})
        self.default_model = default_model
        self.timeout = timeout
        self.runtime_config = config
        self.api_key = (
            api_key
            or config.get("api_key")
            or os.getenv("GEMINI_API_KEY")
            or os.getenv("GOOGLE_API_KEY")
        )
        use_vertex = (
            vertexai
            if vertexai is not None
            else config.get(
                "vertexai", os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "").lower() == "true"
            )
        )
        self.client = None
        if genai is not None:
            if use_vertex:
                self.client = genai.Client(
                    vertexai=True,
                    project=project or config.get("project") or os.getenv("GOOGLE_CLOUD_PROJECT"),
                    location=location
                    or config.get("location")
                    or os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
                )
            elif self.api_key:
                self.client = genai.Client(api_key=self.api_key)

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        self.runtime_config.update(work_dir=str(work_dir), mcp_url=mcp_url, mcp_token=mcp_token)

    def _ready(self):
        if self.client is None or types is None:
            raise EngineError("Configure google-genai with an API key or Vertex AI project and ADC")

    async def stream_turn(
        self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None
    ):
        self._ready()
        contents, instructions = [], []
        if system_instruction:
            instructions.append(system_instruction)
        for message in history or []:
            if message.role == "system":
                instructions.append(message.content)
            elif message.role == "tool":
                # Persisted SessionMessage has no function name/call id; preserve as context.
                contents.append(
                    types.Content(
                        role="user",
                        parts=[types.Part.from_text(text="Prior tool result: " + message.content)],
                    )
                )
            else:
                contents.append(
                    types.Content(
                        role="model" if message.role == "assistant" else "user",
                        parts=[types.Part.from_text(text=message.content)],
                    )
                )
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=prompt)]))
        config = types.GenerateContentConfig(
            system_instruction="\n".join(instructions) or None,
            tools=tools or None,
            # A lesson turn chains plan_init, several pose_quiz waits and plan_advance;
            # the SDK default of 10 remote calls truncates it mid-plan.
            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                maximum_remote_calls=50
            )
            if tools
            else None,
        )
        async with asyncio.timeout(self.timeout):
            stream = await self.client.aio.models.generate_content_stream(
                model=slot.model_id if slot else self.default_model,
                contents=contents,
                config=config,
            )
            async for chunk in stream:
                if chunk.text:
                    yield chunk.text

    async def run_structured(self, prompt, schema, slot=None, system_instruction=None):
        self._ready()
        async with asyncio.timeout(self.timeout):
            response = await self.client.aio.models.generate_content(
                model=slot.model_id if slot else self.default_model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=schema,
                    system_instruction=system_instruction,
                ),
            )
        return schema.model_validate_json(response.text or "")

    async def review_drawing_multimodal(self, png_bytes, drawing_title, context_notes=""):
        self._ready()
        if not png_bytes:
            raise ValueError("Drawing PNG is empty")
        async with asyncio.timeout(self.timeout):
            response = await self.client.aio.models.generate_content(
                model=self.default_model,
                contents=[
                    f"Review the learner diagram {drawing_title}. Context: {context_notes}",
                    types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=DrawingReviewResult,
                    system_instruction="Evaluate correct, missing and incorrect concepts rigorously.",
                ),
            )
        return DrawingReviewResult.model_validate_json(response.text or "")
