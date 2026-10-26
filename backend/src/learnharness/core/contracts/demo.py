"""Demo-Builder contracts: the structured output an engine returns for a lesson simulator.

Pure Pydantic models with ZERO I/O.
"""

from pydantic import BaseModel, Field


class DemoParameter(BaseModel):
    """One learner-adjustable parameter exposed as a slider/input in the simulator."""
    id: str
    label: str
    min: float = 0.0
    max: float = 1.0
    step: float = 0.01
    default: float = 0.5
    unit: str = ""
    description: str = ""


class GeneratedDemo(BaseModel):
    """Self-contained HTML/JS/Canvas simulator generated for one specific lesson."""
    title: str
    html: str
    parameters: list[DemoParameter] = Field(default_factory=list)
    learning_goal: str = ""
