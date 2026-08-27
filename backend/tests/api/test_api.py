import asyncio
import hashlib
import shutil
import threading
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import replace
from pathlib import Path
from typing import NoReturn

import pytest
from fastapi.testclient import TestClient

import batchcraft.execution.state as execution_state_module
from batchcraft.api import Settings, create_app
from batchcraft.api.schemas import ExecutionResponse, PreviewResponse, ResultsResponse
from batchcraft.comfyui import (
    ComfyUIConnectionError,
    DownloadedArtifact,
    ExecutionEvent,
    ExecutionOutcome,
    ExecutionStatus,
    PromptSubmission,
    RemoteOutputArtifact,
    ServerInfo,
    SubmissionDisposition,
    UploadedInput,
)
from batchcraft.execution import (
    ExecutionClient,
    ExecutionConfig,
    ExecutionStateError,
    ExecutionStateStore,
    RunExecutionState,
    RunExecutionStatus,
)
from batchcraft.files import AssetRecord, ProjectAssetStore, PublishedRun, RunFilesystemStore


class FakeEventSource:
    async def events(self, prompt_id: str) -> AsyncIterator[ExecutionEvent]:
        yield ExecutionEvent(
            event_type="execution_success",
            prompt_id=prompt_id,
            node_id=None,
            data={"prompt_id": prompt_id},
        )


class FakeEventContext(AbstractAsyncContextManager[FakeEventSource]):
    async def __aenter__(self) -> FakeEventSource:
        return FakeEventSource()

    async def __aexit__(self, *_args: object) -> None:
        return None


class FakeComfyUIClient:
    def __init__(
        self,
        *,
        status_error: Exception | None = None,
        submission_disposition: SubmissionDisposition = SubmissionDisposition.ACCEPTED,
        history_status: ExecutionStatus = ExecutionStatus.SUCCEEDED,
        upload_error: Exception | None = None,
        artifact_count: int = 0,
    ) -> None:
        self.status_error = status_error
        self.submission_disposition = submission_disposition
        self.history_status = history_status
        self.upload_error = upload_error
        self.artifact_count = artifact_count
        self.closed = False
        self.submission_count = 0

    async def get_server_info(self) -> ServerInfo:
        if self.status_error is not None:
            raise self.status_error
        return ServerInfo(
            data={
                "system": {"comfyui_version": "0.31.0"},
                "devices": [{"name": "Test GPU"}],
            }
        )

    async def upload_input(
        self,
        *,
        filename: str,
        content: bytes,
        mime_type: str = "application/octet-stream",
        subfolder: str = "",
    ) -> UploadedInput:
        if self.upload_error is not None:
            raise self.upload_error
        return UploadedInput(
            name=filename,
            subfolder=subfolder,
            remote_type="input",
            workflow_value=f"{subfolder}/{filename}",
        )

    def open_event_stream(self, client_id: str) -> AbstractAsyncContextManager[FakeEventSource]:
        return FakeEventContext()

    async def submit_prompt(
        self, workflow: Mapping[str, object], *, client_id: str
    ) -> PromptSubmission:
        self.submission_count += 1
        prompt_id = (
            f"prompt-{self.submission_count}"
            if self.submission_disposition is SubmissionDisposition.ACCEPTED
            else None
        )
        return PromptSubmission(
            disposition=self.submission_disposition,
            client_id=client_id,
            prompt_id=prompt_id,
            http_status=200,
            response={"prompt_id": prompt_id} if prompt_id else None,
            diagnostic=(
                "submission outcome unknown"
                if self.submission_disposition is SubmissionDisposition.UNKNOWN
                else None
            ),
        )

    async def get_history(self, prompt_id: str) -> ExecutionOutcome | None:
        artifacts = tuple(
            RemoteOutputArtifact(
                producing_node_id=str(40 + ordinal),
                output_name="images",
                filename=f"{prompt_id}-{ordinal}.png",
                subfolder="batchcraft",
                remote_type="output",
            )
            for ordinal in range(1, self.artifact_count + 1)
        )
        return ExecutionOutcome(
            prompt_id=prompt_id,
            status=self.history_status,
            artifacts=artifacts,
            status_data={"completed": True, "status_str": self.history_status.value},
        )

    async def download_artifact(self, artifact: RemoteOutputArtifact) -> DownloadedArtifact:
        content = f"bytes:{artifact.filename}".encode()
        return DownloadedArtifact(
            remote=artifact,
            content=content,
            content_type="image/png",
            sha256=hashlib.sha256(content).hexdigest(),
        )

    async def aclose(self) -> None:
        self.closed = True


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        projects_root=tmp_path / "projects",
        comfyui_base_url="http://comfyui.test:8188",
        comfyui_timeout_seconds=1,
        websocket_timeout_seconds=1,
        history_timeout_seconds=1,
        history_poll_interval_seconds=0.01,
        frontend_origin="http://localhost:5173",
        server_host="127.0.0.1",
        server_port=8000,
    )


