"""Pure folding and merging rules for the knowledge trace (Fase 8B).

ZERO I/O: callers read/append the JSONL lines (``vault.graph_store``) and pass records in.

* ``fold_nodes`` / ``fold_chains`` turn append-only lines (creations, link-appends and
  tombstones) into the current graph.
* ``uncovered_messages`` / ``select_batch`` decide which teacher prose the extractor reads.
* ``candidate_matches`` is the auditor's cheap pre-filter (token overlap, top 8).
* ``plan_merge`` resolves extractor keys and audit links into the lines to append.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from pydantic import ValidationError

from learnharness.core.contracts.graph import (
    AuditPayload,
    BatchMessage,
    ChainRecord,
    CoverageRecord,
    ExtractionPayload,
    MergePlan,
    PropositionNode,
    Provenance,
)

NODE_ID = re.compile(r"^n_[0-9a-f]{12}$")
CANDIDATES_PER_PROPOSITION = 8


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------


def fingerprint(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def estimate_tokens(content: str) -> int:
    return len(content) // 4


def normalize_name(text: str) -> str:
    """Case/accent/punctuation-insensitive form used for exact-name matches."""
    folded = unicodedata.normalize("NFKD", text.casefold())
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    return " ".join(re.findall(r"\w+", folded))


def _tokens(text: str) -> set[str]:
    return {t for t in normalize_name(text).split() if len(t) >= 3}


def _dedupe(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result = []
    for value in values:
        value = value.strip()
        key = normalize_name(value)
        if value and key and key not in seen:
            seen.add(key)
            result.append(value)
    return result


# ---------------------------------------------------------------------------
# Folding append-only lines
# ---------------------------------------------------------------------------


def _provenance(raw: Any) -> list[Provenance]:
    result = []
    for item in raw or []:
        try:
            result.append(Provenance.model_validate(item))
        except ValidationError:
            continue
    return result


def _union_provenance(current: list[Provenance], extra: Iterable[Provenance]) -> list[Provenance]:
    merged = list(current)
    for item in extra:
        if item not in merged:
            merged.append(item)
    return merged


def fold_nodes(records: Iterable[Mapping[str, Any]]) -> dict[str, PropositionNode]:
    """Creation lines + link-appends (aliases/provenance/note path) - tombstones."""
    nodes: dict[str, PropositionNode] = {}
    deleted: set[str] = set()
    for record in records:
        node_id = record.get("id")
        if not isinstance(node_id, str) or node_id in deleted:
            continue
        if record.get("deleted"):
            nodes.pop(node_id, None)
            deleted.add(node_id)
            continue
        node = nodes.get(node_id)
        if node is None:
            if "name" not in record:
                continue  # A link-append before its creation line carries no node.
            try:
                nodes[node_id] = PropositionNode.model_validate(record)
            except ValidationError:
                continue
            continue
        aliases = [a for a in record.get("aliases") or [] if isinstance(a, str)]
        known = {normalize_name(node.name), *(normalize_name(a) for a in node.aliases)}
        node.aliases += [a for a in _dedupe(aliases) if normalize_name(a) not in known]
        node.provenance = _union_provenance(node.provenance, _provenance(record.get("provenance")))
        if isinstance(record.get("vault_rel_path"), str):
            node.vault_rel_path = record["vault_rel_path"]
            node.note_created = bool(record.get("note_created", node.note_created))
    return nodes


def chain_signature(premises: Iterable[str], conclusion: str) -> tuple[tuple[str, ...], str]:
    return tuple(sorted(set(premises))), conclusion


def fold_chains(
    records: Iterable[Mapping[str, Any]], live_node_ids: set[str] | None = None
) -> list[ChainRecord]:
    """Fold chain lines; chains with the same (sorted premises, conclusion) merge.

    With ``live_node_ids``, chains that reference a missing/tombstoned node are dropped.
    """
    by_id: dict[str, ChainRecord] = {}
    deleted: set[str] = set()
    for record in records:
        chain_id = record.get("id")
        if not isinstance(chain_id, str) or chain_id in deleted:
            continue
        if record.get("deleted"):
            by_id.pop(chain_id, None)
            deleted.add(chain_id)
            continue
        if chain_id in by_id:
            current = by_id[chain_id]
            current.provenance = _union_provenance(current.provenance, _provenance(record.get("provenance")))
            continue
        try:
            by_id[chain_id] = ChainRecord.model_validate(record)
        except ValidationError:
            continue
    merged: dict[tuple[tuple[str, ...], str], ChainRecord] = {}
    for chain in by_id.values():
        if live_node_ids is not None and not ({chain.conclusion, *chain.premises} <= live_node_ids):
            continue
        signature = chain_signature(chain.premises, chain.conclusion)
        first = merged.get(signature)
        if first is None:
            merged[signature] = chain.model_copy(update={"premises": list(dict.fromkeys(chain.premises))})
        else:
            first.provenance = _union_provenance(first.provenance, chain.provenance)
    return list(merged.values())


def is_redundant(premises: list[str], conclusion: str, chains: Iterable[ChainRecord]) -> bool:
    """Same premises and conclusion, or premises that are a superset of an existing chain's."""
    wanted = set(premises)
    return any(c.conclusion == conclusion and set(c.premises) <= wanted for c in chains)


