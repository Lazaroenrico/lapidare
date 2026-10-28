"""Cancelling background jobs (Fase 20): user cancel steers once, shutdown does not."""

from __future__ import annotations

import asyncio

import pytest

from learnharness.core.contracts.jobs import ResearchResult
from tests.conftest import wait_until
from tests.unit.test_background_jobs import (
    ResearchEngine,
    _job_steers,
    _session,
    _settled,
    _state,
    _tools,
)

RESULT = ResearchResult(brief="b", sources=[{"title": "t", "url": "https://x.org"}])


def _blocked_engine():
    engine = ResearchEngine(RESULT)
    gate = asyncio.Event()
    original = engine.research

    async def slow(prompt, slot=None):
        await gate.wait()
        return await original(prompt, slot)

    engine.research = slow
    return engine, gate


async def test_cancel_running_job_records_interrupted_and_steers_once(tmp_path):
    engine, gate = _blocked_engine()
    state = _state(tmp_path, engine)
    try:
        session, _ = _session(state)
        job_id = (await _tools(state, session.id)["research"](question="q?"))["job_id"]
        await wait_until(lambda: state.active_jobs[job_id]["status"] == "running")
        await state.jobs.cancel(job_id)
        record = await _settled(state, job_id, "interrupted")
        assert record["error"] == "cancelado pelo usuário"
        (steer,) = _job_steers(state, session.id)
        assert steer.details["status"] == "failed" and "cancelado pelo usuário" in steer.content
        with pytest.raises(ValueError):
            await state.jobs.cancel(job_id)
        assert len(_job_steers(state, session.id)) == 1
        # A cancelled job can be retried, and its new outcome reaches the session.
        gate.set()
        state.jobs.retry(job_id)
        await _settled(state, job_id, "completed")
        assert [m.details["status"] for m in _job_steers(state, session.id)] == ["failed", "done"]
    finally:
        await state.close()


async def test_cancel_queued_job_before_it_starts(tmp_path):
    engine, _ = _blocked_engine()
    state = _state(tmp_path, engine)
    try:
        session, _ = _session(state)
        job_id = (await _tools(state, session.id)["research"](question="q?"))["job_id"]
        assert state.active_jobs[job_id]["status"] == "queued"
        await state.jobs.cancel(job_id)
        record = await _settled(state, job_id, "interrupted")
        assert record["error"] == "cancelado pelo usuário"
        assert len(_job_steers(state, session.id)) == 1
    finally:
        await state.close()


async def test_shutdown_does_not_steer(tmp_path):
    engine, _ = _blocked_engine()
    state = _state(tmp_path, engine)
    session, _ = _session(state)
    job_id = (await _tools(state, session.id)["research"](question="q?"))["job_id"]
    await wait_until(lambda: state.active_jobs[job_id]["status"] == "running")
    await state.jobs.close()
    assert state.active_jobs[job_id]["status"] == "interrupted"
    assert state.active_jobs[job_id]["error"] is None
    assert not _job_steers(state, session.id)
    await state.close()


def test_cancel_route_404_and_409(app_state, api_client):
    assert api_client.post("/api/jobs/job-nope/cancel").status_code == 404
    app_state.active_jobs["job-done"] = {"job_id": "job-done", "kind": "research", "status": "completed"}
    assert api_client.post("/api/jobs/job-done/cancel").status_code == 409
