"""Bounded NDJSON subprocess transport shared by official Google CLIs."""

import asyncio
import contextlib
import json
import os
import signal
from collections.abc import AsyncIterator, Awaitable, Callable

# While suspended (learner answering a QuestionDock) the idle clock is re-checked at this
# cadence instead of firing.
SUSPEND_POLL_SECONDS = 1.0


class EngineError(RuntimeError):
    """Provider failed; callers must surface this instead of inventing an answer."""


async def idle_wait[T](
    awaitable: Awaitable[T],
    *,
    timeout: float,
    is_suspended: Callable[[], bool] | None = None,
    what: str = "Provider",
) -> T:
    """Await ``awaitable`` with an IDLE timeout: the clock only runs while not suspended.

    ``is_suspended`` is polled; while it returns True (e.g. a ``pose_quiz`` dock is pending
    and the CLI is legitimately blocked inside our MCP tool) the deadline is pushed forward.
    """
    future = asyncio.ensure_future(awaitable)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    try:
        while True:
            suspended = bool(is_suspended and is_suspended())
            if suspended:
                deadline = loop.time() + timeout
                wait = SUSPEND_POLL_SECONDS
            else:
                wait = deadline - loop.time()
                if is_suspended:
                    wait = min(wait, SUSPEND_POLL_SECONDS)
                if wait <= 0:
                    raise EngineError(f"{what} idle for {timeout:g}s without events")
            done, _ = await asyncio.wait({future}, timeout=wait)
            if done:
                return future.result()
    except BaseException:
        future.cancel()
        with contextlib.suppress(BaseException):
            await future
        raise


async def json_events(
    command: list[str],
    *,
    stdin: bytes = b"",
    cwd=None,
    timeout: float = 180,
    env=None,
    is_suspended: Callable[[], bool] | None = None,
) -> AsyncIterator[dict]:
    """Yield NDJSON objects from ``command``.

    ``timeout`` is an IDLE timeout (seconds without a stdout line), suspended while
    ``is_suspended()`` is True. There is no total cap: long lessons legitimately block.
    """
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
        while line := await idle_wait(
            process.stdout.readline(), timeout=timeout, is_suspended=is_suspended
        ):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError) as exc:
                raise EngineError("Provider emitted invalid NDJSON") from exc
            if not isinstance(event, dict):
                raise EngineError("Provider event must be an object")
            yield event
        await idle_wait(process.wait(), timeout=timeout, is_suspended=is_suspended)
        await stderr_task
        if process.returncode:
            # Stderr may contain credentials or user data. Never relay it to the UI.
            raise EngineError(f"Provider process exited with code {process.returncode}")
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), 2)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
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
