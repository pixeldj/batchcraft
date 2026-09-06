import asyncio
import hashlib
import os
import tempfile
import threading
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO, cast

import anyio
import httpx
import pytest
from artifact_fixture import write_artifact_fixture
from fastapi.testclient import TestClient
from starlette.responses import Response
from starlette.types import Message, Scope

from batchcraft.api import create_app
from batchcraft.api.artifacts import (
    ArtifactResponse,
    ReadCapacity,
    ReadCapacityExceeded,
    snapshot_response,
)
from batchcraft.application import RunTaskRegistry
from batchcraft.application import service as service_module
from batchcraft.files import ProjectAssetStore
from batchcraft.files._io import open_regular_file
from tools.fake_comfyui import FakeComfyUIClient, sample_png
from tools.runtime import application, settings_for


@pytest.mark.parametrize("kind", ["result", "asset"])
def test_large_verified_snapshot_exact_bytes_headers_and_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    content = sample_png("stream") + b"x" * (3 * 1024 * 1024 + 17)
    settings = settings_for("test", tmp_path)
    execution = write_artifact_fixture(settings.projects_root, [(content, "image/png", "png")])
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    spools: list[BinaryIO] = []
    original = tempfile.TemporaryFile

    def tracked(*args: Any, **kwargs: Any) -> BinaryIO:
        file = original(*args, **kwargs)
        spools.append(file)
        return cast(BinaryIO, file)

    monkeypatch.setattr("batchcraft.api.artifacts.tempfile.TemporaryFile", tracked)
    reads: list[int] = []

    @contextmanager
    def bounded(path: Path) -> Iterator[BinaryIO]:
        with open_regular_file(path) as file:

            class Reader:
                def read(self, size: int = -1) -> bytes:
                    assert 0 < size <= 1024 * 1024
                    reads.append(size)
                    return file.read(size)

            yield cast(BinaryIO, Reader())

    monkeypatch.setattr(service_module, "open_regular_file", bounded)
    with TestClient(app, base_url="http://localhost:8002") as http:
        url = "/api/runs/run-id/results/1/1"
        if kind == "asset":
            uploaded = http.post(
                "/api/projects/project_key/assets",
                files={"files": ("large.png", content, "image/png")},
            )
            assert uploaded.status_code == 201
            asset_id = uploaded.json()["assets"][0]["asset_id"]
            url = f"/api/projects/project_key/assets/{asset_id}/content"
        before = execution.read_bytes()
        response = http.get(url)
    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-length"] == str(len(content))
    assert response.headers["content-type"] == "image/png"
    if kind == "result":
        assert response.headers["content-disposition"] == "inline; filename*=UTF-8''000001-01.png"
        assert response.headers["x-content-type-options"] == "nosniff"
    assert reads
    assert spools and all(file.closed for file in spools)
    assert execution.read_bytes() == before


@pytest.mark.parametrize(
    "endpoint", ["download", "asset", "listing", "run", "execution", "reconstruction"]
)
def test_blocked_read_does_not_block_health_or_active_polling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, endpoint: str
) -> None:
    settings = settings_for("test", tmp_path)
    write_artifact_fixture(settings.projects_root, [(sample_png("blocked"), "image/png", "png")])
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    entered, release = threading.Event(), threading.Event()
    method = (
        "_read_asset_content"
        if endpoint == "asset"
        else "_read_result"
        if endpoint in {"download", "listing"}
        else "get_historical_run"
    )
    target = service_module if method.startswith("_read_") else service_module.BatchcraftService
    original = getattr(target, method)

    def blocked(*args: Any, **kwargs: Any) -> Any:
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    monkeypatch.setattr(target, method, blocked)
    suffix = {
        "download": "/results/1/1",
        "asset": "",
        "listing": "/results",
        "run": "",
        "execution": "/execution",
        "reconstruction": "/batch-reconstruction",
    }[endpoint]
    url = "/api/runs/run-id" + suffix
    if endpoint == "asset":
        source = tmp_path / "reference.png"
        source.write_bytes(sample_png("asset polling"))
        asset = ProjectAssetStore(settings.projects_root / "project_key").import_file(source)
        url = f"/api/projects/project_key/assets/{asset.asset_id}/content"

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):
            request = asyncio.create_task(http.get(url))
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                for polling_url in ["/api/health", "/api/executions/active"]:
                    assert (await asyncio.wait_for(http.get(polling_url), 1)).status_code == 200
                if endpoint in {"download", "asset", "listing"}:
                    assert (
                        await asyncio.wait_for(http.get("/api/runs/run-id/execution"), 1)
                    ).status_code == 200
                assert not request.done()
            finally:
                release.set()
            assert (await request).status_code == 200

    asyncio.run(check())


