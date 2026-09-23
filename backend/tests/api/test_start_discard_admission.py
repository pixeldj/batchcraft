import asyncio
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from batch_fixture import _batch_request

from batchcraft.api import create_app
from batchcraft.application.service import BatchcraftService
from batchcraft.application.tasks import _LifecycleCleanupTask
from batchcraft.comfyui import ComfyUIClient
from batchcraft.db import RunCancellationMode
from batchcraft.execution import (
    ExecutionStateError,
    ExecutionStateStore,
    JobExecutionStatus,
    RunExecutionStatus,
    initial_execution_state,
)
from tools.fake_comfyui import FakeComfyUIClient
from tools.runtime import settings_for


@pytest.mark.parametrize(
    ("action", "phase"),
    [
        ("execute", "lookup"),
        ("discard", "lookup"),
        ("execute", "exists"),
        ("execute", "validate"),
        ("execute", "read"),
        ("discard", "exists"),
        ("discard", "validate"),
        ("discard", "read"),
        ("discard", "save"),
    ],
)
def test_start_discard_storage_does_not_block_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, action: str, phase: str
) -> None:
    entered, release = threading.Event(), threading.Event()
    threads: list[int] = []
    app = create_app(settings_for("test", tmp_path), client_factory=lambda _: FakeComfyUIClient())

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
            run = app.state.service.get_run(run_id)
            if phase == "read":
                ExecutionStateStore(run.path).initialize(run)
            owner, method = {
                "lookup": (BatchcraftService, "get_run"),
                "exists": (Path, "exists"),
                "validate": (ExecutionStateStore, "validate_storage"),
                "read": (ExecutionStateStore, "read_for_query"),
                "save": (ExecutionStateStore, "save"),
            }[phase]
            original = getattr(owner, method)

            def blocked(*args: Any, **kwargs: Any) -> Any:
                if not entered.is_set() and (
                    phase != "exists" or args[0] == run.path / "execution.json"
                ):
                    threads.append(threading.get_ident())
                    entered.set()
                    assert release.wait(5), "event loop could not release storage worker"
                return original(*args, **kwargs)

            monkeypatch.setattr(owner, method, blocked)
            request = asyncio.create_task(http.post(f"/api/runs/{run_id}/{action}"))
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                assert len(threads) == 1 and threads[0] != threading.get_ident()
                tick = asyncio.Event()
                asyncio.get_running_loop().call_soon(tick.set)
                await asyncio.wait_for(tick.wait(), 1)
                for url in ["/api/health", "/api/projects/project_key/assets"]:
                    assert (await asyncio.wait_for(http.get(url), 1)).status_code == 200
                assert not request.done()
            finally:
                release.set()
                response = await request
            assert response.status_code == (
                409
                if action == "execute" and phase == "read"
                else 202
                if action == "execute"
                else 200
            )

    asyncio.run(check())


