import asyncio
import json
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from api_client import LoopbackTestClient as TestClient
from test_api import (
    FakeComfyUIClient,
    _batch_request,
    _create_run,
    _settings,
    _sync_batch_snapshot,
    _wait_for_status,
)
from test_history_api import _copy_fixture

from batchcraft.api import create_app
from batchcraft.application.errors import ProjectImportError, RunDataError
from batchcraft.comfyui import (
    ComfyUIClient,
    ComfyUIConnectionError,
    ComfyUIError,
    ExecutionOutcome,
    ExecutionStatus,
    PromptSubmission,
    RemoteOutputArtifact,
    SubmissionDisposition,
)
from batchcraft.comfyui.events import parse_execution_event
from batchcraft.db import ProjectValidationError, SavedBatchIntegrityError
from batchcraft.diagnostics import public_diagnostic, public_error_message
from batchcraft.domain import CompilationError

SECRET = "SENTINEL-private-token"
PRIVATE_PATH = f"/Users/private/{SECRET}/credentials.json"
RAW = f"Bearer {SECRET} {PRIVATE_PATH} " + "UPSTREAM_BODY" * 100_000


def _assert_public(text: str, *, limit: int = 4096) -> None:
    assert SECRET not in text
    assert PRIVATE_PATH not in text
    assert "UPSTREAM_BODY" not in text
    assert len(text) < limit


def test_only_complete_diagnostic_contracts_pass_through() -> None:
    message = "Historical PromptVersion position 2 is outside the available range 0..1"
    assert public_diagnostic(message, "Unavailable") == message
    assert public_diagnostic(message + RAW, "Unavailable") == "Unavailable"
    assert (
        public_diagnostic("cannot connect to ComfyUI", "Unavailable") == "cannot connect to ComfyUI"
    )
    _assert_public(public_error_message("future_error_code", RAW))


def test_malformed_prompt_error_does_not_echo_user_text(tmp_path: Path) -> None:
    request = _batch_request(())
    request["prompt_versions"] = [
        {"id": "prompt", "name": "Prompt", "text": "{{" + PRIVATE_PATH + "}}"}
    ]
    _sync_batch_snapshot(request)
    with TestClient(
        create_app(_settings(tmp_path), client_factory=lambda _: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)
    assert response.status_code == 422
    _assert_public(response.text)


@pytest.mark.parametrize("operation", ["status", "upload", "history", "download", "submit"])
@pytest.mark.parametrize("failure", ["http", "json", "transport"])
def test_upstream_failures_have_bounded_diagnostics(operation: str, failure: str) -> None:
    async def scenario() -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if failure == "transport":
                raise httpx.ConnectError(RAW, request=request)
            return httpx.Response(503 if failure == "http" else 200, text=RAW)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = ComfyUIClient("http://unused", http_client=http)
            if operation == "submit":
                submission = await client.submit_prompt({}, client_id="client")
                assert submission.disposition is SubmissionDisposition.UNKNOWN
                _assert_public(submission.diagnostic or "")
            elif operation == "download" and failure == "json":
                # Artifact bytes are intentionally not a diagnostic or JSON contract.
                downloaded = await client.download_artifact(
                    RemoteOutputArtifact("1", "images", "image.png", "", "output")
                )
                assert downloaded.content == RAW.encode()
            else:
                with pytest.raises(ComfyUIError) as raised:
                    if operation == "status":
                        await client.get_server_info()
                    elif operation == "upload":
                        await client.upload_input(filename="input.png", content=b"image")
                    elif operation == "history":
                        await client.get_history(PRIVATE_PATH)
                    else:
                        await client.download_artifact(
                            RemoteOutputArtifact("1", "images", PRIVATE_PATH, "", "output")
                        )
                _assert_public(str(raised.value))
                if failure == "http":
                    assert "503" in str(raised.value)
                if failure == "transport":
                    assert isinstance(raised.value.__cause__, httpx.ConnectError)
            assert attempts == 1

    asyncio.run(scenario())


@pytest.mark.parametrize("body", [RAW, {"error": RAW, "node_errors": {"1": RAW}}])
def test_rejection_classification_does_not_depend_on_body(body: object) -> None:
    async def scenario() -> None:
        response = (
            httpx.Response(400, text=body)
            if isinstance(body, str)
            else httpx.Response(400, json=body)
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: response)) as http:
            submission = await ComfyUIClient("http://unused", http_client=http).submit_prompt(
                {}, client_id="client"
            )
        assert submission.disposition is SubmissionDisposition.REJECTED
        assert submission.http_status == 400
        assert "HTTP 400" in (submission.diagnostic or "")
        _assert_public(submission.diagnostic or "")

    asyncio.run(scenario())


