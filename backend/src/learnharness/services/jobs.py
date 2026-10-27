"""Append-only job queue with bounded concurrency and restart recovery.

Jobs dispatched from a session (research, PDF reading, figures, demos) report back to it:
when the job ends, its result (or its failure) is delivered once as a ``job`` steer
(``SessionService.deliver_steer``), so the teacher never waits for or polls a job.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from uuid import uuid4

from learnharness.core.events import SseEventType
from learnharness.services.sessions import now
from learnharness.vault.lesson_layout import current_node_id
from learnharness.vault.safety import append_line, safe_path

logger = logging.getLogger(__name__)

# Job kind -> ``details.kind`` of the steer the UI renders.
STEER_KINDS = {"research": "research", "pdf": "read_pdf", "visual": "visual", "demo_builder": "demo"}
DISPATCH_NOTE = "Despachado. Continue ensinando; o resultado chegará sozinho — não espere nem consulte."


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
        label = payload.get("label") or payload.get("topic") or kind
        record = {"job_id": f"job-{uuid4().hex}", "kind": kind, "status": "queued", "label": label,
                  "activity": None, "payload": payload, "dedup_key": key, "result_id": None, "error": None,
                  "created_at": now()}
        self.save(record)
        self.tasks[record["job_id"]] = asyncio.create_task(self.run(record))
        return record

    def dispatch(self, session_id: str, kind: str, payload: dict[str, Any], label: str) -> dict[str, Any]:
        """Queue a session job; the plan node current now is where its artifact lands."""
        session = self.state.sessions.get(session_id)
        payload = {**payload, "session_id": session_id, "node_id": current_node_id(session.plan),
                   "label": label}
        return self.submit(kind, payload)

    def progress(self, record, activity: str) -> None:
        """What the job is doing now (shown under BACKGROUND AGENTS)."""
        record["activity"] = activity
        self.save(record)

    async def _execute(self, record):
        kind, payload = record["kind"], record["payload"]
        if kind == "extraction":
            # Payload: {session_id, topic, reason}; the service drains uncovered prose.
            summary = await self.state.graph.extract_session(payload["session_id"])
            record["result_id"] = payload["session_id"]
            record["result"] = {k: summary[k] for k in ("batches", "new_node_ids", "new_chain_ids")}
        elif kind == "track_gen":
            # Payload: {track_id, regenerate}; jobs from before Fase 14 carry no track_id
            # and mean the active track.
            track = await self.state.tracks.generate(payload.get("track_id"),
                                                     regenerate=bool(payload.get("regenerate")))
            record["result_id"] = (track or {}).get("id") or "track"
        elif kind == "demo_builder":
            from learnharness.services.demos import run_demo_job
            result = await run_demo_job(self.state, payload, lambda a: self.progress(record, a))
            record["result_id"] = result["slug"]
            record["result"] = {k: result[k] for k in ("slug", "rel_path", "title", "description", "verified",
                                                       "warnings") if k in result}
        elif kind == "research":
            from learnharness.services.research import run_research_job
            record["result"] = await run_research_job(self.state, payload, lambda a: self.progress(record, a))
        elif kind == "pdf":
            from learnharness.services.pdf_reader import run_pdf_job
            record["result"] = await run_pdf_job(self.state, payload, lambda a: self.progress(record, a))
        elif kind == "visual":
            from learnharness.services.visuals import run_visual_job
            result = await run_visual_job(self.state, payload, lambda a: self.progress(record, a))
            record["result_id"] = result["slug"]
            record["result"] = result
        else:
            raise ValueError("Unsupported background job")
        # Degraded checks (no Chromium, vision unavailable) finish the job with a warning.
        warnings = (record.get("result") or {}).pop("warnings", None)
        if warnings:
            record["warnings"] = warnings

    async def run(self, record):
        # Provider usage of the whole job goes to the global ledger (job_kind, no session).
        usage = self.state.usage.capture(job_kind=record["kind"])
        try:
            async with self.semaphore:
                record["status"] = "running"
                record["started_at"] = now()
                self.save(record)
                await self._execute(record)
                record["status"] = "completed"
                record["activity"] = None
                record["finished_at"] = now()
                self.save(record)
            await self._deliver_steer(record)
        except asyncio.CancelledError:
            record["status"] = "interrupted"
            self.save(record)
            raise
        except Exception as exc:
            logger.exception("Job failed: %s", record["job_id"])
            record["status"] = "failed"
            record["activity"] = None
            record["error"] = self.state.redact(str(exc)) or type(exc).__name__
            record["finished_at"] = now()
            self.save(record)
            await self._deliver_steer(record)
        finally:
            usage.close()

    # ----------------------------------------------------------------- steers

    def _already_steered(self, record, session) -> bool:
        # One steer per attempt: a retried job reports its new outcome (the teacher was told
        # the first attempt failed, so a later success must reach it).
        attempt = record.get("attempt", 1)
        if record.get("steer_message_id"):
            return True
        return any(m.steer_kind == "job" and (m.details or {}).get("job_id") == record["job_id"]
                   and (m.details or {}).get("attempt", 1) == attempt for m in session.messages)

    async def _deliver_steer(self, record) -> None:
        """Deliver the job's outcome to its session exactly once (idempotent per ``job_id``)."""
        payload = record.get("payload") or {}
        session_id = payload.get("session_id")
        if record["kind"] not in STEER_KINDS or not session_id:
            return
        try:
            session = self.state.sessions.get(session_id)
        except KeyError:
            logger.warning("Job %s finished for a session that no longer exists", record["job_id"])
            return
        if self._already_steered(record, session):
            return
        content, details = steer_for(record)
        details["attempt"] = record.get("attempt", 1)
        try:
            message = await self.state.sessions.deliver_steer(session_id, "job", content, details)
        except Exception:
            logger.exception("Could not deliver the steer of job %s", record["job_id"])
            return
        record["steer_message_id"] = message.id
        self.save(record)
        if details["status"] == "done":
            # The artifact belongs in the lesson note now, even if the next turn is delayed.
            try:
                self.state.sessions.refresh_lesson_note(self.state.sessions.get(session_id))
            except Exception:
                logger.exception("Lesson note refresh after job %s failed", record["job_id"])

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
        record.pop("warnings", None)
        record["status"] = "queued"
        record["attempt"] = record.get("attempt", 1) + 1
        record.pop("steer_message_id", None)
        self.save(record)
        self.tasks[job_id] = asyncio.create_task(self.run(record))
        return record

    async def close(self):
        tasks = [t for t in self.tasks.values() if not t.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


# ----------------------------------------------------------------- steer text (model-facing)


def _sources_lines(sources: list[dict[str, str]]) -> str:
    return "\n".join(f"- {s['title']} — {s['url']}" for s in sources)


def _done_content(kind: str, payload: dict[str, Any], result: dict[str, Any]) -> str:
    if kind == "research":
        return (f"A pesquisa '{payload['question']}' terminou.\n\nResumo:\n{result['brief']}\n\n"
                f"Fontes consultadas:\n{_sources_lines(result['sources'])}\n\n"
                "Use o que servir à aula agora e cite as fontes pelo título quando usar. "
                "Não acrescente nada que a pesquisa não diga.")
    if kind == "pdf":
        pages = ", ".join(str(p) for p in result["pages_read"])
        return (f"A leitura do PDF '{result['file']}' terminou (páginas lidas: {pages}).\n"
                f"Pergunta: {payload['question']}\n\nResposta:\n{result['answer']}\n\n"
                "Ao usar, cite as páginas como (p. N). Não atribua ao PDF o que não está aqui.")
    if kind == "visual":
        alt = f" Ele mostra: {result['alt']}" if result.get("alt") else ""
        return (f"O visual '{result['title']}' está pronto e foi inserido na aula.{alt} "
                "Refira-se a ele pelo que mostra; não o descreva como pendente.")
    return (f"A demo interativa '{result['title']}' está pronta e o aluno já a vê. "
            "Refira-se a ela pelo que mostra, de preferência com uma previsão antes de mexer nos controles.")


_FAILED_NAMES = {"research": "A pesquisa", "pdf": "A leitura do PDF", "visual": "O visual",
                 "demo_builder": "A demo interativa"}


def steer_for(record: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """``(content, details)`` of the steer that reports this finished job to its session."""
    kind, payload = record["kind"], record.get("payload") or {}
    details: dict[str, Any] = {
        "job_id": record["job_id"],
        "kind": STEER_KINDS[kind],
        "label": record.get("label"),
        "node_id": payload.get("node_id"),
        "dispatched_at": record.get("created_at"),
        "finished_at": record.get("finished_at") or now(),
    }
    if record["status"] == "completed":
        details["status"] = "done"
        details["result"] = record.get("result") or {}
        return _done_content(kind, payload, details["result"]), details
    details["status"] = "failed"
    details["error"] = record.get("error") or "erro desconhecido"
    content = (f"{_FAILED_NAMES[kind]} '{record.get('label')}' falhou ({details['error']}). "
               "Siga em prosa; não invente o resultado.")
    return content, details
