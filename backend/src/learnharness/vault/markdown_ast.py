"""Markdown AST parser and non-destructive surgical merger.

Enforces Vault Invariants:
1. Fontes/ is strictly READ-ONLY. Any attempt to modify raises PermissionError.
2. In Conceitos/*.md and Aulas/**/*.md, user-written notes, callouts (> [!note]),
   and custom sections are preserved 100% bit-for-bit.
3. All writes are atomic via temporary files in the same directory.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path

import yaml

from learnharness.core.contracts.graph import ConceptNode, ConceptStatus
from learnharness.vault.safety import (
    RevisionConflictError,
    atomic_write,
    folder_map,
    locked_path,
    revision,
    safe_component,
    safe_path,
)

logger = logging.getLogger(__name__)


def _slugify(text: str) -> str:
    """Helper to convert string into a clean identifier."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower())
    return slug.strip("-")


def _extract_wikilinks(text: str) -> list[str]:
    """Extract list of concept names from Obsidian wikilinks [[Concept|Alias]] or [[Concept]]."""
    matches = re.findall(r"\[\[([^\|\]]+)(?:\|[^\]]+)?\]\]", text)
    return [m.strip() for m in matches if m.strip()]


def _format_wikilinks(links: list[str]) -> str:
    """Format a list of strings as Obsidian wikilinks: [[A]], [[B]]."""
    unique_links: list[str] = []
    for link in links:
        clean = link.strip().strip("[]")
        if clean and clean not in unique_links:
            unique_links.append(clean)
    return ", ".join(f"[[{link}]]" for link in unique_links)


def _split_frontmatter(content: str) -> tuple[dict[str, any], str, str]:
    """Split markdown into frontmatter dict, raw frontmatter text, and body.

    Returns:
        (frontmatter_dict, raw_frontmatter_block, body_text)
    """
    if content.startswith("---\n"):
        end_idx = content.find("\n---\n", 4)
        if end_idx != -1:
            raw_fm = content[4:end_idx]
            body = content[end_idx + 5 :]
            try:
                fm_data = yaml.safe_load(raw_fm) or {}
            except yaml.YAMLError as exc:
                # User-authored frontmatter: tolerate it, but never silently.
                logger.warning("Ignoring unparseable note frontmatter: %s", exc)
                fm_data = {}
            if not isinstance(fm_data, dict):
                fm_data = {}
            return fm_data, content[: end_idx + 5], body
    return {}, "", content


def _parse_sections(body: str) -> tuple[str, list[tuple[str, str]]]:
    """Parse markdown body into preamble and list of (## Heading, section_body).

    Preserves exact whitespace and user content.
    """
    pattern = re.compile(r"^(##\s+[^\n]+)", re.MULTILINE)
    fence = None
    masked = []
    for line in body.splitlines(keepends=True):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            run = marker.group(1)
            if fence is None:
                fence = run
            elif run[0] == fence[0] and len(run) >= len(fence):
                fence = None
            masked.append("".join(c if c in "\r\n" else " " for c in line))
        elif fence is not None:
            masked.append("".join(c if c in "\r\n" else " " for c in line))
        else:
            masked.append(line)
    matches = list(pattern.finditer("".join(masked)))
    if not matches:
        return body, []

    preamble = body[: matches[0].start()]
    sections: list[tuple[str, str]] = []

    for i, match in enumerate(matches):
        heading = match.group(1).strip()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        section_body = body[start:end]
        sections.append((heading, section_body))

    return preamble, sections


def _is_empty_or_template_comment(text: str) -> bool:
    """Check if section contains only whitespace or HTML comments like <!-- ... -->."""
    cleaned = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL).strip()
    return len(cleaned) == 0


_atomic_write = atomic_write


