"""The harness tool catalog the model sees (names, descriptions, input/output schemas, order).

FastMCP builds it from the tool functions' names, signatures and docstrings, so any
refactor of ``runtime_server`` must leave this byte-identical unless the change is meant
for the model. Refresh after an intended change with
``LEARNHARNESS_UPDATE_GOLDEN=1 uv run pytest tests/integration/test_tool_catalog.py``.
"""

import json
import os
from pathlib import Path

from learnharness.mcp.runtime_server import HARNESS_TOOL_NAMES, create_runtime_mcp

REFERENCE = Path(__file__).parent.parent / "golden" / "tool_catalog.json"


async def test_tool_catalog_matches_reference():
    tools = await create_runtime_mcp(None).list_tools()
    catalog = [{"name": t.name, "description": t.description, "parameters": t.parameters,
                "output_schema": t.output_schema} for t in tools]
    actual = json.dumps(catalog, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if os.environ.get("LEARNHARNESS_UPDATE_GOLDEN") == "1" or not REFERENCE.exists():
        REFERENCE.write_text(actual, encoding="utf-8")
    assert actual == REFERENCE.read_text(encoding="utf-8")
    assert {t["name"] for t in catalog} == HARNESS_TOOL_NAMES
