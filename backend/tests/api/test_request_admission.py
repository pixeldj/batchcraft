import asyncio
import json
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from typing import BinaryIO, cast

import pytest
from starlette.requests import Request as StarletteRequest
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from batchcraft.api import Settings, create_app
from batchcraft.api.security import RequestSecurityMiddleware
from tools.fake_comfyui import FakeComfyUIClient
from tools.runtime import settings_for


class Request:
    def __init__(
        self,
        method: str = "POST",
        headers: list[tuple[bytes, bytes]] | None = None,
        path: str = "/api/health",
    ) -> None:
        self.scope: Scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "scheme": "http",
            "method": method,
            "path": path,
            "raw_path": path.encode(),
            "root_path": "",
            "query_string": b"",
            "headers": [(b"host", b"localhost:8002"), *(headers or [])],
            "server": ("127.0.0.1", 8002),
        }
        self.events: asyncio.Queue[Message | Exception] = asyncio.Queue()
        self.receiving = asyncio.Event()
        self.waiting = asyncio.Event()
        self.sent: list[Message] = []

    def body(self, content: bytes = b"", *, more: bool = False) -> None:
        self.events.put_nowait({"type": "http.request", "body": content, "more_body": more})

    async def receive(self) -> Message:
        self.receiving.set()
        if self.events.empty():
            self.waiting.set()
        event = await self.events.get()
        if isinstance(event, Exception):
            raise event
        return event

    async def send(self, message: Message) -> None:
        self.sent.append(message)

    async def run(self, app: ASGIApp) -> None:
        await app(self.scope, self.receive, self.send)

    def error(self, status: int, code: str) -> None:
        assert self.sent[0]["status"] == status
        assert json.loads(self.sent[1]["body"])["error"]["code"] == code


async def consume(scope: Scope, receive: Receive, send: Send) -> None:
    content = b""
    while True:
        event = await receive()
        content += event["body"]
        if not event["more_body"]:
            break
    await Response(content)(scope, receive, send)


@pytest.fixture
def spools(monkeypatch: pytest.MonkeyPatch) -> list[BinaryIO]:
    opened: list[BinaryIO] = []
    original = tempfile.SpooledTemporaryFile

    def tracked(*args: object, **kwargs: object) -> BinaryIO:
        spool = cast(BinaryIO, original(*args, **kwargs))  # type: ignore[call-overload]
        opened.append(spool)
        return spool

    monkeypatch.setattr("batchcraft.api.security.tempfile.SpooledTemporaryFile", tracked)
    return opened


def test_capacity_has_no_waiters_and_bodyless_requests_stay_responsive(tmp_path: Path) -> None:
    async def scenario() -> None:
        settings = settings_for("test", tmp_path)
        app = RequestSecurityMiddleware(consume, settings)
        uploads = [Request() for _ in range(4)]
        async with asyncio.TaskGroup() as tasks:
            for request in uploads:
                tasks.create_task(request.run(app))
                await request.receiving.wait()
            # A completed body also cannot wait behind admitted uploads.
            for method in ["POST", "GET", "HEAD", "OPTIONS"]:
                request = Request(method, [(b"content-length", b"0")])
                request.body(b"forged")
                await request.run(app)
                request.error(429, "request_capacity_exceeded")
                assert (b"retry-after", b"1") in request.sent[0]["headers"]
            idle = Request()
            await idle.run(app)
            idle.error(429, "request_capacity_exceeded")
            for method, path in [
                ("GET", "/api/health"),
                ("GET", "/api/executions/active"),
                ("GET", "/api/runs/id/execution"),
                ("OPTIONS", "/api/projects"),
                ("POST", "/api/runs/id/cancel"),
            ]:
                request = Request(method, path=path)
                request.body()
                await request.run(app)
                assert request.sent[0]["status"] == 200
            for request in uploads:
                request.body(b"done")
        for request in uploads:
            assert request.sent[1]["body"] == b"done"
        request = Request()
        request.body(b"reused")
        await request.run(app)
        assert request.sent[1]["body"] == b"reused"

    asyncio.run(asyncio.wait_for(scenario(), 5))


