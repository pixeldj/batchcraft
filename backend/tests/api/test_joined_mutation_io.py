import asyncio
import importlib
import tempfile
import threading
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.datastructures import UploadFile
from test_api import _batch_request

from batchcraft.api import create_app
from batchcraft.application.service import BatchcraftService
from batchcraft.application.tasks import RunTaskRegistry
from batchcraft.comfyui import ExecutionEvent
from batchcraft.db import RunCancellationMode, RunCancellationRequestRecord
from tools.fake_comfyui import FakeComfyUIClient, sample_png
from tools.runtime import settings_for

app_module = importlib.import_module("batchcraft.api.app")


@pytest.mark.parametrize(
    "operation", ["lookup", "initial_state", "ack_state", "finished_race", "upload"]
)
def test_blocked_mutation_io_keeps_active_run_and_health_responsive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    entered, release = threading.Event(), threading.Event()
    submitted, finish = asyncio.Event(), asyncio.Event()

    class HealthyClient(FakeComfyUIClient):
        async def events(self, prompt_id: str) -> AsyncIterator[ExecutionEvent]:
            submitted.set()
            await finish.wait()
            self.ready_at[prompt_id] = 0
            yield ExecutionEvent("execution_success", prompt_id, None, {})

    app = create_app(settings_for("test", tmp_path), client_factory=lambda _: HealthyClient())

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
            assert (await http.post(f"/api/runs/{run_id}/execute")).status_code == 202
            await asyncio.wait_for(submitted.wait(), 2)
            loop_thread = threading.get_ident()
            method = {
                "lookup": "get_run",
                "initial_state": "get_execution_state",
                "ack_state": "get_execution_state",
                "finished_race": "get_execution_state",
                "upload": "import_project_assets",
            }[operation]
            original = getattr(BatchcraftService, method)
            calls = 0

            def blocked(*args: Any, **kwargs: Any) -> Any:
                nonlocal calls
                assert threading.get_ident() != loop_thread
                calls += 1
                if calls == (2 if operation in {"ack_state", "finished_race"} else 1):
                    entered.set()
                    assert release.wait(5)
                return original(*args, **kwargs)

            monkeypatch.setattr(BatchcraftService, method, blocked)
            if operation == "finished_race":
                registry: RunTaskRegistry = app.state.service.task_registry
                original_request = registry.request_cancellation

                async def finish_before_request(
                    requested_run_id: str, mode: RunCancellationMode
                ) -> tuple[RunCancellationRequestRecord, bool] | None:
                    assert threading.get_ident() == loop_thread
                    finish.set()
                    async with asyncio.timeout(2):
                        while registry.is_active(run_id):
                            await asyncio.sleep(0.01)
                    return await original_request(requested_run_id, mode)

                monkeypatch.setattr(registry, "request_cancellation", finish_before_request)
            request = asyncio.create_task(
                http.post(
                    "/api/projects/project_key/assets",
                    files={"files": ("reference.png", sample_png("upload"), "image/png")},
                )
                if operation == "upload"
                else http.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})
            )
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                for url in ["/api/health", "/api/executions/active"]:
                    response = await asyncio.wait_for(http.get(url), 1)
                    assert response.status_code == 200
                    if url.endswith("active"):
                        assert response.json() == {
                            "run_id": None if operation == "finished_race" else run_id
                        }
                tick = asyncio.Event()
                asyncio.get_running_loop().call_later(0.01, tick.set)
                await asyncio.wait_for(tick.wait(), 1)
                assert not request.done()
                if operation == "ack_state":
                    finish.set()
                    # The post-registry read must observe the new terminal outcome.
                    async with asyncio.timeout(2):
                        while app.state.service.execution_task_active(run_id):
                            await asyncio.sleep(0.01)
            finally:
                release.set()
            response = await request
            assert response.status_code == (
                201 if operation == "upload" else 409 if operation == "finished_race" else 202
            )
            if operation == "finished_race":
                assert response.json()["error"]["code"] == "run_cancellation_not_eligible"
                assert (
                    app.state.service.cancellation_store.get(
                        run_id, RunCancellationMode.AFTER_CURRENT_JOB
                    )
                    is None
                )
            if operation == "ack_state":
                assert response.json()["state"] == "cancelled"
            if operation not in {"upload", "finished_race"}:
                repeated = await http.post(
                    f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"}
                )
                assert repeated.status_code == 202
                assert repeated.json()["created"] is False
                assert repeated.json()["requested_at"] == response.json()["requested_at"]

    asyncio.run(check())


