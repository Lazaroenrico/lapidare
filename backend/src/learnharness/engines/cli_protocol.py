"""Bounded NDJSON subprocess transport shared by official Google CLIs."""

import asyncio
import json
import os
import signal
from collections.abc import AsyncIterator


class EngineError(RuntimeError):
    """Provider failed; callers must surface this instead of inventing an answer."""


async def json_events(
    command: list[str], *, stdin: bytes = b"", cwd=None, timeout: float = 180, env=None
) -> AsyncIterator[dict]:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
        start_new_session=True,
        limit=4 * 1024 * 1024,
    )
    stderr_tail = bytearray()

    async def drain():
        while chunk := await process.stderr.read(8192):
            stderr_tail.extend(chunk)
            del stderr_tail[:-16384]

    async def feed():
        try:
            process.stdin.write(stdin)
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            process.stdin.close()

    stderr_task = asyncio.create_task(drain())
    input_task = asyncio.create_task(feed())
    try:
        async with asyncio.timeout(timeout):
            while line := await process.stdout.readline():
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeDecodeError) as exc:
                    raise EngineError("Provider emitted invalid NDJSON") from exc
                if not isinstance(event, dict):
                    raise EngineError("Provider event must be an object")
                yield event
            await process.wait()
            await stderr_task
            if process.returncode:
                # Stderr may contain credentials or user data. Never relay it to the UI.
                raise EngineError(f"Provider process exited with code {process.returncode}")
    except TimeoutError as exc:
        raise EngineError(f"Provider timed out after {timeout:g}s") from exc
    finally:
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), 2)
            except TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
        for task in (input_task, stderr_task):
            task.cancel()
        await asyncio.gather(input_task, stderr_task, return_exceptions=True)


def transcript(prompt, history=None, system_instruction=None):
    messages = [{"role": m.role, "content": m.content} for m in history or []]
    if system_instruction:
        messages.insert(0, {"role": "system", "content": system_instruction})
    messages.append({"role": "user", "content": prompt})
    return "Continue this learning conversation. Follow the system instructions.\n" + json.dumps(
        messages, ensure_ascii=False
    )
