"""Pure rendering of a session into the managed layout of its Obsidian lesson note.

Layout (every block below is a managed block, see ``markdown_ast.merge_owned_blocks``):

* frontmatter keys ``tags`` (ensures ``aula``/``lesson``), ``sessao``, ``topico``,
  ``fonte``, ``status``, ``atualizado``;
* ``**Objetivo:**`` line;
* ``## Diagnóstico``: prose produced before any plan existed;
* ``## Plano``: the PlanDag as a checklist (status, dependencies, ``[[Fonte#^pN]]``);
* ``## Mapa da fonte`` (dense sources only): Dito / Pressuposto / Pulado / Simplificações
  per block, citations rendered as ``[[<source stem>#^pN]]``;
* one ``## <node label>`` section per plan node holding the prose produced while that
  node was current, followed by the artifacts of background jobs dispatched while it was
  current (figure embed ``![[viz/visuals/<slug>.svg]]``, demo link, collapsible research
  or PDF callout ``> [!note]- ...``).

No I/O happens here; callers persist the result with ``sync_lesson_note``.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from pathlib import PurePosixPath
from typing import Any

from learnharness.core.contracts.session import NodeSpan, PlanDag, PlanNode, SessionRecord

# Flat strings, plus the ``modes``/``outcomes`` sub-maps of PRACTICE notes.
_LABELS: dict[str, dict[str, Any]] = {
    "pt-BR": {
        "objective": "Objetivo",
        "diagnosis": "Diagnóstico",
        "plan": "Plano",
        "map": "Mapa da fonte",
        "said": "Dito",
        "assumed": "Pressuposto",
        "skipped": "Pulado",
        "simplified": "Simplificações / Divergências",
        "refs": "Trechos",
        "current": "em curso",
        "review": "revisar",
        "depends": "depende de",
        "tag": "aula",
        "in_progress": "em andamento",
        "done": "concluída",
        "free": "livre",
        "track": "trilha",
        "drawing": "desenho",
        "untitled": "Sessão",
        "practice": "Prática",
        "practice_tag": "prática",
        "problem": "Problema",
        "attempts": "Tentativas",
        "outcome": "Desfecho",
        "rung": "Degrau",
        "miss": "Erro",
        "retest": "reteste",
        "verdict": "Veredito",
        "solution": "Solução-modelo",
        "active": "em aberto",
        "targets": "Alvos",
        "modes": {"recall": "evocação", "discrimination": "discriminação", "composition": "composição"},
        "outcomes": {"solved": "resolvido", "solvedWithHints": "resolvido com dicas", "movedOn": "seguiu adiante",
                     "surrendered": "desistiu", "dismissed": "descartado"},
    },
    "en": {
        "objective": "Goal",
        "diagnosis": "Diagnosis",
        "plan": "Plan",
        "map": "Source map",
        "said": "Said",
        "assumed": "Assumed",
        "skipped": "Skipped",
        "simplified": "Simplifications / Divergences",
        "refs": "Passages",
        "current": "current",
        "review": "review",
        "depends": "depends on",
        "tag": "lesson",
        "in_progress": "in progress",
        "done": "completed",
        "free": "free",
        "track": "track",
        "drawing": "drawing",
        "untitled": "Session",
        "practice": "Practice",
        "practice_tag": "practice",
        "problem": "Problem",
        "attempts": "Attempts",
        "outcome": "Outcome",
        "rung": "Rung",
        "miss": "Miss",
        "retest": "retest",
        "verdict": "Verdict",
        "solution": "Model solution",
        "active": "open",
        "targets": "Targets",
        "modes": {"recall": "recall", "discrimination": "discrimination", "composition": "composition"},
        "outcomes": {"solved": "solved", "solvedWithHints": "solved with hints", "movedOn": "moved on",
                     "surrendered": "surrendered", "dismissed": "dismissed"},
    },
}

# Characters Obsidian (or the OS) rejects in file names or that break wikilinks.
_FORBIDDEN = re.compile(r'[\\/:*?"<>|#^\[\]\x00-\x1f\x7f]')
_PLACEHOLDER_CITE = re.compile(r"\[\[(?:Fonte|Fontes|Source|Sources)?#\^(p\d+)(?:\|[^\]]*)?\]\]")
_BARE_REF = re.compile(r"(?<![#\w\[^])\^(p\d+)\b")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def labels(language: str) -> dict[str, Any]:
    return _LABELS["en" if language == "en" else "pt-BR"]


def sanitize_note_title(title: str, max_length: int = 80) -> str:
    """Readable, filesystem- and wikilink-safe note title (may be empty)."""
    text = unicodedata.normalize("NFC", title)
    text = _FORBIDDEN.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip().strip(".").strip()
    if len(text) > max_length:
        cut = text[:max_length]
        text = (cut.rsplit(" ", 1)[0] if " " in cut else cut).rstrip(" .-")
    return text


def lesson_note_stem(title: str, day: date, language: str = "pt-BR", mode: str = "TEACH") -> str:
    """``<YYYY-MM-DD> <Título legível>`` (PRACTICE: ``<YYYY-MM-DD> Prática — <Título>``).

    Collision suffixes are added by the caller.
    """
    lang = labels(language)
    readable = sanitize_note_title(title) or lang["untitled"]
    if mode == "PRACTICE":
        return f"{day.isoformat()} {lang['practice']} — {readable}"
    return f"{day.isoformat()} {readable}"


def heading_text(label: str) -> str:
    return sanitize_note_title(label, max_length=200) or "—"


def source_stem(session: SessionRecord) -> str | None:
    if not session.source_path:
        return None
    return PurePosixPath(session.source_path.replace("\\", "/")).stem or None


def _ref(value: str) -> str:
    return value.strip().lstrip("#").lstrip("^")


def cite(stem: str | None, ref: str) -> str:
    return f"[[{stem}#^{_ref(ref)}]]" if stem else f"^{_ref(ref)}"


def normalize_citations(text: str, stem: str | None, *, bare: bool = False) -> str:
    """Point placeholder citations (``[[Fonte#^pN]]``) at the real source note."""
    if not stem:
        return text
    text = _PLACEHOLDER_CITE.sub(lambda m: cite(stem, m.group(1)), text)
    if bare:
        text = _BARE_REF.sub(lambda m: cite(stem, m.group(1)), text)
    return text


def balance_fences(text: str) -> str:
    """Close a code fence left open by a partially streamed message."""
    fence = None
    for line in text.splitlines():
        match = _FENCE.match(line)
        if not match:
            continue
        run = match.group(1)
        if fence is None:
            fence = run
        elif run[0] == fence[0] and len(run) >= len(fence):
            fence = None
    return f"{text.rstrip()}\n{fence}" if fence else text


def current_node_id(plan: PlanDag) -> str | None:
    """The node prose is attributed to: explicit ``current``, else the frontier, else the sink."""
    if not plan.nodes:
        return None
    for node in plan.nodes:
        if node.status == "current":
            return node.id
    mastered = {n.id for n in plan.nodes if n.status == "mastered"}
    for node in plan.nodes:
        if node.status != "mastered" and all(dep in mastered for dep in node.depends_on):
            return node.id
    return plan.nodes[-1].id


def prose_by_node(session: SessionRecord) -> dict[str | None, str]:
    """Assistant prose grouped by the plan node that was current when it was produced."""
    known = {n.id for n in session.plan.nodes}
    chunks: dict[str | None, list[str]] = {}
    for message in session.messages:
        if message.role != "assistant":
            continue
        spans = sorted(message.node_spans, key=lambda s: s.start)
        if not spans or spans[0].start > 0:
            spans.insert(0, NodeSpan(start=0, node_id=message.node_id))
        for i, span in enumerate(spans):
            end = spans[i + 1].start if i + 1 < len(spans) else len(message.content)
            text = message.content[span.start:end].strip()
            if text:
                node = span.node_id if span.node_id in known else None
                chunks.setdefault(node, []).append(text)
    return {node: "\n\n".join(parts) for node, parts in chunks.items()}


def _bullets(items: list[str], stem: str | None) -> str:
    clean = [normalize_citations(i.strip(), stem, bare=True) for i in items if i.strip()]
    return "".join(f"\n  - {item}" for item in clean) if clean else " —"


def _node_refs(node: PlanNode) -> list[str]:
    refs = list(node.source_paragraphs)
    if node.four_dimensions:
        refs += node.four_dimensions.paragraph_refs
    return list(dict.fromkeys(_ref(r) for r in refs if _ref(r)))


_ANY_REF = re.compile(r"\^(p\d+)\b")


def plan_paragraph_refs(node: PlanNode) -> list[str]:
    """Every paragraph id a node cites (``pN``), including those inside the 4 dimensions."""
    refs = _node_refs(node)
    dims = node.four_dimensions
    if dims is not None:
        for text in [dims.said, *dims.assumed, *dims.skipped, *dims.simplifications]:
            refs += _ANY_REF.findall(text)
    return list(dict.fromkeys(refs))


def render_plan(plan: PlanDag, stem: str | None, with_sections: set[str], lang: dict[str, str]) -> str:
    by_id = {n.id: n for n in plan.nodes}
    lines = [f"## {lang['plan']}", ""]
    if plan.approach_prose.strip():
        lines += [normalize_citations(plan.approach_prose.strip(), stem), ""]
    for node in plan.nodes:
        title = heading_text(node.label)
        label = f"[[#{title}|{title}]]" if node.id in with_sections else title
        line = f"- [{'x' if node.status == 'mastered' else ' '}] {label}"
        if node.status == "current":
            line += f" — *{lang['current']}*"
        elif node.status == "needs_review":
            line += f" — *{lang['review']}*"
        deps = [heading_text(by_id[d].label) for d in node.depends_on if d in by_id]
        if deps:
            line += f" ({lang['depends']}: {', '.join(deps)})"
        refs = [cite(stem, r) for r in node.source_paragraphs if _ref(r)]
        if refs:
            line += " · " + " ".join(refs)
        lines.append(line)
    return "\n".join(lines)


def render_dense_map(plan: PlanDag, stem: str | None, lang: dict[str, Any]) -> str | None:
    nodes = [(n, n.four_dimensions) for n in plan.nodes if n.four_dimensions is not None]
    if not nodes:
        return None
    parts = [f"## {lang['map']}"]
    for node, dims in nodes:
        said = normalize_citations(dims.said.strip(), stem, bare=True) or "—"
        block = [
            "",
            f"### {heading_text(node.label)}",
            f"- **{lang['said']}:** {said}",
            f"- **{lang['assumed']}:**{_bullets(dims.assumed, stem)}",
            f"- **{lang['skipped']}:**{_bullets(dims.skipped, stem)}",
            f"- **{lang['simplified']}:**{_bullets(dims.simplifications, stem)}",
        ]
        refs = _node_refs(node)
        if refs:
            block.append(f"- **{lang['refs']}:** " + " · ".join(cite(stem, r) for r in refs))
        parts += block
    return "\n".join(parts)


def frontmatter_for(session: SessionRecord, language: str) -> tuple[dict[str, object], list[str]]:
    lang = labels(language)
    stem = source_stem(session)
    if stem and session.source_path and not PurePosixPath(session.source_path).is_absolute():
        fonte = f"[[{stem}]]"
    elif stem:
        fonte = stem
    elif session.context_kind == "track_step":
        fonte = lang["track"]
    elif session.context_kind == "drawing_review":
        fonte = lang["drawing"]
    else:
        fonte = lang["free"]
    status = lang["done"] if session.phase == "completed" else lang["in_progress"]
    managed: dict[str, object] = {"sessao": session.id, "topico": session.title, "fonte": fonte, "status": status}
    return managed, [lang["practice_tag"] if session.mode == "PRACTICE" else lang["tag"]]


_ARTIFACT_LABELS = {
    "pt-BR": {"research": "Pesquisa", "read_pdf": "PDF", "demo": "Simulador Interativo", "sources": "Fontes",
              "pages": "páginas lidas"},
    "en": {"research": "Research", "read_pdf": "PDF", "demo": "Interactive simulator", "sources": "Sources",
           "pages": "pages read"},
}


def _callout(header: str, body: str) -> str:
    lines = [header] + [f"> {line}" if line.strip() else ">" for line in body.strip().splitlines()]
    return "\n".join(lines)


def _flat(text: object) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def render_job_artifact(details: dict[str, Any], language: str) -> str | None:
    """Markdown for one finished background job (``steer_kind == "job"``, status ``done``)."""
    words = _ARTIFACT_LABELS["en" if language == "en" else "pt-BR"]
    result: dict[str, Any] = details.get("result") or {}
    kind = details.get("kind")
    if kind == "visual" and result.get("path"):
        caption = _flat(result.get("title"))
        embed = f"![[{result['path']}]]"
        return f"{embed}\n*{caption}*" if caption else embed
    if kind == "demo" and result.get("slug"):
        title = _flat(result.get("title")) or result["slug"]
        path = result.get("rel_path") or f"viz/demos/{result['slug']}.html"
        return f"[[{path}|{words['demo']}: {title}]]"
    if kind == "research" and result.get("brief"):
        found: list[dict[str, Any]] = result.get("sources") or []
        sources = "\n".join(f"- [{_flat(s.get('title')) or s.get('url')}]({s.get('url')})"
                            for s in found if s.get("url"))
        body = result["brief"] + (f"\n\n**{words['sources']}:**\n{sources}" if sources else "")
        return _callout(f"> [!note]- {words['research']}: {_flat(result.get('question') or details.get('label'))}",
                        body)
    if kind == "read_pdf" and result.get("answer"):
        read: list[Any] = result.get("pages_read") or []
        pages = ", ".join(str(p) for p in read)
        header = f"> [!note]- {words['read_pdf']}: {_flat(result.get('file'))} — {_flat(result.get('question'))}"
        body = result["answer"] + (f"\n\n*{words['pages']}: {pages}*" if pages else "")
        return _callout(header, body)
    return None


def job_artifacts_by_node(session: SessionRecord, language: str) -> dict[str | None, list[str]]:
    """Finished job artifacts grouped by the plan node that was current when dispatched."""
    known = {n.id for n in session.plan.nodes}
    grouped: dict[str | None, list[str]] = {}
    for message in session.messages:
        details = message.details or {}
        if message.steer_kind != "job" or details.get("status") != "done":
            continue
        markdown = render_job_artifact(details, language)
        if markdown:
            node = details.get("node_id") if details.get("node_id") in known else None
            grouped.setdefault(node, []).append(markdown)
    return grouped


def _with_artifacts(body: str, artifacts: list[str]) -> str:
    return "\n\n".join(part for part in [body, *artifacts] if part)


def render_lesson_blocks(session: SessionRecord, language: str) -> list[tuple[str, str]]:
    """Ordered managed blocks ``(key, markdown)`` for the lesson note."""
    if session.mode == "PRACTICE":
        return render_practice_blocks(session, language)
    lang = labels(language)
    stem = source_stem(session)
    prose = prose_by_node(session)
    artifacts = job_artifacts_by_node(session, language)
    blocks: list[tuple[str, str]] = [("lesson:v2:objective", f"**{lang['objective']}:** {session.title}")]
    if prose.get(None) or artifacts.get(None):
        body = balance_fences(normalize_citations(prose.get(None, ""), stem))
        body = _with_artifacts(body, artifacts.get(None, []))
        blocks.append(("lesson:v2:diagnosis", f"## {lang['diagnosis']}\n\n{body}"))
    if session.plan.nodes:
        with_sections = {n.id for n in session.plan.nodes if prose.get(n.id) or artifacts.get(n.id)}
        blocks.append(("lesson:v2:plan", render_plan(session.plan, stem, with_sections, lang)))
        if session.context_kind == "dense_source":
            dense = render_dense_map(session.plan, stem, lang)
            if dense:
                blocks.append(("lesson:v2:dense-map", dense))
        for node in session.plan.nodes:
            if node.id in with_sections:
                body = balance_fences(normalize_citations(prose.get(node.id, ""), stem))
                body = _with_artifacts(body, artifacts.get(node.id, []))
                blocks.append((f"lesson:v2:node:{node.id}", f"## {heading_text(node.label)}\n\n{body}"))
    return blocks


def _summary(text: str, limit: int = 280) -> str:
    flat = re.sub(r"\s+", " ", text).strip()
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def render_practice_blocks(session: SessionRecord, language: str) -> list[tuple[str, str]]:
    """PRACTICE note: the objective plus one managed section per problem.

    Each section holds the statement, summarized attempts and, once concluded, the
    outcome, rung, miss class, verdict and the model solution (hidden while open).
    """
    lang = labels(language)
    blocks: list[tuple[str, str]] = [("lesson:v2:objective", f"**{lang['objective']}:** {session.title}")]
    for index, problem in enumerate(session.practice.problems, start=1):
        mode = lang["modes"].get(problem.mode, problem.mode)
        parts = [f"## {lang['problem']} {index} — {mode}", "", balance_fences(problem.statement.strip())]
        if problem.target:
            parts += ["", f"**{lang['targets']}:** " + ", ".join(f"`{t}`" for t in problem.target)]
        if problem.attempts:
            parts += ["", f"**{lang['attempts']}:**"]
            parts += [f"- {_summary(a.text)}" for a in problem.attempts]
        if problem.outcome is None:
            parts += ["", f"**{lang['outcome']}:** *{lang['active']}*"]
        else:
            line = f"**{lang['outcome']}:** {lang['outcomes'].get(problem.outcome, problem.outcome)}"
            if problem.rung:
                line += f" · **{lang['rung']}:** {problem.rung}"
            if problem.miss_class:
                line += f" · **{lang['miss']}:** {problem.miss_class}"
            if problem.retest:
                line += f" · *{lang['retest']}*"
            parts += ["", line]
            if problem.verdict.strip():
                parts += ["", f"**{lang['verdict']}:** {problem.verdict.strip()}"]
            parts += ["", f"**{lang['solution']}:**", "", balance_fences(problem.model_solution.strip())]
        blocks.append((f"practice:v1:problem:{problem.id}", "\n".join(parts)))
    return blocks


def legacy_message_blocks(session: SessionRecord) -> dict[str, str | None]:
    """Blocks written by the pre-v2 layout (one ``### msg-<hex>`` block per message).

    Mapped to the exact markdown that layout last wrote, so untouched ones are removed
    and edited ones are kept as user text.
    """
    legacy: dict[str, str | None] = {"lesson:objective": f"**Objetivo:** {session.title}"}
    for message in session.messages:
        if message.role == "assistant":
            legacy[f"lesson:node:{message.id}"] = f"### {message.id}\n{message.content}"
    return legacy
