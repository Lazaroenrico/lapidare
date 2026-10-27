"""Markdown export of a session transcript (Fase 12, ``GET /api/chats/{id}/markdown``).

ZERO I/O: renders a ``SessionRecord`` into one Markdown document: title, teaching prose,
questions with the learner's answers (confidence and reasoning), PRACTICE problems,
background-job cards (summarized) and the final plan.
"""

from __future__ import annotations

import re
from typing import Any

from learnharness.core.contracts.practice import PracticeProblem
from learnharness.core.contracts.quiz import CalibrationResult
from learnharness.core.contracts.session import SessionMessage, SessionRecord

_LABELS = {
    "pt-BR": {
        "mode": "Modo", "created": "Criada em", "learner": "Aluno", "question": "Pergunta",
        "answer": "Resposta", "dismissed": "dispensada", "dont_know": "Não sei",
        "confidence": "Confiança", "thinking": "Raciocínio", "reading": "Raciocínio durante a leitura",
        "correct": "correta", "incorrect": "incorreta", "grade": "Avaliação", "pending": "sem resposta",
        "problem": "Problema", "attempt": "Tentativa", "outcome": "Desfecho", "solution": "Solução-modelo",
        "verdict": "Veredito", "job": "Job", "plan": "Plano final", "summary": "Contexto resumido aqui",
        "next": "Próximo problema", "other": "Outro",
    },
    "en": {
        "mode": "Mode", "created": "Created", "learner": "Learner", "question": "Question",
        "answer": "Answer", "dismissed": "dismissed", "dont_know": "Don't know",
        "confidence": "Confidence", "thinking": "Reasoning", "reading": "Reasoning while reading",
        "correct": "correct", "incorrect": "incorrect", "grade": "Grade", "pending": "unanswered",
        "problem": "Problem", "attempt": "Attempt", "outcome": "Outcome", "solution": "Model solution",
        "verdict": "Verdict", "job": "Job", "plan": "Final plan", "summary": "Context summarized here",
        "next": "Next problem", "other": "Other",
    },
}


def _labels(language: str) -> dict[str, str]:
    return _LABELS["en" if language == "en" else "pt-BR"]


def _quote(text: str) -> str:
    return "\n".join(f"> {line}" if line else ">" for line in text.strip().splitlines())


def _answer(result: CalibrationResult, lang: dict[str, str]) -> str:
    lines = [f"**{lang['question']}:** {result.question}"]
    for i, choice in enumerate(result.choices):
        mark = "x" if i in result.chosen_indices else " "
        lines.append(f"- [{mark}] {choice.label}")
    if result.dismissed:
        lines.append(f"**{lang['answer']}:** _{lang['dismissed']}_")
        return "\n".join(lines)
    if result.is_dont_know:
        lines.append(f"**{lang['answer']}:** {lang['dont_know']}")
    if result.text:
        lines.append(f"**{lang['answer']}:**\n\n{_quote(result.text)}")
    if result.other_text:
        lines.append(f"**{lang['other']}:** {result.other_text}")
    if result.correct is not None and result.kind == "quiz":
        lines.append(f"**{lang['answer']}:** {lang['correct'] if result.correct else lang['incorrect']}")
    if result.confidence is not None:
        lines.append(f"**{lang['confidence']}:** {result.confidence}%")
    if result.learner_thinking:
        lines.append(f"**{lang['thinking']}:** {result.learner_thinking}")
    if result.reading_thinking:
        lines.append(f"**{lang['reading']}:** {result.reading_thinking}")
    if result.grade:
        feedback = f" — {result.grade_feedback}" if result.grade_feedback else ""
        lines.append(f"**{lang['grade']}:** {result.grade}{feedback}")
    return "\n".join(lines)


def _problem(problem: PracticeProblem, lang: dict[str, str]) -> str:
    parts = [f"### {lang['problem']} ({problem.mode})\n\n{problem.statement.strip()}"]
    for n, attempt in enumerate(problem.attempts, start=1):
        parts.append(f"**{lang['attempt']} {n}:**\n\n{_quote(attempt.text)}")
    if problem.outcome:
        outcome = f"**{lang['outcome']}:** {problem.outcome}"
        if problem.rung:
            outcome += f" ({problem.rung})"
        parts.append(outcome)
        if problem.verdict:
            parts.append(f"**{lang['verdict']}:** {problem.verdict}")
        if problem.outcome != "dismissed":
            parts.append(f"**{lang['solution']}:**\n\n{problem.model_solution.strip()}")
    return "\n\n".join(parts)


def _job(message: SessionMessage, lang: dict[str, str]) -> str:
    details: dict[str, Any] = message.details or {}
    kind = details.get("kind") or details.get("job_kind") or ""
    title = details.get("title") or details.get("label") or ""
    summary = details.get("summary") or details.get("result_summary") or message.content
    head = " · ".join(str(v) for v in (lang["job"], kind, title) if v)
    text = " ".join(str(summary).split())
    if len(text) > 600:
        text = text[:599] + "…"
    return _quote(f"**{head}**\n{text}")


def _plan(session: SessionRecord, lang: dict[str, str]) -> str:
    lines = [f"## {lang['plan']}"]
    if session.plan.approach_prose:
        lines.append(f"\n{session.plan.approach_prose.strip()}\n")
    for node in session.plan.nodes:
        deps = f" ← {', '.join(node.depends_on)}" if node.depends_on else ""
        lines.append(f"- **{node.label}** (`{node.id}`): {node.status}{deps}")
    return "\n".join(lines)


def _message(message: SessionMessage, session: SessionRecord, lang: dict[str, str]) -> str | None:
    if message.quiz_id:
        result = session.answers.get(message.quiz_id)
        return _answer(result, lang) if result else None
    if message.steer_kind == "job":
        return _job(message, lang)
    if message.role == "assistant":
        return message.content.strip() or None
    if message.role == "user":
        if message.practice_kind == "attempt":
            return None  # Rendered with its problem.
        if message.practice_kind == "next":
            return f"**{lang['learner']}:** _{lang['next']}_"
        return f"**{lang['learner']}:**\n\n{_quote(message.content)}"
    return None


def export_filename(title: str) -> str:
    stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", title).strip().strip(".") or "session"
    return " ".join(stem.split())[:120] + ".md"


def render_session_markdown(session: SessionRecord, language: str) -> str:
    lang = _labels(language)
    out = [f"# {session.title}", f"_{lang['mode']}: {session.mode} · {lang['created']}: {session.created_at}_"]
    problems = sorted(session.practice.problems, key=lambda p: p.created_at)
    pending = list(problems)
    cut = session.compaction.first_kept_message_id if session.compaction else None
    for message in session.messages:
        while pending and pending[0].created_at and pending[0].created_at <= message.created_at:
            out.append(_problem(pending.pop(0), lang))
        if message.id == cut:
            out.append(f"---\n\n_{lang['summary']}_")
        block = _message(message, session, lang)
        if block:
            out.append(block)
    out.extend(_problem(p, lang) for p in pending)
    if session.pending_quiz:
        out.append(f"**{lang['question']}:** {session.pending_quiz.question}\n_{lang['pending']}_")
    if session.plan.nodes:
        out.append(_plan(session, lang))
    return "\n\n".join(out).rstrip() + "\n"
