import asyncio
import errno
import hashlib
import json
import logging
from collections.abc import AsyncIterator, Mapping
from dataclasses import replace
from pathlib import Path
from typing import cast
from unittest.mock import Mock

import h11
import pytest
from api_client import LoopbackTestClient as TestClient
from fastapi.responses import StreamingResponse
from test_api import (
    FakeComfyUIClient,
    _batch_request,
    _create_run,
    _import_asset,
    _settings,
    _sync_batch_snapshot,
    _wait_for_status,
)
from test_public_diagnostics import PRIVATE_PATH, RAW, SECRET, _assert_public
from uvicorn._types import ASGI3Application, HTTPScope
from uvicorn.protocols.http.flow_control import FlowControl
from uvicorn.protocols.http.h11_impl import RequestResponseCycle

from batchcraft.api import create_app
from batchcraft.application.cancellation import ActiveRunCancellationControl
from batchcraft.application.tasks import RunTaskRegistry
from batchcraft.comfyui import PromptSubmission, SubmissionDisposition
from batchcraft.db import RunCancellationRequestStore
from batchcraft.diagnostics import safe_exception
from batchcraft.execution import execute_run
from batchcraft.files import RunFilesystemStore
from batchcraft.files._io import write_bytes


@pytest.mark.parametrize("streaming", [False, True])
def test_uvicorn_http_cycle_cannot_log_raw_rethrown_exception(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, streaming: bool
) -> None:
    app = create_app(_settings(tmp_path), client_factory=lambda _: FakeComfyUIClient())

    def fail() -> None:
        try:
            raise OSError(errno.ENOSPC, RAW, PRIVATE_PATH)
        except OSError as error:
            raise RuntimeError(RAW) from error

    @app.get("/api/failure")
    async def failure() -> StreamingResponse:
        if not streaming:
            fail()

        async def chunks() -> AsyncIterator[bytes]:
            yield b"safe initial content"
            fail()

        return StreamingResponse(chunks())

    async def scenario() -> None:
        # Exercise Uvicorn's real exception/logging wrapper without binding any port.
        connection = h11.Connection(h11.SERVER)
        connection.receive_data(b"GET /api/failure HTTP/1.1\r\nHost: localhost\r\n\r\n")
        assert isinstance(connection.next_event(), h11.Request)
        transport = Mock(spec=asyncio.Transport)
        scope = cast(
            HTTPScope,
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "scheme": "http",
                "method": "GET",
                "root_path": "",
                "path": "/api/failure",
                "raw_path": b"/api/failure",
                "query_string": b"",
                "headers": [(b"host", b"localhost")],
                "client": ("127.0.0.1", 12345),
                "server": ("127.0.0.1", 8002),
                "state": {},
            },
        )
        cycle = RequestResponseCycle(
            scope,
            connection,
            transport,
            FlowControl(transport),
            logging.getLogger("uvicorn.error"),
            logging.getLogger("uvicorn.access"),
            False,
            [],
            asyncio.Event(),
            lambda: None,
        )
        cycle.more_body = False
        cycle.message_event.set()
        async with asyncio.timeout(5):
            await cycle.run_asgi(cast(ASGI3Application, app))
        wire = b"".join(call.args[0] for call in transport.write.call_args_list)
        _assert_public(wire.decode())
        if streaming:
            assert b"200 OK" in wire
            assert not cycle.response_complete
            transport.close.assert_called_once()
            assert "ASGI callable returned without completing response" in caplog.text
        else:
            assert b"500 Internal Server Error" in wire
            assert b'"code":"internal_error"' in wire
            assert cycle.response_complete

    asyncio.run(scenario())
    _assert_public(caplog.text)
    assert "Unhandled HTTP application error" in caplog.text
    assert "RuntimeError" in caplog.text
    assert "OSError storage_full" in caplog.text
    assert "batchcraft/api/app.py:" in caplog.text
    assert str(Path(__file__).parents[2]) not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)
    assert "Exception in ASGI application" not in caplog.text