@pytest.mark.parametrize("kind", ["corrupt", "symlink", "fifo"])
def test_invalid_result_rejected_before_success(tmp_path: Path, kind: str) -> None:
    settings = settings_for("test", tmp_path)
    content = sample_png("invalid")
    execution = write_artifact_fixture(settings.projects_root, [(content, "image/png", "png")])
    path = execution.parent / "outputs/000001-01.png"
    path.unlink()
    if kind == "corrupt":
        path.write_bytes(b"x" * len(content))
    elif kind == "symlink":
        target = tmp_path / "outside.png"
        target.write_bytes(content)
        path.symlink_to(target)
    else:
        os.mkfifo(path)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url="http://localhost:8002") as http:
        # A daemon caller gives this regression a deadline even if a FIFO open regresses.
        responses = []
        worker = threading.Thread(
            target=lambda: responses.append(http.get("/api/runs/run-id/results/1/1")), daemon=True
        )
        worker.start()
        worker.join(3)
        if worker.is_alive() and kind == "fifo":
            writer = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
            os.close(writer)
            worker.join(3)
            pytest.fail("Result download waited for a FIFO writer")
        assert not worker.is_alive()
        assert responses[0].status_code == 500
        assert responses[0].json()["error"]["code"] == "invalid_run_data"


@pytest.mark.parametrize("finish", ["normal", "disconnect", "send_error", "cancel"])
def test_stream_owns_temp_until_workers_finish(finish: str) -> None:
    snapshots: list[BinaryIO] = []
    entered, release = threading.Event(), threading.Event()
    content = b"x" * (2 * 1024 * 1024 + 3)

    def prepare(snapshot: BinaryIO) -> Response:
        snapshots.append(snapshot)
        if finish == "cancel":
            entered.set()
            assert release.wait(5)
            assert not snapshot.closed
        snapshot.write(content)
        snapshot.seek(0)
        return snapshot_response(snapshot, size=len(content), media_type="application/octet-stream")

    async def check() -> None:
        first_chunk = asyncio.Event()
        digest = hashlib.sha256()
        sizes: list[int] = []
        scope: Scope = {"type": "http", "asgi": {"spec_version": "2.0"}}

        async def receive() -> Message:
            await first_chunk.wait()
            if finish == "disconnect":
                return {"type": "http.disconnect"}
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        async def send(message: Message) -> None:
            if message["type"] == "http.response.body":
                chunk = message.get("body", b"")
                sizes.append(len(chunk))
                digest.update(chunk)
                first_chunk.set()
                if finish == "send_error":
                    raise OSError("disconnected")
                if finish == "disconnect":
                    await asyncio.Event().wait()

        capacity = ReadCapacity(1, wait_timeout_seconds=0.01)
        task = asyncio.create_task(ArtifactResponse(prepare, capacity)(scope, receive, send))
        if finish == "cancel":
            assert await asyncio.to_thread(entered.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            assert not snapshots[0].closed
            assert capacity.active == 1
            with pytest.raises(ReadCapacityExceeded):
                async with capacity.claim():
                    pytest.fail("a cancelled writer must retain capacity until it finishes")
            assert capacity.active == 1
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
        elif finish == "send_error":
            with pytest.raises(OSError, match="disconnected"):
                await task
        else:
            await task
        assert snapshots and all(file.closed for file in snapshots)
        assert capacity.active == 0
        assert all(size <= 64 * 1024 for size in sizes)
        if finish == "normal":
            assert digest.digest() == hashlib.sha256(content).digest()
        if finish == "disconnect":
            assert sum(sizes) == 64 * 1024

    asyncio.run(check())


def test_snapshot_survives_in_place_source_change(tmp_path: Path) -> None:
    settings = settings_for("test", tmp_path)
    content = sample_png("snapshot")
    execution = write_artifact_fixture(settings.projects_root, [(content, "image/png", "png")])
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url="http://localhost:8002"), tempfile.TemporaryFile() as snapshot:
        service = app.state.service
        run = service.get_run("run-id")
        result = service.get_result(run, 1, 1, snapshot)
        (execution.parent / result.local_path).write_bytes(b"x" * len(content))
        assert snapshot.read() == content


