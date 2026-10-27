"""Pure validation of model-generated SVG figures (ZERO I/O).

A lesson figure is shown as an ``<img>`` data URI in the UI and embedded in the Obsidian
note, so it must be one self-contained, inert document: well-formed XML whose root is an
``<svg>`` with a ``viewBox``, no scripting, no foreign HTML and no reference that leaves
the file. Colors are never judged here; the prompt only suggests the purple palette.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

MAX_SVG_BYTES = 300_000

_DECLARATIONS = re.compile(r"<!\s*(?:DOCTYPE|ENTITY)\b", re.I)
_CSS_URL = re.compile(r"url\(\s*(['\"]?)\s*([^)'\"]*)\1\s*\)", re.I)
_CSS_IMPORT = re.compile(r"@import\b", re.I)
_FORBIDDEN_ELEMENTS = {"script": "<script> is forbidden", "foreignobject": "<foreignObject> is forbidden"}


def _local(name: str) -> str:
    """``{namespace}tag`` or ``prefix:tag`` -> ``tag``."""
    return name.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _internal(reference: str) -> bool:
    value = reference.strip()
    return value.startswith("#") or value.lower().startswith("data:")


def _css_errors(text: str, where: str) -> list[str]:
    errors: list[str] = []
    if _CSS_IMPORT.search(text):
        errors.append(f"CSS @import is forbidden ({where})")
    for match in _CSS_URL.finditer(text):
        if not _internal(match.group(2)):
            errors.append(f"external url({match.group(2)!r}) is forbidden ({where}); use #id or data:")
    return errors


def validate_svg(svg: str) -> list[str]:
    """Return every rule the SVG breaks; an empty list means it can be saved."""
    if not svg or not svg.strip():
        return ["SVG is empty"]
    errors: list[str] = []
    size = len(svg.encode("utf-8"))
    if size > MAX_SVG_BYTES:
        errors.append(f"SVG is {size} bytes; the maximum is {MAX_SVG_BYTES} bytes")
    if _DECLARATIONS.search(svg):
        # Entities are the only way an XML file pulls in outside content or explodes on parse.
        return [*errors, "<!DOCTYPE>/<!ENTITY> declarations are forbidden"]
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        return [*errors, f"SVG is not well-formed XML: {exc}"]
    if _local(root.tag).lower() != "svg":
        errors.append(f"the root element must be <svg>, not <{_local(root.tag)}>")
    elif not (root.get("viewBox") or "").strip():
        errors.append("the root <svg> needs a viewBox attribute (e.g. viewBox=\"0 0 800 450\")")
    seen: set[str] = set()

    def add(message: str) -> None:
        if message not in seen:
            seen.add(message)
            errors.append(message)

    for element in root.iter():
        # Comments and processing instructions carry a factory function as their tag,
        # whatever the stubs say.
        if not isinstance(element.tag, str):  # pyright: ignore[reportUnnecessaryIsInstance]
            continue
        tag = _local(element.tag)
        reason = _FORBIDDEN_ELEMENTS.get(tag.lower())
        if reason:
            add(reason)
        for name, value in element.attrib.items():
            attribute = _local(name)
            if attribute.lower().startswith("on"):
                add(f"event handler attributes are forbidden (found {attribute}= on <{tag}>)")
            elif attribute.lower() == "href" and not _internal(value):
                add(f"external href {value!r} on <{tag}> is forbidden; only #id or data: references")
            elif attribute.lower() == "style":
                for message in _css_errors(value, f"style on <{tag}>"):
                    add(message)
            elif "url(" in value.lower():
                for message in _css_errors(value, f"{attribute} on <{tag}>"):
                    add(message)
        if tag.lower() == "style" and element.text:
            for message in _css_errors(element.text, "<style>"):
                add(message)
    return errors