def chain_expression(chain: ChainRecord, names: Mapping[str, str]) -> str:
    left = " ∧ ".join(names.get(p, p) for p in chain.premises)
    return f"{left} ⟹ {names.get(chain.conclusion, chain.conclusion)}"


# ---------------------------------------------------------------------------
# Coverage and batching
# ---------------------------------------------------------------------------


def coverage_index(records: Iterable[CoverageRecord]) -> dict[tuple[str, str], set[str]]:
    index: dict[tuple[str, str], set[str]] = {}
    for record in records:
        index.setdefault((record.session_id, record.message_id), set()).add(record.fp)
    return index


def uncovered_messages(
    session_id: str,
    messages: Iterable[tuple[str, str, str]],
    coverage: Mapping[tuple[str, str], set[str]],
    exclude: set[str] | None = None,
) -> list[BatchMessage]:
    """Teacher prose (``role == "assistant"``) whose current fingerprint was never read."""
    result = []
    for message_id, role, content in messages:
        if role != "assistant" or not content.strip() or message_id in (exclude or set()):
            continue
        fp = fingerprint(content)
        if fp in coverage.get((session_id, message_id), set()):
            continue
        result.append(BatchMessage(message_id=message_id, content=content, fp=fp,
                                   tokens=estimate_tokens(content)))
    return result


def select_batch(uncovered: list[BatchMessage], budget: int) -> list[BatchMessage]:
    """Oldest first, greedily up to ``budget`` tokens (a single oversized message still goes)."""
    batch: list[BatchMessage] = []
    total = 0
    for message in uncovered:
        if batch and total + message.tokens > budget:
            break
        batch.append(message)
        total += message.tokens
    return batch


# ---------------------------------------------------------------------------
# Auditor pre-filter
# ---------------------------------------------------------------------------


def exact_match(name: str, aliases: Iterable[str], nodes: Mapping[str, PropositionNode]) -> str | None:
    wanted = {normalize_name(name), *(normalize_name(a) for a in aliases)} - {""}
    for node in nodes.values():
        if wanted & {normalize_name(node.name), *(normalize_name(a) for a in node.aliases)}:
            return node.id
    return None


def candidate_matches(
    name: str, statement: str, nodes: Mapping[str, PropositionNode], limit: int = CANDIDATES_PER_PROPOSITION
) -> list[str]:
    """Node ids ranked by token overlap with the proposition's name and statement."""
    name_tokens = _tokens(name)
    all_tokens = name_tokens | _tokens(statement)
    if not all_tokens:
        return []
    scored = []
    for node in nodes.values():
        node_name = _tokens(" ".join([node.name, *node.aliases]))
        node_all = node_name | _tokens(node.statement)
        overlap = len(all_tokens & node_all)
        if not overlap:
            continue
        # Name-to-name overlap weighs double: names are the strongest identity signal.
        score = (overlap + len(name_tokens & node_name)) / len(all_tokens | node_all)
        scored.append((score, node.created_at, node.id))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [node_id for _score, _created, node_id in scored[:limit]]


# ---------------------------------------------------------------------------
# Merger
# ---------------------------------------------------------------------------