def parse_concept_note(path: Path) -> ConceptNode:
    """Parse an Obsidian concept note (Conceitos/*.md) into ConceptNode."""
    path = Path(path).resolve()
    content = path.read_text(encoding="utf-8")
    fm, _, body = _split_frontmatter(content)

    title_match = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else path.stem

    # Unconditional truth / definition
    def_match = re.search(
        r"\*\*Verdade incondicional\s*/\s*definição:\*\*\s*(.*?)(?=\n\n|\n[A-Z]|\n##|\Z)",
        body,
        re.DOTALL | re.IGNORECASE,
    )
    unconditional_truth = def_match.group(1).strip() if def_match else ""

    # Depende de:: and Usado em::
    depends_match = re.search(r"Depende de::\s*([^\n]+)", body, re.IGNORECASE)
    depends_on = _extract_wikilinks(depends_match.group(1)) if depends_match else []

    used_match = re.search(r"Usado em::\s*([^\n]+)", body, re.IGNORECASE)
    used_in = _extract_wikilinks(used_match.group(1)) if used_match else []

    # Sections
    _, sections = _parse_sections(body)
    sections_dict = {h.replace("##", "").strip(): b for h, b in sections}

    mechanism = sections_dict.get("Mecanismo", sections_dict.get("Mechanism", "")).strip()
    practice = sections_dict.get("Na prática", sections_dict.get("In Practice", "")).strip()
    mistakes_text = "\n".join(
        b for h, b in sections if h.strip() in {"## Erros que eu cometi", "## Mistakes I Made"}
    )

    mistake_lines = [
        line.strip()
        for line in mistakes_text.splitlines()
        if line.strip().startswith("-") or line.strip().startswith("*")
    ]

    statuses = re.findall(r"^Harness status:: (.+)$", body, re.MULTILINE)
    status_raw = str(statuses[-1] if statuses else fm.get("status", "aprendendo")).lower()
    status: ConceptStatus = (
        "sólido"
        if status_raw in ["solido", "sólido", "mastered"]
        else ("revisar" if status_raw in ["revisar", "review"] else "aprendendo")
    )

    sources_val = fm.get("fontes", [])
    if isinstance(sources_val, str):
        sources = [sources_val]
    elif isinstance(sources_val, list):
        sources = [str(s) for s in sources_val]
    else:
        sources = []

    return ConceptNode(
        id=_slugify(title),
        title=title,
        status=status,
        unconditional_truth=unconditional_truth,
        depends_on=depends_on,
        used_in=used_in,
        sources=sources,
        vault_rel_path=path.name,
        mistake_count=len(mistake_lines),
        mechanism_summary=mechanism[:300] if mechanism else "",
        practice_summary=practice[:300] if practice else "",
    )


def merge_managed_block(content: str, key: str, markdown: str) -> str:
    """Replace only explicit ownership markers, ignoring markers inside fenced examples.

    Legacy notes carry no ownership evidence: append a block and preserve every byte.
    """
    token = revision(key)[:24]
    start = f"<!-- harness:{token}:start -->"
    end = f"<!-- harness:{token}:end -->"
    replacement = f"{start}\n{markdown.rstrip()}\n{end}"
    offset = 0
    opened = None
    fence = None
    spans = []
    for line in content.splitlines(keepends=True):
        stripped = line.strip()
        marker = re.match(r"^(`{3,}|~{3,})", stripped)
        if marker:
            run = marker.group(1)
            if fence is None:
                fence = run
            elif run[0] == fence[0] and len(run) >= len(fence):
                fence = None
        elif fence is None:
            if stripped == start:
                if opened is not None:
                    raise ValueError("Ambiguous managed block")
                opened = offset
            elif stripped == end and opened is not None:
                spans.append((opened, offset + len(line.rstrip("\r\n"))))
                opened = None
        offset += len(line)
    if opened is not None or len(spans) > 1:
        raise ValueError("Malformed or duplicate managed block; refusing destructive merge")
    if spans:
        begin, finish = spans[0]
        return content[:begin] + replacement + content[finish:]
    return content + ("" if content.endswith("\n\n") else "\n\n") + replacement + "\n"


def _merge_note(
    path: Path, initial: str, updates: dict[str, str | None], expected_revision: str | None = None
) -> Path:
    with locked_path(path):
        exists = path.exists()
        content = path.read_bytes().decode("utf-8") if exists else initial
        original_revision = revision(content) if exists else None
        if expected_revision is not None and expected_revision != original_revision:
            raise RevisionConflictError("Document changed; reload before saving")
        for key, value in updates.items():
            if value is not None:
                content = merge_managed_block(content, key, value)
        atomic_write(path, content, expected_revision=original_revision, create_only=not exists)
    return path