@pytest.mark.parametrize("phase", ["drain", "client_close"])
def test_runner_teardown_finishes_lifespan_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    worker_entered, worker_release = threading.Event(), threading.Event()
    worker_finished, runner_cancelled = threading.Event(), threading.Event()
    cleanup_release, close_entered = asyncio.Event(), asyncio.Event()
    shutdown_requested, lifespan_entered = asyncio.Event(), asyncio.Event()
    order: list[str] = []
    controller_errors: list[str] = []
    retained: dict[str, asyncio.Task[Any]] = {}
    cancel_attempts: list[str] = []
    loop_errors: list[dict[str, Any]] = []

    class Client(FakeComfyUIClient):
        async def aclose(self) -> None:
            task = asyncio.current_task()
            assert task is not None
            if phase == "client_close":
                retained["close"] = task
            order.append("close_started")
            close_entered.set()
            if phase == "client_close":
                try:
                    await cleanup_release.wait()
                except asyncio.CancelledError:
                    runner_cancelled.set()
                    raise
            order.append("client_closed")

    async def executor(**kwargs: Any) -> Any:
        try:
            await asyncio.Event().wait()
        finally:
            order.append("executor_cleanup_started")
            await app.state.service.task_registry.active_run_id()
            await cleanup_release.wait()
            order.append("executor_cleanup_finished")
        return initial_execution_state(kwargs["run"])

    client: FakeComfyUIClient | ComfyUIClient = Client()
    if phase == "client_close":
        client = ComfyUIClient("http://localhost:8002")
        # Exercise real ComfyUIClient/HTTPX closure, gating only the transport.
        # This phase performs no network requests.
        monkeypatch.setattr(client._http._transport, "aclose", Client().aclose)
    app = create_app(
        settings_for("test", tmp_path), client_factory=lambda _: client, executor=executor
    )

    async def lifetime() -> None:
        async with app.router.lifespan_context(app):
            lifespan_entered.set()
            await shutdown_requested.wait()

    async def discard(run_id: str) -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
        ) as http:
            return await http.post(f"/api/runs/{run_id}/discard")

    def controller(loop: asyncio.AbstractEventLoop) -> None:
        try:
            if not runner_cancelled.wait(2):
                controller_errors.append("runner did not cancel pending tasks")
        finally:
            worker_release.set()
            try:
                loop.call_soon_threadsafe(cleanup_release.set)
            except RuntimeError:
                if not loop.is_closed():
                    raise

    controllers: list[threading.Thread] = []

    async def prepare_teardown() -> None:
        loop = asyncio.get_running_loop()
        loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
        retained["lifespan"] = asyncio.create_task(lifetime())
        await asyncio.wait_for(lifespan_entered.wait(), 2)
        registry = app.state.service.task_registry
        original_completed = registry._task_completed

        def completed(*args: Any) -> None:
            original_completed(*args)
            order.append("executor_observed")

        monkeypatch.setattr(registry, "_task_completed", completed)
        if phase == "drain":
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http:
                first = await http.post("/api/runs", json=_batch_request(()))
                second = await http.post("/api/runs", json=_batch_request(()))
                assert first.status_code == second.status_code == 201
                run_id = first.json()["run_id"]
                assert (await http.post(f"/api/runs/{run_id}/execute")).status_code == 202
                retained["executor"] = registry._active_runs[run_id].task
            original_save = ExecutionStateStore.save

            def save(*args: Any, **kwargs: Any) -> Any:
                worker_entered.set()
                try:
                    assert worker_release.wait(5), "worker watchdog expired"
                    return original_save(*args, **kwargs)
                finally:
                    order.append("worker_finished")
                    worker_finished.set()

            monkeypatch.setattr(ExecutionStateStore, "save", save)
            retained["discard"] = asyncio.create_task(discard(second.json()["run_id"]))
            assert await asyncio.to_thread(worker_entered.wait, 2)
        shutdown_requested.set()
        async with asyncio.timeout(2):
            if phase == "drain":
                while registry._shutdown_task is None:
                    await asyncio.sleep(0)
                retained["drain"] = registry._shutdown_task
                await asyncio.sleep(0)
                assert registry._lock.locked()
                assert not retained["drain"].done()
            else:
                await close_entered.wait()

        cleanup_name = "drain" if phase == "drain" else "close"
        original_cancel = retained[cleanup_name].cancel

        def cancel(msg: Any = None) -> bool:
            cancel_attempts.append(cleanup_name)
            return original_cancel(msg)

        monkeypatch.setattr(retained[cleanup_name], "cancel", cancel)

        def inspect_cancellation() -> None:
            if not cancel_attempts or not all(
                task.cancelling() for name, task in retained.items() if name != cleanup_name
            ):
                loop.call_later(0.001, inspect_cancellation)
                return
            if phase == "drain" and (not registry._lock.locked() or worker_finished.is_set()):
                controller_errors.append("admitted worker lost lock before finishing")
            runner_cancelled.set()

        loop.call_soon(inspect_cancellation)
        thread = threading.Thread(target=controller, args=(loop,))
        controllers.append(thread)
        thread.start()
        # Return with lifespan, drain/close, executor and HTTP request pending.
        # Only asyncio.run's real _cancel_all_tasks initiates their cancellation.

    async def main() -> None:
        try:
            await prepare_teardown()
        finally:
            if not controllers:
                worker_release.set()
                cleanup_release.set()

    try:
        asyncio.run(main())
    finally:
        worker_release.set()
        for thread in controllers:
            thread.join(5)
            assert not thread.is_alive(), "controller watchdog expired"
    assert not controller_errors
    assert runner_cancelled.is_set()
    assert all(task.done() for task in retained.values())
    cleanup_name = "drain" if phase == "drain" else "close"
    assert cancel_attempts == [cleanup_name]
    assert retained[cleanup_name].cancelling() == 0
    assert all(task.cancelling() for name, task in retained.items() if name != cleanup_name)
    outcomes = {
        name: "cancelled" if task.cancelled() else task.exception()
        for name, task in retained.items()
    }
    assert not loop_errors, loop_errors
    assert outcomes[cleanup_name] is None
    assert outcomes["lifespan"] == "cancelled"
    assert not app.state.service.task_registry._active_runs
    if phase == "drain":
        assert worker_finished.is_set()
        assert outcomes["discard"] == "cancelled"
        assert order.index("worker_finished") < order.index("executor_cleanup_finished")
        assert order.index("executor_cleanup_finished") < order.index("executor_observed")
        assert order.index("executor_observed") < order.index("close_started"), order
    assert "client_closed" in order, (order, outcomes)
    assert order.count("close_started") == order.count("client_closed") == 1


