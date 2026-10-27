"""Configuration and setup contracts for LearnHarness.

Pure Pydantic models with ZERO I/O.
Defines engine slots, vault folder mapping, MCP connections, and track configuration.
"""

import hashlib
import json
from enum import StrEnum
from pathlib import PurePosixPath
from typing import Any, Literal, cast
from uuid import uuid4

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

from learnharness.core.schema_gate import SUPPORTED_SCHEMA_VERSION


def wire_dict(value: object) -> dict[str, Any] | None:
    """A shallow copy of ``value`` when it is a JSON object, else None.

    ``mode="before"`` validators receive anything the caller passed; this is their typed entry.
    """
    return dict(cast("dict[str, Any]", value)) if isinstance(value, dict) else None


class EngineKind(StrEnum):
    """Supported Google ecosystem engine kinds."""
    AGY = "agy"
    GEMINI_CLI = "gemini_cli"
    GENAI_SDK = "genai_sdk"

    @classmethod
    def _missing_(cls, value: object) -> "EngineKind | None":
        return {"gemini": cls.GEMINI_CLI, "sdk": cls.GENAI_SDK}.get(str(value))


class EffortLevel(StrEnum):
    """Reasoning / thinking effort level for models supporting it."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ModelSlotConfig(BaseModel):
    """Configuration for a specific model slot."""
    model_config = ConfigDict(populate_by_name=True)
    engine: EngineKind = EngineKind.GEMINI_CLI
    model_id: str = Field(default="gemini-2.5-flash", validation_alias=AliasChoices("model_id", "model"), min_length=1)
    effort: EffortLevel = EffortLevel.MEDIUM


class ModelSlots(BaseModel):
    """Three dedicated model slots: strong (teaching/practice), fast (summaries), background (LangGraph)."""
    strong: ModelSlotConfig = Field(
        default_factory=lambda: ModelSlotConfig(
            engine=EngineKind.GEMINI_CLI,
            model_id="gemini-2.5-pro",
            effort=EffortLevel.MEDIUM,
        )
    )
    fast: ModelSlotConfig = Field(
        default_factory=lambda: ModelSlotConfig(
            engine=EngineKind.GEMINI_CLI,
            model_id="gemini-2.5-flash",
            effort=EffortLevel.MEDIUM,
        )
    )
    background: ModelSlotConfig = Field(
        default_factory=lambda: ModelSlotConfig(
            engine=EngineKind.GEMINI_CLI,
            model_id="gemini-2.5-flash",
            effort=EffortLevel.MEDIUM,
        )
    )


class VaultFolderMap(BaseModel):
    """Folder naming scheme inside the user's Obsidian Vault.

    Preserves bilingual conventions (PT-BR defaults or English).
    """
    map_file: str = "00 Mapa.md"
    lessons_dir: str = "Aulas"
    concepts_dir: str = "Conceitos"
    sources_dir: str = "Fontes"
    drawings_dir: str = "Desenhos"
    sessions_dir: str = "Sessões"
    templates_dir: str = "Templates"
    viz_dir: str = "viz"

    @model_validator(mode="before")
    @classmethod
    def legacy_names(cls, values: Any) -> Any:
        if (data := wire_dict(values)) is not None:
            aliases = {"aulas": "lessons_dir", "conceitos": "concepts_dir", "fontes": "sources_dir", "desenhos": "drawings_dir", "viz": "viz_dir", "templates": "templates_dir"}
            return {aliases.get(k, k): v for k, v in data.items()}
        return values

    @field_validator("map_file", "lessons_dir", "concepts_dir", "sources_dir", "drawings_dir", "sessions_dir", "templates_dir", "viz_dir")
    @classmethod
    def confined_name(cls, value: str) -> str:
        if not value or value.startswith(("/", "\\")) or "\\" in value or any(p in ("", ".", "..") for p in value.split("/")):
            raise ValueError("Vault folders must be relative paths without traversal")
        return value


class McpServerConfig(BaseModel):
    """Configuration for an external MCP server (e.g. Praxis content server)."""
    name: str
    command: str | None = None
    url: str | None = None
    transport: Literal["stdio", "http", "sse"] = "stdio"
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    catalog_tool: str = "list_lessons"
    content_tool: str = "get_lesson"
    content_id_argument: str = "lesson_id"
    # Reference to the token, never the token itself: a key into the user's secrets file
    # (outside the Vault) or ``env:VAR_NAME``.
    auth_ref: str | None = None
    # stdio only: name of the env var through which the token is passed to the child process.
    auth_env_var: str | None = None

    @model_validator(mode="before")
    @classmethod
    def legacy_active(cls, values: Any) -> Any:
        if (data := wire_dict(values)) is not None:
            if "active" in data and "enabled" not in data:
                data["enabled"] = data["active"]
            if data.get("url") and "transport" not in data:
                data["transport"] = "http"
            return data
        return values

    @model_validator(mode="after")
    def valid_transport(self):
        if self.enabled and not (self.command if self.transport == "stdio" else self.url):
            raise ValueError("Enabled MCP requires a command or a URL matching its transport")
        return self


class TrackMode(StrEnum):
    """Track progression mode configured during setup."""
    REPO_LEVELING = "repo_leveling"
    GOAL_GENERATED = "goal_generated"
    FREE = "free"

    @classmethod
    def _missing_(cls, value: object) -> "TrackMode | None":
        return cls.REPO_LEVELING if value == "repo_binary" else None


class TrackItem(BaseModel):
    """Single syllabus step in the active learning track (2:1 rhythm)."""
    id: str
    title: str
    kind: Literal["mentoria", "curriculo", "base", "livre"] = "mentoria"
    source_ref: str | None = None
    stage_label: str = ""
    status_detail: str = ""
    completed: bool = False
    parent_item_id: str | None = None
    prerequisites: list[str] = Field(default_factory=list)
    ordered: bool = False


TrackSource = Literal["repo", "github", "goal", "manual", "legacy"]


def new_track_id() -> str:
    return f"trk-{uuid4().hex[:8]}"


class TrackConfig(BaseModel):
    """One learning track (Fase 14: several side by side, one in focus).

    Appears in Home ONLY as a contextual chip above the composer:
    ⇶ <título> · Próximo: ... [Continuar ↵]
    Item ids are unique within the track; ``(track id, item id)`` identifies a step.
    ``mode`` FREE on a track with a queue means a hand-written list (``source="manual"``).
    """
    id: str = Field(default_factory=new_track_id)
    title: str = ""
    archived: bool = False
    created_at: str = ""
    source: TrackSource = "goal"
    github_url: str | None = None
    mode: TrackMode = TrackMode.FREE
    repo_path: str | None = None
    learning_md_path: str | None = None
    goal_description: str | None = None
    active_item_id: str | None = None
    queue: list[TrackItem] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def legacy_queue(cls, values: Any) -> Any:
        if (data := wire_dict(values)) is not None:
            data.setdefault("queue", data.get("items", []))
            data.setdefault("active_item_id", data.get("current_step_id"))
            return data
        return values

    def item(self, item_id: str | None) -> TrackItem | None:
        return next((i for i in self.queue if i.id == item_id), None) if item_id else None


def derive_track_title(track: TrackConfig, language: str = "pt-BR") -> str:
    """Repository name, else the goal's first line, else a generic name (pure)."""
    repo = (track.repo_path or "").replace("\\", "/").rstrip("/")
    if repo and PurePosixPath(repo).name:
        return PurePosixPath(repo).name
    goal = next((line.strip(" #-*\t") for line in (track.goal_description or "").splitlines() if line.strip()), "")
    if goal:
        return goal if len(goal) <= 60 else goal[:59].rstrip() + "…"
    return "Main track" if language == "en" else "Trilha principal"