def merge_concept_note(
    vault_path: Path,
    node: ConceptNode,
    mechanism_md: str | None = None,
    practice_md: str | None = None,
    discovery_md: str | None = None,
    mistake_entry: str | None = None,
    drawing_embed: str | None = None,
    expected_revision: str | None = None,
) -> Path:
    """Update explicitly owned blocks; legacy text and YAML remain byte-for-byte intact."""
    folders = folder_map(vault_path)
    safe_component(node.title)
    target = safe_path(vault_path, Path(folders.concepts_dir) / f"{node.title}.md")
    english = folders.concepts_dir == "Concepts"
    fm = yaml.safe_dump(
        {
            "tags": ["concept" if english else "conceito"],
            "status": node.status,
            "fontes": node.sources,
            "criado": datetime.now().strftime("%Y-%m-%d"),
        },
        allow_unicode=True,
    )
    initial = f"---\n{fm}---\n# {node.title}\n"
    metadata = (
        f"**Verdade incondicional / definição:** {node.unconditional_truth}\n\n"
        f"Depende de:: {_format_wikilinks(node.depends_on)}\n"
        f"Usado em:: {_format_wikilinks(node.used_in)}\n"
        f"Harness status:: {node.status}\n"
    )
    updates = {
        "concept:metadata": metadata,
        "concept:mechanism": f"## Mecanismo\n{mechanism_md}" if mechanism_md is not None else None,
        "concept:practice": f"## Na prática\n{practice_md}" if practice_md is not None else None,
        "concept:discovery": f"## Como eu poderia ter descoberto isso\n{discovery_md}"
        if discovery_md is not None
        else None,
    }
    if mistake_entry:
        updates[f"concept:mistake:{mistake_entry}"] = f"## Erros que eu cometi\n- {mistake_entry}"
    if drawing_embed:
        updates[f"concept:drawing:{drawing_embed}"] = f"## Desenhos\n{drawing_embed}"
    return _merge_note(target, initial, updates, expected_revision)


def merge_lesson_note(
    vault_path: Path,
    rel_path: str,
    title: str,
    fonte: str = "livre",
    objetivo: str | None = None,
    fontes_links: str | None = None,
    ponto_de_partida: str | None = None,
    mermaid_dag: str | None = None,
    node_section_title: str | None = None,
    node_section_md: str | None = None,
    quiz_summary: str | None = None,
    status: str | None = None,
    expected_revision: str | None = None,
) -> Path:
    folders = folder_map(vault_path)
    target = safe_path(vault_path, rel_path)
    for source in {folders.sources_dir, "Fontes", "Sources"}:
        if target.is_relative_to(safe_path(vault_path, source)):
            raise PermissionError("Fontes/ is strictly read-only")
    if not target.is_relative_to(safe_path(vault_path, folders.lessons_dir)):
        raise PermissionError("Lesson notes must be inside the configured lessons folder")
    if target.suffix != ".md":
        raise ValueError("Lesson notes must be Markdown files")
    fm = yaml.safe_dump(
        {
            "tags": ["aula"],
            "fonte": fonte,
            "data": datetime.now().strftime("%Y-%m-%d"),
            "status": status or "em andamento",
        },
        allow_unicode=True,
    )
    initial = f"---\n{fm}---\n# {title}\n"
    updates = {
        "lesson:objective": f"**Objetivo:** {objetivo}" if objetivo is not None else None,
        "lesson:sources": f"**Fontes:** {fontes_links}" if fontes_links is not None else None,
        "lesson:starting": f"## Ponto de partida\n{ponto_de_partida}"
        if ponto_de_partida is not None
        else None,
        "lesson:dag": f"## Mapa de dependências\n```mermaid\n{mermaid_dag}\n```"
        if mermaid_dag is not None
        else None,
        "lesson:quizzes": f"## Quizzes\n{quiz_summary}" if quiz_summary is not None else None,
        "lesson:status": f"Status: {status}" if status is not None else None,
    }
    if node_section_title and node_section_md is not None:
        updates[f"lesson:node:{node_section_title}"] = (
            f"### {node_section_title}\n{node_section_md}"
        )
    return _merge_note(target, initial, updates, expected_revision)