@pytest.mark.parametrize("outcome", ["success", "error", "cancelled"])
def test_lifecycle_cleanup_declines_cancel_without_changing_outcome(outcome: str) -> None:
    async def check() -> None:
        entered, release = asyncio.Event(), asyncio.Event()
        calls = 0
        failure = RuntimeError("cleanup failed")

        async def cleanup() -> None:
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            if outcome == "error":
                raise failure
            if outcome == "cancelled":
                raise asyncio.CancelledError

        def unexpected_factory(*args: Any, **kwargs: Any) -> Any:
            pytest.fail("lifecycle cleanup must bypass the loop task factory")

        loop = asyncio.get_running_loop()
        original_factory = loop.get_task_factory()
        loop.set_task_factory(unexpected_factory)
        try:
            task = _LifecycleCleanupTask(cleanup(), loop=loop, name="test-lifecycle-cleanup")
        finally:
            loop.set_task_factory(original_factory)
        try:
            assert task.cancel("before start") is False
            await asyncio.wait_for(entered.wait(), 2)
            for _ in range(3):
                assert task.cancel("while suspended") is False
                await asyncio.sleep(0)
                assert not task.done()
                assert task.cancelling() == 0
        finally:
            release.set()
            result = await asyncio.gather(task, return_exceptions=True)
        assert calls == 1
        assert task.cancel("after completion") is False
        assert task.cancelling() == 0
        if outcome == "success":
            assert result[0] is None
            assert task.result() is None
        elif outcome == "error":
            assert result[0] is failure
            assert task.exception() is failure
        else:
            assert isinstance(result[0], asyncio.CancelledError)
            assert task.cancelled()

    asyncio.run(check())


@pytest.mark.parametrize("executor_fails", [False, True])
def test_concurrent_shutdown_callers_keep_independent_cancellation(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, executor_fails: bool
) -> None:
    cleanup_entered, cleanup_release = asyncio.Event(), asyncio.Event()
    closed = asyncio.Event()

    class Client(FakeComfyUIClient):
        async def aclose(self) -> None:
            closed.set()

    async def executor(**kwargs: Any) -> Any:
        try:
            await asyncio.Event().wait()
        finally:
            await app.state.service.task_registry.active_run_id()
            cleanup_entered.set()
            await cleanup_release.wait()
            if executor_fails:
                raise RuntimeError("injected executor cleanup failure")
        return initial_execution_state(kwargs["run"])

    app = create_app(
        settings_for("test", tmp_path), client_factory=lambda _: Client(), executor=executor
    )

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
            registry = app.state.service.task_registry
            first = asyncio.create_task(registry.shutdown())
            second = asyncio.create_task(registry.shutdown())
            try:
                await asyncio.wait_for(cleanup_entered.wait(), 2)
                drain = registry._shutdown_task
                assert drain is not None
                for _ in range(3):
                    first.cancel()
                    await asyncio.sleep(0)
                assert not first.done() and not second.done() and not drain.done()
                assert not closed.is_set()
                assert second.cancelling() == drain.cancelling() == 0
                for action in ("execute", "discard"):
                    response = await http.post(f"/api/runs/{run_id}/{action}")
                    assert response.status_code == 409
                    assert response.json()["error"]["code"] == "execution_service_closed"
            finally:
                cleanup_release.set()
                results = await asyncio.wait_for(
                    asyncio.gather(first, second, return_exceptions=True), 2
                )
            assert isinstance(results[0], asyncio.CancelledError)
            assert results[1] is None
            await asyncio.wait_for(registry.shutdown(), 2)
            assert registry._shutdown_task is drain
            assert drain.result() is None
            assert not registry._active_runs
            assert not closed.is_set()
        assert closed.is_set()
        if executor_fails:
            assert "Run execution task failed" in caplog.text

    asyncio.run(check())


