"""Mermaid plan parser, validator and derived statuses (core.plan_mermaid, pure)."""

import pytest

from learnharness.core.contracts.session import PlanNode
from learnharness.core.plan_mermaid import (
    PlanSyntaxError,
    derive_plan_statuses,
    mermaid_to_plan_nodes,
    parse_mermaid_plan,
    validate_plan,
)


def test_parses_the_supported_subset() -> None:
    text = """```mermaid
%% the learner already holds ratios
flowchart LR
  ratio[Ratios compare quantities]
  slope("Slope is a ratio of changes")
  limit(Limits) ==> derivative["Derivative"]
  ratio --> slope -.-> derivative
  limit -->|needs| slope
  standalone_fact
```"""
    nodes = mermaid_to_plan_nodes(text)
    by_id = {n.id: n for n in nodes}
    assert by_id["ratio"].label == "Ratios compare quantities"
    assert by_id["slope"].label == "Slope is a ratio of changes"
    assert by_id["limit"].label == "Limits"
    assert by_id["derivative"].label == "Derivative"
    assert by_id["standalone_fact"].label == "standalone_fact"
    assert sorted(by_id["derivative"].depends_on) == ["limit", "slope"]
    assert sorted(by_id["slope"].depends_on) == ["limit", "ratio"]
    # kind derives from the edges: roots are unconditional truths, sinks are goals.
    assert by_id["ratio"].kind == "unconditional_truth"
    assert by_id["slope"].kind == "derived_step"
    assert by_id["derivative"].kind == "goal"
    assert by_id["standalone_fact"].kind == "unconditional_truth"
    # Topological order: every prerequisite precedes its dependents.
    order = [n.id for n in nodes]
    assert all(order.index(dep) < order.index(n.id) for n in nodes for dep in n.depends_on)


def test_header_is_case_insensitive_and_bare_ids_register() -> None:
    nodes, edges = parse_mermaid_plan("GRAPH td;\na --> b --> c")
    assert [(e.source, e.target, e.line) for e in edges] == [("a", "b", 2), ("b", "c", 2)]
    assert {n.id for n in nodes} == {"a", "b", "c"}


@pytest.mark.parametrize(("text", "message"), [
    ("", "line 1: the plan is empty"),
    ("graph TD\nA[Upper]", "line 2: node id `A` must be a lowercase slug"),
    ("graph TD\na.b --> c", "line 2: node id `a.b`"),
    ("graph TD\n\nfoo bar baz", "line 3: cannot read `foo bar baz`"),
    ("graph TD\na -->", "line 2: cannot read `a -->`"),
    ("graph TD\nsubgraph s", "line 2: cannot read `subgraph s`"),
    ("sequenceDiagram\na --> b", "line 1: expected the header `graph TD`"),
    ("graph TD\ngraph LR", "line 2: only one `graph TD` header"),
    ("graph TD\na[One]\na[Two]", "line 3: duplicate node id `a`"),
    ("graph TD\na --> a", "line 2: self-loop `a --> a`"),
    ("graph TD\na --> b\na ==> b", "line 3: duplicate edge `a --> b` (already on line 2)"),
    ("graph TD\na --> b\nb --> c\nc --> a", "line 4: cycle a --> b --> c --> a"),
])
def test_each_error_names_its_line(text: str, message: str) -> None:
    with pytest.raises(PlanSyntaxError) as info:
        mermaid_to_plan_nodes(text)
    assert any(message in problem for problem in info.value.problems), info.value.problems


def test_every_problem_is_reported_at_once() -> None:
    with pytest.raises(PlanSyntaxError) as info:
        parse_mermaid_plan("graph TD\nA --> b\nc d e\nB")
    assert [p.split(":")[0] for p in info.value.problems] == ["line 2", "line 3", "line 4"]


def test_validate_rejects_unknown_endpoints() -> None:
    from learnharness.core.plan_mermaid import MermaidEdge, MermaidNode

    with pytest.raises(PlanSyntaxError, match="`ghost` is not a declared node"):
        validate_plan([MermaidNode("a", "A", 2)], [MermaidEdge("a", "ghost", 3)])


def test_node_details_must_reference_plan_ids() -> None:
    with pytest.raises(PlanSyntaxError, match="unknown ids \\['zzz'\\]"):
        mermaid_to_plan_nodes("graph TD\na", details={"zzz": {"source_paragraphs": ["p1"]}})
    node = mermaid_to_plan_nodes("graph TD\na", details={"a": {"source_paragraphs": ["p1"]}})[0]
    assert node.source_paragraphs == ["p1"]


def test_replan_keeps_progress_of_permanent_ids() -> None:
    previous = [
        PlanNode(id="a", label="A", status="mastered"),
        PlanNode(id="b", label="B", depends_on=["a"], status="needs_review"),
        PlanNode(id="c", label="C", depends_on=["b"], status="current"),
        PlanNode(id="gone", label="Pruned", status="mastered"),
    ]
    nodes = mermaid_to_plan_nodes("graph TD\nbase[Foundation] --> a\na --> b --> c", previous)
    assert {n.id: n.status for n in nodes} == {"base": "pending", "a": "mastered", "b": "needs_review", "c": "pending"}
    assert next(n for n in nodes if n.id == "a").depends_on == ["base"]


def test_derived_statuses() -> None:
    nodes = [PlanNode(id=i, label=i) for i in ("a", "b", "c", "d")]
    nodes[3].status = "mastered"
    assert derive_plan_statuses(nodes, []) == {"a": "pending", "b": "pending", "c": "pending", "d": "mastered"}
    statuses = derive_plan_statuses(nodes, ["a", None, "b", "a", "d"])
    # current = node of the latest question, unless sticky; earlier ones are visited.
    assert statuses == {"a": "visited", "b": "visited", "c": "pending", "d": "mastered"}
    assert derive_plan_statuses(nodes, ["a", "b"])["b"] == "current"
