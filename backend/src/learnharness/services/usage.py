"""Token usage ledger: ``<vault>/.harness/usage.jsonl`` (append-only) and its aggregates.

Each provider call reported by an engine (``engines.usage.report_usage``) while a capture
is installed becomes one row ``{at, session_id, job_kind, model_id, input_tokens,
output_tokens, thinking_tokens, turn, cached_tokens}``. Session captures also accumulate the turn's reports into
``SessionRecord.usage`` when the turn ends. After each row the hub broadcasts
``usage:updated`` (notify -> the UI fetches ``GET /api/usage``).
"""
from __future__ import annotations

import contextlib
import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from learnharness.core.contracts.session import SessionUsage, TokenUsage, TurnUsage
from learnharness.core.events import SseEventType
from learnharness.engines.usage import reset_usage_sink, set_usage_sink
from learnharness.vault.jsonl_store import load_session
from learnharness.vault.safety import append_line, safe_path

if TYPE_CHECKING:
    from learnharness.api.state import AppState

logger = logging.getLogger(__name__)

LEDGER = ".harness/usage.jsonl"
TOP_SESSIONS = 10
MAX_TURNS = 50


class UsageCapture:
    """Installs the usage sink for one session turn or one background job (task-local)."""

    def __init__(self, service: UsageService, session_id: str | None = None,
                 job_kind: str | None = None, track_context: bool = True, charge: bool = True):
        self.service = service
        self.session_id = session_id
        self.job_kind = job_kind
        # Teaching turns tell how full the context is; a side call (compaction) does not.
        self.track_context = track_context
        # Background jobs only tag their ledger rows with the session; the session total stays turns-only.
        self.charge = charge
        self.turn: int | None = None  # SessionRecord.turn_seq of the turn this capture serves.
        self.reports: list[TurnUsage] = []
        self._token = set_usage_sink(self._record)

    def _record(self, usage: TurnUsage) -> None:
        self.reports.append(usage)
        self.service.append(usage, session_id=self.session_id, job_kind=self.job_kind, turn=self.turn)

    def close(self) -> None:
        """Remove the sink and charge the session (idempotent; never raises)."""
        if self._token is None:
            return
        with contextlib.suppress(ValueError):  # closed from another context: nothing to reset
            reset_usage_sink(self._token)
        self._token = None
        if self.charge and self.session_id and self.reports:
            self.service.charge_session(self.session_id, self.reports, track_context=self.track_context)


class UsageService:
    def __init__(self, state: AppState):
        self.state = state

    def capture(self, session_id: str | None = None, job_kind: str | None = None,
                track_context: bool = True, charge: bool = True) -> UsageCapture:
        return UsageCapture(self, session_id=session_id, job_kind=job_kind, track_context=track_context,
                            charge=charge)

    def _path(self):
        return safe_path(self.state.vault_path, LEDGER)

    def append(self, usage: TurnUsage, *, session_id: str | None = None,
               job_kind: str | None = None, turn: int | None = None) -> None:
        row = {
            "at": datetime.now(UTC).isoformat(), "session_id": session_id, "job_kind": job_kind,
            "model_id": usage.model_id, "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens, "thinking_tokens": usage.thinking_tokens,
            "turn": turn, "cached_tokens": usage.cached_tokens,
        }
        path = self._path()
        path.parent.mkdir(parents=True, exist_ok=True)
        append_line(path, json.dumps(row, ensure_ascii=False) + "\n")
        self.state.sse_hub.broadcast(SseEventType.USAGE_UPDATED,
                                     {"session_id": session_id, "job_kind": job_kind})

    def charge_session(self, session_id: str, reports: list[TurnUsage],
                       track_context: bool = True) -> None:
        """Add a turn's reports to ``SessionRecord.usage`` (sync get+save: no await between).

        With ``track_context`` it also records ``context_tokens`` (input + output of the last
        report) and ``last_turn`` (the sum of these reports).
        """
        try:
            session = self.state.sessions.get(session_id)
            for usage in reports:
                session.usage.add(usage)
            if track_context and reports:
                last = reports[-1]
                session.usage.context_tokens = last.input_tokens + last.output_tokens
                cached = [r.cached_tokens for r in reports if r.cached_tokens is not None]
                session.usage.last_turn = TokenUsage(
                    input_tokens=sum(r.input_tokens for r in reports),
                    output_tokens=sum(r.output_tokens for r in reports),
                    thinking_tokens=sum(r.thinking_tokens for r in reports),
                    cached_tokens=sum(cached) if cached else None)
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
        return {"today": current.model_dump(exclude_none=True),
                "total": total.model_dump(exclude_none=True), "by_session": by_session}

    def session_turns(self, session_id: str) -> dict[str, Any]:
        """``{session_id, turns, background[, untracked]}`` from this session's ledger rows.

        ``turns``: teaching turns summed by ``turn`` (oldest first, last ``MAX_TURNS``).
        ``background``: job rows summed by ``job_kind``. ``untracked``: legacy rows with
        neither, present only when non-zero so they never vanish from the total.
        """
        turns: dict[int, dict[str, Any]] = {}
        background: dict[str, dict[str, Any]] = {}
        untracked = _bucket()
        for row in self.rows():
            if row.get("session_id") != session_id:
                continue
            turn, job_kind = row.get("turn"), row.get("job_kind")
            if job_kind:
                bucket = background.setdefault(str(job_kind), {"job_kind": str(job_kind), **_bucket()})
            elif isinstance(turn, int):
                bucket = turns.setdefault(turn, {"turn": turn, "at": row.get("at"), **_bucket()})
            else:
                bucket = untracked
            _add_row(bucket, row)
        result: dict[str, Any] = {
            "session_id": session_id,
            "turns": [turns[t] for t in sorted(turns)][-MAX_TURNS:],
            "background": sorted(background.values(), key=lambda b: b["job_kind"]),
        }
        if untracked["calls"]:
            result["untracked"] = untracked
        return result


_COUNTERS = ("input_tokens", "output_tokens", "thinking_tokens")


def _bucket() -> dict[str, Any]:
    return {**dict.fromkeys(_COUNTERS, 0), "cached_tokens": None, "calls": 0}


def _add_row(bucket: dict[str, Any], row: dict[str, Any]) -> None:
    """Add one ledger row to ``bucket``; ``cached_tokens`` stays ``None`` until a row reports it."""
    for key in _COUNTERS:
        value = row.get(key)
        bucket[key] += value if isinstance(value, int) else 0
    cached = row.get("cached_tokens")
    if isinstance(cached, int):
        bucket["cached_tokens"] = (bucket["cached_tokens"] or 0) + cached
    bucket["calls"] += 1