def plan_merge(
    extraction: ExtractionPayload,
    audit: AuditPayload,
    nodes: Mapping[str, PropositionNode],
    chains: list[ChainRecord],
    session_id: str,
    batch: list[BatchMessage],
    now: str,
    make_id: Callable[[str], str],
) -> MergePlan:
    """Resolve keys into ids and compute every line to append (nothing is written here)."""
    plan = MergePlan()
    links = {link.key: link.link_to for link in audit.links}
    batch_ids = [m.message_id for m in batch]
    key_message: dict[str, str | None] = {}
    new_by_id: dict[str, PropositionNode] = {}
    appends: dict[str, dict[str, Any]] = {}

    for prop in extraction.propositions:
        key = prop.key.strip()
        if not key or key in plan.key_to_id:
            continue
        message_id = prop.message_id if prop.message_id in batch_ids else (
            batch_ids[0] if len(batch_ids) == 1 else None)
        key_message[key] = message_id
        provenance = Provenance(session_id=session_id, message_id=message_id)
        target = links.get(key) or (key if key in nodes else None)
        if target in nodes:
            plan.key_to_id[key] = target
            node = nodes[target]
            entry = appends.setdefault(target, {"id": target, "aliases": [], "provenance": []})
            known = {normalize_name(node.name), *(normalize_name(a) for a in node.aliases + entry["aliases"])}
            entry["aliases"] += [a for a in _dedupe([prop.name, *prop.aliases]) if normalize_name(a) not in known]
            if provenance not in node.provenance and provenance.model_dump() not in entry["provenance"]:
                entry["provenance"].append(provenance.model_dump())
            continue
        twin = next((n for n in new_by_id.values() if normalize_name(n.name) == normalize_name(prop.name)), None)
        if twin is not None:
            plan.key_to_id[key] = twin.id
            twin.aliases = [a for a in _dedupe(twin.aliases + prop.aliases)
                            if normalize_name(a) != normalize_name(twin.name)]
            twin.provenance = _union_provenance(twin.provenance, [provenance])
            continue
        node_id = make_id("n")
        new_by_id[node_id] = PropositionNode(
            id=node_id, name=prop.name.strip(), statement=prop.statement.strip(),
            aliases=[a for a in _dedupe(prop.aliases) if normalize_name(a) != normalize_name(prop.name)],
            created_at=now, provenance=[provenance],
        )
        plan.key_to_id[key] = node_id

    plan.new_nodes = list(new_by_id.values())
    plan.link_appends = [a for a in appends.values() if a["aliases"] or a["provenance"]]

    accepted: list[ChainRecord] = []
    for raw in extraction.chains:
        def resolve(ref: str) -> str | None:
            ref = ref.strip()
            return plan.key_to_id.get(ref) or (ref if ref in nodes else None)

        premises = [resolve(p) for p in raw.premises]
        conclusion = resolve(raw.conclusion)
        reason = None
        if conclusion is None or any(p is None for p in premises):
            reason = "unknown reference"
        else:
            premises = list(dict.fromkeys(premises))
            if conclusion in premises:
                reason = "self-implication"
            elif is_redundant(premises, conclusion, [*chains, *accepted]):
                reason = "redundant"
        if reason:
            plan.rejected_chains.append({"chain": raw.model_dump(), "reason": reason})
            continue
        conclusion_key = next((k for k, v in plan.key_to_id.items() if v == conclusion), None)
        message_id = key_message.get(conclusion_key) if conclusion_key else None
        accepted.append(ChainRecord(
            id=make_id("arg"), premises=premises, conclusion=conclusion, created_at=now,
            provenance=[Provenance(session_id=session_id, message_id=message_id)],
        ))
    plan.new_chains = accepted
    plan.coverage = [CoverageRecord(session_id=session_id, message_id=m.message_id, fp=m.fp,
                                    tokens=m.tokens, at=now) for m in batch]
    return plan


# ---------------------------------------------------------------------------
# Session prompt context (graph_context)
# ---------------------------------------------------------------------------


def format_graph_context(
    selected: list[PropositionNode], chains: Iterable[ChainRecord], *, practice: bool = False
) -> str:
    """Selected propositions ("[id] name: statement") plus the chains among them."""
    if not selected:
        return ""
    ids = {n.id for n in selected}
    names = {n.id: n.name for n in selected}
    if practice:
        header = ("PRACTICE MATERIAL (the learner picked these propositions from their knowledge "
                  "graph; build the practice on them):")
    else:
        header = ("ALREADY-KNOWN MATERIAL (the learner picked these propositions from their knowledge "
                  "graph; they already know them, so do not re-teach them: build on them and connect "
                  "new ideas to them):")
    lines = [header, *(f"[{n.id}] {n.name}: {n.statement}" for n in selected)]
    among = [c for c in chains if {c.conclusion, *c.premises} <= ids]
    if among:
        lines.append("Chains among them:")
        lines += [f"- [{c.id}] {chain_expression(c, names)}" for c in among]
    return "\n".join(lines)
