"""``PreToolUse`` hook for ``agy``: only the harness MCP server may act.

Copied verbatim into ``<work_dir>/.agents/harness_gate.py`` and run by agy (``python -I``)
before every tool step, so it must stay standalone (stdlib only, no learnharness imports).

Headless agy soft-denies MCP calls that would need an interactive permission prompt
(verified with agy 1.4.7: ``denied_actions: [{"action": "mcp"}]``). The hook answers
``allow`` for the harness MCP tools and ``deny`` for everything else (shell, file writes,
browser, other MCP servers such as the user's global ones).

A research workspace writes ``gate_policy.json`` (``{"policy": "research"}``) next to the
copied script. The gate then allows only agy's web-read tools (``search_web`` and
``read_url_content``, names taken from a real agy 1.4.8 ``init`` event) plus the
structured-output ``finish``; every MCP server, file, shell and browser tool is denied.
"""

import json
import os
import sys

SERVER = "harness"
# agy caches each MCP tool schema under this dir and the model reads it before calling.
MCP_SCHEMA_DIR = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity-cli", "mcp")
READ_TOOLS = {"read_file", "view_file"}
PATH_KEYS = ("Path", "AbsolutePath", "File", "FilePath", "Uri")
WEB_READ_TOOLS = {"search_web", "read_url_content"}
POLICY_FILE = "gate_policy.json"
POLICIES = ("harness", "research")


def _within(path, root):
    if path.startswith("file://"):
        path = path[len("file://") :]
    real = os.path.realpath(os.path.expanduser(path))
    root = os.path.realpath(root)
    return real == root or real.startswith(root + os.sep)


def decide_research(payload):
    name = (payload.get("toolCall") or {}).get("name") or ""
    if name in WEB_READ_TOOLS or name == "finish":
        return {"decision": "allow"}
    return {
        "decision": "deny",
        "reason": "Research job: only search_web and read_url_content are available.",
    }


def decide(payload, schema_dir=MCP_SCHEMA_DIR, server=SERVER, policy="harness"):
    if policy == "research":
        return decide_research(payload)
    call = payload.get("toolCall") or {}
    name = call.get("name") or ""
    args = call.get("args") or {}
    if name == "call_mcp_tool":
        if args.get("ServerName") == server:
            return {"decision": "allow"}
        return {"decision": "deny", "reason": f"Only the {server} MCP server is allowed here."}
    if name == "finish":  # structured-output terminator (--json-schema)
        return {"decision": "allow"}
    if name in READ_TOOLS:
        paths = [args[k] for k in PATH_KEYS if isinstance(args.get(k), str)]
        if paths and all(_within(p, os.path.join(schema_dir, server)) for p in paths):
            return {"decision": "allow"}
    return {
        "decision": "deny",
        "reason": f"Learning harness: only {server} MCP tools are available in this session.",
    }


def read_policy(directory):
    """The policy stored next to the gate; anything unreadable means the strict default."""
    try:
        with open(os.path.join(directory, POLICY_FILE), encoding="utf-8") as handle:
            policy = json.load(handle).get("policy")
    except (OSError, ValueError, AttributeError):
        return "harness"
    return policy if policy in POLICIES else "harness"


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = {}
    policy = read_policy(os.path.dirname(os.path.abspath(__file__)))
    json.dump(decide(payload if isinstance(payload, dict) else {}, policy=policy), sys.stdout)


if __name__ == "__main__":
    main()
