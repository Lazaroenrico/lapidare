"""The harness tools, one module per family; ``runtime_server`` composes and guards them.

Each family's ``build(state, session_id)`` returns its tool callables. Their names,
signatures and docstrings ARE what the model sees (FastMCP and google-genai derive the
tool schemas from them), so ``tests/golden/tool_catalog.json`` pins them.
"""
