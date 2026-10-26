"""Practice sets, hint ladder (R0-R5), interactive demos, and background LangGraph jobs routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from learnharness.api.state import get_app_state
from learnharness.core.contracts.practice import PracticeSet
from learnharness.core.events import SseEventType
from learnharness.mcp.demo_builder import load_demo_from_vault, save_demo_to_vault
from learnharness.pipelines.extraction import run_extraction_pipeline
from learnharness.pipelines.practice_gen import (
    grade_practice_attempt_node,
    run_practice_generation_pipeline,
)

practice_router = APIRouter(tags=["practice_demos_and_jobs"])


class GeneratePracticePayload(BaseModel):
    topics: list[str] = []


class PracticeAttemptPayload(BaseModel):
    answer: str
    request_hint: bool = False


class CreateDemoPayload(BaseModel):
    title: str
    topic: str
    description: str = ""
    lesson_rel_path: str | None = None
    parameters: list[dict[str, Any]] | None = None


class TriggerExtractionPayload(BaseModel):
    session_id: str
    topic: str
    messages_text: str
    source_ref: str | None = None


def _serialize_practice_set(p_set: PracticeSet) -> dict[str, Any]:
    problems_data = []
    for prob in p_set.problems:
        problems_data.append(
            {
                "id": prob.problem_id,
                "problem_id": prob.problem_id,
                "title": prob.topic,
                "prompt": prob.prompt,
                "target_concepts": [prob.topic],
                "kind": prob.kind,
                "hints": [{"level": h.level, "title": h.label, "content": h.prompt} for h in prob.hints],
                "rubric": [{"name": r.description, "weight": r.max_points, "description": r.description} for r in prob.rubric],
                "max_score": 10,
            }
        )

    return {
        "id": p_set.set_id,
        "set_id": p_set.set_id,
        "title": p_set.title,
        "created_at": p_set.created_at,
        "problems": problems_data,
        "completed": bool(p_set.grades and len(p_set.grades) >= len(p_set.problems)),
    }


@practice_router.get("/api/practice/sets")
async def get_practice_sets(request: Request) -> list[dict[str, Any]]:
    """List all created practice problem sets."""
    state = get_app_state(request.app)
    return [_serialize_practice_set(s) for s in state.practice_sets.values()]


@practice_router.post("/api/practice/generate")
async def generate_practice_set(payload: GeneratePracticePayload, request: Request) -> dict[str, Any]:
    """Generate practice set via LangGraph StateGraph (Partitioner -> Send(Generator) -> Aggregator)."""
    state = get_app_state(request.app)
    p_set = await run_practice_generation_pipeline(
        vault_path=state.vault_path,
        topics=payload.topics if payload.topics else None,
    )
    state.practice_sets[p_set.set_id] = p_set
    return _serialize_practice_set(p_set)


@practice_router.post("/api/practice/sets/{set_id}/problems/{problem_id}/attempt")
async def submit_practice_attempt(
    set_id: str, problem_id: str, payload: PracticeAttemptPayload, request: Request
) -> dict[str, Any]:
    """Step hint ladder without grading OR grade attempt against committed rubric."""
    state = get_app_state(request.app)
    p_set = state.practice_sets.get(set_id)
    if not p_set:
        raise HTTPException(status_code=404, detail=f"Practice set {set_id} not found")

    target_prob = next((p for p in p_set.problems if p.problem_id == problem_id), None)
    if not target_prob:
        raise HTTPException(status_code=404, detail=f"Problem {problem_id} not found in set")

    current_idx = p_set.current_hint_idx.get(problem_id, -1)

    # If learner requests hint, advance hint step WITHOUT revealing solution or grading
    if payload.request_hint:
        next_idx = min(current_idx + 1, len(target_prob.hints) - 1)
        p_set.current_hint_idx[problem_id] = next_idx
        hint = target_prob.hints[next_idx]
        return {
            "next_hint": {
                "level": hint.level,
                "title": hint.label,
                "label": hint.label,
                "prompt": hint.prompt,
                "content": hint.prompt,
            }
        }

    # Grade attempt against committed rubric via LangGraph grader node
    grade = grade_practice_attempt_node(target_prob, payload.answer)
    p_set.grades[problem_id] = grade

    return {
        "grade": {
            "score": grade.score,
            "max_score": grade.max_score,
            "feedback": grade.feedback,
            "rubric_scores": grade.criterion_scores,
            "passed": grade.passed,
        },
        "next_hint": None,
    }


@practice_router.post("/api/demos")
async def create_demo_endpoint(payload: CreateDemoPayload, request: Request) -> dict[str, Any]:
    """Generate and persist a self-contained #141414 interactive simulator in viz/demos/<slug>.html."""
    state = get_app_state(request.app)
    result = save_demo_to_vault(
        vault_path=state.vault_path,
        title=payload.title,
        topic=payload.topic,
        description=payload.description,
        lesson_rel_path=payload.lesson_rel_path,
        parameters=payload.parameters,
    )
    state.sse_hub.broadcast(SseEventType.VAULT_CHANGED, {"demo": result["slug"]})
    return result


@practice_router.get("/api/demos/{slug}")
async def get_demo_endpoint(slug: str, request: Request, raw: bool = False) -> Any:
    """Load an interactive simulator from viz/demos/<slug>.html."""
    state = get_app_state(request.app)
    try:
        data = load_demo_from_vault(state.vault_path, slug)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Demo '{slug}' not found") from None

    if raw:
        return HTMLResponse(content=data["html"])
    return data


@practice_router.post("/api/jobs/extract")
async def trigger_extraction_job(payload: TriggerExtractionPayload, request: Request) -> dict[str, Any]:
    """Run LangGraph concept & chain extraction pipeline (Extractor -> Auditor -> Merger)."""
    state = get_app_state(request.app)
    res = await run_extraction_pipeline(
        vault_path=state.vault_path,
        session_id=payload.session_id,
        topic=payload.topic,
        messages_text=payload.messages_text,
        source_ref=payload.source_ref,
    )
    return res


@practice_router.get("/api/jobs")
async def get_background_jobs(request: Request) -> list[dict[str, Any]]:
    """List active and recent background LangGraph agent jobs."""
    state = get_app_state(request.app)
    jobs = []
    for j in state.active_jobs.values():
        if hasattr(j, "model_dump"):
            jobs.append(j.model_dump())
        else:
            jobs.append(j)
    return jobs


@practice_router.post("/api/jobs/{job_id}/retry")
async def retry_background_job(job_id: str, request: Request) -> dict[str, Any]:
    """Re-queue a failed or interrupted background job (non-retryable status -> ValueError -> 422)."""
    state = get_app_state(request.app)
    try:
        return state.jobs.retry(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found") from None
