"""Pure PRACTICE helpers (Fase 9): graph search, target resolution, retest queue, prompt blocks.

No I/O: callers load nodes, sessions and the practice log and pass them in.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping

from learnharness.core.contracts.graph import PropositionNode
from learnharness.core.contracts.practice import PracticeLogEntry

MAX_RETEST_QUEUE = 20
MAX_SUGGESTED = 20
_TOKEN = re.compile(r"[a-z0-9]+")


def fold_text(text: str) -> str:
    """Casefolded text without diacritics (``Atenção`` -> ``atencao``)."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def tokens(text: str) -> set[str]:
    return {t for t in _TOKEN.findall(fold_text(text)) if len(t) > 1 or t.isdigit()}


def graph_search(
    nodes: Mapping[str, PropositionNode], session_titles: Mapping[str, str], query: str, limit: int = 10
) -> list[dict[str, str]]:
    """Propositions ranked by token overlap with ``query`` in name, statement and aliases.

    Name/alias hits weigh twice a statement hit; ties go to the shorter name, then the id.
    """
    wanted = tokens(query)
    if not wanted or limit <= 0:
        return []
    scored: list[tuple[int, str, str, PropositionNode]] = []
    for node in nodes.values():
        label = tokens(" ".join([node.name, *node.aliases]))
        body = tokens(node.statement)
        score = 2 * len(wanted & label) + len(wanted & body)
        if score:
            scored.append((-score, node.name, node.id, node))
    scored.sort(key=lambda item: (item[0], len(item[1]), item[2]))
    results = []
    for _, _, _, node in scored[:limit]:
        birth = node.provenance[0].session_id if node.provenance else ""
        results.append({"id": node.id, "name": node.name, "statement": node.statement,
                        "session_title": session_titles.get(birth, "")})
    return results


def resolve_targets(nodes: Mapping[str, PropositionNode], targets: Iterable[str]) -> list[str]:
    """Graph ids for ``targets`` (ids, or exact names/aliases ignoring case and accents).

    Raises ``ValueError`` with corrective text for unknown or ambiguous targets.
    """
    by_label: dict[str, list[str]] = {}
    for node in nodes.values():
        for label in {node.name, *node.aliases}:
            by_label.setdefault(fold_text(label).strip(), []).append(node.id)
    resolved: list[str] = []
    for raw in targets:
        target = raw.strip()
        if not target:
            continue
        if target in nodes:
            node_id = target
        else:
            matches = list(dict.fromkeys(by_label.get(fold_text(target), [])))
            if not matches:
                raise ValueError(
                    f"Unknown target {target!r}: use graph node ids (n_...) or exact proposition names "
                    "from the practice material or graph_search; pass target=[] when the problem has no "
                    "graph proposition."
                )
            if len(matches) > 1:
                raise ValueError(f"Target {target!r} is ambiguous; use one of the ids: {', '.join(matches)}.")
            node_id = matches[0]
        if node_id not in resolved:
            resolved.append(node_id)
    return resolved


def retest_queue(entries: Iterable[PracticeLogEntry]) -> list[PracticeLogEntry]:
    """Concluded problems flagged ``retest`` with no later ``solved`` covering the same targets.

    A later ``solved`` (without its own retest flag) clears every pending entry whose
    non-empty target set it covers. Oldest first, at most ``MAX_RETEST_QUEUE`` (the newest).
    """
    pending: list[PracticeLogEntry] = []
    for entry in sorted(entries, key=lambda e: e.at):
        if entry.retest:
            pending.append(entry)
        elif entry.outcome == "solved" and entry.target:
            covered = set(entry.target)
            pending = [p for p in pending if not (p.target and set(p.target) <= covered)]
    return pending[-MAX_RETEST_QUEUE:]


def _target_list(target: list[str], nodes: Mapping[str, PropositionNode]) -> str:
    if not target:
        return "(no graph target)"
    return ", ".join(f"[{t}] {nodes[t].name}" if t in nodes else f"[{t}]" for t in target)


def format_retest_queue(queue: list[PracticeLogEntry], nodes: Mapping[str, PropositionNode]) -> str:
    """``RETEST QUEUE`` prompt block ("" when empty)."""
    if not queue:
        return ""
    lines = ["RETEST QUEUE (problems that went wrong earlier and still need a retest; retest these "
             "targets near the end of the session with a new surface and context):"]
    for e in queue:
        lines.append(
            f"- targets: {_target_list(e.target, nodes)} · mode: {e.mode} · outcome: {e.outcome} · "
            f"rung: {e.rung or 'none'} · miss_class: {e.miss_class or 'none'} · date: {e.at[:10]}"
        )
    return "\n".join(lines)


def suggested_nodes(
    nodes: Mapping[str, PropositionNode], recent_teach_session_ids: list[str], limit: int = MAX_SUGGESTED
) -> list[PropositionNode]:
    """Propositions taught in the most recent TEACH sessions (most recent session first)."""
    rank = {sid: i for i, sid in enumerate(recent_teach_session_ids)}
    picked = [(min(rank[p.session_id] for p in n.provenance if p.session_id in rank), n.created_at, n)
              for n in nodes.values() if any(p.session_id in rank for p in n.provenance)]
    picked.sort(key=lambda item: (item[0], item[1]))
    return [n for _, _, n in picked[:limit]]


def format_suggested_material(selected: list[PropositionNode], session_titles: Mapping[str, str]) -> str:
    """``SUGGESTED MATERIAL`` prompt block ("" when empty)."""
    if not selected:
        return ""
    lines = ["SUGGESTED MATERIAL (the learner picked no graph context; these propositions come from "
             "their most recent TEACH sessions; practice on them unless the learner asked for something "
             "else):"]
    for n in selected:
        birth = n.provenance[0].session_id if n.provenance else ""
        title = session_titles.get(birth, "")
        lines.append(f"[{n.id}] {n.name}: {n.statement}" + (f" (session: {title})" if title else ""))
    return "\n".join(lines)
