"""Fake ``agy`` stream-json process replaying the real 1.4.7 transcript turn by turn.

Env: ``FAKE_AGY_LOG`` (JSONL log of start/prompt), ``FAKE_AGY_MODE`` = replay | die.
"""

import json
import os
import sys
from pathlib import Path

FIXTURE = Path(__file__).with_name("agy-1.4.7-two-turns-json-schema-real.ndjson")


def turns():
    lines = FIXTURE.read_text(encoding="utf-8").splitlines()
    init, rest = lines[0], lines[1:]
    groups, current = [], []
    for line in rest:
        current.append(line)
        if json.loads(line)["event"] == "result":
            groups.append(current)
            current = []
    return init, groups


def log(entry):
    path = os.environ.get("FAKE_AGY_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")


def main():
    mode = os.environ.get("FAKE_AGY_MODE", "replay")
    log({"start": os.getpid(), "argv": sys.argv[1:], "cwd": os.getcwd()})
    init, groups = turns()
    print(init, flush=True)
    for index, line in enumerate(sys.stdin):
        request = json.loads(line)
        assert request["event"] == "user" and request["message"]["content"]
        log({"pid": os.getpid(), "prompt": request["message"]["content"]})
        if mode == "die":
            sys.exit(7)
        for event in groups[index % len(groups)]:
            print(event, flush=True)


if __name__ == "__main__":
    main()