@pytest.mark.parametrize(
    "error_number, reason", [(errno.ENOSPC, "storage_full"), (errno.EACCES, "permission_denied")]
)
@pytest.mark.parametrize("phase", ["initialize", "save"])
def test_task_failure_before_execution_state_write_retains_safe_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error_number: int,
    reason: str,
    phase: str,
) -> None:
    settings = _settings(tmp_path)
    client = FakeComfyUIClient()
    with TestClient(create_app(settings, client_factory=lambda _: client)) as http:
        _create_run(http, _batch_request(()))
    path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
    run = RunFilesystemStore(settings.projects_root).load_run(path)
    assert not (path / "execution.json").exists()

    writes = 0

    def cannot_write(path: Path, content: bytes) -> None:
        nonlocal writes
        writes += 1
        if phase == "save" and writes == 1:
            write_bytes(path, content)
            return
        raise OSError(error_number, RAW, PRIVATE_PATH)

    monkeypatch.setattr("batchcraft.execution.state.write_bytes", cannot_write)

    async def scenario() -> None:
        registry = RunTaskRegistry()
        control = ActiveRunCancellationControl(
            PRIVATE_PATH, RunCancellationRequestStore(settings.database_path)
        )
        await registry.start(PRIVATE_PATH, control, lambda: execute_run(run=run, client=client))
        async with asyncio.timeout(5):
            while registry.is_active(PRIVATE_PATH):
                await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert await registry.active_run_id() is None
        await registry.shutdown()

    asyncio.run(scenario())
    if phase == "save":
        persisted = json.loads((path / "execution.json").read_bytes())
        assert persisted["status"] == "created"
        assert persisted["error"] is None
    else:
        assert not (path / "execution.json").exists()
    assert client.submission_count == 0
    _assert_public(caplog.text)
    expected = hashlib.sha256(PRIVATE_PATH.encode()).hexdigest()[:16]
    assert f"run=sha256:{expected}" in caplog.text
    assert reason in caplog.text
    assert "batchcraft/execution/state.py:" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_safe_exception_limits_chains_and_does_not_render_custom_type_names() -> None:
    error = type(SECRET, (RuntimeError,), {})(RAW)
    error.__cause__ = error
    text = safe_exception(error, run_id=PRIVATE_PATH)
    _assert_public(text)
    assert "RuntimeError at external" in text


@pytest.mark.parametrize("target", ["image", "parameter"])
@pytest.mark.parametrize("evidence", ["base", "override", "unstructured", "unknown", "unrelated"])
def test_base_rejection_guidance_uses_structured_frozen_evidence_only(
    tmp_path: Path, target: str, evidence: str
) -> None:
    settings = _settings(tmp_path)
    asset_ids = (
        (_import_asset(settings, tmp_path),) if target == "image" and evidence == "override" else ()
    )
    request = _batch_request(asset_ids)
    workflow = cast(dict[str, object], request["workflow"])
    profile = cast(dict[str, object], request["workflow_profile"])
    if target == "parameter":
        workflow["99"] = {"class_type": "Custom", "inputs": {"model": PRIVATE_PATH}}
        profile["parameters"] = [
            {
                "key": "model",
                "label": SECRET,
                "node_id": "99",
                "input_name": "model",
                "value_type": "string",
            }
        ]
        request["parameter_bindings"] = [
            {
                "parameter_key": "model",
                "mode": "values",
                "values": ["override" if evidence == "override" else None],
            }
        ]
    else:
        workflow["25"] = {"class_type": "LoadImage", "inputs": {"image": PRIVATE_PATH}}
        slots = cast(list[dict[str, object]], profile["image_inputs"])
        slots[0]["label"] = SECRET
    _sync_batch_snapshot(request)
    node, input_name = ("25", "image") if target == "image" else ("99", "model")
    response: dict[str, object] = {
        "node_errors": {
            node: {"errors": [{"extra_info": {"input_name": input_name}, "message": RAW}]}
        }
    }
    if evidence == "unstructured":
        response = {"error": RAW}
    if evidence == "unrelated":
        response = {
            "node_errors": {"unrelated": {"errors": [{"extra_info": {"input_name": input_name}}]}}
        }

    class RejectedClient(FakeComfyUIClient):
        async def submit_prompt(
            self, workflow: Mapping[str, object], *, client_id: str
        ) -> PromptSubmission:
            submission = await super().submit_prompt(workflow, client_id=client_id)
            return replace(
                submission,
                response=response,
                http_status=400,
                diagnostic="ComfyUI reported validation for Image Input fake Base workflow; " + RAW,
            )

    client = RejectedClient(
        submission_disposition=SubmissionDisposition.UNKNOWN
        if evidence == "unknown"
        else SubmissionDisposition.REJECTED
    )
    with TestClient(create_app(settings, client_factory=lambda _: client)) as http:
        run_id = _create_run(http, request)
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        _wait_for_status(http, run_id, "blocked" if evidence == "unknown" else "failed")
        path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
        before = {file: file.read_bytes() for file in path.iterdir() if file.is_file()}
        for body in (
            http.get(f"/api/runs/{run_id}/execution").json(),
            http.get(f"/api/runs/{run_id}").json()["execution"],
        ):
            messages = body["jobs"][0]["diagnostics"]
            text = " ".join(messages)
            _assert_public(text)
            assert "HTTP 400" in text
            if evidence == "base":
                category = "Base Image Input 1" if target == "image" else "Base parameter 1"
                assert category in text
                assert (
                    "choose a Project image" if target == "image" else "choose an override"
                ) in text
            else:
                assert "Base Image Input" not in text
                assert "Base parameter" not in text
        assert before == {file: file.read_bytes() for file in before}
        assert client.submission_count == 1