@pytest.mark.parametrize("change", ["pathname", "in_place"])
def test_changes_during_snapshot_use_only_verified_descriptor_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    settings = settings_for("test", tmp_path)
    content = sample_png("race") + b"x" * (2 * 1024 * 1024)
    execution = write_artifact_fixture(settings.projects_root, [(content, "image/png", "png")])
    source = execution.parent / "outputs/000001-01.png"
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"y" * len(content))

    @contextmanager
    def changed(path: Path) -> Iterator[BinaryIO]:
        with open_regular_file(path) as file:
            if change == "pathname":
                path.unlink()
                path.symlink_to(outside)
            else:
                path.write_bytes(b"y" * len(content))
            yield file

    monkeypatch.setattr(service_module, "open_regular_file", changed)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url="http://localhost:8002") as http:
        response = http.get("/api/runs/run-id/results/1/1")
    assert source.exists()
    if change == "pathname":
        assert response.status_code == 200
        assert response.content == content
    else:
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "invalid_run_data"


def test_parent_symlink_is_not_followed(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    (real / "result").write_bytes(b"untrusted")
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(OSError), open_regular_file(link / "result"):
        pytest.fail("parent symlink must not be traversed")


def test_preparation_failure_closes_temp_without_starting_http() -> None:
    snapshots: list[BinaryIO] = []

    def prepare(snapshot: BinaryIO) -> Response:
        snapshots.append(snapshot)
        snapshot.write(b"partial")
        raise OSError("disk failure")

    async def check() -> None:
        messages: list[Message] = []

        async def receive() -> Message:
            return {"type": "http.disconnect"}

        async def send(message: Message) -> None:
            messages.append(message)

        with pytest.raises(OSError, match="disk failure"):
            await ArtifactResponse(prepare, ReadCapacity(1))({"type": "http"}, receive, send)
        assert not messages
        assert snapshots[0].closed

    asyncio.run(check())


@pytest.mark.parametrize("_attempt", range(3))
def test_event_loop_shutdown_joins_snapshot_writer_before_close(_attempt: int) -> None:
    entered, release, wrote = threading.Event(), threading.Event(), threading.Event()
    snapshots: list[BinaryIO] = []
    capacity = ReadCapacity(1, max_waiters=4)

    def prepare(snapshot: BinaryIO) -> Response:
        snapshots.append(snapshot)
        entered.set()
        assert release.wait(5)
        assert not snapshot.closed
        snapshot.write(b"verified")
        wrote.set()
        snapshot.seek(0)
        return snapshot_response(snapshot, size=8, media_type="application/octet-stream")

    async def check() -> None:
        async def receive() -> Message:
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        async def send(message: Message) -> None:
            pytest.fail("shutdown must not start an HTTP response")

        asyncio.create_task(ArtifactResponse(prepare, capacity)({"type": "http"}, receive, send))
        assert await asyncio.to_thread(entered.wait, 2)
        for _ in range(4):
            asyncio.create_task(
                ArtifactResponse(prepare, capacity)({"type": "http"}, receive, send)
            )
        await asyncio.sleep(0)
        assert len(capacity._waiters) == 4
        assert len(snapshots) == 1
        # Returning from main makes asyncio.run cancel every remaining Task.
        timer.start()

    timer = threading.Timer(0.1, release.set)
    try:
        asyncio.run(check())
    finally:
        release.set()
        timer.join()
    assert wrote.is_set()
    assert snapshots[0].closed
    assert len(snapshots) == 1
    assert capacity.active == 0
    assert not capacity._waiters


def test_runtime_temporary_directory_storage_is_canonical_and_readable() -> None:
    # Deliberately use runtime.main's convention, not pytest's resolved tmp_path.
    with tempfile.TemporaryDirectory(prefix="batchcraft-e2e-") as temporary_directory:
        root = Path(temporary_directory)
        settings = settings_for("test", root)
        assert settings.data_root == root.resolve()
        assert settings.database_path == root.resolve() / "batchcraft.sqlite3"
        assert settings.projects_root == root.resolve() / "projects"
        content = sample_png("runtime temp")
        write_artifact_fixture(root / "projects", [(content, "image/png", "png")])
        with TestClient(application("test", settings), base_url="http://localhost:8002") as http:
            assert (
                http.post(
                    "/api/projects/import", json={"filesystem_key": "project_key"}
                ).status_code
                == 201
            )
            for url in [
                "/api/projects/project-id",
                "/api/projects/project-id/runs",
                "/api/runs/run-id",
                "/api/runs/run-id/execution",
                "/api/runs/run-id/results",
            ]:
                assert http.get(url).status_code == 200
            assert http.get("/api/runs/run-id/results/1/1").content == content
            asset = http.post(
                "/api/projects/project_key/assets",
                files={"files": ("reference.png", content, "image/png")},
            )
            assert asset.status_code == 201
            assert http.get(asset.json()["assets"][0]["content_url"]).content == content


def test_only_configured_storage_anchor_is_resolved(tmp_path: Path) -> None:
    original = tmp_path / "original"
    original.mkdir()
    alias = tmp_path / "configured-alias"
    alias.symlink_to(original, target_is_directory=True)
    settings = settings_for("test", alias)
    content = sample_png("canonical root")
    execution = write_artifact_fixture(settings.projects_root, [(content, "image/png", "png")])
    aliased_file = alias / execution.relative_to(original)
    with pytest.raises(OSError), open_regular_file(aliased_file):
        pytest.fail("low-level readers must not resolve a supplied path")
    with TestClient(application("test", settings), base_url="http://localhost:8002") as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        # Changing the trusted alias after Settings construction does not repoint storage.
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        alias.unlink()
        alias.symlink_to(elsewhere, target_is_directory=True)
        assert http.get("/api/projects/project-id/runs").status_code == 200
        assert http.get("/api/runs/run-id/results/1/1").content == content
        # An internal symlink remains unsafe even if it points at the same valid bytes.
        outputs = execution.parent / "outputs"
        moved = execution.parent / "moved-outputs"
        outputs.rename(moved)
        outputs.symlink_to(moved, target_is_directory=True)
        response = http.get("/api/runs/run-id/results/1/1")
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "invalid_run_data"


@pytest.mark.parametrize(
    ("kind", "request_count"),
    [("listing", 40), ("download", 40), ("execution", 40), ("download", 6)],
)
def test_read_bursts_queue_without_starving_control_or_polling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str, request_count: int
) -> None:
    settings = settings_for("test", tmp_path)
    write_artifact_fixture(settings.projects_root, [(sample_png("capacity"), "image/png", "png")])
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    entered, release = threading.Event(), threading.Event()
    lock = threading.Lock()
    started = 0
    capacity = 2 if kind == "execution" else 4
    waiting_capacity = 4 if kind == "execution" else 8
    accepted = min(request_count, capacity + waiting_capacity)
    snapshots: list[BinaryIO] = []
    original_tempfile = tempfile.TemporaryFile

    def tracked_tempfile(*args: Any, **kwargs: Any) -> BinaryIO:
        snapshot = cast(BinaryIO, original_tempfile(*args, **kwargs))
        snapshots.append(snapshot)
        return snapshot

    monkeypatch.setattr("batchcraft.api.artifacts.tempfile.TemporaryFile", tracked_tempfile)
    method = {
        "listing": "list_results",
        "download": "get_result",
        "execution": "get_historical_execution_state",
    }[kind]
    original = getattr(service_module.BatchcraftService, method)

    def blocked(*args: Any, **kwargs: Any) -> Any:
        nonlocal started
        with lock:
            started += 1
            if started == capacity:
                entered.set()
        assert release.wait(10)
        return original(*args, **kwargs)

    monkeypatch.setattr(service_module.BatchcraftService, method, blocked)

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):
            loop_thread = threading.get_ident()
            registry = cast(RunTaskRegistry, app.state.service.task_registry)
            is_active = registry.is_active

            def checked_active(run_id: str) -> bool:
                assert threading.get_ident() == loop_thread
                return is_active(run_id)

            monkeypatch.setattr(registry, "is_active", checked_active)
            url = (
                "/api/runs/run-id"
                + {
                    "listing": "/results",
                    "download": "/results/1/1",
                    "execution": "/execution",
                }[kind]
            )

            async def empty_body() -> AsyncIterator[bytes]:
                # Match Uvicorn's single terminal empty frame. httpx's default
                # ByteStream emits an empty nonterminal frame and leases body capacity.
                chunks: tuple[bytes, ...] = ()
                for chunk in chunks:
                    yield chunk

            requests = [
                asyncio.create_task(http.request("GET", url, content=empty_body()))
                for _ in range(request_count)
            ]
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                done, pending = await asyncio.wait(requests, timeout=1)
                assert len(done) == request_count - accepted
                assert len(pending) == accepted
                assert started == capacity
                assert len(snapshots) == (capacity if kind == "download" else 0)
                for task in done:
                    response = task.result()
                    assert response.status_code == 503
                    assert response.headers["retry-after"] == "1"
                    assert response.json()["error"]["code"] == "read_capacity_exceeded"
                # Other bulk routes share the same budget, not one budget per URL.
                if kind == "execution":
                    assert (
                        await asyncio.wait_for(http.get("/api/projects/project_key/assets"), 1)
                    ).status_code == 200
                elif request_count == 40:
                    for path in ["/api/runs/run-id", "/api/projects/project_key/assets"]:
                        assert (await asyncio.wait_for(http.get(path), 1)).status_code == 503
                for path in ["/api/health", "/api/executions/active", "/api/runs/run-id/execution"]:
                    response = await asyncio.wait_for(http.get(path), 1)
                    if kind == "execution" and path.endswith("/execution"):
                        assert response.status_code == 503
                        continue
                    assert response.status_code == 200
                    if path.endswith("/execution"):
                        assert response.json()["status"] == "created"
                        assert response.json()["execution_task_active"] is False
                cancellation = await asyncio.wait_for(
                    http.post("/api/runs/run-id/cancel", json={"mode": "after_current_job"}), 1
                )
                assert cancellation.status_code == 409
                assert cancellation.json()["error"]["code"] == "run_cancellation_not_eligible"
            finally:
                release.set()
                responses = await asyncio.gather(*requests)
            assert sum(response.status_code == 200 for response in responses) == accepted
            assert started == accepted
            if kind == "download":
                assert len(snapshots) == accepted
                assert all(snapshot.closed for snapshot in snapshots)
            assert (await http.get("/api/runs/run-id")).status_code == 200

    asyncio.run(check())