@pytest.mark.parametrize(
    "headers", [[], [(b"content-length", b"0")], [(b"transfer-encoding", b"chunked")]]
)
@pytest.mark.parametrize("size", [4, 5])
def test_received_bytes_exact_limit_and_forged_lengths(
    tmp_path: Path, spools: list[BinaryIO], headers: list[tuple[bytes, bytes]], size: int
) -> None:
    async def scenario() -> None:
        app = RequestSecurityMiddleware(
            consume, replace(settings_for("test", tmp_path), max_request_bytes=4)
        )
        request = Request("GET", headers)
        request.body(b"", more=True)
        request.body(b"xx", more=True)
        request.body(b"x" * (size - 2))
        await request.run(app)
        if size == 4:
            assert request.sent[1]["body"] == b"xxxx"
        else:
            request.error(413, "request_too_large")
        assert spools and all(spool.closed for spool in spools)

    asyncio.run(scenario())


@pytest.mark.parametrize("initial_body", [False, True])
def test_total_deadline_prevents_mutations_and_cleans_spools(
    tmp_path: Path, spools: list[BinaryIO], initial_body: bool
) -> None:
    async def scenario() -> None:
        settings = replace(settings_for("test", tmp_path), request_body_timeout_seconds=0.02)
        app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
        request = Request(
            headers=[(b"origin", settings.frontend_origin.encode())], path="/api/projects"
        )
        if initial_body:
            request.body(b'{"name":', more=True)
        await request.run(app)
        request.error(408, "request_body_timeout")
        assert (b"access-control-allow-origin", settings.frontend_origin.encode()) in request.sent[
            0
        ]["headers"]
        assert not settings.projects_root.exists()
        assert not settings.database_path.exists()
        assert spools and all(spool.closed for spool in spools)
        health = Request("GET")
        health.body()
        await health.run(app)
        assert health.sent[0]["status"] == 200

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_lease_covers_handler_but_deadline_does_not(tmp_path: Path, spools: list[BinaryIO]) -> None:
    async def scenario() -> None:
        entered = asyncio.Event()
        finish = asyncio.Event()

        async def handler(scope: Scope, receive: Receive, send: Send) -> None:
            entered.set()
            await finish.wait()
            await consume(scope, receive, send)

        app = RequestSecurityMiddleware(
            handler,
            replace(
                settings_for("test", tmp_path),
                max_inflight_request_bodies=1,
                request_body_timeout_seconds=0.02,
            ),
        )
        first = Request()
        first.body(b"owned")
        task = asyncio.create_task(first.run(app))
        await entered.wait()
        await asyncio.sleep(0.04)  # Explicitly cross the admission deadline inside the handler.
        assert not task.done()
        assert not spools[0].closed
        other = Request()
        other.body(b"queued")
        await other.run(app)
        other.error(429, "request_capacity_exceeded")
        finish.set()
        await task
        assert first.sent[1]["body"] == b"owned"
        assert all(spool.closed for spool in spools)

    asyncio.run(asyncio.wait_for(scenario(), 5))


@pytest.mark.parametrize("failure", ["disconnect", "receive", "cancel", "handler"])
def test_failure_releases_permit_and_spool(
    tmp_path: Path, spools: list[BinaryIO], failure: str
) -> None:
    async def scenario() -> None:
        entered = asyncio.Event()

        async def handler(scope: Scope, receive: Receive, send: Send) -> None:
            if failure == "handler" and not entered.is_set():
                entered.set()
                raise RuntimeError("handler failed")
            await consume(scope, receive, send)

        app = RequestSecurityMiddleware(
            handler, replace(settings_for("test", tmp_path), max_inflight_request_bodies=1)
        )
        request = Request()
        request.body(b"x", more=failure != "handler")
        if failure == "disconnect":
            request.events.put_nowait({"type": "http.disconnect"})
        elif failure == "receive":
            request.events.put_nowait(OSError("receive failed"))
        task = asyncio.create_task(request.run(app))
        if failure == "cancel":
            await request.waiting.wait()
            assert spools and not spools[-1].closed
            task.cancel()
        if failure == "disconnect":
            await task
        else:
            with pytest.raises(asyncio.CancelledError if failure == "cancel" else Exception):
                await task
        assert all(spool.closed for spool in spools)
        fresh = Request()
        fresh.body(b"fresh")
        await fresh.run(app)
        assert fresh.sent[1]["body"] == b"fresh"

    asyncio.run(asyncio.wait_for(scenario(), 5))


