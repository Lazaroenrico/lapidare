"""Interactive demos and background job routes (/api/demos, /api/jobs*)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from learnharness.api.state import get_app_state
from learnharness.core.demo_validation import DEMO_CSP
from learnharness.mcp.demo_builder import load_demo_from_vault
from learnharness.services.demos import submit_demo

jobs_router = APIRouter(tags=["demos_and_jobs"])


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


@jobs_router.post("/api/demos", status_code=202)
async def create_demo_endpoint(payload: CreateDemoPayload, request: Request) -> dict[str, Any]:
    """Queue a `demo_builder` job (engine-generated simulator saved to viz/demos/<slug>.html); returns the job record."""
    state = get_app_state(request.app)
    return submit_demo(state, payload.title, payload.topic, payload.description,
                       lesson_rel_path=payload.lesson_rel_path, session_id=payload.session_id)


@jobs_router.get("/api/demos/{slug}")
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


@jobs_router.get("/api/visuals/{slug}")
async def get_visual_endpoint(slug: str, request: Request) -> dict[str, Any]:
    """A lesson figure from ``<viz>/visuals/<slug>.svg`` as text (the UI renders it as a data URI)."""
    from learnharness.core.svg_validation import validate_svg
    from learnharness.services.visuals import visuals_dir
    from learnharness.vault.safety import safe_component, safe_path

    state = get_app_state(request.app)
    try:
        name = safe_component(slug.removesuffix(".svg"))
        path = safe_path(state.vault_path, f"{visuals_dir(state)}/{name}.svg")
    except (ValueError, PermissionError):
        raise HTTPException(status_code=400, detail="Invalid visual slug") from None
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Visual '{name}' not found")
    svg = path.read_text(encoding="utf-8")
    errors = validate_svg(svg)  # the file may have been edited in Obsidian since it was saved
    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors))
    return {"slug": name, "path": f"{visuals_dir(state)}/{name}.svg", "svg": svg}


@jobs_router.post("/api/jobs/extract", status_code=202)
async def trigger_extraction_job(payload: TriggerExtractionPayload, request: Request) -> dict[str, Any]:
    """Legacy alias of ``POST /api/graph/extract/{session_id}`` (Fase 8B)."""
    state = get_app_state(request.app)
    return state.graph.request_extraction(state.graph.session_or_404(payload.session_id), "manual")


@jobs_router.get("/api/jobs")
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


@jobs_router.post("/api/jobs/{job_id}/retry")
async def retry_background_job(job_id: str, request: Request) -> dict[str, Any]:
    """Re-queue a failed or interrupted background job (non-retryable status -> ValueError -> 422)."""
    state = get_app_state(request.app)
    try:
        return state.jobs.retry(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found") from None


@jobs_router.post("/api/jobs/{job_id}/cancel")
async def cancel_background_job(job_id: str, request: Request) -> dict[str, Any]:
    """Cancel a queued or running job (recorded as `interrupted`; finished job -> 409)."""
    state = get_app_state(request.app)
    try:
        return await state.jobs.cancel(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