def test_websocket_protocol_errors_do_not_echo_event_type() -> None:
    with pytest.raises(ComfyUIError) as raised:
        parse_execution_event(json.dumps({"type": RAW, "data": None}), "prompt")
    _assert_public(str(raised.value))


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (ProjectImportError(RAW), 422),
        (ProjectValidationError(RAW), 422),
        (SavedBatchIntegrityError(RAW), 422),
        (CompilationError(RAW), 422),
        (RunDataError(RAW), 500),
        (RuntimeError(RAW), 500),
    ],
)
def test_domain_error_handlers_do_not_echo_exception_text(
    tmp_path: Path, error: Exception, status: int, caplog: pytest.LogCaptureFixture
) -> None:
    app = create_app(_settings(tmp_path), client_factory=lambda _: FakeComfyUIClient())

    @app.get("/api/diagnostic-probe")
    def probe() -> None:
        raise error

    with TestClient(app, raise_server_exceptions=False) as http:
        response = http.get("/api/diagnostic-probe")
    assert response.status_code == status
    _assert_public(response.text)
    _assert_public(caplog.text)
    assert len(response.json()["error"]["message"]) > 20


def test_status_sanitizes_legacy_client_errors(tmp_path: Path) -> None:
    client = FakeComfyUIClient(status_error=ComfyUIConnectionError(RAW))
    with TestClient(create_app(_settings(tmp_path), client_factory=lambda _: client)) as http:
        response = http.get("/api/comfyui/status")
    assert response.status_code == 200
    assert response.json()["reachable"] is False
    _assert_public(response.text)


def test_import_reindex_and_history_hide_paths_without_rewriting_files(tmp_path: Path) -> None:
    settings = _settings(tmp_path / SECRET)
    settings.projects_root.parent.mkdir()
    project = _copy_fixture(settings)
    with TestClient(create_app(settings, client_factory=lambda _: FakeComfyUIClient())) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        run_json = project / "batches/batch_key/001-run/run.json"
        run_json.write_text(RAW)
        before = {path: path.read_bytes() for path in project.rglob("*") if path.is_file()}
        reindexed = http.post("/api/projects/project-id/reindex")
        assert reindexed.status_code == 200
        assert reindexed.json()["run_count"] == 0
        history = http.get("/api/projects/project-id/runs")
        diagnostic = history.json()["diagnostics"][0]
        assert diagnostic["code"] == "invalid_run"
        assert diagnostic["filesystem_key"] == "001-run"
        _assert_public(history.text)
        assert before == {path: path.read_bytes() for path in before}
        owner = project / "project.json"
        owner.write_text(RAW)
        for endpoint in ("/api/projects/import", "/api/projects/project-id/reindex"):
            response = http.post(endpoint, json={"filesystem_key": "project_key"})
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "project_import_failed"
            _assert_public(response.text)
        assert owner.read_text() == RAW
        assert http.get("/api/projects/project-id/runs").json() == history.json()


@pytest.mark.parametrize("outcome", ["rejected", "unknown", "failed", "succeeded"])
def test_execution_public_projection_preserves_outcomes_and_frozen_user_data(
    tmp_path: Path, outcome: str
) -> None:
    class DiagnosticClient(FakeComfyUIClient):
        async def submit_prompt(
            self, workflow: Mapping[str, object], *, client_id: str
        ) -> PromptSubmission:
            submission = await super().submit_prompt(workflow, client_id=client_id)
            return replace(
                submission,
                diagnostic=RAW,
                response={"error": RAW},
                http_status=503 if outcome == "unknown" else 400 if outcome == "rejected" else 200,
            )

        async def get_history(self, prompt_id: str) -> ExecutionOutcome:
            return ExecutionOutcome(
                prompt_id,
                ExecutionStatus.SUCCEEDED if outcome == "succeeded" else ExecutionStatus.FAILED,
                (),
                {
                    "completed": True,
                    "status_str": "success" if outcome == "succeeded" else "error",
                    "messages": [RAW],
                },
            )

    client = DiagnosticClient(
        submission_disposition=SubmissionDisposition.ACCEPTED
        if outcome in {"failed", "succeeded"}
        else SubmissionDisposition(outcome)
    )
    settings = _settings(tmp_path)
    request = _batch_request(())
    provenance = "User requested /private/workflow/model.safetensors"
    request["prompt_versions"] = [{"id": "prompt-v1", "name": "Prompt", "text": provenance}]
    _sync_batch_snapshot(request)
    with TestClient(create_app(settings, client_factory=lambda _: client)) as http:
        run_id = _create_run(http, request)
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        state = _wait_for_status(
            http,
            run_id,
            "blocked"
            if outcome == "unknown"
            else "succeeded"
            if outcome == "succeeded"
            else "failed",
        )
        assert state.jobs[0].ordinal == 1
        assert client.submission_count == (len(state.jobs) if outcome == "succeeded" else 1)
        if outcome == "succeeded":
            assert state.jobs[0].error is None
            assert state.jobs[0].diagnostics == [
                "Job completed; additional diagnostic detail omitted"
            ]
        if outcome in {"unknown", "rejected"}:
            assert str(503 if outcome == "unknown" else 400) in (state.jobs[0].error or "")
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
        before = {path: path.read_bytes() for path in run_path.iterdir() if path.is_file()}
        assert SECRET.encode() in before[run_path / "execution.json"]
        execution = http.get(f"/api/runs/{run_id}/execution")
        _assert_public(execution.text)
        detail = http.get(f"/api/runs/{run_id}")
        assert detail.status_code == 200
        _assert_public(json.dumps(detail.json()["execution"]))
        assert detail.json()["prompt_versions"][0]["text"] == provenance
        assert detail.json()["plan"]["jobs"][0]["resolved_prompt"] == provenance
        assert before == {path: path.read_bytes() for path in before}