def scan_all_concepts(vault_path: Path, concepts_dir: str = "Conceitos") -> list[ConceptNode]:
    """Scan all markdown concept files in Conceitos/ and return ConceptNode list."""
    vault_path = Path(vault_path).resolve()
    dir_path = safe_path(
        vault_path,
        folder_map(vault_path).concepts_dir if concepts_dir == "Conceitos" else concepts_dir,
    )

    if not dir_path.exists():
        # Fallback to English Concepts/ if needed
        dir_path = vault_path / "Concepts"
        if not dir_path.exists():
            return []

    nodes: list[ConceptNode] = []
    for file_path in dir_path.glob("*.md"):
        if file_path.name.startswith("."):
            continue
        try:
            safe_path(vault_path, file_path.relative_to(vault_path))
            node = parse_concept_note(file_path)
            node.vault_rel_path = str(file_path.relative_to(vault_path))
            nodes.append(node)
        except (OSError, ValueError) as exc:
            # OSError: unreadable/symlinked note (PermissionError from safe_path);
            # ValueError: UnicodeDecodeError or pydantic ValidationError.
            # One bad note must not hide the whole graph, but it is logged.
            logger.warning("Skipping unparseable concept note %s: %s", file_path, exc)

    # Deterministic sorting by title
    nodes.sort(key=lambda n: n.title.lower())
    return nodes


# ============================================================================
# Lesson notes v2: ordered, digest-tracked managed blocks + managed frontmatter keys
# ============================================================================
#
# Merge policy:
# * A managed block is delimited by whole-line HTML comments (hidden in Obsidian's
#   reading view and on GitHub):
#       <!-- harness:<token>:start sha=<digest> -->
#       ...agent-owned markdown...
#       <!-- harness:<token>:end -->
#   ``token`` is derived from the block key; ``digest`` fingerprints what the agent wrote.
# * Bytes outside markers are never modified (blocks are only inserted next to other
#   managed blocks of the same layout, or appended at the end of the note).
# * Inside markers the content is agent-owned. A block is rewritten only when the agent's
#   own rendering changed. If the learner edited a block (digest mismatch) and the agent
#   has nothing new for it, the edit stays. If the agent must rewrite an edited block, the
#   learner's edited text is first moved, verbatim, right after the block and outside the
#   markers, where it becomes a regular user-owned paragraph. User text is never dropped.
# * Only the managed frontmatter keys are touched, and only when their value differs;
#   every other key, comment and formatting in the YAML is preserved byte-for-byte.
# * Writes happen only when the resulting bytes differ, so repeated flushes are no-ops
#   (no watcher churn).

_OWNED_START = re.compile(r"^<!-- harness:([0-9a-f]{24}):start(?: sha=([0-9a-f]{12}))? -->$")


def _block_token(key: str) -> str:
    return revision(key)[:24]


def _normalize_block(markdown: str) -> str:
    return markdown.replace("\r\n", "\n").rstrip()


def _block_digest(markdown: str) -> str:
    return revision(_normalize_block(markdown))[:12]


def _scan_owned_blocks(content: str) -> dict[str, tuple[int, int, int, int, str | None]]:
    """Map token -> (begin, inner_begin, inner_end, finish, sha) for every marker pair.

    Raises ValueError on unclosed, nested or duplicate blocks (refusing to guess).
    """
    found: dict[str, tuple[int, int, int, int, str | None]] = {}
    offset = 0
    opened: tuple[str, int, int, str | None] | None = None
    for line in content.splitlines(keepends=True):
        stripped = line.strip()
        match = _OWNED_START.match(stripped)
        if match:
            if opened is not None:
                raise ValueError("Nested managed block; refusing destructive merge")
            opened = (match.group(1), offset, offset + len(line), match.group(2))
        elif opened is not None and stripped == f"<!-- harness:{opened[0]}:end -->":
            token, begin, inner_begin, sha = opened
            if token in found:
                raise ValueError("Duplicate managed block; refusing destructive merge")
            found[token] = (begin, inner_begin, offset, offset + len(line.rstrip("\r\n")), sha)
            opened = None
        offset += len(line)
    if opened is not None:
        raise ValueError("Unclosed managed block; refusing destructive merge")
    return found


