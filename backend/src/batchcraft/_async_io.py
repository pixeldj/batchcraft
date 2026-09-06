"""Joined worker operations that retain ownership through cancellation."""

import asyncio
from collections.abc import Callable
from contextvars import copy_context

import anyio


async def file_operation[T](operation: Callable[[], T]) -> T:
    # A Future, rather than a Task wrapping to_thread, also survives the loop's
    # shutdown cancellation of all Tasks until the actual file operation ends.
    worker = asyncio.get_running_loop().run_in_executor(None, copy_context().run, operation)
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        # asyncio cancellation cannot stop a filesystem call. Join it without
        # blocking the loop, including repeated shutdown cancellation.
        with anyio.CancelScope(shield=True):
            while not worker.done():
                try:
                    await asyncio.shield(worker)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
        if not worker.cancelled():
            worker.exception()
        raise
