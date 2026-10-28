"""Official google-genai API-key / Vertex ADC adapter. Failures always propagate."""

import asyncio
import os
from typing import Any

from google import genai
from google.genai import types
from pydantic import ValidationError

from learnharness.core.contracts.drawing import DrawingReviewResult
from learnharness.engines.agy_engine import DRAWING_REVIEW_PROMPT
from learnharness.engines.cli_protocol import EngineError, idle_wait
from learnharness.engines.usage import genai_usage, report_usage

_CLIENTS: dict[tuple[Any, ...], genai.Client] = {}


def _shared_client(**kwargs: Any) -> genai.Client:
    """One ``genai.Client`` per credentials: an engine is built per turn and per job, and a
    fresh client would drop its HTTP connection pool (a new TLS handshake every time)."""
    key = (genai.Client, *sorted(kwargs.items()))
    client = _CLIENTS.get(key)
    if client is None:
        client = _CLIENTS[key] = genai.Client(**kwargs)
    return client


def _research_tools() -> list[types.ToolUnion]:
    """``google_search`` plus ``url_context`` when the installed SDK has it."""
    tools: list[types.ToolUnion] = [types.Tool(google_search=types.GoogleSearch())]
    url_context = getattr(types, "UrlContext", None)
    if url_context is not None:
        tools.append(types.Tool(url_context=url_context()))
    return tools


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
        is_waiting_on_learner=None,
        **kwargs,
    ):
        if simulate:
            raise ValueError("Inject a test engine instead of enabling production simulation")
        config = dict(runtime_config or {})
        self.default_model = default_model
        self.timeout = timeout
        self.is_waiting_on_learner = is_waiting_on_learner
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
        self.client: genai.Client | None = None
        if use_vertex:
            self.client = _shared_client(
                vertexai=True,
                project=project or config.get("project") or os.getenv("GOOGLE_CLOUD_PROJECT"),
                location=location
                or config.get("location")
                or os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
            )
        elif self.api_key:
            self.client = _shared_client(api_key=self.api_key)

    def configure_runtime(self, work_dir, mcp_url, mcp_token=None):
        self.runtime_config.update(work_dir=str(work_dir), mcp_url=mcp_url, mcp_token=mcp_token)

    def _ready(self) -> genai.Client:
        if self.client is None:
            raise EngineError("Configure google-genai with an API key or Vertex AI project and ADC")
        return self.client

    async def stream_turn(
        self, prompt, session_id, history=None, slot=None, tools=None, system_instruction=None
    ):
        client = self._ready()
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
        model = slot.model_id if slot else self.default_model
        metadata = None
        # Inline tools run inside the stream, and ``pose`` waits for the learner: the
        # timeout is idle time between chunks, paused while a question waits (as in the CLIs).
        waiting = self.is_waiting_on_learner
        suspended = (lambda: bool(waiting(session_id))) if waiting else None

        def step(awaitable):
            return idle_wait(awaitable, timeout=self.timeout, is_suspended=suspended, what="google-genai")

        stream = await step(client.aio.models.generate_content_stream(
            model=model,
            contents=contents,
            config=config,
        ))
        chunks = aiter(stream)
        while (chunk := await step(anext(chunks, None))) is not None:
            # The last chunk's usage_metadata holds the call's totals.
            metadata = getattr(chunk, "usage_metadata", None) or metadata
            if chunk.text:
                yield chunk.text
        report_usage(model, genai_usage(metadata))

    async def run_structured(self, prompt, schema, slot=None, system_instruction=None):
        client = self._ready()
        model = slot.model_id if slot else self.default_model
        async with asyncio.timeout(self.timeout):
            response = await client.aio.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=schema,
                    system_instruction=system_instruction,
                ),
            )
        report_usage(model, genai_usage(getattr(response, "usage_metadata", None)))
        return schema.model_validate_json(response.text or "")

    def research_ready(self):
        return self.client is not None

    async def research(self, prompt, slot=None):
        """Web research with ``google_search`` grounding; sources come from grounding metadata.

        The brief is the model's markdown; the source list is never model-written here, it
        is the set of pages the grounding actually returned. No grounding, no result.
        """
        from learnharness.core.contracts.jobs import ResearchResult, ResearchSource

        client = self._ready()
        model = slot.model_id if slot else self.default_model
        async with asyncio.timeout(self.timeout):
            response = await client.aio.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    tools=_research_tools(),
                ),
            )
        report_usage(model, genai_usage(getattr(response, "usage_metadata", None)))
        sources, seen = [], set()
        for candidate in getattr(response, "candidates", None) or []:
            metadata = getattr(candidate, "grounding_metadata", None)
            for chunk in getattr(metadata, "grounding_chunks", None) or []:
                web = getattr(chunk, "web", None)
                url = getattr(web, "uri", None)
                if url and url not in seen:
                    seen.add(url)
                    sources.append(ResearchSource(title=getattr(web, "title", None) or url, url=url))
            # Pages the url_context tool actually fetched count as consulted too.
            fetched = getattr(candidate, "url_context_metadata", None)
            for item in getattr(fetched, "url_metadata", None) or []:
                url = getattr(item, "retrieved_url", None)
                if url and url not in seen:
                    seen.add(url)
                    sources.append(ResearchSource(title=url, url=url))
        brief = (response.text or "").strip()
        if not sources:
            raise EngineError("google_search grounding returned no sources")
        if not brief:
            raise EngineError("google_search research returned an empty answer")
        return ResearchResult(brief=brief, sources=sources)

    async def review_image(self, png_bytes, instructions, schema, slot=None, *, context="",
                           system_instruction=None, image_name=None, subject=None):
        """Structured verdict on a PNG sent as an inline image part."""
        client = self._ready()
        if not png_bytes:
            raise ValueError("Image PNG is empty")
        model = slot.model_id if slot else self.default_model
        prompt = f"{instructions}\n<notes>\n{context}\n</notes>" if context else instructions
        async with asyncio.timeout(self.timeout):
            response = await client.aio.models.generate_content(
                model=model,
                contents=[prompt, types.Part.from_bytes(data=png_bytes, mime_type="image/png")],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=schema,
                    system_instruction=system_instruction,
                ),
            )
        report_usage(model, genai_usage(getattr(response, "usage_metadata", None)))
        try:
            return schema.model_validate_json(response.text or "")
        except ValidationError as exc:
            raise EngineError(f"Provider returned an invalid image review: {exc}") from exc

    async def review_drawing_multimodal(self, png_bytes, drawing_title, context_notes=""):
        """Drawing review: ``review_image`` with the prompt the agy engine uses (usage is reported)."""
        if not png_bytes:
            raise ValueError("Drawing PNG is empty")
        return await self.review_image(
            png_bytes, f"{DRAWING_REVIEW_PROMPT}\nDrawing title: {drawing_title!r}.", DrawingReviewResult,
            context=context_notes,
            system_instruction="Evaluate correct, missing and incorrect concepts rigorously.")
