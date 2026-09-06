"""Request-owned verified snapshots; workers never outlive their open files."""

import asyncio
import math
import tempfile
from collections import deque
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import BinaryIO

from starlette.responses import Response, StreamingResponse
from starlette.types import Receive, Scope, Send

from batchcraft._async_io import file_operation as file_operation


class ReadCapacityExceeded(Exception):
    pass


class ReadCapacity:
    """Event-loop-only bounded FIFO admission, without workers for waiting requests."""

    def __init__(
        self, limit: int, *, max_waiters: int = 8, wait_timeout_seconds: float = 5.0
    ) -> None:
        if limit < 1 or max_waiters < 1:
            raise ValueError("Read capacity and waiting capacity must be positive")
        if not math.isfinite(wait_timeout_seconds) or wait_timeout_seconds <= 0:
            raise ValueError("Read wait timeout must be positive and finite")
        self.limit = limit
        self.max_waiters = max_waiters
        self.wait_timeout_seconds = wait_timeout_seconds
        self.active = 0
        self._waiters: deque[asyncio.Future[None]] = deque()

    @asynccontextmanager
    async def claim(self) -> AsyncIterator[None]:
        if self.active < self.limit and not self._waiters:
            self.active += 1
        else:
            if len(self._waiters) >= self.max_waiters:
                raise ReadCapacityExceeded
            loop = asyncio.get_running_loop()
            waiter: asyncio.Future[None] = loop.create_future()
            deadline = loop.time() + self.wait_timeout_seconds
            self._waiters.append(waiter)
            try:
                async with asyncio.timeout_at(deadline):
                    await asyncio.shield(waiter)
                    if loop.time() >= deadline:
                        raise TimeoutError
            except BaseException as error:
                # A completed waiter already owns a reserved slot, even if it
                # was cancelled or timed out before resuming after the grant.
                if waiter.done():
                    self._release()
                else:
                    self._waiters.remove(waiter)
                    waiter.cancel()
                if isinstance(error, TimeoutError):
                    raise ReadCapacityExceeded from error
                raise
        try:
            yield
        finally:
            self._release()

    def _release(self) -> None:
        self.active -= 1
        if self._waiters:
            waiter = self._waiters.popleft()
            self.active += 1
            waiter.set_result(None)


class ArtifactResponse(Response):
    def __init__(self, prepare: Callable[[BinaryIO], Response], capacity: ReadCapacity) -> None:
        super().__init__()
        self.prepare = prepare
        self.capacity = capacity

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        snapshot: BinaryIO | None = None

        def prepare() -> Response:
            nonlocal snapshot
            snapshot = tempfile.TemporaryFile(mode="w+b")  # noqa: SIM115 - closed after streaming
            return self.prepare(snapshot)

        async with self.capacity.claim():
            try:
                response = await file_operation(prepare)
                await response(scope, receive, send)
            finally:
                if snapshot is not None:
                    await file_operation(snapshot.close)


def snapshot_response(
    snapshot: BinaryIO, *, size: int, media_type: str | None, headers: dict[str, str] | None = None
) -> Response:
    async def chunks() -> AsyncIterator[bytes]:
        while chunk := await file_operation(lambda: snapshot.read(64 * 1024)):
            yield chunk

    return StreamingResponse(
        chunks(),
        media_type=media_type,
        headers={**(headers or {}), "Content-Length": str(size)},
    )