def _render_owned_block(key: str, markdown: str) -> str:
    body = _normalize_block(markdown)
    token = _block_token(key)
    return (
        f"<!-- harness:{token}:start sha={_block_digest(body)} -->\n"
        f"{body}\n<!-- harness:{token}:end -->"
    )


def merge_owned_blocks(
    content: str,
    blocks: list[tuple[str, str]],
    retire: dict[str, str | None] | None = None,
) -> str:
    """Upsert ``blocks`` (ordered ``(key, markdown)``) and retire obsolete keys.

    New blocks are placed after the closest preceding managed block of the same layout
    (or before the closest following one), otherwise appended. ``retire`` maps keys of
    obsolete blocks to the markdown the agent last wrote there: an untouched obsolete
    block is removed; an edited (or unknown, ``None``) one is unwrapped so its text
    becomes user-owned.
    """
    for key, expected in (retire or {}).items():
        span = _scan_owned_blocks(content).get(_block_token(key))
        if span is None:
            continue
        begin, inner_begin, inner_end, finish, _sha = span
        inner = content[inner_begin:inner_end]
        if expected is not None and _normalize_block(inner) == _normalize_block(expected):
            before, after = content[:begin], content[finish:]
            if before.endswith("\n\n") and after.startswith("\n"):
                after = after[1:]
            content = before + after
        else:
            content = content[:begin] + inner.rstrip("\r\n") + content[finish:]

    keys = [key for key, _ in blocks]
    for index, (key, markdown) in enumerate(blocks):
        found = _scan_owned_blocks(content)
        rendered = _render_owned_block(key, markdown)
        wanted = _block_digest(markdown)
        span = found.get(_block_token(key))
        if span is not None:
            begin, inner_begin, inner_end, finish, sha = span
            inner = content[inner_begin:inner_end]
            if sha is not None and _block_digest(inner) != sha:  # edited by the learner
                if sha == wanted:
                    continue  # The edit stands until the agent has something new to say.
                preserved = inner.strip("\r\n")
                content = content[:begin] + rendered + "\n\n" + preserved + content[finish:]
            elif sha != wanted or _normalize_block(inner) != _normalize_block(markdown):
                content = content[:begin] + rendered + content[finish:]
            continue
        anchor = next(
            (found[_block_token(k)] for k in reversed(keys[:index]) if _block_token(k) in found),
            None,
        )
        if anchor is not None:
            finish = anchor[3]
            content = content[:finish] + "\n\n" + rendered + content[finish:]
            continue
        following = next(
            (found[_block_token(k)] for k in keys[index + 1 :] if _block_token(k) in found), None
        )
        if following is not None:
            begin = following[0]
            content = content[:begin] + rendered + "\n\n" + content[begin:]
            continue
        if not content or content.endswith("\n\n"):
            separator = ""
        else:
            separator = "\n" if content.endswith("\n") else "\n\n"
        content = content + separator + rendered + "\n"
    return content


_FRONTMATTER = re.compile(r"\A---(\r?\n)(?:(.*?)(\r?\n))?---[ \t]*(?:\r?\n|\Z)", re.DOTALL)


def _dump_yaml_key(key: str, value: object, newline: str) -> str:
    dumped = yaml.safe_dump(
        {key: value}, allow_unicode=True, sort_keys=False, default_flow_style=False, width=10**6
    )
    return dumped.replace("\n", newline)