@pytest.mark.parametrize("phase", ["write", "read"])
def test_repeated_cancellation_joins_file_worker_before_close(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    async def scenario() -> None:
        entered = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        original = tempfile.SpooledTemporaryFile
        opened: list[BinaryIO] = []

        def tracked(*args: object, **kwargs: object) -> BinaryIO:
            spool = cast(BinaryIO, original(*args, **kwargs))  # type: ignore[call-overload]
            operation = getattr(spool, phase)

            def blocked(value: bytes | int) -> object:
                loop.call_soon_threadsafe(entered.set)
                assert release.wait(5)
                assert not spool.closed
                return operation(value)

            setattr(spool, phase, blocked)
            opened.append(spool)
            return spool

        monkeypatch.setattr("batchcraft.api.security.tempfile.SpooledTemporaryFile", tracked)
        app = RequestSecurityMiddleware(
            consume, replace(settings_for("test", tmp_path), max_inflight_request_bodies=1)
        )
        request = Request()
        request.body(b"x" * (1024 * 1024 + 1))
        task = asyncio.create_task(request.run(app))
        try:
            await entered.wait()
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            assert not opened[0].closed
            other = Request()
            other.body(b"cannot queue")
            await other.run(app)
            other.error(429, "request_capacity_exceeded")
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert opened[0].closed
        fresh = Request()
        fresh.body(b"fresh")
        await fresh.run(app)
        assert fresh.sent[1]["body"] == b"fresh"

    asyncio.run(asyncio.wait_for(scenario(), 10))


@pytest.mark.parametrize("phase", ["write", "read", "close"])
def test_event_loop_shutdown_joins_body_worker_before_close(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    entered, release, completed = threading.Event(), threading.Event(), threading.Event()
    opened: list[BinaryIO] = []
    errors: list[dict[str, object]] = []
    original = tempfile.SpooledTemporaryFile
    app = RequestSecurityMiddleware(
        consume, replace(settings_for("test", tmp_path), max_inflight_request_bodies=1)
    )

    def tracked(*args: object, **kwargs: object) -> BinaryIO:
        spool = original(*args, **kwargs)  # type: ignore[call-overload]
        spool.rollover()
        operation = getattr(spool, phase)

        def blocked(*values: bytes | int) -> object:
            entered.set()
            assert release.wait(5)
            assert not spool.closed
            result = operation(*values)
            completed.set()
            return result

        setattr(spool, phase, blocked)
        opened.append(cast(BinaryIO, spool))
        return cast(BinaryIO, spool)

    monkeypatch.setattr("batchcraft.api.security.tempfile.SpooledTemporaryFile", tracked)

    async def scenario() -> None:
        asyncio.get_running_loop().set_exception_handler(lambda _, context: errors.append(context))
        request = Request()
        request.body(b"owned")
        asyncio.create_task(request.run(app))
        assert await asyncio.to_thread(entered.wait, 2)
        # Returning cancels every remaining Task, not just the request's Task.
        timer.start()

    timer = threading.Timer(0.1, release.set)
    try:
        asyncio.run(scenario())
    finally:
        release.set()
        if timer.ident is not None:
            timer.join()
    assert completed.is_set()
    assert opened[0].closed
    assert app._inflight_bodies == 0
    assert not errors


def test_repeated_cancellation_joins_offthread_close_before_releasing_lease(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        entered = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        loop_thread = threading.get_ident()
        original = tempfile.SpooledTemporaryFile
        opened: list[BinaryIO] = []

        def tracked(*args: object, **kwargs: object) -> BinaryIO:
            spool = original(*args, **kwargs)  # type: ignore[call-overload]
            spool.rollover()
            close = spool.close

            def blocked() -> None:
                assert threading.get_ident() != loop_thread
                loop.call_soon_threadsafe(entered.set)
                assert release.wait(5)
                close()

            monkeypatch.setattr(spool, "close", blocked)
            opened.append(cast(BinaryIO, spool))
            return cast(BinaryIO, spool)

        monkeypatch.setattr("batchcraft.api.security.tempfile.SpooledTemporaryFile", tracked)
        app = RequestSecurityMiddleware(
            consume, replace(settings_for("test", tmp_path), max_inflight_request_bodies=1)
        )
        request = Request()
        request.body(b"owned")
        task = asyncio.create_task(request.run(app))
        try:
            await entered.wait()
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            assert not opened[0].closed
            other = Request()
            other.body(b"cannot queue")
            await other.run(app)
            other.error(429, "request_capacity_exceeded")
            poll = Request("GET")
            poll.body()
            await poll.run(app)
            assert poll.sent[0]["status"] == 200
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert opened[0].closed
        fresh = Request()
        fresh.body(b"fresh")
        await fresh.run(app)
        assert fresh.sent[1]["body"] == b"fresh"

    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_settings_defaults_overrides_and_launcher_isolation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BATCHCRAFT_MAX_INFLIGHT_REQUEST_BODIES", "2")
    monkeypatch.setenv("BATCHCRAFT_REQUEST_BODY_TIMEOUT", "3.5")
    settings = Settings.from_env()
    assert settings.max_inflight_request_bodies == 2
    assert settings.request_body_timeout_seconds == 3.5
    for mode in ["app", "dev", "test"]:
        isolated = settings_for(mode, tmp_path)
        assert isolated.max_inflight_request_bodies == 4
        assert isolated.request_body_timeout_seconds == 120


def test_slow_progress_does_not_restart_total_deadline(tmp_path: Path) -> None:
    async def scenario() -> None:
        app = RequestSecurityMiddleware(
            consume, replace(settings_for("test", tmp_path), request_body_timeout_seconds=0.04)
        )
        request = Request()
        request.body(b"x", more=True)
        task = asyncio.create_task(request.run(app))
        for _ in range(10):
            await asyncio.sleep(0.01)  # Progress within, but cumulatively beyond, the deadline.
            if task.done():
                break
            request.body(b"x", more=True)
        assert task.done()
        await task
        request.error(408, "request_body_timeout")
        fresh = Request()
        fresh.body(b"fresh")
        await fresh.run(app)
        assert fresh.sent[1]["body"] == b"fresh"

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_full_application_capacity_cors_and_polling(tmp_path: Path) -> None:
    async def scenario() -> None:
        settings = replace(settings_for("test", tmp_path), max_inflight_request_bodies=1)
        app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
        entered = asyncio.Event()
        finish = asyncio.Event()

        @app.post("/api/admission-probe")
        async def probe(request: StarletteRequest) -> Response:
            entered.set()
            await finish.wait()
            return Response(await request.body())

        async with app.router.lifespan_context(app):
            owner = Request(path="/api/admission-probe")
            owner.body(b"owned")
            task = asyncio.create_task(owner.run(app))
            try:
                await entered.wait()
                rejected = Request(
                    headers=[(b"origin", settings.frontend_origin.encode())], path="/api/projects"
                )
                rejected.body(b'{"name":"Must not be created"}')
                await rejected.run(app)
                rejected.error(429, "request_capacity_exceeded")
                assert (
                    b"access-control-allow-origin",
                    settings.frontend_origin.encode(),
                ) in rejected.sent[0]["headers"]
                assert not settings.projects_root.exists()
                for path in ["/api/health", "/api/executions/active", "/api/projects"]:
                    poll = Request("GET", path=path)
                    poll.body()
                    await poll.run(app)
                    assert poll.sent[0]["status"] == 200
                    if path == "/api/projects":
                        assert json.loads(poll.sent[1]["body"]) == {"projects": []}
            finally:
                finish.set()
                await task

    asyncio.run(asyncio.wait_for(scenario(), 5))


@pytest.mark.parametrize("phase", ["open", "write", "seek", "read", "handler", "receive"])
def test_diagnostic_wrapper_handles_failures_and_permit_reuse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, phase: str
) -> None:
    async def scenario() -> None:
        settings = replace(settings_for("test", tmp_path), max_inflight_request_bodies=1)
        app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
        failed = False
        original = tempfile.SpooledTemporaryFile
        opened: list[BinaryIO] = []

        def fail() -> None:
            nonlocal failed
            failed = True
            raise OSError("private upload failure")

        def tracked(*args: object, **kwargs: object) -> BinaryIO:
            if phase == "open" and not failed:
                fail()
            spool = cast(BinaryIO, original(*args, **kwargs))  # type: ignore[call-overload]
            if phase in {"write", "seek", "read"} and not failed:
                setattr(spool, phase, lambda *_: fail())
            opened.append(spool)
            return spool

        monkeypatch.setattr("batchcraft.api.security.tempfile.SpooledTemporaryFile", tracked)

        @app.post("/api/admission-probe")
        async def probe(request: StarletteRequest) -> Response:
            if phase == "handler" and not failed:
                fail()
            return Response(await request.body())

        request = Request(path="/api/admission-probe")
        if phase == "receive":
            request.events.put_nowait(OSError("private upload failure"))
        else:
            request.body(b"original")
        await request.run(app)
        request.error(500, "internal_error")
        assert all(spool.closed for spool in opened)
        fresh = Request(path="/api/admission-probe")
        fresh.body(b"fresh")
        await fresh.run(app)
        assert fresh.sent[0]["status"] == 200
        assert fresh.sent[1]["body"] == b"fresh"
        assert all(spool.closed for spool in opened)
        assert "private upload failure" not in caplog.text
        assert all(record.exc_info is None for record in caplog.records)

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_deadline_waits_for_active_file_worker_before_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        entered = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        original = tempfile.SpooledTemporaryFile
        opened: list[BinaryIO] = []

        def tracked(*args: object, **kwargs: object) -> BinaryIO:
            spool = cast(BinaryIO, original(*args, **kwargs))  # type: ignore[call-overload]
            write = spool.write

            def blocked(content: bytes) -> int:
                loop.call_soon_threadsafe(entered.set)
                assert release.wait(5)
                assert not spool.closed
                return write(content)

            monkeypatch.setattr(spool, "write", blocked)
            opened.append(spool)
            return spool

        monkeypatch.setattr("batchcraft.api.security.tempfile.SpooledTemporaryFile", tracked)
        app = RequestSecurityMiddleware(
            consume,
            replace(
                settings_for("test", tmp_path),
                max_inflight_request_bodies=1,
                request_body_timeout_seconds=0.02,
            ),
        )
        request = Request()
        request.body(b"x")
        task = asyncio.create_task(request.run(app))
        try:
            await entered.wait()
            await asyncio.sleep(0.04)  # Let the real deadline cancel the blocked file await.
            assert task.cancelling()
            assert not task.done()
            assert not opened[0].closed
            other = Request()
            other.body(b"cannot queue")
            await other.run(app)
            other.error(429, "request_capacity_exceeded")
        finally:
            release.set()
        await task
        request.error(408, "request_body_timeout")
        assert opened[0].closed
        fresh = Request()
        fresh.body(b"fresh")
        await fresh.run(app)
        assert fresh.sent[1]["body"] == b"fresh"

    asyncio.run(asyncio.wait_for(scenario(), 10))


@pytest.mark.parametrize("value", [0, -1, True, 1.5, "4", float("inf"), float("nan")])
def test_invalid_capacity_setting(tmp_path: Path, value: object) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        replace(settings_for("test", tmp_path), max_inflight_request_bodies=value)  # type: ignore[arg-type]


@pytest.mark.parametrize("value", [0, -1, True, "120", float("inf"), float("nan")])
def test_invalid_deadline_setting(tmp_path: Path, value: object) -> None:
    with pytest.raises(ValueError, match="positive and finite"):
        replace(settings_for("test", tmp_path), request_body_timeout_seconds=value)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "name", ["BATCHCRAFT_MAX_INFLIGHT_REQUEST_BODIES", "BATCHCRAFT_REQUEST_BODY_TIMEOUT"]
)
@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf", "-inf", "invalid"])
def test_invalid_admission_environment(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError):
        Settings.from_env()