@pytest.mark.parametrize("first", ["execute", "discard"])
@pytest.mark.parametrize("cancel", [False, True])
@pytest.mark.parametrize("fail", [False, True])
def test_protected_worker_retains_admission_until_finished(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, first: str, cancel: bool, fail: bool
) -> None:
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    contender_entered = asyncio.Event()
    factories: list[asyncio.AbstractEventLoop] = []

    def executor(**kwargs: Any) -> Any:
        factories.append(asyncio.get_running_loop())
        assert finished.is_set()

        async def execute() -> Any:
            await asyncio.Event().wait()
            return initial_execution_state(kwargs["run"])

        return execute()

    app = create_app(
        settings_for("test", tmp_path),
        client_factory=lambda _: FakeComfyUIClient(),
        executor=executor,
    )

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):
            created = await http.post("/api/runs", json=_batch_request(()))
            run_id = created.json()["run_id"]
            service = app.state.service
            run = service.get_run(run_id)
            frozen = {path: path.read_bytes() for path in run.path.iterdir() if path.is_file()}
            method = "validate_storage" if first == "execute" else "save"
            original = getattr(ExecutionStateStore, method)
            loop_thread = threading.get_ident()

            def blocked(*args: Any, **kwargs: Any) -> Any:
                assert threading.get_ident() != loop_thread
                if first == "discard":
                    assert args[2].status is RunExecutionStatus.CANCELLED
                    assert args[2].started_at is None
                    assert args[2].diagnostics == ("discarded_before_start",)
                    assert args[2].jobs == initial_execution_state(run).jobs
                if not entered.is_set():
                    entered.set()
                    try:
                        assert release.wait(5)
                        if fail:
                            raise ExecutionStateError("injected storage failure")
                        return original(*args, **kwargs)
                    finally:
                        finished.set()
                assert finished.is_set(), "contender crossed unfinished storage"
                return original(*args, **kwargs)

            monkeypatch.setattr(ExecutionStateStore, method, blocked)
            second = "discard" if first == "execute" else "execute"
            registry_method = "discard" if second == "discard" else "start"
            original_admit = getattr(service.task_registry, registry_method)

            async def admit(*args: Any, **kwargs: Any) -> Any:
                contender_entered.set()
                return await original_admit(*args, **kwargs)

            monkeypatch.setattr(service.task_registry, registry_method, admit)
            request = asyncio.create_task(http.post(f"/api/runs/{run_id}/{first}"))
            contender = None
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                contender = asyncio.create_task(http.post(f"/api/runs/{run_id}/{second}"))
                await asyncio.wait_for(contender_entered.wait(), 2)
                if cancel:
                    for _ in range(3):
                        request.cancel()
                        await asyncio.sleep(0)
                assert not request.done()
                assert not contender.done()
                assert not finished.is_set()
                assert not factories
            finally:
                release.set()
            if cancel:
                with pytest.raises(asyncio.CancelledError):
                    await request
            else:
                response = await request
                assert response.status_code == (
                    (409 if first == "execute" else 500)
                    if fail
                    else 202
                    if first == "execute"
                    else 200
                )
                if fail:
                    assert response.json()["error"]["code"] == (
                        "execution_not_eligible" if first == "execute" else "invalid_run_data"
                    )
            assert contender is not None
            response = await asyncio.wait_for(contender, 2)
            second_wins = fail or (cancel and first == "execute")
            expected = (200 if second == "discard" else 202) if second_wins else 409
            assert response.status_code == expected
            assert all(path.read_bytes() == content for path, content in frozen.items())
            if second == "discard" and second_wins or first == "discard" and not fail:
                state_bytes = (run.path / "execution.json").read_bytes()
                repeated = await http.post(f"/api/runs/{run_id}/discard")
                assert repeated.status_code == 200
                assert (run.path / "execution.json").read_bytes() == state_bytes
                assert not factories
            else:
                assert factories == [asyncio.get_running_loop()]
                assert service.execution_task_active(run_id)
                assert not (run.path / "execution.json").exists()

    asyncio.run(check())


