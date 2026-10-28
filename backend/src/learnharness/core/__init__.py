"""Core pure domain layer for LearnHarness.

Contains contracts, calibration logic, SSE events, and port interfaces.
ZERO I/O ARCHITECTURAL INVARIANT: zero network, filesystem, or subprocess dependencies.
"""

from learnharness.core.calibration import (
    compute_confidence_band,
    evaluate_calibration,
    validate_quiz_options_evenness,
)
from learnharness.core.contracts import (
    CalibrationBand,
    CalibrationResult,
    ConceptNode,
    ConceptStatus,
    ConfidenceBand,
    ConnectorStatus,
    DenseBlockDimensions,
    DrawingReviewResult,
    EffortLevel,
    EngineKind,
    GraphEdge,
    GraphSnapshot,
    HarnessConfig,
    HintRung,
    LogicalChain,
    McpServerConfig,
    ModelSlotConfig,
    ModelSlots,
    PlanDag,
    PlanNode,
    PlanNodeStatus,
    PracticeProblem,
    PracticeState,
    QuizMode,
    QuizOption,
    QuizPayload,
    QuizSubmission,
    SessionMessage,
    SessionMode,
    SessionPhase,
    SessionRecord,
    TeachContextKind,
    TrackConfig,
    TrackItem,
    TrackMode,
    VaultFolderMap,
)
from learnharness.core.events import (
    BackgroundJobStatus,
    SseEventType,
    SseFrame,
)
from learnharness.core.ports import (
    AgentEnginePort,
    ContentMcpPort,
)

__all__ = [
    # Ports
    "AgentEnginePort",
    # Events
    "BackgroundJobStatus",
    # Contracts
    "CalibrationBand",
    "CalibrationResult",
    "ConceptNode",
    "ConceptStatus",
    "ConfidenceBand",
    "ConnectorStatus",
    "ContentMcpPort",
    "DenseBlockDimensions",
    "DrawingReviewResult",
    "EffortLevel",
    "EngineKind",
    "GraphEdge",
    "GraphSnapshot",
    "HarnessConfig",
    "HintRung",
    "LogicalChain",
    "McpServerConfig",
    "ModelSlotConfig",
    "ModelSlots",
    "PlanDag",
    "PlanNode",
    "PlanNodeStatus",
    "PracticeProblem",
    "PracticeState",
    "QuizMode",
    "QuizOption",
    "QuizPayload",
    "QuizSubmission",
    "SessionMessage",
    "SessionMode",
    "SessionPhase",
    "SessionRecord",
    "SseEventType",
    "SseFrame",
    "TeachContextKind",
    "TrackConfig",
    "TrackItem",
    "TrackMode",
    "VaultFolderMap",
    # Calibration
    "compute_confidence_band",
    "evaluate_calibration",
    "validate_quiz_options_evenness",
]