def migrate_legacy_track(data: dict[str, Any]) -> dict[str, Any]:
    """Read-time migration of the single legacy ``track`` key into ``tracks`` (pure).

    A legacy track with a queue or a non-FREE mode becomes ``tracks[0]`` (``source="legacy"``,
    active). Its id is derived from its content, so repeated reads before the first save
    agree. A FREE, empty track does not become a track. When ``tracks`` already exists the
    legacy key is just dropped; saving writes only the new shape.
    """
    if "track" not in data:
        return data
    data = dict(data)
    legacy = data.pop("track")
    if "tracks" in data:
        return data
    if isinstance(legacy, TrackConfig):
        legacy = legacy.model_dump(mode="json")
    legacy = wire_dict(legacy)
    if legacy is None:
        return data
    track = TrackConfig.model_validate({k: v for k, v in legacy.items() if k != "id"})
    if not track.queue and track.mode == TrackMode.FREE:
        data["tracks"] = []
        return data
    digest = hashlib.sha256(json.dumps(legacy, sort_keys=True, default=str).encode()).hexdigest()[:8]
    track.id = f"trk-{digest}"
    track.source = "legacy"
    track.title = track.title or derive_track_title(track, data.get("language", "pt-BR"))
    data["tracks"] = [track.model_dump(mode="json")]
    if not data.get("active_track_id"):
        data["active_track_id"] = track.id
    return data


class ConnectorStatus(BaseModel):
    """Health and authentication status of a detected Google engine."""
    engine: EngineKind
    available: bool
    binary_path: str | None = None
    authenticated: bool | None = None
    models: list[str] = Field(default_factory=list)
    detail: str = ""
    # Set by the detector on the connector a fresh setup should preselect.
    recommended: bool = False


# Sentinel model id: let the CLI choose its own account default (agy model ids are
# account-specific, e.g. ``gemini-3.8-flash-medium``; see ``agy models``).
AUTO_MODEL = "auto"

