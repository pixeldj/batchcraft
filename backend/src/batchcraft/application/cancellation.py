import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from batchcraft.db import (
    RunCancellationMode,
    RunCancellationRequestRecord,
    RunCancellationRequestStore,
)


class ActiveRunCancellationControl:
    """Coordinates durable cancellation intent with Job submission admission."""

    def __init__(
        self,
        run_id: str,
        store: RunCancellationRequestStore,
        *,
        requested: bool = False,
        detach_requested: bool = False,
    ) -> None:
        self.run_id = run_id
        self._store = store
        self._lock = asyncio.Lock()
        self._requested = requested
        self._detach_requested = detach_requested

    def cancellation_requested(self) -> bool:
        return self._requested or self._detach_requested

    def detach_requested(self) -> bool:
        return self._detach_requested

    @asynccontextmanager
    async def submission_admission(self) -> AsyncIterator[bool]:
        async with self._lock:
            yield not (self._requested or self._detach_requested)

    async def request(self, mode: RunCancellationMode) -> tuple[RunCancellationRequestRecord, bool]:
        async with self._lock:
            record, created = await asyncio.to_thread(
                self._store.request,
                self.run_id,
                mode,
            )
            if mode is RunCancellationMode.DETACH:
                self._detach_requested = True
            else:
                self._requested = True
            return record, created