def test_discard_preserves_stopped_cancelled_state_while_other_run_is_active(
    tmp_path: Path,
) -> None:
    async def executor(**kwargs: Any) -> Any:
        await asyncio.Event().wait()
        return initial_execution_state(kwargs["run"])

    app = create_app(
        settings_for("test", tmp_path),
        client_factory=lambda _: FakeComfyUIClient(),
        executor=executor,
    )

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):
            first = await http.post("/api/runs", json=_batch_request(()))
            second = await http.post("/api/runs", json=_batch_request(()))
            run_id = second.json()["run_id"]
            run = app.state.service.get_run(run_id)
            store = ExecutionStateStore(run.path)
            state = initial_execution_state(run)
            running = replace(state, status=RunExecutionStatus.RUNNING, started_at="started")
            store.save(run, running)
            cancelled = replace(
                running,
                status=RunExecutionStatus.CANCELLED,
                completed_at="finished",
                diagnostics=("stopped_after_current_job",),
                jobs=tuple(
                    replace(job, status=JobExecutionStatus.CANCELLED, completed_at="finished")
                    for job in state.jobs
                ),
            )
            store.save(run, cancelled)
            before = {path: path.read_bytes() for path in run.path.iterdir() if path.is_file()}
            active_id = first.json()["run_id"]
            assert (await http.post(f"/api/runs/{active_id}/execute")).status_code == 202
            for _ in range(2):
                response = await http.post(f"/api/runs/{run_id}/discard")
                assert response.status_code == 200
                assert response.json()["diagnostics"] == ["stopped_after_current_job"]
            assert all(path.read_bytes() == content for path, content in before.items())
            assert app.state.service.execution_task_active(active_id)

    asyncio.run(check())


@pytest.mark.parametrize("phase", ["lookup", "intent"])
def test_cancelled_start_before_admission_never_calls_executor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()

    def executor(**kwargs: Any) -> Any:
        pytest.fail("cancelled pre-admission request created an executor coroutine")

    app = create_app(
        settings_for("test", tmp_path),
        client_factory=lambda _: FakeComfyUIClient(),
        executor=executor,
    )

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):
            created = await http.post("/api/runs", json=_batch_request(()))
            run_id = created.json()["run_id"]
            method = "get_run" if phase == "lookup" else "_get_cancellation_intent"
            original = getattr(BatchcraftService, method)

            def blocked(*args: Any, **kwargs: Any) -> Any:
                if not entered.is_set():
                    entered.set()
                    try:
                        assert release.wait(5)
                        return original(*args, **kwargs)
                    finally:
                        finished.set()
                return original(*args, **kwargs)

            monkeypatch.setattr(BatchcraftService, method, blocked)
            request = asyncio.create_task(http.post(f"/api/runs/{run_id}/execute"))
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                for _ in range(3):
                    request.cancel()
                    await asyncio.sleep(0)
                if phase == "lookup":
                    assert not request.done()
                assert not app.state.service.execution_task_active(run_id)
            finally:
                release.set()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert await asyncio.to_thread(finished.wait, 2)
            assert (await http.post(f"/api/runs/{run_id}/discard")).status_code == 200

    asyncio.run(check())


