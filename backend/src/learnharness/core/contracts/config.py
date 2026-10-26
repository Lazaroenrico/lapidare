"""Configuration and setup contracts for LearnHarness.

Pure Pydantic models with ZERO I/O.
Defines engine slots, vault folder mapping, MCP connections, and track configuration.
"""

from enum import StrEnum
from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator


class EngineKind(StrEnum):
    """Supported Google ecosystem engine kinds."""
    AGY = "agy"
    GEMINI_CLI = "gemini_cli"
    GENAI_SDK = "genai_sdk"

    @classmethod
    def _missing_(cls, value):
        return {"gemini": cls.GEMINI_CLI, "sdk": cls.GENAI_SDK}.get(value)


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
    def legacy_names(cls, values):
        if isinstance(values, dict):
            aliases = {"aulas": "lessons_dir", "conceitos": "concepts_dir", "fontes": "sources_dir", "desenhos": "drawings_dir", "viz": "viz_dir", "templates": "templates_dir"}
            values = {aliases.get(k, k): v for k, v in values.items()}
        return values

    @field_validator("map_file", "lessons_dir", "concepts_dir", "sources_dir", "drawings_dir", "sessions_dir", "templates_dir", "viz_dir")
    @classmethod
    def confined_name(cls, value):
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
    def legacy_active(cls, values):
        if isinstance(values, dict):
            values = dict(values)
            if "active" in values and "enabled" not in values:
                values["enabled"] = values["active"]
            if values.get("url") and "transport" not in values:
                values["transport"] = "http"
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
    def _missing_(cls, value):
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


class TrackConfig(BaseModel):
    """Active learning track configuration.

    Appears in Home ONLY as a contextual chip above the composer:
    ⇶ Trilha ativa · Próximo: ... [Continuar ↵]
    """
    mode: TrackMode = TrackMode.FREE
    repo_path: str | None = None
    learning_md_path: str | None = None
    goal_description: str | None = None
    active_item_id: str | None = None
    queue: list[TrackItem] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def legacy_queue(cls, values):
        if isinstance(values, dict):
            values = dict(values)
            values.setdefault("queue", values.get("items", []))
            values.setdefault("active_item_id", values.get("current_step_id"))
        return values


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


class HarnessConfig(BaseModel):
    """Root configuration for LearnHarness persisted in .harness/config.json."""
    configured: bool = False
    language: Literal["pt-BR", "en"] = "pt-BR"
    schema_version: int = 2
    vault_path: str = "~/Documents/StudyVault"
    folders: VaultFolderMap = Field(default_factory=VaultFolderMap)
    slots: ModelSlots = Field(default_factory=ModelSlots)
    content_mcps: list[McpServerConfig] = Field(default_factory=list)
    track: TrackConfig = Field(default_factory=TrackConfig)
    # Prompt segment path -> use the Vault override in .harness/prompts/<path> (Fase 8).
    prompt_overrides: dict[str, bool] = Field(default_factory=dict)
