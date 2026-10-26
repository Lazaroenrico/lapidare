"""Excalidraw drawing codec and multimodal drawing sync.

Supports reading both ```compressed-json``` (decompressing via lzstring)
AND ```json``` inside %% ## Drawing ... %% in Desenhos/*.excalidraw.md.
Creates memory retrieval prompts and handles bidirectional sync with Obsidian.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

from learnharness.vault.markdown_ast import merge_managed_block
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

try:
    import lzstring

    _lz = lzstring.LZString()
except ImportError:
    _lz = None


def _slugify(text: str) -> str:
    """Generate safe URL/filename slug."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower())
    return slug.strip("-")


_atomic_write = atomic_write


def _split_frontmatter(content: str) -> tuple[dict[str, Any], str, str]:
    """Extract YAML frontmatter from markdown file."""
    if content.startswith("---\n"):
        end_idx = content.find("\n---\n", 4)
        if end_idx != -1:
            raw_fm = content[4:end_idx]
            body = content[end_idx + 5 :]
            try:
                fm_data = yaml.safe_load(raw_fm) or {}
            except yaml.YAMLError as exc:
                # User-authored frontmatter: tolerate it, but never silently.
                logger.warning("Ignoring unparseable drawing frontmatter: %s", exc)
                fm_data = {}
            if not isinstance(fm_data, dict):
                fm_data = {}
            return fm_data, content[: end_idx + 5], body
    return {}, "", content


def create_retrieval_drawing(
    vault_path: Path,
    title: str,
    prompt: str,
    aula_rel: str | None = None,
    conceitos: list[str] | None = None,
) -> tuple[str, Path]:
    """Create a new memory retrieval drawing in Desenhos/.

    Contains locked title & prompt text elements, frontmatter, and initial scene.
    Returns (slug, file_path).
    """
    vault_path = Path(vault_path).resolve()
    drawings_dir = safe_path(vault_path, folder_map(vault_path).drawings_dir)
    drawings_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.now().strftime("%Y-%m-%d")
    slug = f"{_slugify(title)}-{today}"
    target_file = drawings_dir / f"{slug}.excalidraw.md"

    # Excalidraw locked text elements
    initial_elements = [
        {
            "id": "titulo01",
            "type": "text",
            "x": 80,
            "y": 60,
            "width": 640,
            "height": 40,
            "angle": 0,
            "strokeColor": "#e6e6e6",
            "backgroundColor": "transparent",
            "fillStyle": "hachure",
            "strokeWidth": 1,
            "strokeStyle": "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "frameId": None,
            "roundness": None,
            "seed": 1001,
            "version": 1,
            "versionNonce": 1,
            "isDeleted": False,
            "boundElements": None,
            "updated": 1,
            "link": None,
            "locked": True,
            "text": title,
            "fontSize": 26,
            "fontFamily": 1,
            "textAlign": "left",
            "verticalAlign": "top",
            "baseline": 22,
            "containerId": None,
            "originalText": title,
            "lineHeight": 1.25,
        },
        {
            "id": "enunciado01",
            "type": "text",
            "x": 80,
            "y": 120,
            "width": 720,
            "height": 60,
            "angle": 0,
            "strokeColor": "#8d8d8d",
            "backgroundColor": "transparent",
            "fillStyle": "hachure",
            "strokeWidth": 1,
            "strokeStyle": "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "frameId": None,
            "roundness": None,
            "seed": 1002,
            "version": 1,
            "versionNonce": 1,
            "isDeleted": False,
            "boundElements": None,
            "updated": 1,
            "link": None,
            "locked": True,
            "text": prompt,
            "fontSize": 16,
            "fontFamily": 1,
            "textAlign": "left",
            "verticalAlign": "top",
            "baseline": 14,
            "containerId": None,
            "originalText": prompt,
            "lineHeight": 1.25,
        },
    ]

    scene_data: dict[str, Any] = {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": initial_elements,
        "appState": {
            "gridSize": None,
            "viewBackgroundColor": "#141414",
        },
        "files": {},
    }

    # Compress scene if lzstring is available, else output json
    json_str = json.dumps(scene_data)
    if _lz:
        compressed = _lz.compressToBase64(json_str)
        drawing_block = f"```compressed-json\n{compressed}\n```"
    else:
        drawing_block = f"```json\n{json.dumps(scene_data, indent=2)}\n```"

    fm_data = {
        "excalidraw-plugin": "parsed",
        "tags": ["excalidraw", "desenho"],
        "criado": today,
        "aula": aula_rel or "",
        "conceitos": conceitos or [],
        "revisado": False,
    }
    fm_str = yaml.dump(fm_data, allow_unicode=True, default_flow_style=None).strip()

    banner = (
        "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== "
        "You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. "
        "For more info check in plugin settings under 'Saving'"
    )

    content = f"""---
{fm_str}
---
{banner}

# Excalidraw Data

## Text Elements
{title} ^titulo01

{prompt} ^enunciado01

%%
## Drawing
{drawing_block}
%%
"""
    with locked_path(target_file):
        if target_file.exists():
            # A second retrieval exercise must never overwrite an existing drawing.
            from uuid import uuid4

            slug = f"{slug}-{uuid4().hex[:8]}"
            target_file = drawings_dir / f"{slug}.excalidraw.md"
        atomic_write(target_file, content, create_only=True)
    return slug, target_file


