"""Fake ``gemini --acp`` agent (stdio, JSON-RPC 2.0, one object per line).

Handshake payloads come from the real gemini-cli 0.62.0 exchange recorded in
``gemini-0.62.0-handshake-real.ndjson``; turn payloads from
``gemini-0.62.0-turn-synthetic.ndjson`` (shapes copied from the 0.62.0 ACP source because
the local account could not authenticate a real prompt).

Environment:
  FAKE_ACP_LOG        append every received message (and a start record) as NDJSON
  FAKE_ACP_SCENARIO   stream | echo | suspend | hang | die | die_once | cancel
  FAKE_ACP_SLEEP      seconds the ``suspend`` scenario blocks inside the harness tool
  FAKE_ACP_MARKER     file used by ``die_once`` (dies only when it does not exist yet)
  FAKE_ACP_AUTH_ERROR when set, session/new fails with the recorded auth error
"""

import json
import os
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.environ.get("FAKE_ACP_LOG")
SCENARIO = os.environ.get("FAKE_ACP_SCENARIO", "stream")


def load(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


REAL = load("gemini-0.62.0-handshake-real.ndjson")
INIT_RESULT = REAL[1]["msg"]["result"]
AUTH_ERROR = REAL[3]["msg"]["error"]


def log(entry):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    message = json.loads(line)
    log({"recv": message})
    return message


def update(session_id, payload):
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": session_id, "update": payload},
        }
    )


def chunk(session_id, text):
    update(
        session_id,
        {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}},
    )


def finish(prompt_id, stop="end_turn"):
    send({"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": stop}})


def substitute(message, session_id, prompt_id):
    text = json.dumps(message)
    text = text.replace('"$SESSION"', json.dumps(session_id))
    text = text.replace('"$PROMPT_ID"', json.dumps(prompt_id))
    return json.loads(text)


def wait_response(request_id):
    while True:
        message = read()
        if message.get("id") == request_id and "method" not in message:
            return message


def turn(message):
    session_id = message["params"]["sessionId"]
    prompt_id = message["id"]
    if SCENARIO == "stream":
        for entry in load("gemini-0.62.0-turn-synthetic.ndjson"):
            out = substitute(entry["msg"], session_id, prompt_id)
            send(out)
            if "method" in out and "id" in out:
                wait_response(out["id"])
        return
    if SCENARIO == "suspend":
        call = "mcp_harness_pose_quiz-1761480000000-1"
        update(
            session_id,
            {"sessionUpdate": "tool_call", "toolCallId": call, "status": "pending",
             "title": "pose_quiz (harness MCP Server)", "kind": "other"},
        )
        time.sleep(float(os.environ.get("FAKE_ACP_SLEEP", "1")))
        update(
            session_id,
            {"sessionUpdate": "tool_call_update", "toolCallId": call, "status": "completed"},
        )
        chunk(session_id, "depois")
        finish(prompt_id)
        return
    if SCENARIO == "hang":
        chunk(session_id, "parcial")
        time.sleep(3600)
    if SCENARIO == "die":
        chunk(session_id, "parcial")
        os._exit(3)
    if SCENARIO == "die_once":
        marker = os.environ["FAKE_ACP_MARKER"]
        if not os.path.exists(marker):
            open(marker, "w").close()
            chunk(session_id, "parcial")
            os._exit(3)
        chunk(session_id, "recuperado")
        finish(prompt_id)
        return
    if SCENARIO == "cancel":
        chunk(session_id, "parcial")
        while read().get("method") != "session/cancel":
            pass
        finish(prompt_id, "cancelled")
        return
    chunk(session_id, "ok")  # echo
    finish(prompt_id)


def main():
    log(
        {
            "start": {
                "argv": sys.argv[1:],
                "cwd": os.getcwd(),
                "trust": os.environ.get("GEMINI_CLI_TRUST_WORKSPACE"),
                "pid": os.getpid(),
            }
        }
    )
    while True:
        message = read()
        method, request_id = message.get("method"), message.get("id")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": request_id, "result": INIT_RESULT})
        elif method == "session/new":
            if os.environ.get("FAKE_ACP_AUTH_ERROR"):
                send({"jsonrpc": "2.0", "id": request_id, "error": AUTH_ERROR})
                continue
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {"sessionId": f"sess-{uuid.uuid4().hex[:8]}"},
                }
            )
        elif method == "session/load":
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        elif method == "session/prompt":
            turn(message)
        elif request_id is not None and method:
            send(
                {"jsonrpc": "2.0", "id": request_id,
                 "error": {"code": -32601, "message": "Method not found"}}
            )


if __name__ == "__main__":
    main()
