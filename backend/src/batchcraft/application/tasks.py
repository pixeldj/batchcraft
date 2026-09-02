import asyncio
import logging
from collections.abc import Callable, Coroutine
from dataclasses import dataclass

from batchcraft.db import RunCancellationMode, RunCancellationRequestRecord
from batchcraft.execution import RunExecutionState

from .cancellation import ActiveRunCancellationControl
from .errors import ExecutionAlreadyActiveError, RunDiscardNotEligibleError

logger = logging.getLogger(__name__)

ExecutionCoroutineFactory = Callable[[], Coroutine[object, object, RunExecutionState]]
DiscardOperation = Callable[[], RunExecutionState]


@dataclass(frozen=True, slots=True)
class _ActiveRun:
    task: asyncio.Task[RunExecutionState]
    cancellation_control: ActiveRunCancellationControl


class RunTaskRegistry:
    """Retains and observes local-process Run execution tasks."""

    def __init__(self) -> None:
        self._active_runs: dict[str, _ActiveRun] = {}
        self._lock = asyncio.Lock()

    async def start(
        self,
        run_id: str,
        cancellation_control: ActiveRunCancellationControl,
        factory: ExecutionCoroutineFactory,
    ) -> None:
        async with self._lock:
            self._remove_completed()
            for active_run_id in self._active_runs:
                if active_run_id == run_id:
                    raise ExecutionAlreadyActiveError(f"Run {run_id!r} is already executing")
                raise ExecutionAlreadyActiveError(
                    f"Run {active_run_id!r} is already executing; concurrent Runs are disabled"
                )

            task = asyncio.create_task(factory(), name=f"batchcraft-run-{run_id}")
            self._active_runs[run_id] = _ActiveRun(task, cancellation_control)
            task.add_done_callback(lambda completed: self._task_completed(run_id, completed))

    async def discard(self, run_id: str, operation: DiscardOperation) -> RunExecutionState:
        async with self._lock:
            self._remove_completed()
            if run_id in self._active_runs:
                raise RunDiscardNotEligibleError(f"Run {run_id!r} has an active execution task")
            return operation()

    def is_active(self, run_id: str) -> bool:
        active = self._active_runs.get(run_id)
        return active is not None and not active.task.done()

    async def request_cancellation(
        self, run_id: str, mode: RunCancellationMode
    ) -> tuple[RunCancellationRequestRecord, bool] | None:
        async with self._lock:
            self._remove_completed()
            active = self._active_runs.get(run_id)
            if active is None:
                return None
            requested = await active.cancellation_control.request(mode)
            if mode is RunCancellationMode.DETACH:
                active.task.cancel()
            return requested

    async def shutdown(self) -> None:
        tasks = tuple(active.task for active in self._active_runs.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        async with self._lock:
            self._active_runs.clear()

    def _task_completed(self, run_id: str, task: asyncio.Task[RunExecutionState]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            logger.info("Run execution task was cancelled: %s", run_id)
        except Exception:
            logger.exception("Run execution task failed: %s", run_id)
        asyncio.create_task(self._release(run_id, task))

    async def _release(self, run_id: str, task: asyncio.Task[RunExecutionState]) -> None:
        async with self._lock:
            active = self._active_runs.get(run_id)
            if active is not None and active.task is task:
                self._active_runs.pop(run_id, None)

    def _remove_completed(self) -> None:
        for run_id, active in tuple(self._active_runs.items()):
            if active.task.done():
                self._active_runs.pop(run_id, None)
