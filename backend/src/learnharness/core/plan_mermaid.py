"""Mermaid plan authoring: parse, validate and derive the lesson DAG. Pure, zero I/O.

The teacher writes the session map as a small mermaid flowchart; ``plan_init`` turns it
into ``PlanNode``s. Accepted subset::

    graph TD                      (or flowchart; TD | TB | LR | BT | RL, any case)
    %% comment
    slug                          bare id (title = id)
    slug[Title]  slug["Title"]  slug("Title")  slug(Title)
    a --> b      a ==> b      a -.-> b      a -->|note| b   (a is a prerequisite of b)
    a --> b --> c                 chains expand to consecutive pairs

Ids are permanent lowercase slugs: questions reference them via ``node_id`` and a
re-plan keeps the progress of every id it keeps. Every problem is reported with its
1-based line number so the model can fix the block and retry.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from learnharness.core.contracts.session import PlanNode, PlanNodeStatus

SLUG_RE = re.compile(r"^[a-z0-9]+([-_][a-z0-9]+)*$")
_HEADER_RE = re.compile(r"^(graph|flowchart)\s+(td|tb|lr|rl|bt)\s*;?\s*$", re.IGNORECASE)
_ARROW_RE = re.compile(r"\s*(?:-->|==>|-\.->)(?:\|[^|]*\|)?\s*")
# Broad id class on purpose: a bad id reaches the specific slug message, not a generic one.
_ENDPOINT_RE = re.compile(
    r"""^(?P<id>[^\s()\[\]"]+)\s*(?:\[(?P<sq>[^\[\]]*)\]|\(\s*"(?P<dq>[^"]*)"\s*\)|\((?P<par>[^()]*)\))?$"""
)
STICKY_STATUSES: frozenset[str] = frozenset({"mastered", "needs_review"})


class PlanSyntaxError(ValueError):
    """The mermaid block is not a valid plan; ``problems`` lists every issue found."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("\n".join(problems))


@dataclass(frozen=True)
class MermaidNode:
    id: str
    label: str
    line: int
    labeled: bool = True


@dataclass(frozen=True)
class MermaidEdge:
    source: str
    target: str
    line: int


def _endpoint(text: str) -> tuple[str, str] | None:
    match = _ENDPOINT_RE.match(text.strip())
    if not match:
        return None
    label = next((g for g in (match["sq"], match["dq"], match["par"]) if g is not None), "").strip()
    if len(label) >= 2 and label[0] == label[-1] and label[0] in "\"'":
        label = label[1:-1].strip()
    return match["id"], label


def parse_mermaid_plan(text: str) -> tuple[list[MermaidNode], list[MermaidEdge]]:
    """Parse the mermaid subset into declared nodes and edges (syntax only).

    Every node mention is returned (bare references with ``labeled=False``); edges are
    returned as written, duplicates included, so ``validate_plan`` can point at them.
    Raises ``PlanSyntaxError`` with every problem found.
    """
    problems: list[str] = []
    nodes: list[MermaidNode] = []
    edges: list[MermaidEdge] = []
    lines = (text or "").splitlines()
    header_seen = False
    for number, raw in enumerate(lines, start=1):
        line = raw.strip().rstrip(";").strip()
        if not line or line.startswith("%%") or line.startswith("```"):
            continue  # Blank, comment, or a markdown fence the model wrapped around the block.
        if not header_seen:
            header_seen = True
            if _HEADER_RE.match(line):
                continue
            problems.append(f"line {number}: expected the header `graph TD` (or `flowchart TD`), got `{line}`.")
            continue
        if _HEADER_RE.match(line):
            problems.append(f"line {number}: only one `graph TD` header is allowed.")
            continue
        segments = _ARROW_RE.split(line)
        endpoints: list[tuple[str, str]] = []
        for segment in segments:
            parsed = _endpoint(segment)
            if parsed is None:
                expected = (
                    "`a[Title] --> b[Title]` (chains like `a --> b --> c` are fine)"
                    if len(segments) > 1
                    else "a node `slug[Title]` or an edge `a --> b`; subgraphs, styles and classes are not supported"
                )
                problems.append(f"line {number}: cannot read `{line}`; expected {expected}.")
                endpoints = []
                break
            endpoints.append(parsed)
        for node_id, label in endpoints:
            if not SLUG_RE.match(node_id):
                problems.append(
                    f"line {number}: node id `{node_id}` must be a lowercase slug (a-z, 0-9 joined by `-` or `_`, "
                    "e.g. `chain-rule`); ids are permanent and questions reference them."
                )
                continue
            nodes.append(MermaidNode(node_id, label or node_id, number, labeled=bool(label)))
        if len(endpoints) > 1 and all(SLUG_RE.match(e[0]) for e in endpoints):
            edges.extend(
                MermaidEdge(endpoints[i][0], endpoints[i + 1][0], number) for i in range(len(endpoints) - 1)
            )
    if not header_seen:
        problems.append("line 1: the plan is empty; expected a `graph TD` block with nodes and `-->` edges.")
    if problems:
        raise PlanSyntaxError(problems)
    return nodes, edges


def validate_plan(nodes: Iterable[MermaidNode], edges: Iterable[MermaidEdge]) -> list[MermaidNode]:
    """Check structure and return one node per id, in first-mention order.

    Rejects: an id given two different titles, edges to undeclared ids, self-loops,
    duplicate edges and cycles. Raises ``PlanSyntaxError``.
    """
    problems: list[str] = []
    unique: dict[str, MermaidNode] = {}
    for node in nodes:
        known = unique.get(node.id)
        if known is None or (node.labeled and not known.labeled):
            unique[node.id] = node if known is None else MermaidNode(node.id, node.label, known.line, True)
        elif node.labeled and known.labeled and node.label != known.label:
            problems.append(
                f"line {node.line}: duplicate node id `{node.id}` (already titled `{known.label}` on line {known.line}); "
                "give each node one title."
            )
    edges = list(edges)
    seen: dict[tuple[str, str], int] = {}
    for edge in edges:
        for end in (edge.source, edge.target):
            if end not in unique:
                problems.append(f"line {edge.line}: edge endpoint `{end}` is not a declared node.")
        if edge.source == edge.target:
            problems.append(f"line {edge.line}: self-loop `{edge.source} --> {edge.target}`; a node cannot require itself.")
        elif (edge.source, edge.target) in seen:
            problems.append(
                f"line {edge.line}: duplicate edge `{edge.source} --> {edge.target}` (already on line {seen[(edge.source, edge.target)]})."
            )
        else:
            seen[(edge.source, edge.target)] = edge.line
    if not unique:
        problems.append("line 1: no nodes found; the plan needs at least one node.")
    if problems:
        raise PlanSyntaxError(problems)
    cycle = _find_cycle(list(unique), [(e.source, e.target, e.line) for e in edges])
    if cycle:
        path, line = cycle
        raise PlanSyntaxError([f"line {line}: cycle {' --> '.join(path)}; the plan must be acyclic."])
    return list(unique.values())


def _find_cycle(ids: list[str], edges: list[tuple[str, str, int]]) -> tuple[list[str], int] | None:
    children: dict[str, list[tuple[str, int]]] = {i: [] for i in ids}
    for source, target, line in edges:
        children[source].append((target, line))
    state: dict[str, int] = {}  # 1 = on stack, 2 = done
    stack: list[str] = []

    def visit(node: str) -> tuple[list[str], int] | None:
        state[node] = 1
        stack.append(node)
        for child, line in children[node]:
            if state.get(child) == 1:
                return [*stack[stack.index(child):], child], line
            if child not in state:
                found = visit(child)
                if found:
                    return found
        stack.pop()
        state[node] = 2
        return None

    for node in ids:
        if node not in state:
            found = visit(node)
            if found:
                return found
    return None


def mermaid_to_plan_nodes(
    text: str,
    previous: Iterable[PlanNode] = (),
    details: Mapping[str, Mapping[str, object]] | None = None,
) -> list[PlanNode]:
    """Parse + validate ``text`` into ``PlanNode``s in topological order.

    ``depends_on`` comes from the edges, ``kind`` is derived (no prerequisites:
    ``unconditional_truth``; no dependents: ``goal``; else ``derived_step``), ``mastered``
    / ``needs_review`` of ids kept from ``previous`` survive, and ``details`` maps an id to
    extra ``PlanNode`` fields (``source_paragraphs``, ``four_dimensions``).
    """
    raw_nodes, edges = parse_mermaid_plan(text)
    nodes = validate_plan(raw_nodes, edges)
    details = details or {}
    unknown = sorted(set(details) - {n.id for n in nodes})
    if unknown:
        raise PlanSyntaxError([
            f"node_details references unknown ids {unknown}; valid ids: {[n.id for n in nodes]}."
        ])
    parents: dict[str, list[str]] = {n.id: [] for n in nodes}
    has_children: set[str] = set()
    for edge in edges:
        if edge.source not in parents[edge.target]:
            parents[edge.target].append(edge.source)
        has_children.add(edge.source)
    kept = {n.id: n.status for n in previous if n.status in STICKY_STATUSES}
    ordered: list[PlanNode] = []
    placed: set[str] = set()
    remaining = list(nodes)
    while remaining:  # Kahn's algorithm with first-mention order as the tie-break.
        ready = next(n for n in remaining if all(p in placed for p in parents[n.id]))
        remaining.remove(ready)
        placed.add(ready.id)
        kind = (
            "unconditional_truth" if not parents[ready.id]
            else "goal" if ready.id not in has_children
            else "derived_step"
        )
        ordered.append(PlanNode.model_validate({
            **dict(details.get(ready.id, {})),
            "id": ready.id, "label": ready.label, "kind": kind,
            "depends_on": parents[ready.id], "status": kept.get(ready.id, "pending"),
        }))
    return ordered


def derive_plan_statuses(nodes: Iterable[PlanNode], question_node_ids: Iterable[str | None]) -> dict[str, PlanNodeStatus]:
    """Status per node: sticky ``mastered`` / ``needs_review`` first, then derived.

    ``current`` is the node of the most recent quiz/explain carrying a ``node_id``
    (``question_node_ids`` is oldest-first), ``visited`` the nodes of earlier ones and
    ``pending`` the rest.
    """
    asked = [n for n in question_node_ids if n]
    current = asked[-1] if asked else None
    visited = set(asked)
    statuses: dict[str, PlanNodeStatus] = {}
    for node in nodes:
        if node.status in STICKY_STATUSES:
            statuses[node.id] = node.status
        elif node.id == current:
            statuses[node.id] = "current"
        elif node.id in visited:
            statuses[node.id] = "visited"
        else:
            statuses[node.id] = "pending"
    return statuses