def test_full_anyio_pool_cannot_hold_dependencies_or_execution_polling(tmp_path: Path) -> None:
    settings = settings_for("test", tmp_path)
    write_artifact_fixture(settings.projects_root, [(sample_png("pool"), "image/png", "png")])
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    entered, release = threading.Event(), threading.Event()
    lock = threading.Lock()
    started = 0

    def blocked() -> None:
        nonlocal started
        with lock:
            started += 1
            if started == 40:
                entered.set()
        assert release.wait(10)

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):
            limiter = anyio.to_thread.current_default_thread_limiter()
            assert limiter.total_tokens == 40
            workers = [asyncio.create_task(anyio.to_thread.run_sync(blocked)) for _ in range(40)]
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                for url in [
                    "/api/health",
                    "/api/executions/active",
                    "/api/runs/run-id/execution",
                    "/api/projects",
                ]:
                    assert (await asyncio.wait_for(http.get(url), 1)).status_code == 200
                response = await asyncio.wait_for(
                    http.post("/api/runs/run-id/cancel", json={"mode": "after_current_job"}), 1
                )
                assert response.status_code == 409
            finally:
                release.set()
                await asyncio.gather(*workers)

    asyncio.run(check())


@pytest.mark.parametrize("cancel_after_grant", [False, True])
def test_fifo_waiter_cancellation_returns_reserved_slots(cancel_after_grant: bool) -> None:
    async def check() -> None:
        capacity = ReadCapacity(1, max_waiters=3)
        holder = capacity.claim()
        await holder.__aenter__()
        entered: list[int] = []
        release = asyncio.Event()

        async def request(index: int) -> None:
            async with capacity.claim():
                assert capacity.active == 1
                entered.append(index)
                await release.wait()

        tasks = [asyncio.create_task(request(index)) for index in range(3)]
        await asyncio.sleep(0)
        assert len(capacity._waiters) == 3
        with pytest.raises(ReadCapacityExceeded):
            async with capacity.claim():
                pytest.fail("overflow must not acquire a slot")
        if cancel_after_grant:
            await holder.__aexit__(None, None, None)
            assert capacity.active == 1
        tasks[0].cancel()
        tasks[0].cancel()
        with pytest.raises(asyncio.CancelledError):
            await tasks[0]
        if not cancel_after_grant:
            await holder.__aexit__(None, None, None)
        # This newcomer must not bypass the two surviving FIFO waiters.
        newcomer = asyncio.create_task(request(3))
        await asyncio.sleep(0)
        release.set()
        await asyncio.wait_for(asyncio.gather(*tasks[1:], newcomer), 1)
        assert entered == [1, 2, 3]
        assert capacity.active == 0
        assert not capacity._waiters

    asyncio.run(check())