def _find_drawing_file(vault_path: Path, slug: str) -> Path:
    """Find matching .excalidraw.md file by exact slug or pattern."""
    drawings_dir = safe_path(vault_path, folder_map(vault_path).drawings_dir)
    clean_slug = slug.removesuffix(".md").removesuffix(".excalidraw")
    safe_component(clean_slug)
    exact = safe_path(drawings_dir, f"{clean_slug}.excalidraw.md")
    if exact.is_file():
        return exact

    raise FileNotFoundError(f"Drawing with slug '{slug}' not found in {drawings_dir}")


def load_drawing(vault_path: Path, slug: str) -> dict[str, Any]:
    """Load and parse an Excalidraw drawing file.

    Supports both ```compressed-json``` and ```json``` blocks.
    Locates associated light/dark PNG exports.
    """
    file_path = _find_drawing_file(vault_path, slug)
    content = file_path.read_bytes().decode("utf-8")

    fm, _, body = _split_frontmatter(content)

    # 1. Parse Text Elements
    text_elements: dict[str, str] = {}
    text_elem_match = re.search(r"## Text Elements\s*\n(.*?)(?=\n%%|\n##|\Z)", body, re.DOTALL)
    if text_elem_match:
        raw_text = text_elem_match.group(1)
        for line in raw_text.splitlines():
            line = line.strip()
            item_match = re.search(r"^(.*?)\s+\^([a-zA-Z0-9_-]+)$", line)
            if item_match:
                text_elements[item_match.group(2)] = item_match.group(1).strip()

    # 2. Extract and parse scene JSON
    scene: dict[str, Any] = {}
    drawing_body = re.search(r"^## Drawing[^\n]*\n(.*?)(?=^%%|\Z)", body, re.MULTILINE | re.DOTALL)
    scene_body = drawing_body.group(1) if drawing_body else ""
    compressed_match = re.search(r"```compressed-json\s*\n(.*?)\n```", scene_body, re.DOTALL)
    json_match = re.search(r"```json\s*\n(.*?)\n```", scene_body, re.DOTALL)

    if compressed_match:
        compressed_text = re.sub(r"\s+", "", compressed_match.group(1))
        if _lz is not None:
            decompressed = _lz.decompressFromBase64(compressed_text)
            if decompressed:
                scene = json.loads(decompressed)
        else:
            raise RuntimeError("lzstring package is required to decompress compressed-json blocks")
    elif json_match:
        json_str = json_match.group(1).strip()
        scene = json.loads(json_str)

    # 3. Locate PNG export if present
    drawings_dir = file_path.parent
    base_name = file_path.name.replace(".excalidraw.md", "")
    png_path: Path | None = None
    for candidate in [
        drawings_dir / f"{base_name}.excalidraw.light.png",
        drawings_dir / f"{base_name}.excalidraw.dark.png",
        drawings_dir / f"{base_name}.png",
    ]:
        safe_path(vault_path, candidate.relative_to(Path(vault_path).resolve()))
        if candidate.exists():
            png_path = candidate
            break

    # 4. Parse ## Revisão section if present
    review_content: str | None = None
    review_match = re.search(r"## Revis[ãa]o\s*\n(.*?)(?=\n##|\Z)", body, re.DOTALL)
    if review_match:
        review_content = review_match.group(1).strip()

    return {
        "revision": revision(content),
        "slug": base_name,
        "path": str(file_path),
        "frontmatter": fm,
        "text_elements": text_elements,
        "scene": scene,
        "png_path": str(png_path) if png_path else None,
        "review": review_content,
        "revisado": fm.get("revisado", False),
    }