def _import_asset(settings: Settings, tmp_path: Path, asset_id: str = "asset-1") -> str:
    source = tmp_path / f"{asset_id}.png"
    source.write_bytes(f"reference:{asset_id}".encode())
    asset = ProjectAssetStore(
        settings.projects_root / "project_key",
        id_factory=lambda: asset_id,
    ).import_file(source)
    return asset.asset_id


def _batch_request(
    asset_ids: tuple[str, ...],
    *,
    include_unused_binding: bool = False,
    invalid_profile: bool = False,
) -> dict[str, object]:
    bindings: list[dict[str, object]] = [
        {
            "placeholder": "animal",
            "variable_list": {"id": "animals", "values": ["cat", "dog"]},
            "mode": "all",
            "selected_values": ["dog", "cat"],
        }
    ]
    if include_unused_binding:
        bindings.append(
            {
                "placeholder": "unused",
                "variable_list": {"id": "unused-values", "values": ["value"]},
                "mode": "fixed",
                "fixed_value": "value",
            }
        )
    profile = {
        "id": "profile-id",
        "name": "Profile",
        "mappings": {
            "prompt": {"node_id": "34", "input_name": "prompt", "value_type": "string"},
            "reference_image": {
                "node_id": "25",
                "input_name": "image",
                "value_type": "image",
            },
            "seed": {"node_id": "7", "input_name": "seed", "value_type": "integer"},
            "output_prefix": {
                "node_id": "41",
                "input_name": "filename_prefix",
                "value_type": "string",
            },
        },
    }
    if invalid_profile:
        mappings = profile["mappings"]
        assert isinstance(mappings, dict)
        mappings.pop("output_prefix")
    return {
        "project": {"id": "project-id", "filesystem_key": "project_key", "name": "Project"},
        "batch": {"id": "batch-id", "filesystem_key": "batch_key", "name": "Batch"},
        "prompt_version": {"id": "prompt-v1", "text": "Portrait of {{animal}}"},
        "variable_bindings": bindings,
        "references": [{"asset_id": asset_id} for asset_id in asset_ids],
        "seeds": {"mode": "explicit", "values": [9, 3]},
        "workflow": {
            "7": {"class_type": "KSampler", "inputs": {"seed": 0}},
            "25": {"class_type": "LoadImage", "inputs": {"image": "original.png"}},
            "34": {"class_type": "TextEncode", "inputs": {"prompt": "original"}},
            "41": {"class_type": "SaveImage", "inputs": {"filename_prefix": "original"}},
        },
        "workflow_profile": profile,
    }


def _create_run(http: TestClient, request: dict[str, object]) -> str:
    response = http.post("/api/runs", json=request)
    assert response.status_code == 201, response.text
    return str(response.json()["run_id"])


def _wait_for_status(http: TestClient, run_id: str, expected: str) -> ExecutionResponse:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        response = http.get(f"/api/runs/{run_id}/execution")
        assert response.status_code == 200
        body = ExecutionResponse.model_validate(response.json())
        if body.status == expected:
            return body
        time.sleep(0.01)
    raise AssertionError(f"Run {run_id} did not reach {expected}")