@pytest.mark.parametrize("phase", ["staging", "import", "cleanup"])
@pytest.mark.parametrize("ending", ["normal", "repeated_cancel", "shutdown"])
def test_upload_worker_owns_parser_files_and_tempdir_until_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str, ending: str
) -> None:
    entered, release, completed = threading.Event(), threading.Event(), threading.Event()
    uploads: list[UploadFile] = []
    roots: list[Path] = []
    loop_threads: list[int] = []
    original_stage = app_module._stage_asset_uploads
    original_import = BatchcraftService.import_project_assets
    original_cleanup = tempfile.TemporaryDirectory.cleanup
    content = sample_png("joined upload")

    def pause() -> None:
        assert threading.get_ident() != loop_threads[0]
        entered.set()
        assert release.wait(5)
        assert uploads and all(not upload.file.closed for upload in uploads)
        assert roots[0].is_dir()

    def stage(files: list[UploadFile], root: Path) -> Any:
        uploads.extend(files)
        roots.append(root)
        if phase == "staging":
            pause()
        return original_stage(files, root)

    def import_assets(*args: Any, **kwargs: Any) -> Any:
        if phase == "import":
            pause()
        return original_import(*args, **kwargs)

    def cleanup(directory: Any) -> None:
        if roots and Path(directory.name) == roots[0]:
            assert threading.get_ident() != loop_threads[0]
            if phase == "cleanup":
                pause()
            original_cleanup(directory)
            completed.set()
        else:
            original_cleanup(directory)

    monkeypatch.setattr(app_module, "_stage_asset_uploads", stage)
    monkeypatch.setattr(BatchcraftService, "import_project_assets", import_assets)
    monkeypatch.setattr(tempfile.TemporaryDirectory, "cleanup", cleanup)
    app = create_app(settings_for("test", tmp_path), client_factory=lambda _: FakeComfyUIClient())
    requests: list[asyncio.Task[httpx.Response]] = []

    async def upload() -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
        ) as http:
            return await http.post(
                "/api/projects/project_key/assets",
                files={"files": ("../reference.png", content, "image/png")},
            )

    async def check() -> None:
        loop_threads.append(threading.get_ident())
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http:
                assert (await http.post("/api/runs", json=_batch_request(()))).status_code == 201
            request = asyncio.create_task(upload())
            requests.append(request)
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                if ending == "shutdown":
                    timer.start()
                    return  # asyncio.run cancels all outstanding Tasks.
                if ending == "repeated_cancel":
                    for _ in range(3):
                        request.cancel()
                        await asyncio.sleep(0)
                    assert not request.done()
                    assert not completed.is_set()
                    assert all(not item.file.closed for item in uploads)
            finally:
                if ending != "shutdown":
                    release.set()
            if ending == "repeated_cancel":
                with pytest.raises(asyncio.CancelledError):
                    await request
            else:
                assert (await request).status_code == 201

    timer = threading.Timer(0.1, release.set)
    try:
        asyncio.run(check())
    finally:
        release.set()
        if timer.ident is not None:
            timer.join()
    assert completed.is_set()
    assert requests[0].done()
    assert all(upload.file.closed for upload in uploads)
    assert not roots[0].exists()
    # Cancellation must not roll back content-addressed assets already published by the worker.
    assets = app.state.service.list_project_assets("project_key")
    assert len(assets) == 1
    assert assets[0].byte_size == len(content)