def _managed_block_body(content: str, key: str) -> str | None:
    """Return the inner text of the harness-managed block ``key``, if present."""
    token = revision(key)[:24]
    match = re.search(
        rf"^<!-- harness:{token}:start -->\n(.*?)^<!-- harness:{token}:end -->",
        content,
        re.MULTILINE | re.DOTALL,
    )
    return match.group(1) if match else None


def save_drawing(
    vault_path: Path,
    slug: str,
    scene_json: dict[str, Any],
    png_bytes: bytes | None = None,
    review_markdown: str | None = None,
    expected_revision: str | None = None,
) -> Path:
    """Replace scene data surgically, preserving surrounding prose and scene metadata."""
    file_path = _find_drawing_file(vault_path, slug)
    with locked_path(file_path):
        content = file_path.read_bytes().decode("utf-8")
        current_revision = revision(content)
        if expected_revision is not None and expected_revision != current_revision:
            raise RevisionConflictError("Drawing changed; reload before saving")
        existing = load_drawing(vault_path, slug)["scene"]
        merged_scene = {**existing, **scene_json}
        for key in ("files", "appState"):
            merged_scene[key] = {**existing.get(key, {}), **scene_json.get(key, {})}
        drawing = re.search(
            r"^## Drawing[^\n]*\n(.*?)(?=^%%|\Z)", content, re.MULTILINE | re.DOTALL
        )
        if drawing is None:
            raise ValueError("Missing Excalidraw Drawing section")
        block = re.search(r"```(?:compressed-json|json)\s*\n.*?\n```", drawing.group(1), re.DOTALL)
        if block is None:
            raise ValueError("Missing Excalidraw scene block")
        serialized = json.dumps(merged_scene, ensure_ascii=False)
        replacement = (
            f"```compressed-json\n{_lz.compressToBase64(serialized)}\n```"
            if _lz
            else f"```json\n{serialized}\n```"
        )
        start = drawing.start(1) + block.start()
        end = drawing.start(1) + block.end()
        content = content[:start] + replacement + content[end:]
        # Text Elements belong to the codec, but retain free user text in that section.
        text_section = re.search(
            r"(^## Text Elements[^\n]*\n)(.*?)(?=^%%|^## |\Z)", content, re.MULTILINE | re.DOTALL
        )
        if text_section:
            old_text = text_section.group(2)
            old_elements = {
                e.get("id"): e.get("text", "")
                for e in existing.get("elements", [])
                if e.get("type") == "text"
            }
            for element_id, text in old_elements.items():
                old_text = old_text.replace(f"{text} ^{element_id}", "", 1)
            new_text = "\n\n".join(
                f"{e.get('text', '')} ^{e['id']}"
                for e in merged_scene.get("elements", [])
                if e.get("type") == "text" and not e.get("isDeleted") and e.get("id")
            )
            content = (
                content[: text_section.start(2)]
                + old_text
                + new_text
                + "\n\n"
                + content[text_section.end(2) :]
            )
        if review_markdown is not None:
            # Reviews accumulate: earlier entries in the managed block are kept and the
            # new one is appended; text outside the block (user notes) is never touched.
            previous = _managed_block_body(content, "drawing:review")
            if previous is not None:
                previous = re.sub(r"^## Revis[ãa]o[^\n]*\n?", "", previous.strip(), count=1).strip()
            entries = [e for e in (previous, review_markdown.strip()) if e]
            content = merge_managed_block(
                content, "drawing:review", "## Revisão\n" + "\n\n---\n\n".join(entries)
            )
            _fm, raw_fm, body = _split_frontmatter(content)
            if raw_fm:
                if re.search(r"^revisado:", raw_fm, re.MULTILINE):
                    updated = re.sub(r"^(revisado:)[^\n]*", r"\1 true", raw_fm, flags=re.MULTILINE)
                else:
                    updated = raw_fm[:-4] + "revisado: true\n---\n"
                content = updated + body
        atomic_write(file_path, content, expected_revision=current_revision)
        if png_bytes is not None:
            base = file_path.name.removesuffix(".excalidraw.md")
            for filename in (f"{base}.excalidraw.light.png", f"{base}.png"):
                target = safe_path(
                    vault_path, file_path.parent.relative_to(Path(vault_path).resolve()) / filename
                )
                atomic_write(target, png_bytes)
    return file_path