def merge_frontmatter_keys(
    content: str, managed: dict[str, object], ensure_tags: list[str] | None = None
) -> str:
    """Set only ``managed`` keys (when their value differs) and ensure ``ensure_tags``.

    Unparseable user YAML is left untouched: the learner's note beats our metadata.
    """
    ensure_tags = ensure_tags or []
    match = _FRONTMATTER.match(content)
    if match is None:
        values = {"tags": list(ensure_tags), **managed} if ensure_tags else dict(managed)
        fm = "".join(_dump_yaml_key(k, v, "\n") for k, v in values.items())
        return f"---\n{fm}---\n" + content
    newline = match.group(1)
    raw = match.group(2) or ""
    try:
        data = yaml.safe_load(raw) or {}
    except yaml.YAMLError as exc:
        logger.warning("Leaving unparseable lesson frontmatter untouched: %s", exc)
        return content
    if not isinstance(data, dict):
        return content
    updates: dict[str, object] = {}
    if ensure_tags:
        tags = data.get("tags")
        current = [tags] if isinstance(tags, str) else (list(tags) if isinstance(tags, list) else [])
        missing = [t for t in ensure_tags if t not in current]
        if missing:
            updates["tags"] = current + missing
    for key, value in managed.items():
        if data.get(key) != value:
            updates[key] = value
    if not updates:
        return content
    lines = raw.splitlines(keepends=True)
    if lines and not lines[-1].endswith(("\n", "\r")):
        lines[-1] += newline
    for key, value in updates.items():
        rendered = _dump_yaml_key(key, value, newline)
        head = re.compile(rf"^{re.escape(key)}\s*:")
        start = next((i for i, line in enumerate(lines) if head.match(line)), None)
        if start is None:
            lines.append(rendered)
            continue
        end = start + 1
        while end < len(lines) and (lines[end][:1] in (" ", "\t") or lines[end].startswith("-")):
            end += 1
        lines[start:end] = [rendered]
    return f"---{newline}{''.join(lines)}---{newline}" + content[match.end() :]


def _lesson_target(vault_path: Path, rel_path: str) -> Path:
    folders = folder_map(vault_path)
    target = safe_path(vault_path, rel_path)
    for source in {folders.sources_dir, "Fontes", "Sources"}:
        if target.is_relative_to(safe_path(vault_path, source)):
            raise PermissionError("Fontes/ is strictly read-only")
    if not target.is_relative_to(safe_path(vault_path, folders.lessons_dir)):
        raise PermissionError("Lesson notes must be inside the configured lessons folder")
    if target.suffix != ".md":
        raise ValueError("Lesson notes must be Markdown files")
    return target


def sync_lesson_note(
    vault_path: Path,
    rel_path: str,
    title: str,
    frontmatter: dict[str, object],
    blocks: list[tuple[str, str]],
    *,
    tags: list[str] | None = None,
    retire: dict[str, str | None] | None = None,
    touched: dict[str, object] | None = None,
    create_only: bool = False,
) -> bool:
    """Bring a lesson note to the rendered layout. Returns True when bytes were written.

    ``touched`` (e.g. ``{"atualizado": today}``) is applied only when something else
    changed, so re-syncing the same state never rewrites the file. ``create_only``
    refuses to adopt an existing file (FileExistsError): user notes are never overwritten.
    """
    target = _lesson_target(vault_path, rel_path)
    with locked_path(target):
        exists = target.exists()
        if exists and create_only:
            raise FileExistsError(rel_path)
        original = target.read_bytes().decode("utf-8") if exists else None
        content = original if original is not None else f"# {title}\n"
        content = merge_frontmatter_keys(content, frontmatter, tags)
        content = merge_owned_blocks(content, blocks, retire)
        if content == original:
            return False
        if touched:
            content = merge_frontmatter_keys(content, touched)
        atomic_write(
            target,
            content,
            expected_revision=revision(original) if original is not None else None,
            create_only=not exists,
        )
    return True


# ============================================================================
# Concept notes v2 (Fase 8B): one managed proposition block per note
# ============================================================================


def read_frontmatter(content: str) -> dict[str, object]:
    """Parsed YAML frontmatter, or ``{}`` when absent/unparseable (never raises)."""
    match = _FRONTMATTER.match(content)
    if match is None:
        return {}
    try:
        data = yaml.safe_load(match.group(2) or "") or {}
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


def body_without_frontmatter(content: str) -> str:
    match = _FRONTMATTER.match(content)
    return content[match.end():] if match else content


def remove_owned_block(content: str, key: str) -> str:
    """Drop the managed block ``key``; a block the learner edited is unwrapped instead."""
    span = _scan_owned_blocks(content).get(_block_token(key))
    if span is None:
        return content
    _begin, inner_begin, inner_end, _finish, sha = span
    inner = content[inner_begin:inner_end]
    untouched = sha is not None and _block_digest(inner) == sha
    return merge_owned_blocks(content, [], retire={key: inner if untouched else None})
