"""Background jobs dispatched from a turn (they return at once; results arrive as messages)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastmcp.exceptions import ToolError

from learnharness.mcp.tools.inputs import _required_text

# Background-job tools: toggle in config.agent.tools -> refusal when it is off.
_TOOL_OFF = {
    "research": "a pesquisa está desativada nas Configurações; siga sem ela.",
    "pdf": "a leitura de PDF está desativada nas Configurações; siga sem ela.",
    "visual": "os visuais estão desativados nas Configurações; siga sem eles, em prosa.",
    "demo": "as demos interativas estão desativadas nas Configurações; siga sem elas.",
}


def _require_tool(state, toggle: str) -> None:
    if not getattr(state.get_config().agent.tools, toggle):
        raise ToolError(_TOOL_OFF[toggle])




def _dispatched(record: dict[str, Any]) -> dict[str, Any]:
    from learnharness.services.jobs import DISPATCH_NOTE
    return {"ok": True, "job_id": record["job_id"], "status": record["status"], "note": DISPATCH_NOTE}

def build(state, session_id) -> list[Callable[..., Awaitable[Any]]]:
    async def spawn_demo(title: str, topic: str, description: str = "") -> dict[str, Any]:
        """Dispatch a lesson-specific interactive simulator as a background job; returns at once.

        Keep teaching: when the demo is ready (or fails) a message arrives on its own.
        """
        from learnharness.services.demos import submit_demo
        _require_tool(state, "demo")
        record = submit_demo(state, title, topic, description, session_id=session_id)
        return _dispatched(record)

    async def research(question: str, context: str = "") -> dict[str, Any]:
        """Dispatch web research with sources as a background job; returns at once (TEACH and PRACTICE).

        question: one precise, checkable question (a fact you are unsure of, a source to cite).
        context: optional, why it matters for this lesson. Keep teaching: the brief and its
        sources arrive on their own as a message; never wait for it or invent its result.
        """
        _require_tool(state, "research")
        question = _required_text(question, "question", "the question to research")
        record = state.jobs.dispatch(session_id, "research", {"question": question, "context": context or ""},
                                     label=question[:120])
        return _dispatched(record)

    async def read_pdf(path: str, question: str) -> dict[str, Any]:
        """Dispatch reading a PDF from the learner's vault as a background job; returns at once (TEACH and PRACTICE).

        path: vault-relative path of a .pdf (e.g. "Fontes/paper.pdf"); nothing outside the
        vault is readable. question: what to find in it. The relevant pages are triaged and
        read; the answer arrives on its own with pages cited as (p. N).
        """
        from learnharness.services.pdf_reader import PdfPathError, resolve_pdf
        _require_tool(state, "pdf")
        question = _required_text(question, "question", "what to look for in the PDF")
        try:
            _, rel = resolve_pdf(state.vault_path, path)
        except PdfPathError as exc:
            raise ToolError(str(exc)) from None
        record = state.jobs.dispatch(session_id, "pdf", {"path": rel, "question": question},
                                     label=f"{rel.rsplit('/', 1)[-1]}: {question[:80]}")
        return _dispatched(record)

    async def visual(brief: str) -> dict[str, Any]:
        """Dispatch a static figure (a self-contained SVG) for the current step; returns at once.

        brief: what the figure must show that prose cannot (elements, labels, relations,
        layout). It is inserted in the lesson when ready and a message tells you; until
        then, do not refer to it as visible.
        """
        _require_tool(state, "visual")
        brief = _required_text(brief, "brief", "what the figure must show")
        record = state.jobs.dispatch(session_id, "visual", {"brief": brief}, label=brief[:120])
        return _dispatched(record)

    return [spawn_demo, research, read_pdf, visual]