_DEFAULT_MODELS: dict[EngineKind, tuple[str, str]] = {
    # (strong, fast/background)
    EngineKind.AGY: (AUTO_MODEL, AUTO_MODEL),
    EngineKind.GEMINI_CLI: ("gemini-2.5-pro", "gemini-2.5-flash"),
    EngineKind.GENAI_SDK: ("gemini-2.5-pro", "gemini-2.5-flash"),
}


def recommend_engine(statuses: list[ConnectorStatus], *, sdk_credentials: bool = False) -> EngineKind:
    """Pure preference order for a fresh setup.

    ``agy`` when its binary is available (individual Gemini Code Assist accounts were
    moved to Antigravity, so ``gemini --acp`` rejects them); otherwise ``genai_sdk`` when
    an API key / ADC is configured; otherwise ``gemini_cli``.
    """
    available = {s.engine for s in statuses if s.available}
    if EngineKind.AGY in available:
        return EngineKind.AGY
    if sdk_credentials and EngineKind.GENAI_SDK in available:
        return EngineKind.GENAI_SDK
    return EngineKind.GEMINI_CLI


def default_slots(engine: EngineKind) -> ModelSlots:
    """Slot defaults for ``engine`` (pure; model ids valid for that connector)."""
    strong, fast = _DEFAULT_MODELS[engine]
    return ModelSlots(
        strong=ModelSlotConfig(engine=engine, model_id=strong, effort=EffortLevel.MEDIUM),
        fast=ModelSlotConfig(engine=engine, model_id=fast, effort=EffortLevel.LOW),
        background=ModelSlotConfig(engine=engine, model_id=fast, effort=EffortLevel.MEDIUM),
    )


class GraphSettings(BaseModel):
    """Knowledge-trace extraction settings (Fase 8B)."""
    # Uncovered teacher prose (len/4 tokens) that triggers extraction at the end of a run;
    # also the token budget of one extraction batch.
    extraction_chunk_tokens: int = Field(default=4096, ge=1)


class ToolToggles(BaseModel):
    """Background-job tools the agent may use (Settings → Agente)."""
    research: bool = True
    pdf: bool = True
    visual: bool = True
    demo: bool = True


class AgentSettings(BaseModel):
    tools: ToolToggles = Field(default_factory=ToolToggles)
    # History beyond this many estimated tokens (chars/4) is summarized (Fase 12).
    compaction_tokens: int = Field(default=150_000, ge=32_000)


class HarnessConfig(BaseModel):
    """Root configuration for LearnHarness persisted in .harness/config.json."""
    configured: bool = False
    language: Literal["pt-BR", "en"] = "pt-BR"
    schema_version: int = SUPPORTED_SCHEMA_VERSION
    vault_path: str = "~/Documents/StudyVault"
    folders: VaultFolderMap = Field(default_factory=VaultFolderMap)
    slots: ModelSlots = Field(default_factory=ModelSlots)
    content_mcps: list[McpServerConfig] = Field(default_factory=list)
    # Fase 14: several tracks side by side, one in focus (``active_track_id``).
    tracks: list[TrackConfig] = Field(default_factory=list)
    active_track_id: str | None = None
    # Prompt segment path -> use the Vault override in .harness/prompts/<path> (Fase 8).
    prompt_overrides: dict[str, bool] = Field(default_factory=dict)
    graph: GraphSettings = Field(default_factory=GraphSettings)
    agent: AgentSettings = Field(default_factory=AgentSettings)

    @model_validator(mode="before")
    @classmethod
    def legacy_track(cls, values: Any) -> Any:
        data = wire_dict(values)
        return migrate_legacy_track(data) if data is not None else values

    def find_track(self, track_id: str | None) -> TrackConfig | None:
        return next((t for t in self.tracks if t.id == track_id), None) if track_id else None

    def active_track(self) -> TrackConfig | None:
        """The track in focus; ``None`` means no track (free study)."""
        return self.find_track(self.active_track_id)

    def session_track(self, track_id: str | None, track_item_id: str | None) -> TrackConfig | None:
        """Track of a session: its ``track_id``. Sessions older than Fase 14 (no ``track_id``)
        fall back to the active track, then to the first track holding the item."""
        if track_id:
            return self.find_track(track_id)
        if not track_item_id:
            return None
        active = self.active_track()
        if active and active.item(track_item_id):
            return active
        return next((t for t in self.tracks if t.item(track_item_id)), None)

    def next_active_track_id(self, after: str | None = None) -> str | None:
        """The next non-archived track after ``after`` (wrapping around), never ``after`` itself."""
        ids = [t.id for t in self.tracks]
        start = ids.index(after) + 1 if after in ids else 0
        for track in self.tracks[start:] + self.tracks[:start]:
            if track.id != after and not track.archived:
                return track.id
        return None