@pytest.mark.parametrize("failure", ["factory", "task", "cancel_request"])
def test_loop_factory_and_registered_task_ownership(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str, caplog: pytest.LogCaptureFixture
) -> None:
    registered, finish, observed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    factories: list[asyncio.AbstractEventLoop] = []

    def executor(**kwargs: Any) -> Any:
        factories.append(asyncio.get_running_loop())
        if failure == "factory":
            raise RuntimeError("injected synchronous factory failure")

        async def execute() -> Any:
            await finish.wait()
            if failure == "task":
                raise RuntimeError("injected task failure")
            return initial_execution_state(kwargs["run"])

        return execute()

    app = create_app(
        settings_for("test", tmp_path),
        client_factory=lambda _: FakeComfyUIClient(),
        executor=executor,
    )

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):
            created = await http.post("/api/runs", json=_batch_request(()))
            run_id = created.json()["run_id"]
            registry = app.state.service.task_registry
            original_start, original_completed = registry.start, registry._task_completed

            async def start(*args: Any, **kwargs: Any) -> None:
                await original_start(*args, **kwargs)
                registered.set()
                if failure == "cancel_request":
                    await asyncio.Event().wait()

            def completed(*args: Any) -> None:
                original_completed(*args)
                observed.set()

            monkeypatch.setattr(registry, "start", start)
            monkeypatch.setattr(registry, "_task_completed", completed)
            request = asyncio.create_task(http.post(f"/api/runs/{run_id}/execute"))
            try:
                if failure == "factory":
                    assert (await request).status_code == 500
                    assert not registry.is_active(run_id)
                else:
                    await asyncio.wait_for(registered.wait(), 2)
                    if failure == "cancel_request":
                        request.cancel()
                        with pytest.raises(asyncio.CancelledError):
                            await request
                        assert registry.is_active(run_id)
                        assert not observed.is_set()
                        for mode in RunCancellationMode:
                            assert app.state.service.cancellation_store.get(run_id, mode) is None
                    else:
                        assert (await request).status_code == 202
                    finish.set()
                    await asyncio.wait_for(observed.wait(), 2)
                    assert await asyncio.wait_for(registry.active_run_id(), 2) is None
                assert factories == [asyncio.get_running_loop()]
                assert (await http.post(f"/api/runs/{run_id}/discard")).status_code == 200
            finally:
                finish.set()
                await asyncio.gather(request, return_exceptions=True)
            if failure == "task":
                assert "Run execution task failed" in caplog.text

    asyncio.run(check())


