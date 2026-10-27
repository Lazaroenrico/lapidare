"""Token usage ledger: ``<vault>/.harness/usage.jsonl`` (append-only) and its aggregates.

Each provider call reported by an engine (``engines.usage.report_usage``) while a capture
is installed becomes one row ``{at, session_id, job_kind, model_id, input_tokens,
output_tokens, thinking_tokens}``. Session captures also accumulate the turn's reports into
``SessionRecord.usage`` when the turn ends. After each row the hub broadcasts
``usage:updated`` (notify -> the UI fetches ``GET /api/usage``).
"""
from __future__ import annotations

import contextlib
import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from learnharness.core.contracts.session import SessionUsage, TurnUsage
from learnharness.core.events import SseEventType
from learnharness.engines.usage import reset_usage_sink, set_usage_sink
from learnharness.vault.jsonl_store import load_session
from learnharness.vault.safety import append_line, safe_path

if TYPE_CHECKING:
    from learnharness.api.state import AppState

logger = logging.getLogger(__name__)

LEDGER = ".harness/usage.jsonl"
TOP_SESSIONS = 10


class UsageCapture:
    """Installs the usage sink for one session turn or one background job (task-local)."""

    def __init__(self, service: UsageService, session_id: str | None = None,
                 job_kind: str | None = None):
        self.service = service
        self.session_id = session_id
        self.job_kind = job_kind
        self.reports: list[TurnUsage] = []
        self._token = set_usage_sink(self._record)

    def _record(self, usage: TurnUsage) -> None:
        self.reports.append(usage)
        self.service.append(usage, session_id=self.session_id, job_kind=self.job_kind)

    def close(self) -> None:
        """Remove the sink and charge the session (idempotent; never raises)."""
        if self._token is None:
            return
        with contextlib.suppress(ValueError):  # closed from another context: nothing to reset
            reset_usage_sink(self._token)
        self._token = None
        if self.session_id and self.reports:
            self.service.charge_session(self.session_id, self.reports)


class UsageService:
    def __init__(self, state: AppState):
        self.state = state

    def capture(self, session_id: str | None = None, job_kind: str | None = None) -> UsageCapture:
        return UsageCapture(self, session_id=session_id, job_kind=job_kind)

    def _path(self):
        return safe_path(self.state.vault_path, LEDGER)

    def append(self, usage: TurnUsage, *, session_id: str | None = None,
               job_kind: str | None = None) -> None:
        row = {
            "at": datetime.now(UTC).isoformat(), "session_id": session_id, "job_kind": job_kind,
            "model_id": usage.model_id, "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens, "thinking_tokens": usage.thinking_tokens,
        }
        path = self._path()
        path.parent.mkdir(parents=True, exist_ok=True)
        append_line(path, json.dumps(row, ensure_ascii=False) + "\n")
        self.state.sse_hub.broadcast(SseEventType.USAGE_UPDATED,
                                     {"session_id": session_id, "job_kind": job_kind})

    def charge_session(self, session_id: str, reports: list[TurnUsage]) -> None:
        """Add a turn's reports to ``SessionRecord.usage`` (sync get+save: no await between)."""
        try:
            session = self.state.sessions.get(session_id)
            for usage in reports:
                session.usage.add(usage)
            self.state.sessions.save(session)
        except Exception:
            logger.warning("Could not charge usage to session %s", session_id, exc_info=True)

    def rows(self) -> list[dict[str, Any]]:
        path = self._path()
        if not path.is_file():
            return []
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Ignoring incomplete usage ledger line")
                continue
            if isinstance(row, dict):
                rows.append(row)
        return rows

    def summary(self, today: datetime | None = None) -> dict[str, Any]:
        """``{today, total, by_session}``; "today" is the server's local calendar day."""
        day = (today or datetime.now().astimezone()).astimezone().date()
        total, current = SessionUsage(), SessionUsage()
        per_session: dict[str, int] = {}
        for row in self.rows():
            usage = TurnUsage.model_validate({k: row.get(k) or 0 for k in
                                              ("input_tokens", "output_tokens", "thinking_tokens")})
            total.add(usage)
            try:
                if datetime.fromisoformat(row["at"]).astimezone().date() == day:
                    current.add(usage)
            except (KeyError, TypeError, ValueError):
                pass
            if row.get("session_id"):
                per_session[row["session_id"]] = per_session.get(row["session_id"], 0) + usage.total_tokens
        top = sorted(per_session.items(), key=lambda item: item[1], reverse=True)[:TOP_SESSIONS]
        by_session = []
        for session_id, tokens in top:
            try:
                record = load_session(self.state.vault_path, session_id)
            except (ValueError, OSError):
                record = None
            by_session.append({"session_id": session_id, "title": record.title if record else "",
                               "total_tokens": tokens})
        return {"today": current.model_dump(), "total": total.model_dump(), "by_session": by_session}
