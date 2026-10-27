"""PRACTICE sessions (Fase 9): one problem at a time, attempts, conclude, dismissal.

The authoritative state lives on ``SessionRecord.practice`` (append-only session JSONL);
every ``conclude`` also appends one line to ``.harness/practice-log.jsonl``, which feeds
the retest queue of later sessions. Dismissals never reach the log.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import uuid4

from learnharness.core.contracts.practice import (
    AGENT_OUTCOMES,
    HINT_RUNGS,
    MISS_CLASSES,
    PRACTICE_MODES,
    PracticeAttempt,
    PracticeLogEntry,
    PracticeProblem,
)
from learnharness.core.contracts.session import SessionMessage, SessionRecord
from learnharness.core.practice import (
    format_retest_queue,
    format_suggested_material,
    graph_search,
    resolve_targets,
    retest_queue,
    suggested_nodes,
)
from learnharness.services.sessions import SessionConflict, now
from learnharness.vault.jsonl_store import append_practice_log, list_sessions, load_practice_log

if TYPE_CHECKING:
    from learnharness.api.state import AppState

DISMISS_NOTE = ("The learner dismissed the active problem. Do not return to it, do not pose it again "
                "and do not conclude it; wait for the learner.")
ATTEMPT_PREFIX = {"pt-BR": "Tentativa:\n", "en": "Attempt:\n"}
NEXT_REQUEST = {"pt-BR": "Próximo problema, por favor.", "en": "Next problem, please."}


def _localized(table: dict[str, str], language: str) -> str:
    return table["en" if language == "en" else "pt-BR"]


def attempt_prefix(language: str) -> str:
    return _localized(ATTEMPT_PREFIX, language)


def next_request(language: str) -> str:
    return _localized(NEXT_REQUEST, language)


def public_practice(session: SessionRecord) -> dict[str, Any]:
    """``practice`` as the learner sees it: ``model_solution`` only once a problem is concluded."""
    problems = []
    for problem in session.practice.problems:
        data = problem.model_dump(mode="json")
        if problem.outcome is None:
            data.pop("model_solution", None)
        problems.append(data)
    return {"active_problem_id": session.practice.active_problem_id, "problems": problems}


class PracticeService:
    def __init__(self, state: AppState):
        self.state = state

    @property
    def sessions(self):
        return self.state.sessions

    @staticmethod
    def _require_practice(session: SessionRecord, tool: str) -> None:
        if session.mode != "PRACTICE":
            raise SessionConflict(f"{tool} is a PRACTICE tool and this is a TEACH session.")

    def _session_titles(self) -> dict[str, str]:
        return {s.id: s.title for s in list_sessions(self.state.vault_path)}

    # ------------------------------------------------------------------ tools

    async def pose(self, session_id: str, statement: str, mode: str, model_solution: str,
                   target: list[str]) -> dict[str, Any]:
        """``problem``: register the active problem (non-blocking)."""
        if mode not in PRACTICE_MODES:
            raise SessionConflict(f"mode must be one of: {', '.join(PRACTICE_MODES)}.")
        if not statement.strip():
            raise SessionConflict("statement is empty; write the problem the learner will see.")
        if not model_solution.strip():
            raise SessionConflict("model_solution is empty; write the full worked solution before posing "
                                  "the problem (it stays hidden until conclude).")
        try:
            target_ids = resolve_targets(self.state.graph.nodes(), target)
        except ValueError as exc:
            raise SessionConflict(str(exc)) from exc
        await self.sessions.split_streaming(session_id)
        async with self.sessions.lock(session_id):
            session = self.sessions.get(session_id)
            self._require_practice(session, "problem")
            active = session.practice.active()
            if active is not None:
                raise SessionConflict(
                    f"Problem {active.id} is still active: wait for the learner's attempt and close it "
                    "with conclude before posing another problem."
                )
            problem = PracticeProblem(id=f"prob-{uuid4().hex[:12]}", statement=statement, mode=mode,
                                      target=target_ids, model_solution=model_solution, created_at=now())
            session.practice.problems.append(problem)
            session.practice.active_problem_id = problem.id
            self.sessions.save(session)
            self.sessions.refresh_lesson_note(session)
        return {
            "ok": True, "problem_id": problem.id, "target": target_ids,
            "next": "Problem presented. End your turn now and wait for the learner's attempt; "
                    "do not hint, solve or comment further.",
        }

    async def conclude(self, session_id: str, outcome: str, verdict: str, rung: str | None,
                       miss_class: str | None, retest: bool) -> dict[str, Any]:
        """``conclude``: close the active problem, log it and reveal its model solution."""
        if outcome not in AGENT_OUTCOMES:
            raise SessionConflict(f"outcome must be one of: {', '.join(AGENT_OUTCOMES)}.")
        if rung is not None and rung not in HINT_RUNGS:
            raise SessionConflict("rung must be the highest hint rung used (R0..R5) or null when no hint was given.")
        if miss_class is not None and miss_class not in MISS_CLASSES:
            raise SessionConflict(f"miss_class must be one of: {', '.join(MISS_CLASSES)}, or null.")
        await self.sessions.split_streaming(session_id)
        async with self.sessions.lock(session_id):
            session = self.sessions.get(session_id)
            self._require_practice(session, "conclude")
            problem = session.practice.active()
            if problem is None:
                raise SessionConflict(
                    "There is no active problem to conclude (it was already concluded or the learner "
                    "dismissed it). Pose a new one with problem only when the learner asks for it."
                )
            problem.outcome = outcome  # type: ignore[assignment]
            problem.verdict = verdict.strip()
            problem.rung = rung  # type: ignore[assignment]
            problem.miss_class = miss_class  # type: ignore[assignment]
            problem.retest = retest
            problem.concluded_at = now()
            session.practice.active_problem_id = None
            self.sessions.save(session)  # Authoritative commit precedes the derived log.
            append_practice_log(self.state.vault_path, PracticeLogEntry(
                at=problem.concluded_at, session_id=session.id, problem_id=problem.id, mode=problem.mode,
                target=problem.target, outcome=outcome, rung=rung, miss_class=miss_class, retest=retest,
            ))
            self.sessions.refresh_lesson_note(session)
        return {
            "ok": True, "problem_id": problem.id, "outcome": outcome, "model_solution_revealed": True,
            "next": "The model solution is now shown to the learner. Write your closing words and end your "
                    "turn; the next problem waits until the learner asks for it.",
        }

    def search(self, query: str, limit: int = 10) -> list[dict[str, str]]:
        """``graph_search``: read-only lookup over the propositions of the graph."""
        limit = max(1, min(int(limit), 50))
        return graph_search(self.state.graph.nodes(), self._session_titles(), query, limit)

    # ------------------------------------------------------------------ learner inputs

    @staticmethod
    def add_attempt(session: SessionRecord, text: str) -> PracticeProblem:
        """Append ``text`` to the active problem (the caller holds the session lock and saves)."""
        if session.mode != "PRACTICE":
            raise SessionConflict("Attempts only exist in PRACTICE sessions")
        problem = session.practice.active()
        if problem is None:
            raise SessionConflict("There is no active problem to attempt")
        problem.attempts.append(PracticeAttempt(at=now(), text=text))
        return problem

    async def dismiss(self, session_id: str) -> SessionRecord:
        """The learner's "Descartar problema": close it as ``dismissed`` without logging or running."""
        async with self.sessions.lock(session_id):
            session = self.sessions.get(session_id)
            if session.mode != "PRACTICE":
                raise SessionConflict("Only PRACTICE sessions have problems to dismiss")
            problem = session.practice.active()
            if problem is None:
                raise SessionConflict("There is no active problem to dismiss")
            problem.outcome = "dismissed"
            problem.concluded_at = now()
            session.practice.active_problem_id = None
            session.messages.append(SessionMessage(
                id=f"msg-{uuid4().hex}", role="system", content=DISMISS_NOTE, created_at=now(),
                practice_kind="dismiss", problem_id=problem.id,
            ))
            self.sessions.save(session)
            self.sessions.refresh_lesson_note(session)
        return session

    # ------------------------------------------------------------------ prompt

    def state_context(self, session: SessionRecord) -> dict[str, Any]:
        """Practice state for the agent (it wrote the model solutions, so it sees them)."""
        active = session.practice.active()
        return {
            "active_problem": active.model_dump(mode="json") if active else None,
            "problems": [{
                "id": p.id, "mode": p.mode, "target": p.target, "outcome": p.outcome, "rung": p.rung,
                "miss_class": p.miss_class, "retest": p.retest, "attempts": len(p.attempts),
            } for p in session.practice.problems],
        }

    def prompt_material(self, session: SessionRecord) -> str:
        """``RETEST QUEUE`` and, without graph context, ``SUGGESTED MATERIAL`` blocks."""
        nodes = self.state.graph.nodes()
        blocks = [format_retest_queue(retest_queue(load_practice_log(self.state.vault_path)), nodes)]
        if not session.graph_context:
            sessions = list_sessions(self.state.vault_path)  # Most recently updated first.
            recent = [s.id for s in sessions if s.mode == "TEACH"]
            titles = {s.id: s.title for s in sessions}
            blocks.append(format_suggested_material(suggested_nodes(nodes, recent), titles))
        return "\n\n".join(b for b in blocks if b)
