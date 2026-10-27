"""The lesson's arc: closing the diagnosis, the plan, and track structure."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Literal

from fastmcp.exceptions import ToolError
from pydantic import BaseModel, ValidationError

from learnharness.core.contracts.session import ProbeAssessment, ProbeStrand
from learnharness.core.latex_heal import heal_latex
from learnharness.mcp.tools.inputs import NodeDetailIn, StrandIn, _heal_json, _required_text


def build(state, session_id) -> list[Callable[..., Awaitable[Any]]]:
    async def probe_done(strands: list[StrandIn] | str, summary: str | None = None) -> dict[str, Any]:
        """Close the diagnosis exactly once, with no question pending.

        strands: one entry per dependency strand the goal rests on, each
        {strand, assessment} where assessment states the floor (reliably right), the
        ceiling (where it breaks), misconceptions seen and where to build from.
        summary: optional overall read. After it succeeds, say one closing sentence and
        end your turn; planning starts automatically.
        """
        raw = _heal_json(strands)
        if not isinstance(raw, list) or not raw:
            raise ToolError("strands must be a non-empty list of {strand, assessment} objects.")
        try:
            items = [s if isinstance(s, StrandIn) else StrandIn.model_validate(s) for s in raw]
            assessment = ProbeAssessment(
                strands=[ProbeStrand(strand=s.strand, assessment=s.assessment) for s in items],
                summary=summary or None,
            )
        except ValidationError as exc:
            raise ToolError("strands must be {strand, assessment} objects with non-empty text.") from exc
        return await state.sessions.probe_done(session_id, assessment)

    async def leveling_done(known_item_ids: list[str] | str, start_item_id: str, summary: str) -> dict[str, Any]:
        """Track leveling only: close the diagnosis exactly once, with no question pending.

        known_item_ids: ids from the pending queue the learner already masters (they are marked
        done); never an item whose prerequisite is not also known. start_item_id: the first
        pending item NOT mastered (the track resumes there; never one of known_item_ids).
        summary: two or three sentences on the evidence. After it succeeds, tell the learner
        where the track starts in one or two sentences and end your turn.
        """
        raw = _heal_json(known_item_ids)
        if isinstance(raw, str):
            raw = [raw] if raw.strip() else []
        if not isinstance(raw, list) or not all(isinstance(i, str) for i in raw):
            raise ToolError('known_item_ids must be a list of item ids, e.g. ["s1", "s2"] (or [] when none).')
        start = _required_text(start_item_id, "start_item_id", "the id of the first pending item not mastered")
        return await state.leveling.done(session_id, raw, start, heal_latex(str(summary or "")))

    async def plan_init(mermaid: str, approach_prose: str = "",
                        node_details: dict[str, NodeDetailIn] | str | None = None) -> dict[str, Any]:
        """Write or rewrite the lesson map after probe_done (a mermaid flowchart).

        Example:
            graph TD
              ratio[Ratios compare quantities] --> slope[Slope is a ratio of changes]
              slope --> derivative[Derivative is the limit of slopes]
        Ids are permanent lowercase slugs (a-z, 0-9 joined by - or _); every quiz/explain
        references one as node_id. Titles are single-line; `a --> b` means a is a
        prerequisite of b (chains allowed); no subgraphs or styles. Aim for the minimal
        tree: roots are truths this learner already holds unconditionally, nothing off the
        path. Re-call it when a gap appears: kept ids keep their progress.
        approach_prose: the approach in a few sentences. node_details (dense sources):
        {id: {source_paragraphs: ["p3"], four_dimensions: {said, assumed, skipped,
        simplifications, paragraph_refs}}}; every ^pN must exist in the source. On the first
        call, present the plan and end your turn without teaching.
        """
        details = _heal_json(node_details) or {}
        if not isinstance(details, dict):
            raise ToolError("node_details must be an object keyed by node id.")
        details = {k: (v.model_dump(exclude_none=True) if isinstance(v, BaseModel) else v) for k, v in details.items()}
        return await state.sessions.init_plan(session_id, mermaid, approach_prose, details)

    async def plan_advance(node_id: str, status: Literal["mastered", "needs_review"]) -> dict[str, Any]:
        """Mark a plan node mastered or needs_review after its check.

        mastered requires mastered prerequisites and CHECK evidence on the node (a CHECK
        quiz answered correctly with high confidence, or a CHECK explain graded correct).
        Which node is current is derived from your questions; do not track it here.
        """
        return await state.sessions.advance(session_id, node_id, status)

    async def track_foundation(title: str, prerequisite: str) -> dict[str, Any]:
        """Insert a prerequisite lesson only when diagnostic evidence identifies a gap."""
        return await state.tracks.foundation(session_id, title, prerequisite)

    return [probe_done, leveling_done, plan_init, plan_advance, track_foundation]
