"""Practice sets, hint ladder (R0-R5), interactive demos, and background LangGraph jobs routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ValidationError

from learnharness.api.state import get_app_state
from learnharness.core.contracts.practice import PracticeAttemptGrade, PracticeSet
from learnharness.core.demo_validation import DEMO_CSP
from learnharness.engines.cli_protocol import EngineError
from learnharness.mcp.demo_builder import load_demo_from_vault
from learnharness.pipelines.practice_gen import InvalidGradeError, grade_practice_attempt
from learnharness.services.demos import submit_demo

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
    session_id: str | None = None


class TriggerExtractionPayload(BaseModel):
    """Legacy body; extraction now reads the session's own uncovered teacher prose."""
    session_id: str
    topic: str | None = None
    messages_text: str | None = None
    source_ref: str | None = None


def _serialize_hint(hint) -> dict[str, Any]:
    return {"level": hint.level, "title": hint.label, "label": hint.label, "prompt": hint.prompt,
            "content": hint.prompt}


def _serialize_grade(grade: PracticeAttemptGrade) -> dict[str, Any]:
    return {"score": grade.score, "max_score": grade.max_score, "feedback": grade.feedback,
            "rubric_scores": grade.criterion_scores, "passed": grade.passed}


def _serialize_practice_set(p_set: PracticeSet) -> dict[str, Any]:
    """Public view: never exposes the committed solution nor hints beyond the revealed rung."""
    problems_data = []
    for prob in p_set.problems:
        revealed = p_set.current_hint_idx.get(prob.problem_id, -1)
        grade = p_set.grades.get(prob.problem_id)
        problems_data.append(
            {
                "id": prob.problem_id,
                "problem_id": prob.problem_id,
                "title": prob.topic,
                "prompt": prob.prompt,
                "target_concepts": [prob.topic],
                "kind": prob.kind,
                "hints": [_serialize_hint(h) for h in prob.hints[: revealed + 1]],
                "rubric": [{"id": r.id, "name": r.description, "weight": r.max_points, "description": r.description}
                           for r in prob.rubric],
                "max_score": 10,
                "grade": _serialize_grade(grade) if grade else None,
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


@practice_router.post("/api/practice/generate", status_code=202)
async def generate_practice_set(payload: GeneratePracticePayload, request: Request) -> dict[str, Any]:
    """Queue a `practice_gen` background job (Partitioner -> Send(Generator) -> Aggregator).

    Returns the job record; the set appears in GET /api/practice/sets after SSE `jobs:updated`.
    An identical request still queued/running is returned instead of duplicated.
    """
    state = get_app_state(request.app)
    topics = list(dict.fromkeys(t.strip() for t in payload.topics if t.strip()))
    for job in state.active_jobs.values():
        if (job.get("kind") == "practice_gen" and job.get("status") in ("queued", "running")
                and job.get("payload", {}).get("topics") == topics):
            return job
    label = f"Practice: {', '.join(topics[:2])}" if topics else "Practice: prioridades do quiz"
    return state.jobs.submit("practice_gen", {"topics": topics, "topic": label})


def _find_problem(request: Request, set_id: str, problem_id: str):
    state = get_app_state(request.app)
    p_set = state.practice_sets.get(set_id)
    if not p_set:
        raise HTTPException(status_code=404, detail=f"Practice set {set_id} not found")
    problem = next((p for p in p_set.problems if p.problem_id == problem_id), None)
    if not problem:
        raise HTTPException(status_code=404, detail=f"Problem {problem_id} not found in set")
    return state, p_set, problem


@practice_router.post("/api/practice/sets/{set_id}/problems/{problem_id}/attempt")
async def submit_practice_attempt(
    set_id: str, problem_id: str, payload: PracticeAttemptPayload, request: Request
) -> dict[str, Any]:
    """Reveal exactly the next hint rung (R0 -> R5) OR grade the attempt against the committed rubric."""
    state, p_set, problem = _find_problem(request, set_id, problem_id)

    if payload.request_hint:
        next_idx = p_set.current_hint_idx.get(problem_id, -1) + 1
        if next_idx >= len(problem.hints):
            raise HTTPException(status_code=409, detail="Hint ladder exhausted (R5 already revealed)")
        p_set.current_hint_idx[problem_id] = next_idx
        state.jobs.save_practice(p_set)
        return {"next_hint": _serialize_hint(problem.hints[next_idx])}

    if not payload.answer.strip():
        raise HTTPException(status_code=422, detail="Submit an answer before requesting grading")
    config = state.get_config()
    try:
        grade = await grade_practice_attempt(
            problem, payload.answer, state.engine(config.slots.strong), slot=config.slots.strong)
    except (InvalidGradeError, ValidationError) as exc:
        # Inconsistent provider output is an upstream failure, never silently repaired.
        raise EngineError(f"Provider returned an invalid grade: {exc}") from exc
    p_set.grades[problem_id] = grade
    state.jobs.save_practice(p_set)
    return {"grade": _serialize_grade(grade), "next_hint": None}


@practice_router.post("/api/demos", status_code=202)
async def create_demo_endpoint(payload: CreateDemoPayload, request: Request) -> dict[str, Any]:
    """Queue a `demo_builder` job (engine-generated simulator saved to viz/demos/<slug>.html); returns the job record."""
    state = get_app_state(request.app)
    return submit_demo(state, payload.title, payload.topic, payload.description,
                       lesson_rel_path=payload.lesson_rel_path, session_id=payload.session_id)


@practice_router.get("/api/demos/{slug}")
async def get_demo_endpoint(slug: str, request: Request, raw: bool = False) -> Any:
    """Load an interactive simulator from viz/demos/<slug>.html."""
    state = get_app_state(request.app)
    try:
        data = load_demo_from_vault(state.vault_path, slug)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Demo '{slug}' not found") from None

    if raw:
        # Opened directly (outside the sandboxed iframe) it must still get an opaque origin.
        return HTMLResponse(content=data["html"], headers={"Content-Security-Policy": f"sandbox allow-scripts; {DEMO_CSP}"})
    return data


@practice_router.post("/api/jobs/extract", status_code=202)
async def trigger_extraction_job(payload: TriggerExtractionPayload, request: Request) -> dict[str, Any]:
    """Legacy alias of ``POST /api/graph/extract/{session_id}`` (Fase 8B)."""
    state = get_app_state(request.app)
    return state.graph.request_extraction(state.graph.session_or_404(payload.session_id), "manual")


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
