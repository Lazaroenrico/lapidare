"""PRACTICE: one problem at a time, its conclusion, and the learner's graph."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastmcp.exceptions import ToolError

from learnharness.core.contracts.practice import AgentOutcome, HintRung, MissClass, PracticeMode
from learnharness.core.latex_heal import heal_latex
from learnharness.mcp.tools.inputs import _flag, _optional_choice, _outcome, _rung, _targets


def build(state, session_id) -> list[Callable[..., Awaitable[Any]]]:
    async def problem(statement: str, mode: PracticeMode, model_solution: str,
                      target: list[str] | str | None = None) -> dict[str, Any]:
        """PRACTICE: pose exactly one problem; it does not block.

        statement: the problem as the learner sees it (never name the target idea).
        mode: recall | discrimination | composition. model_solution: your complete worked
        solution, written now; it stays hidden until conclude. target: graph proposition
        ids (n_...) or their exact names (resolved to ids), [] when none apply. Refused while
        another problem is active. After it succeeds, end your turn and wait for the attempt.
        """
        return await state.practice.pose(
            session_id, heal_latex(statement), str(mode).strip().casefold(), heal_latex(model_solution),
            _targets(target),
        )

    async def conclude(outcome: AgentOutcome, verdict: str, rung: HintRung | None = None,
                       miss_class: MissClass | None = None, retest: bool = False) -> dict[str, Any]:
        """PRACTICE: close the active problem and reveal its model solution.

        outcome: solved (no hints) | solvedWithHints | movedOn | surrendered. verdict: one
        sentence. rung: the highest hint rung used (R0..R5), null when none. miss_class:
        cue | discrimination | execution | careless | structural, null when nothing went
        wrong. retest: true to retest these targets later. Then write the closing words and
        end your turn; the next problem waits for the learner.
        """
        miss = _optional_choice(miss_class)
        return await state.practice.conclude(
            session_id, _outcome(outcome), heal_latex(verdict), _rung(rung),
            miss.casefold() if miss else None, _flag(retest),
        )

    async def graph_search(query: str, limit: int = 10) -> list[dict[str, str]]:
        """Read-only search of the learner's knowledge graph (TEACH and PRACTICE).

        Returns up to ``limit`` propositions as {id, name, statement, session_title},
        ranked by word overlap with ``query`` in name, statement and aliases.
        """
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            raise ToolError("limit must be an integer.") from None
        return state.practice.search(query, limit)

    return [problem, conclude, graph_search]
