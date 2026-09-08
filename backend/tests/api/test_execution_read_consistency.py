import asyncio
import threading
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from test_api import _batch_request

from batchcraft.api import create_app
from batchcraft.application.service import BatchcraftService
from batchcraft.comfyui import ExecutionEvent
from batchcraft.execution import RunExecutionState
from batchcraft.files import PublishedRun
from tools.fake_comfyui import FakeComfyUIClient
from tools.runtime import settings_for


@pytest.mark.parametrize("endpoint", ["", "/execution"])
@pytest.mark.parametrize("transition", ["finish", "start"])
@pytest.mark.parametrize("read_first", [False, True])
def test_execution_read_keeps_polling_across_task_transition(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str,
    transition: str,
    read_first: bool,
) -> None:
    entered, release = threading.Event(), threading.Event()
    submitted, finish, completed = asyncio.Event(), asyncio.Event(), asyncio.Event()

    class ControlledClient(FakeComfyUIClient):
        async def events(self, prompt_id: str) -> AsyncIterator[ExecutionEvent]:
            submitted.set()
            await finish.wait()
            self.ready_at[prompt_id] = 0
            yield ExecutionEvent("execution_success", prompt_id, None, {})

    app = create_app(settings_for("test", tmp_path), client_factory=lambda _: ControlledClient())

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):
            created = await http.post("/api/runs", json=_batch_request(()))
            assert created.status_code == 201
            run_id = created.json()["run_id"]
            registry = app.state.service.task_registry
            original_completed = registry._task_completed

            def task_completed(run_id: str, task: asyncio.Task[RunExecutionState]) -> None:
                original_completed(run_id, task)
                completed.set()

            monkeypatch.setattr(registry, "_task_completed", task_completed)
            if transition == "finish":
                assert (await http.post(f"/api/runs/{run_id}/execute")).status_code == 202
                await asyncio.wait_for(submitted.wait(), 2)
                assert (
                    await http.post(
                        f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"}
                    )
                ).status_code == 202

            original_read = BatchcraftService.get_historical_execution_state
            loop_thread = threading.get_ident()

            def blocked_read(service: BatchcraftService, run: PublishedRun) -> RunExecutionState:
                assert threading.get_ident() != loop_thread
                state = original_read(service, run) if read_first else None
                entered.set()
                assert release.wait(5)
                return state if state is not None else original_read(service, run)

            with monkeypatch.context() as patch:
                patch.setattr(BatchcraftService, "get_historical_execution_state", blocked_read)
                request = asyncio.create_task(http.get(f"/api/runs/{run_id}{endpoint}"))
                try:
                    assert await asyncio.to_thread(entered.wait, 2)
                    assert (await asyncio.wait_for(http.get("/api/health"), 1)).status_code == 200
                    if transition == "finish":
                        finish.set()
                        await asyncio.wait_for(completed.wait(), 2)
                        assert not registry.is_active(run_id)
                    else:
                        assert (await http.post(f"/api/runs/{run_id}/execute")).status_code == 202
                        await asyncio.wait_for(submitted.wait(), 2)
                        assert registry.is_active(run_id)
                finally:
                    release.set()
                response = await request

            assert response.status_code == 200
            execution = response.json() if endpoint else response.json()["execution"]
            expected_status = (
                ("running" if read_first else "cancelled")
                if transition == "finish"
                else ("created" if read_first else "running")
            )
            assert execution["status"] == expected_status
            # Never pair a pre-completion state with lost task ownership.
            assert execution["execution_task_active"] is True

            if transition == "start":
                assert (
                    await http.post(
                        f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"}
                    )
                ).status_code == 202
                finish.set()
                await asyncio.wait_for(completed.wait(), 2)
            response = await http.get(f"/api/runs/{run_id}{endpoint}")
            assert response.status_code == 200
            execution = response.json() if endpoint else response.json()["execution"]
            assert execution["execution_task_active"] is False
            assert execution["status"] == "cancelled"
            assert execution["cancellation"]["state"] == "cancelled"
            assert [job["status"] for job in execution["jobs"]] == [
                "succeeded",
                "cancelled",
                "cancelled",
                "cancelled",
            ]
            assert execution["jobs"][0]["result_count"] == 1
            assert all(job["prompt_id"] is None for job in execution["jobs"][1:])

    asyncio.run(check())
