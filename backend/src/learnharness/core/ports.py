"""Pure Protocol interfaces (ports) for LearnHarness hexagonal architecture.

ZERO I/O: contains only typing.Protocol definitions with no implementation details,
no network calls, and no filesystem operations.
"""

from collections.abc import AsyncIterator
from typing import Any, Literal, Protocol, TypeVar

from learnharness.core.contracts.config import HarnessConfig, ModelSlotConfig
from learnharness.core.contracts.graph import ConceptNode, GraphSnapshot, LogicalChain
from learnharness.core.contracts.quiz import CalibrationResult
from learnharness.core.contracts.session import SessionMessage, SessionRecord

T = TypeVar("T")


class AgentEnginePort(Protocol):
    """Port interface for Google ecosystem agent connectors (agy, gemini-cli, genai-sdk).

    tool_transport tells the session runner how pedagogical tools reach the model:
    "mcp" engines discover them through the bound /internal/mcp server (configure_runtime),
    "inline" engines receive Python callables through stream_turn(tools=...).
    """

    tool_transport: Literal["mcp", "inline"]

    async def stream_turn(
        self,
        prompt: str,
        session_id: str,
        history: list[SessionMessage] | None = None,
        slot: ModelSlotConfig | None = None,
        tools: list[Any] | None = None,
    ) -> AsyncIterator[str]:
        """Stream conversational turn deltas and handle tool execution."""
        ...

    async def run_structured(
        self,
        prompt: str,
        schema: type[T],
        slot: ModelSlotConfig | None = None,
        system_instruction: str | None = None,
    ) -> T:
        """Execute a single structured turn and return typed output adhering to schema."""
        ...


class VaultPort(Protocol):
    """Port interface for bidirectional synchronization with the user's Obsidian Vault."""

    async def load_config(self) -> HarnessConfig | None:
        """Load .harness/config.json if initialized."""
        ...

    async def save_config(self, config: HarnessConfig) -> None:
        """Persist updated configuration into .harness/config.json."""
        ...

    async def get_graph_snapshot(self) -> GraphSnapshot:
        """Build GraphSnapshot combining Conceitos/*.md and .harness/chains.jsonl."""
        ...

    async def get_concept(self, concept_id: str) -> ConceptNode | None:
        """Fetch concept metadata and content from Conceitos/<Name>.md."""
        ...

    async def upsert_concept(self, concept: ConceptNode) -> None:
        """Non-destructively merge concept into Conceitos/<Name>.md."""
        ...

    async def append_session_record(self, session: SessionRecord) -> None:
        """Append session state to .harness/sessions/<id>.jsonl."""
        ...

    async def get_session_record(self, session_id: str) -> SessionRecord | None:
        """Load session record from .harness/sessions/<id>.jsonl."""
        ...

    async def append_quiz_log(self, result: CalibrationResult) -> None:
        """Append calibration entry to .harness/quiz-log.jsonl."""
        ...

    async def append_chain(self, chain: LogicalChain) -> None:
        """Append logical chain to .harness/chains.jsonl."""
        ...

    async def read_source_excerpt(self, source_path: str, paragraph_ref: str) -> str | None:
        """Extract referenced paragraph #^pN from read-only Fontes/."""
        ...

    async def save_drawing(
        self, slug: str, content_markdown: str, png_bytes: bytes
    ) -> None:
        """Save drawing markdown and exported PNG in Desenhos/."""
        ...

    async def read_drawing_png(self, slug: str) -> bytes | None:
        """Read exported drawing PNG for multimodal vision review."""
        ...


class ContentMcpPort(Protocol):
    """Port interface for external educational content MCP servers (e.g. Praxis)."""

    async def is_available(self, server_name: str | None = None) -> bool:
        """Check if content MCP server is configured and reachable."""
        ...

    async def list_available_lessons(
        self, server_name: str | None = None
    ) -> list[dict[str, Any]]:
        """List lessons and transcripts available to import from MCP."""
        ...

    async def fetch_lesson_content(
        self, lesson_id: str, server_name: str | None = None
    ) -> str:
        """Fetch full markdown/transcript of a lesson from MCP."""
        ...