def test_health_and_comfyui_status_reachable_and_client_lifecycle(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    client = FakeComfyUIClient()

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        health = http.get("/api/health")
        comfyui = http.get("/api/comfyui/status")

        assert health.status_code == 200
        assert health.json() == {"status": "ok", "version": "0.1.0"}
        assert comfyui.json() == {
            "reachable": True,
            "version": "0.31.0",
            "devices": ["Test GPU"],
            "diagnostic": None,
        }
        cors = http.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        disallowed_cors = http.options(
            "/api/health",
            headers={
                "Origin": "https://example.invalid",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert cors.headers["access-control-allow-origin"] == "http://localhost:5173"
        assert "access-control-allow-origin" not in disallowed_cors.headers
        assert not client.closed

    assert client.closed


def test_comfyui_unavailable_is_a_stable_status_response(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    client = FakeComfyUIClient(status_error=ComfyUIConnectionError("cannot connect to ComfyUI"))

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        response = http.get("/api/comfyui/status")

    assert response.status_code == 200
    assert response.json() == {
        "reachable": False,
        "version": None,
        "devices": [],
        "diagnostic": "cannot connect to ComfyUI",
    }


def test_preview_uses_production_compiler_order_and_preserves_warnings(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(
        ("asset-1", "asset-2"),
        include_unused_binding=True,
    )

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)

    assert response.status_code == 200
    body = PreviewResponse.model_validate(response.json())
    assert body.job_count == 8
    assert [(job.resolved_prompt, job.reference_asset_id, job.seed) for job in body.jobs] == [
        ("Portrait of dog", "asset-1", 9),
        ("Portrait of dog", "asset-1", 3),
        ("Portrait of dog", "asset-2", 9),
        ("Portrait of dog", "asset-2", 3),
        ("Portrait of cat", "asset-1", 9),
        ("Portrait of cat", "asset-1", 3),
        ("Portrait of cat", "asset-2", 9),
        ("Portrait of cat", "asset-2", 3),
    ]
    assert body.warnings[0].code == "unused_binding"


def test_invalid_binding_returns_api_error(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(("asset-1",))
    bindings = request["variable_bindings"]
    assert isinstance(bindings, list)
    bindings[0]["selected_values"] = ["horse"]

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_batch"


def test_run_creation_and_lookup_use_real_durable_store(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    request = _batch_request((asset_id,))

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        create_response = http.post("/api/runs", json=request)
        assert create_response.status_code == 201
        created = create_response.json()
        run_id = created["run_id"]
        lookup = http.get(f"/api/runs/{run_id}")
        missing = http.get("/api/runs/missing")

    run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
    published = RunFilesystemStore(settings.projects_root).load_run(run_path)
    assert published.run_id == run_id
    assert created["job_count"] == 4
    assert created["durable_status"] == "created"
    assert lookup.status_code == 200
    assert lookup.json()["execution"]["status"] == "created"
    assert not (run_path / "execution.json").exists()
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "run_not_found"


def test_run_lookup_ignores_corrupt_unrelated_run_and_only_loads_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        target_run_id = _create_run(http, _batch_request((asset_id,)))
        _create_run(http, _batch_request((asset_id,)))
        target_path, unrelated_path = sorted(settings.projects_root.glob("*/batches/*/run-*"))
        (unrelated_path / "workflow.json").write_bytes(b"{}")
        loaded_paths: list[Path] = []
        real_load_run = RunFilesystemStore.load_run

        def counting_load_run(store: RunFilesystemStore, path: Path) -> PublishedRun:
            loaded_paths.append(path)
            return real_load_run(store, path)

        monkeypatch.setattr(RunFilesystemStore, "load_run", counting_load_run)

        response = http.get(f"/api/runs/{target_run_id}")

    assert response.status_code == 200
    assert response.json()["run_id"] == target_run_id
    assert loaded_paths == [target_path]


def test_run_lookup_rejects_corrupt_matching_run(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
        (run_path / "workflow.json").write_bytes(b"{}")

        response = http.get(f"/api/runs/{run_id}")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "invalid_run_data"


def test_run_lookup_rejects_duplicate_matching_run_ids(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
        duplicate_path = (
            settings.projects_root / "duplicate_project" / "batches" / "batch_key" / "run-001"
        )
        duplicate_path.parent.mkdir(parents=True)
        shutil.copytree(run_path, duplicate_path)

        response = http.get(f"/api/runs/{run_id}")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "invalid_run_data"


def test_invalid_workflow_fails_without_partial_run_publication(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    request = _batch_request((asset_id,), invalid_profile=True)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/runs", json=request)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_workflow_profile"
    assert not tuple(settings.projects_root.glob("*/batches/*/run-*"))


def test_run_creation_ignores_corrupt_unrelated_project_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    project_path = settings.projects_root / "project_key"
    healthy_source = tmp_path / "healthy.png"
    healthy_source.write_bytes(b"healthy")
    unrelated_source = tmp_path / "unrelated.png"
    unrelated_source.write_bytes(b"unrelated")
    healthy = ProjectAssetStore(
        project_path,
        id_factory=lambda: "healthy-asset",
    ).import_file(healthy_source)
    unrelated = ProjectAssetStore(
        project_path,
        id_factory=lambda: "unrelated-asset",
    ).import_file(unrelated_source)
    (project_path / unrelated.stored_path).write_bytes(b"corrupted!")
    loaded_digests: list[str] = []
    real_load = ProjectAssetStore.load

    def counting_load(store: ProjectAssetStore, sha256: str) -> AssetRecord:
        loaded_digests.append(sha256)
        return real_load(store, sha256)

    monkeypatch.setattr(ProjectAssetStore, "load", counting_load)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/runs", json=_batch_request((healthy.asset_id,)))

    assert response.status_code == 201
    assert healthy.sha256 in loaded_digests
    assert unrelated.sha256 not in loaded_digests


def test_run_creation_rejects_symlinked_project_ancestor(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    settings.projects_root.mkdir(parents=True)
    outside = tmp_path / "outside-project"
    outside.mkdir()
    (settings.projects_root / "project_key").symlink_to(outside, target_is_directory=True)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/runs", json=_batch_request(("asset-1",)))

    assert response.status_code == 422
    assert response.json() == {
        "error": {"code": "run_creation_failed", "message": "Run could not be created"}
    }
    assert not (outside / "batches").exists()


def test_run_publication_io_failure_is_a_stable_server_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    def fail_publication(*_args: object, **_kwargs: object) -> NoReturn:
        raise OSError("disk path details")

    monkeypatch.setattr(RunFilesystemStore, "create_run", fail_publication)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient()),
        raise_server_exceptions=False,
    ) as http:
        response = http.post("/api/runs", json=_batch_request((asset_id,)))

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "run_publication_failed", "message": "Run could not be published"}
    }
    assert "disk path details" not in response.text


def test_execution_runs_in_background_and_serves_ordered_results(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    client = FakeComfyUIClient(artifact_count=2)

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
        immutable_before = {
            name: (run_path / name).read_bytes()
            for name in ("run.json", "manifest.json", "workflow.json", "workflow-profile.json")
        }

        started = http.post(f"/api/runs/{run_id}/execute")
        assert started.status_code == 202
        assert started.json() == {"run_id": run_id, "status": "accepted"}
        execution = _wait_for_status(http, run_id, "succeeded")
        results = http.get(f"/api/runs/{run_id}/results")
        first_file = http.get(f"/api/runs/{run_id}/results/1/1")
        missing = http.get(f"/api/runs/{run_id}/results/1/99")
        traversal = http.get(f"/api/runs/{run_id}/results/not-a-job/1")
        encoded_traversal = http.get(f"/api/runs/{run_id}/results/%2e%2e/%2e%2e/manifest.json")
        restart = http.post(f"/api/runs/{run_id}/execute")

        result_path = run_path / "outputs" / "000001-01.png"
        secret = tmp_path / "secret.txt"
        secret.write_bytes(b"must not be served")
        result_path.unlink()
        result_path.symlink_to(secret)
        symlinked_result = http.get(f"/api/runs/{run_id}/results/1/1")

    assert execution.current_job_ordinal is None
    assert [job.status for job in execution.jobs] == ["succeeded"] * 4
    assert [job.prompt_id for job in execution.jobs] == [
        "prompt-1",
        "prompt-2",
        "prompt-3",
        "prompt-4",
    ]
    result_items = ResultsResponse.model_validate(results.json()).results
    assert [(item.job_ordinal, item.artifact_ordinal) for item in result_items] == [
        (1, 1),
        (1, 2),
        (2, 1),
        (2, 2),
        (3, 1),
        (3, 2),
        (4, 1),
        (4, 2),
    ]
    assert first_file.status_code == 200
    assert first_file.headers["content-type"] == "image/png"
    assert first_file.content == b"bytes:prompt-1-1.png"
    assert missing.status_code == 404
    assert traversal.status_code == 422
    assert traversal.json()["error"]["code"] == "invalid_request"
    assert encoded_traversal.status_code in {404, 422}
    assert b'"format_version"' not in encoded_traversal.content
    assert symlinked_result.status_code == 500
    assert b"must not be served" not in symlinked_result.content
    assert restart.status_code == 409
    assert restart.json()["error"]["code"] == "execution_not_eligible"
    assert {name: (run_path / name).read_bytes() for name in immutable_before} == immutable_before


def test_api_state_queries_skip_result_hashing_and_download_verifies_selected_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    client = FakeComfyUIClient(artifact_count=2)

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        _wait_for_status(http, run_id, "succeeded")
        run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
        hashed_paths: list[Path] = []
        real_sha256_file = execution_state_module._sha256_file

        def counting_sha256_file(path: Path) -> str:
            hashed_paths.append(path)
            return real_sha256_file(path)

        monkeypatch.setattr(execution_state_module, "_sha256_file", counting_sha256_file)

        assert http.get(f"/api/runs/{run_id}").status_code == 200
        assert http.get(f"/api/runs/{run_id}/execution").status_code == 200
        assert http.get(f"/api/runs/{run_id}/execution").status_code == 200
        assert http.get(f"/api/runs/{run_id}/results").status_code == 200
        assert hashed_paths == []

        selected = http.get(f"/api/runs/{run_id}/results/1/1")
        assert selected.status_code == 200
        assert selected.content == b"bytes:prompt-1-1.png"
        assert hashed_paths == []

        tampered_path = run_path / "outputs" / "000001-02.png"
        original = tampered_path.read_bytes()
        tampered_path.write_bytes(b"x" * len(original))
        tampered = http.get(f"/api/runs/{run_id}/results/1/2")
        assert tampered.status_code == 500
        assert tampered.json()["error"]["code"] == "invalid_run_data"

    published = RunFilesystemStore(settings.projects_root).load_run(run_path)
    with pytest.raises(ExecutionStateError, match="SHA-256"):
        ExecutionStateStore(run_path).load(published)
    assert tampered_path in hashed_paths


def test_duplicate_active_execution_is_rejected_and_running_state_is_visible(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    started = threading.Event()
    cancelled = threading.Event()
    client = FakeComfyUIClient()

    async def blocking_executor(
        *,
        run: PublishedRun,
        client: ExecutionClient,
        config: ExecutionConfig,
    ) -> RunExecutionState:
        assert client is not None
        assert config.history_timeout_seconds == 1
        store = ExecutionStateStore(run.path)
        state = store.initialize(run)
        running = replace(state, status=RunExecutionStatus.RUNNING, started_at="started")
        store.save(run, running)
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        raise AssertionError("unreachable")

    with TestClient(
        create_app(
            settings,
            client_factory=lambda _settings: client,
            executor=blocking_executor,
        )
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
        first = http.post(f"/api/runs/{run_id}/execute")
        assert first.status_code == 202
        assert started.wait(timeout=1)

        second = http.post(f"/api/runs/{run_id}/execute")
        other_run_id = _create_run(http, _batch_request((asset_id,)))
        other_run = http.post(f"/api/runs/{other_run_id}/execute")
        execution = http.get(f"/api/runs/{run_id}/execution")

        assert second.status_code == 409
        assert second.json()["error"]["code"] == "execution_already_active"
        assert other_run.status_code == 409
        assert other_run.json()["error"]["code"] == "execution_already_active"
        assert execution.json()["status"] == "running"

    assert cancelled.is_set()
    assert client.closed
    published = RunFilesystemStore(settings.projects_root).load_run(run_path)
    assert ExecutionStateStore(run_path).load(published).status is RunExecutionStatus.RUNNING


def test_execution_rejects_unsafe_outputs_before_starting_task(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    client = FakeComfyUIClient()

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
        outputs = run_path / "outputs"
        outputs.rmdir()
        outside = tmp_path / "outside-outputs"
        outside.mkdir()
        outputs.symlink_to(outside, target_is_directory=True)

        response = http.post(f"/api/runs/{run_id}/execute")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "execution_not_eligible"
    assert not (run_path / "execution.json").exists()
    assert client.submission_count == 0


def test_executor_failure_and_unknown_submission_are_durable_states(tmp_path: Path) -> None:
    failed_settings = _settings(tmp_path / "failed")
    failed_asset = _import_asset(failed_settings, tmp_path, "failed-asset")
    failed_client = FakeComfyUIClient(upload_error=RuntimeError("upload failed"))

    with TestClient(
        create_app(failed_settings, client_factory=lambda _settings: failed_client)
    ) as http:
        failed_run = _create_run(http, _batch_request((failed_asset,)))
        assert http.post(f"/api/runs/{failed_run}/execute").status_code == 202
        failed = _wait_for_status(http, failed_run, "failed")
        failed_restart = http.post(f"/api/runs/{failed_run}/execute")

    blocked_settings = _settings(tmp_path / "blocked")
    blocked_asset = _import_asset(blocked_settings, tmp_path, "blocked-asset")
    blocked_client = FakeComfyUIClient(submission_disposition=SubmissionDisposition.UNKNOWN)

    with TestClient(
        create_app(blocked_settings, client_factory=lambda _settings: blocked_client)
    ) as http:
        blocked_run = _create_run(http, _batch_request((blocked_asset,)))
        assert http.post(f"/api/runs/{blocked_run}/execute").status_code == 202
        blocked = _wait_for_status(http, blocked_run, "blocked")
        blocked_restart = http.post(f"/api/runs/{blocked_run}/execute")

    assert failed.jobs[0].status == "failed"
    assert failed.jobs[0].error is not None
    assert "upload failed" in failed.jobs[0].error
    assert blocked.jobs[0].status == "submission_unknown"
    assert blocked.jobs[0].prompt_id is None
    assert failed_restart.status_code == 409
    assert blocked_restart.status_code == 409
