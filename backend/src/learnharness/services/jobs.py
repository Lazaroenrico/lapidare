"""Append-only job queue with bounded concurrency and restart recovery."""
from __future__ import annotations

import asyncio
import json
import logging
from uuid import uuid4

from learnharness.core.contracts.practice import PracticeSet
from learnharness.core.events import SseEventType
from learnharness.services.sessions import now
from learnharness.vault.safety import append_line, safe_path

logger = logging.getLogger(__name__)


class JobManager:
    def __init__(self, state):
        self.state = state
        self.tasks: dict[str, asyncio.Task] = {}
        self.semaphore = asyncio.Semaphore(2)

    def _records(self, name):
        path = safe_path(self.state.vault_path, f".harness/{name}")
        if not path.exists():
            return []
        result = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                logger.warning("Ignoring incomplete JSONL record in %s", name)
        return result

    def load(self):
        for record in self._records("jobs.jsonl"):
            self.state.active_jobs[record["job_id"]] = record
        practice_dir = safe_path(self.state.vault_path, ".harness/practice")
        if practice_dir.exists():
            for path in practice_dir.glob("*.jsonl"):
                records = self._records(f"practice/{path.name}")
                if records:
                    item = PracticeSet.model_validate(records[-1])
                    self.state.practice_sets[item.set_id] = item

    def save_practice(self, item):
        path = safe_path(self.state.vault_path, f".harness/practice/{item.set_id}.jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        append_line(path, item.model_dump_json() + "\n")
        self.state.practice_sets[item.set_id] = item
        self.state.sse_hub.broadcast(SseEventType.JOBS_UPDATED, {})

    def save(self, record):
        record["updated_at"] = now()
        path = safe_path(self.state.vault_path, ".harness/jobs.jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        append_line(path, json.dumps(record, ensure_ascii=False) + "\n")
        self.state.active_jobs[record["job_id"]] = record
        self.state.sse_hub.broadcast(SseEventType.JOBS_UPDATED, {"job_id": record["job_id"]})

    def submit(self, kind, payload, *, key=None, dedup_statuses=("queued", "running", "completed")):
        if key:
            existing = next((j for j in self.state.active_jobs.values() if j.get("dedup_key") == key and j["status"] in dedup_statuses), None)
            if existing:
                return existing
        record = {"job_id": f"job-{uuid4().hex}", "kind": kind, "status": "queued", "label": payload.get("topic") or kind, "payload": payload, "dedup_key": key, "result_id": None, "error": None, "created_at": now()}
        self.save(record)
        self.tasks[record["job_id"]] = asyncio.create_task(self.run(record))
        return record

    async def run(self, record):
        try:
            async with self.semaphore:
                record["status"] = "running"
                self.save(record)
                config = self.state.get_config()
                if record["kind"] == "practice_gen":
                    from learnharness.pipelines.practice_gen import run_practice_generation_pipeline
                    item = await run_practice_generation_pipeline(self.state.vault_path, topics=record["payload"].get("topics"), engine=self.state.engine(config.slots.background), slot=config.slots.background)
                    self.save_practice(item)
                    record["result_id"] = item.set_id
                elif record["kind"] == "extraction":
                    # Payload: {session_id, topic, reason}; the service drains uncovered prose.
                    summary = await self.state.graph.extract_session(record["payload"]["session_id"])
                    record["result_id"] = record["payload"]["session_id"]
                    record["result"] = {k: summary[k] for k in ("batches", "new_node_ids", "new_chain_ids")}
                elif record["kind"] == "track_gen":
                    await self.state.tracks.generate()
                    record["result_id"] = "track"
                elif record["kind"] == "demo_builder":
                    from learnharness.services.demos import run_demo_job
                    result = await run_demo_job(self.state, record["payload"])
                    record["result_id"] = result["slug"]
                else:
                    raise ValueError("Unsupported background job")
                record["status"] = "completed"
                self.save(record)
        except asyncio.CancelledError:
            record["status"] = "interrupted"
            self.save(record)
            raise
        except Exception as exc:
            logger.exception("Job failed: %s", record["job_id"])
            record["status"] = "failed"
            record["error"] = self.state.redact(str(exc))
            self.save(record)

    def recover(self):
        self.load()
        for record in list(self.state.active_jobs.values()):
            if record["status"] in ("running", "queued"):
                record["status"] = "interrupted"
                self.save(record)

    def retry(self, job_id):
        record = self.state.active_jobs[job_id]
        if record["status"] not in ("failed", "interrupted"):
            raise ValueError("Only failed or interrupted jobs may be retried")
        record["error"] = None
        record["status"] = "queued"
        self.save(record)
        self.tasks[job_id] = asyncio.create_task(self.run(record))
        return record

    async def close(self):
        tasks = [t for t in self.tasks.values() if not t.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