@pytest.mark.parametrize("phase", ["lookup", "intent", "prepare", "save"])
@pytest.mark.parametrize("cancel_shutdown", [False, True])
def test_shutdown_joins_admitted_io_and_rejects_late_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str, cancel_shutdown: bool
) -> None:
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    cleanup_entered, cleanup_release, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    factories: list[asyncio.AbstractEventLoop] = []
    observed = asyncio.Event()

    class Client(FakeComfyUIClient):
        async def aclose(self) -> None:
            if phase in {"prepare", "save"}:
                assert finished.is_set()
            if factories:
                assert observed.is_set()
            closed.set()

    def executor(**kwargs: Any) -> Any:
        factories.append(asyncio.get_running_loop())

        async def execute() -> Any:
            try:
                await asyncio.Event().wait()
            finally:
                # Shutdown must drain outside the registry lock.
                await app.state.service.task_registry.active_run_id()
                cleanup_entered.set()
                await cleanup_release.wait()
            return initial_execution_state(kwargs["run"])

        return execute()

    app = create_app(
        settings_for("test", tmp_path), client_factory=lambda _: Client(), executor=executor
    )

    async def check() -> None:
        lifespan = app.router.lifespan_context(app)
        await lifespan.__aenter__()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
        ) as http:
            created = await http.post("/api/runs", json=_batch_request(()))
            run_id = created.json()["run_id"]
            service = app.state.service
            registry = service.task_registry
            original_completed = registry._task_completed

            def completed(*args: Any) -> None:
                original_completed(*args)
                observed.set()

            monkeypatch.setattr(registry, "_task_completed", completed)
            owner, method = {
                "lookup": (BatchcraftService, "get_run"),
                "intent": (BatchcraftService, "_get_cancellation_intent"),
                "prepare": (ExecutionStateStore, "validate_storage"),
                "save": (ExecutionStateStore, "save"),
            }[phase]
            original = getattr(owner, method)

            def blocked(*args: Any, **kwargs: Any) -> Any:
                if not entered.is_set():
                    entered.set()
                    assert release.wait(5)
                    try:
                        return original(*args, **kwargs)
                    finally:
                        finished.set()
                return original(*args, **kwargs)

            monkeypatch.setattr(owner, method, blocked)
            action = "discard" if phase == "save" else "execute"
            request = asyncio.create_task(http.post(f"/api/runs/{run_id}/{action}"))
            shutdown = None
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                shutdown = asyncio.create_task(lifespan.__aexit__(None, None, None))
                await asyncio.sleep(0)
                if cancel_shutdown:
                    for _ in range(3):
                        shutdown.cancel()
                        await asyncio.sleep(0)
                if phase in {"prepare", "save"}:
                    assert not shutdown.done()
                    assert not closed.is_set()
                else:
                    # Initial lookup/intent is outside admission; closing must not
                    # depend on it and it must never register after the client closes.
                    await asyncio.wait_for(closed.wait(), 2)
                release.set()
                response = await asyncio.wait_for(request, 2)
                assert response.status_code == (
                    202 if phase == "prepare" else 200 if phase == "save" else 409
                )
                if phase == "prepare":
                    await asyncio.wait_for(cleanup_entered.wait(), 2)
                    assert not closed.is_set()
                    assert factories == [asyncio.get_running_loop()]
                    if cancel_shutdown:
                        shutdown.cancel()
                        await asyncio.sleep(0)
                        assert not shutdown.done()
                else:
                    assert not factories
            finally:
                release.set()
                cleanup_release.set()
                await asyncio.gather(request, return_exceptions=True)
                if shutdown is None:
                    await lifespan.__aexit__(None, None, None)
                elif cancel_shutdown:
                    with pytest.raises(asyncio.CancelledError):
                        await asyncio.wait_for(shutdown, 2)
                else:
                    await asyncio.wait_for(shutdown, 2)
            assert closed.is_set()
            assert not registry.is_active(run_id)
            assert await registry.active_run_id() is None
            late = await http.post(f"/api/runs/{run_id}/execute")
            assert late.status_code == 409
            assert late.json()["error"]["code"] == "execution_service_closed"

    asyncio.run(check())


@pytest.mark.parametrize("action", ["execute", "discard"])
def test_closed_registry_rejects_mutation(tmp_path: Path, action: str) -> None:
    app = create_app(settings_for("test", tmp_path), client_factory=lambda _: FakeComfyUIClient())

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://localhost:8002"
            ) as http,
        ):
            created = await http.post("/api/runs", json=_batch_request(()))
            run_id = created.json()["run_id"]
            await app.state.service.task_registry.shutdown()
            response = await http.post(f"/api/runs/{run_id}/{action}")
            assert response.status_code == 409
            assert "shutting down" in response.json()["error"]["message"].lower()
            assert not app.state.service.execution_task_active(run_id)
            run = app.state.service.get_run(run_id)
            assert not (run.path / "execution.json").exists()

    asyncio.run(check())


@pytest.mark.parametrize("close_fails", [False, True])
def test_lifespan_joins_client_close_under_repeated_cancellation(
    tmp_path: Path, close_fails: bool
) -> None:
    entered, release, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    failure = RuntimeError("injected client close failure")

    class Client(FakeComfyUIClient):
        async def aclose(self) -> None:
            entered.set()
            await release.wait()
            closed.set()
            if close_fails:
                raise failure

    app = create_app(settings_for("test", tmp_path), client_factory=lambda _: Client())

    async def check() -> None:
        lifespan = app.router.lifespan_context(app)
        await lifespan.__aenter__()
        shutdown = asyncio.create_task(lifespan.__aexit__(None, None, None))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            for _ in range(3):
                shutdown.cancel()
                await asyncio.sleep(0)
            assert not shutdown.done()
            assert not closed.is_set()
        finally:
            release.set()
        if close_fails:
            with pytest.raises(RuntimeError) as caught:
                await asyncio.wait_for(shutdown, 2)
            assert caught.value is failure
        else:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(shutdown, 2)
        assert closed.is_set()

    asyncio.run(check())
