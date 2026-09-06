import asyncio
import gc
import json
import shutil
import sqlite3
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from typing import cast
from weakref import ref

import httpx
import pytest
from api_client import LoopbackTestClient as TestClient
from httpx import Response
from test_api import _batch_request
from test_history_api import _add_result, _client, _copy_fixture, _settings

from batchcraft.api import create_app
from batchcraft.application.service import BatchcraftService
from batchcraft.db import HistoricalProjectionError, ProjectStore, open_connection
from batchcraft.files.history import ProjectHistoryScan


def test_failed_imports_do_not_retain_history_locks(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path), client_factory=_client)
    with TestClient(app) as http:
        service = cast(BatchcraftService, app.state.service)
        for index in range(50):
            for key in (f"missing_{index}", f"../unsafe_{index}"):
                response = http.post("/api/projects/import", json={"filesystem_key": key})
                assert response.status_code == 422
        gc.collect()
        assert len(service._history_locks) == 0


def test_history_lock_survives_holders_and_waiters_then_is_reclaimed(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path), client_factory=_client)
    with TestClient(app), ThreadPoolExecutor(max_workers=2) as pool:
        service = cast(BatchcraftService, app.state.service)
        ready = [threading.Event(), threading.Event()]
        acquire, release = threading.Event(), threading.Event()
        first_entered, second_entered = threading.Event(), threading.Event()

        def waiter(index: int) -> None:
            lock = service._history_lock("shared")
            assert reference() is lock
            ready[index].set()
            assert acquire.wait(5)
            with lock:
                if first_entered.is_set():
                    second_entered.set()
                else:
                    first_entered.set()
                assert release.wait(5)

        try:
            with service._history_lock("shared"):
                reference = ref(service._history_lock("shared"))
                pending = [pool.submit(waiter, index) for index in range(2)]
                assert all(event.wait(3) for event in ready)
                gc.collect()
                assert reference() is service._history_lock("shared")
                assert service._history_lock("shared").locked()
            # Only the not-yet-acquiring waiters now retain the original lock.
            gc.collect()
            assert reference() is service._history_lock("shared")
            assert not service._history_lock("shared").locked()
            acquire.set()
            assert first_entered.wait(3)
            assert not second_entered.wait(0.05)
            gc.collect()
            assert reference() is service._history_lock("shared")
        finally:
            acquire.set()
            release.set()
        for future in pending:
            future.result(timeout=3)
        assert second_entered.is_set()
        gc.collect()
        assert reference() is None
        assert len(service._history_locks) == 0


def _bytes(project: Path) -> dict[Path, bytes]:
    return {
        path.relative_to(project): path.read_bytes()
        for path in project.rglob("*")
        if path.is_file()
    }


def test_registered_reindex_recovers_missing_index_and_restart_keeps_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    _add_result(project)
    before = _bytes(project)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        ProjectStore(settings.database_path).create(
            "Renamed Project", "project_key", project_id="project-id"
        )
        assert http.get("/api/projects/project-id/runs").json()["runs"] == []
        assert http.post("/api/projects/project-id/reindex").status_code == 200
        history = http.get("/api/projects/project-id/runs").json()
        assert [run["run_id"] for run in history["runs"]] == ["run-id"]
        assert len(app.state.service.history_store.list_results("run-id")) == 1
        assert http.get("/api/projects/project-id").json()["name"] == "Renamed Project"

    restarted = create_app(replace(settings, max_jobs=1), client_factory=_client)
    with TestClient(restarted) as http:
        service = cast(BatchcraftService, restarted.state.service)
        with monkeypatch.context() as patch:

            def no_scan(_key: str) -> ProjectHistoryScan:
                pytest.fail("GET must return the existing index without scanning")

            patch.setattr(service.history_scanner, "scan", no_scan)
            assert http.get("/api/projects/project-id/runs").json() == history
        assert http.post("/api/projects/project-id/reindex").status_code == 200
        assert http.get("/api/projects/project-id/runs").json() == history
    assert _bytes(project) == before


