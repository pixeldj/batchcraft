import asyncio
import logging
from collections.abc import Callable, Coroutine

from batchcraft.execution import RunExecutionState

from .errors import ExecutionAlreadyActiveError, RunDiscardNotEligibleError

logger = logging.getLogger(__name__)

ExecutionCoroutineFactory = Callable[[], Coroutine[object, object, RunExecutionState]]
DiscardOperation = Callable[[], RunExecutionState]


class RunTaskRegistry:
    """Retains and observes local-process Run execution tasks."""

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[RunExecutionState]] = {}
        self._lock = asyncio.Lock()

    async def start(self, run_id: str, factory: ExecutionCoroutineFactory) -> None:
        async with self._lock:
            self._remove_completed()
            for active_run_id in self._tasks:
                if active_run_id == run_id:
                    raise ExecutionAlreadyActiveError(f"Run {run_id!r} is already executing")
                raise ExecutionAlreadyActiveError(
                    f"Run {active_run_id!r} is already executing; concurrent Runs are disabled"
                )

            task = asyncio.create_task(factory(), name=f"batchcraft-run-{run_id}")
            self._tasks[run_id] = task
            task.add_done_callback(lambda completed: self._task_completed(run_id, completed))

    async def discard(self, run_id: str, operation: DiscardOperation) -> RunExecutionState:
        async with self._lock:
            self._remove_completed()
            if run_id in self._tasks:
                raise RunDiscardNotEligibleError(f"Run {run_id!r} has an active execution task")
            return operation()

    def is_active(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return task is not None and not task.done()

    async def shutdown(self) -> None:
        tasks = tuple(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    def _task_completed(self, run_id: str, task: asyncio.Task[RunExecutionState]) -> None:
        if self._tasks.get(run_id) is task:
            self._tasks.pop(run_id, None)
        try:
            task.result()
        except asyncio.CancelledError:
            logger.info("Run execution task was cancelled during application shutdown: %s", run_id)
        except Exception:
            logger.exception("Run execution task failed: %s", run_id)

    def _remove_completed(self) -> None:
        for run_id, task in tuple(self._tasks.items()):
            if task.done():
                self._tasks.pop(run_id, None)