@pytest.mark.parametrize("grant_after_deadline", [False, True])
def test_wait_deadline_removes_waiter_or_returns_late_grant(grant_after_deadline: bool) -> None:
    async def check() -> None:
        capacity = ReadCapacity(1, max_waiters=1, wait_timeout_seconds=0.01)
        holder = capacity.claim()
        await holder.__aenter__()

        async def request() -> None:
            async with capacity.claim():
                pytest.fail("an expired waiter must never start work")

        task = asyncio.create_task(request())
        await asyncio.sleep(0)
        assert len(capacity._waiters) == 1
        if grant_after_deadline:
            # Stall this test's loop so release grants before the expired timer
            # can run. The waiter must return that reserved slot on resumption.
            time.sleep(0.02)
            await holder.__aexit__(None, None, None)
        with pytest.raises(ReadCapacityExceeded):
            await asyncio.wait_for(task, 1)
        assert not capacity._waiters
        if not grant_after_deadline:
            assert capacity.active == 1
            await holder.__aexit__(None, None, None)
        assert capacity.active == 0
        async with capacity.claim():
            assert capacity.active == 1

    asyncio.run(check())


def test_http_wait_deadline_rejects_without_allocating_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = settings_for("test", tmp_path)
    content = sample_png("wait deadline")
    write_artifact_fixture(settings.projects_root, [(content, "image/png", "png")])
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    entered, release = threading.Event(), threading.Event()
    snapshots: list[BinaryIO] = []
    original_tempfile = tempfile.TemporaryFile
    original_read = service_module.BatchcraftService.get_result
    started = 0
    lock = threading.Lock()

    def tracked_tempfile(*args: Any, **kwargs: Any) -> BinaryIO:
        snapshot = cast(BinaryIO, original_tempfile(*args, **kwargs))
        snapshots.append(snapshot)
        return snapshot

    def blocked(*args: Any, **kwargs: Any) -> Any:
        nonlocal started
        with lock:
            started += 1
            if started == 4:
                entered.set()
        assert release.wait(10)
        return original_read(*args, **kwargs)

    monkeypatch.setattr("batchcraft.api.artifacts.tempfile.TemporaryFile", tracked_tempfile)
    monkeypatch.setattr(service_module.BatchcraftService, "get_result", blocked)

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):

            async def empty_body() -> AsyncIterator[bytes]:
                chunks: tuple[bytes, ...] = ()
                for chunk in chunks:
                    yield chunk

            url = "/api/runs/run-id/results/1/1"
            holders = [
                asyncio.create_task(http.request("GET", url, content=empty_body()))
                for _ in range(4)
            ]
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                start = asyncio.get_running_loop().time()
                response = await asyncio.wait_for(http.request("GET", url, content=empty_body()), 7)
                assert asyncio.get_running_loop().time() - start >= 5
                assert response.status_code == 503
                assert response.headers["retry-after"] == "1"
                assert response.json()["error"]["code"] == "read_capacity_exceeded"
                assert started == len(snapshots) == 4
            finally:
                release.set()
                responses = await asyncio.gather(*holders)
            assert all(
                response.status_code == 200 and response.content == content
                for response in responses
            )
            assert all(snapshot.closed for snapshot in snapshots)
            assert (await http.get(url)).status_code == 200

    asyncio.run(check())