def test_registered_owner_mismatch_never_registers_foreign_project(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        before = http.get("/api/projects/project-id/runs").json()
        owner_path = project / "project.json"
        owner = json.loads(owner_path.read_text())
        owner["project_id"] = "foreign-id"
        owner_path.write_text(json.dumps(owner))
        response = http.post("/api/projects/project-id/reindex")
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "project_import_conflict"
        assert http.get("/api/projects/project-id/runs").json() == before
        assert [item["id"] for item in http.get("/api/projects").json()["projects"]] == [
            "project-id"
        ]


@pytest.mark.parametrize(
    "failure", ["missing", "symlink", "file", "enumeration", "asset_enumeration", "project_missing"]
)
def test_unavailable_root_retains_index_and_retry_repairs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        before = http.get("/api/projects/project-id/runs").json()
        root = project if failure == "project_missing" else project / "batches"
        moved = tmp_path / "unavailable"
        with monkeypatch.context() as patch:
            if failure.endswith("enumeration"):
                unreadable = (
                    project / "assets" / "sha256" if failure == "asset_enumeration" else root
                )
                original = Path.iterdir

                def fail_enumeration(path: Path) -> Iterator[Path]:
                    if path == unreadable:
                        raise PermissionError("private path must not escape")
                    return original(path)

                patch.setattr(Path, "iterdir", fail_enumeration)
            else:
                root.rename(moved)
                if failure == "symlink":
                    root.symlink_to(moved, target_is_directory=True)
                elif failure == "file":
                    root.write_text("not a directory")
            response = http.post("/api/projects/project-id/reindex")
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "project_import_failed"
            assert "private path" not in response.text
            assert http.get("/api/projects/project-id/runs").json() == before
        if not failure.endswith("enumeration"):
            if root.is_symlink() or root.is_file():
                root.unlink()
            moved.rename(root)
        assert http.post("/api/projects/project-id/reindex").status_code == 200
        assert http.get("/api/projects/project-id/runs").json() == before


def test_new_project_without_batches_is_confirmed_empty(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        created = http.post("/api/projects", json={"name": "Empty", "filesystem_key": "empty"})
        assert created.status_code == 201
        project = created.json()
        response = http.post(f"/api/projects/{project['id']}/reindex")
        assert response.status_code == 200
        assert response.json()["run_count"] == response.json()["diagnostic_count"] == 0


@pytest.mark.parametrize("first", ["reindex", "import", "create"])
@pytest.mark.parametrize("second", ["reindex", "create"])
def test_full_scans_and_publication_are_serialized_without_blocking_health(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, first: str, second: str
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    before = _bytes(project)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http, ThreadPoolExecutor(max_workers=3) as pool:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        service = cast(BatchcraftService, app.state.service)
        scanned = threading.Event()
        other = http.post("/api/projects", json={"name": "Other", "filesystem_key": "other"}).json()
        release = threading.Event()
        second_waiting = threading.Event()
        second_scanning = threading.Event()
        original_scan = service.history_scanner.scan
        original_lock = service._history_lock

        def paused_scan(key: str) -> ProjectHistoryScan:
            if key == "other":
                return original_scan(key)
            if scanned.is_set():
                second_scanning.set()
                return original_scan(key)
            scan = original_scan(key)
            scanned.set()
            assert release.wait(5)
            return scan

        def observed_lock(key: str) -> threading.Lock:
            if scanned.is_set():
                second_waiting.set()
            return original_lock(key)

        def request(operation: str) -> Response:
            if operation == "create":
                return cast(Response, http.post("/api/runs", json=_batch_request(())))
            if operation == "import":
                return cast(
                    Response,
                    http.post("/api/projects/import", json={"filesystem_key": "project_key"}),
                )
            return cast(Response, http.post("/api/projects/project-id/reindex"))

        monkeypatch.setattr(service.history_scanner, "scan", paused_scan)
        monkeypatch.setattr(service, "_history_lock", observed_lock)
        older = pool.submit(request, first)
        try:
            assert scanned.wait(5)
            newer = pool.submit(request, second)
            assert second_waiting.wait(5)
            assert not second_scanning.wait(0.05)
            assert pool.submit(http.get, "/api/health").result(timeout=2).status_code == 200
            assert (
                pool.submit(http.post, f"/api/projects/{other['id']}/reindex")
                .result(timeout=2)
                .status_code
                == 200
            )
        finally:
            release.set()
        assert older.result(timeout=5).status_code in (200, 201)
        assert newer.result(timeout=5).status_code in (200, 201)
        assert second_scanning.is_set()
        expected_count = 1 + (first == "create") + (second == "create")
        assert len(http.get("/api/projects/project-id/runs").json()["runs"]) == expected_count
    after = _bytes(project)
    assert all(after[path] == content for path, content in before.items())


def test_publication_refresh_failure_is_safely_logged_and_reindex_repairs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    settings = _settings(tmp_path)
    _copy_fixture(settings)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        service = cast(BatchcraftService, app.state.service)
        with monkeypatch.context() as patch:

            def fail(*args: object, **kwargs: object) -> None:
                raise HistoricalProjectionError("secret /private/user/path")

            patch.setattr(service.history_store, "replace_project", fail)
            response = http.post("/api/runs", json=_batch_request(()))
        assert response.status_code == 201
        assert "Published Run history refresh failed" in caplog.text
        assert "secret" not in caplog.text
        assert "/private/user/path" not in caplog.text
        assert "Traceback" not in caplog.text
        assert response.json()["run_id"] not in caplog.text
        assert len(http.get("/api/projects/project-id/runs").json()["runs"]) == 1
        assert http.post("/api/projects/project-id/reindex").status_code == 200
        assert len(http.get("/api/projects/project-id/runs").json()["runs"]) == 2


def test_reindex_refreshes_terminal_execution_without_rewriting_artifacts(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        assert http.post("/api/runs/run-id/discard").status_code == 200
        before = _bytes(project)
        assert (
            http.get("/api/projects/project-id/runs").json()["runs"][0]["execution_status"]
            == "created"
        )
        assert http.post("/api/projects/project-id/reindex").status_code == 200
        assert (
            http.get("/api/projects/project-id/runs").json()["runs"][0]["execution_status"]
            == "cancelled"
        )
        assert _bytes(project) == before


def test_registered_replacement_cannot_create_registration(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    _copy_fixture(settings)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        service = cast(BatchcraftService, app.state.service)
        scan = service.history_scanner.scan("project_key")
        with pytest.raises(HistoricalProjectionError, match="explicit import"):
            service.history_store.replace_project(scan, register=False)
        with closing(open_connection(settings.database_path)) as connection:
            assert connection.execute("SELECT count(*) FROM project").fetchone() == (0,)
        assert http.post("/api/projects/project-id/reindex").status_code == 404
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )


def test_failed_replacement_rolls_back_all_prior_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    _add_result(project)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        store = app.state.service.history_store
        history = http.get("/api/projects/project-id/runs").json()
        results = store.list_results("run-id")
        before = _bytes(project)
        original = store._insert_projection

        def fail_after_insert(connection: sqlite3.Connection, scan: ProjectHistoryScan) -> None:
            original(connection, scan)
            raise sqlite3.OperationalError("private database failure")

        with monkeypatch.context() as patch:
            patch.setattr(store, "_insert_projection", fail_after_insert)
            assert http.post("/api/projects/project-id/reindex").status_code == 422
        assert http.get("/api/projects/project-id/runs").json() == history
        assert store.list_results("run-id") == results
        assert _bytes(project) == before


def test_registered_reindex_refreshes_results_and_isolates_malformed_run(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        assert app.state.service.history_store.list_results("run-id") == ()
        _add_result(project)
        bad = project / "batches" / "batch_key" / "002-bad"
        bad.mkdir()
        (bad / "run.json").write_text("{}")
        before = _bytes(project)
        assert http.post("/api/projects/project-id/reindex").status_code == 200
        history = http.get("/api/projects/project-id/runs").json()
        assert [run["run_id"] for run in history["runs"]] == ["run-id"]
        assert any(item["code"] == "invalid_run" for item in history["diagnostics"])
        assert len(app.state.service.history_store.list_results("run-id")) == 1
        assert _bytes(project) == before


@pytest.mark.parametrize("operation", ["create", "import", "reindex"])
@pytest.mark.parametrize("phase", ["waiting", "running"])
@pytest.mark.parametrize("cancellation", ["request", "shutdown"])
def test_history_mutation_worker_is_joined_on_repeated_cancellation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    phase: str,
    cancellation: str,
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    before = _bytes(project)
    app = create_app(settings, client_factory=_client)
    entered, release = threading.Event(), threading.Event()
    worker_done, owner_done = threading.Event(), threading.Event()
    timers: list[threading.Timer] = []
    tasks: list[asyncio.Task[object]] = []
    unlock: list[Callable[[], None]] = []
    shutdown_observations: list[bool] = []

    async def owner() -> None:
        try:
            async with (
                app.router.lifespan_context(app),
                httpx.AsyncClient(
                    transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
                ) as http,
            ):
                assert (
                    await http.post("/api/projects/import", json={"filesystem_key": "project_key"})
                ).status_code == 201
                service = cast(BatchcraftService, app.state.service)
                if phase == "waiting":
                    lock = service._history_lock("project_key")
                    lock.acquire()
                    unlock.append(lock.release)
                    original_lock = service._history_lock

                    def observed_lock(key: str) -> threading.Lock:
                        entered.set()
                        return original_lock(key)

                    monkeypatch.setattr(service, "_history_lock", observed_lock)
                else:
                    original_scan = service.history_scanner.scan

                    def paused_scan(key: str) -> ProjectHistoryScan:
                        scan = original_scan(key)
                        entered.set()
                        assert release.wait(5)
                        return scan

                    monkeypatch.setattr(service.history_scanner, "scan", paused_scan)

                method = {
                    "create": "create_run",
                    "import": "import_project",
                    "reindex": "reindex_project",
                }[operation]
                original_mutation = getattr(service, method)

                def mutation(*args: object) -> object:
                    try:
                        return original_mutation(*args)
                    finally:
                        worker_done.set()

                monkeypatch.setattr(service, method, mutation)
                if operation == "create":
                    request = http.post("/api/runs", json=_batch_request(()))
                elif operation == "import":
                    request = http.post(
                        "/api/projects/import", json={"filesystem_key": "project_key"}
                    )
                else:
                    request = http.post("/api/projects/project-id/reindex")
                task = asyncio.create_task(request)
                tasks.append(cast(asyncio.Task[object], task))
                await task
        finally:
            assert worker_done.is_set(), "request/lifespan owner exited before its mutation worker"
            owner_done.set()

    def finish_worker() -> None:
        if unlock:
            unlock.pop()()
        release.set()

    async def check() -> None:
        owning_task = asyncio.create_task(owner())
        assert await asyncio.to_thread(entered.wait, 3)
        task = tasks[0]
        task.cancel()
        await asyncio.sleep(0.01)
        task.cancel()
        owning_task.cancel()
        await asyncio.sleep(0.01)
        assert not task.done()
        assert not owning_task.done()
        assert not worker_done.is_set()
        assert not owner_done.is_set()
        if cancellation == "shutdown":

            def release_during_shutdown() -> None:
                shutdown_observations.append(not owner_done.is_set() and not worker_done.is_set())
                finish_worker()

            timer = threading.Timer(0.1, release_during_shutdown)
            timers.append(timer)
            timer.start()
            # asyncio.run cancels every remaining Task again, including the owner and request.
            return
        finish_worker()
        with pytest.raises(asyncio.CancelledError):
            await owning_task

    try:
        asyncio.run(check())
    finally:
        finish_worker()
        for timer in timers:
            timer.join()
    assert owner_done.is_set() and worker_done.is_set()
    if cancellation == "shutdown":
        assert shutdown_observations == [True]
    service = cast(BatchcraftService, app.state.service)
    assert len(service.list_project_runs("project-id")) == (2 if operation == "create" else 1)
    after = _bytes(project)
    assert all(after[path] == content for path, content in before.items())


@pytest.mark.parametrize("operation", ["import", "reindex"])
@pytest.mark.parametrize("change", ["owner", "directory", "symlink", "projects_root"])
def test_project_context_change_during_scan_preserves_prior_projection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str, change: str
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http, ThreadPoolExecutor(max_workers=1) as pool:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        service = cast(BatchcraftService, app.state.service)
        prior = http.get("/api/projects/project-id/runs").json()
        scanned, release = threading.Event(), threading.Event()
        original = service.history_scanner.scan

        def paused_scan(key: str) -> ProjectHistoryScan:
            scan = original(key)
            scanned.set()
            assert release.wait(5)
            # A distinguishable stale scan must never reach replacement.
            return replace(scan, runs=())

        monkeypatch.setattr(service.history_scanner, "scan", paused_scan)
        if operation == "import":
            pending = pool.submit(
                http.post, "/api/projects/import", json={"filesystem_key": "project_key"}
            )
        else:
            pending = pool.submit(http.post, "/api/projects/project-id/reindex")
        try:
            assert scanned.wait(3)
            if change == "owner":
                path = project / "project.json"
                owner_record = json.loads(path.read_text())
                owner_record["project_id"] = "foreign-id"
                path.write_text(json.dumps(owner_record))
            else:
                path = settings.projects_root if change == "projects_root" else project
                moved = tmp_path / "original-directory"
                path.rename(moved)
                if change == "symlink":
                    path.symlink_to(moved, target_is_directory=True)
                else:
                    shutil.copytree(moved, path)
            after_change = _bytes(project)
        finally:
            release.set()
        response = pending.result(timeout=5)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "project_import_failed"
        assert http.get("/api/projects/project-id/runs").json() == prior
        assert [item["id"] for item in http.get("/api/projects").json()["projects"]] == [
            "project-id"
        ]
        assert _bytes(project) == after_change
