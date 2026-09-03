import asyncio
import copy
import hashlib
import json
import shutil
import threading
import time
from collections.abc import AsyncIterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractAsyncContextManager
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import NoReturn, cast

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from pydantic import BaseModel, TypeAdapter

import batchcraft.execution.state as execution_state_module
from batchcraft.api import Settings, create_app
from batchcraft.api.schemas import (
    BatchRequest,
    ExecutionResponse,
    ParameterBindingRequest,
    ParameterValuesBindingRequest,
    PreviewResponse,
    ResultsResponse,
    SavedBatchParameterBindingRequest,
    SavedBatchVariableBindingRequest,
)
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
from batchcraft.db import (
    RunCancellationMode,
    RunCancellationRequestStore,
    RunCancellationStoreError,
)
from batchcraft.domain import PromptVersion
from batchcraft.execution import (
    STOPPED_AFTER_CURRENT_JOB,
    USER_DETACHED_FROM_CURRENT_JOB,
    ExecutionClient,
    ExecutionConfig,
    ExecutionStateError,
    ExecutionStateStore,
    JobExecutionStatus,
    RunCancellationControl,
    RunExecutionState,
    RunExecutionStatus,
)
from batchcraft.files import (
    AssetRecord,
    BatchIdentity,
    BatchOwnerStore,
    ProjectAssetStore,
    ProjectIdentity,
    ProjectOwnerDiscoveryError,
    ProjectOwnerStore,
    PublishedRun,
    RunFilesystemStore,
)
from batchcraft.files.snapshots import SnapshotParameterBinding, SnapshotParameterValuesBinding

PNG_A = b"\x89PNG\r\n\x1a\nimage-a"
PNG_B = b"\x89PNG\r\n\x1a\nimage-b"


@pytest.mark.parametrize(
    "value",
    (-(2**53 - 1), 2**53 - 1, 1.25, "", True, None),
)
def test_parameter_scalar_api_and_snapshot_boundaries_preserve_valid_values(
    value: object,
) -> None:
    payload = {"parameter_key": "value", "mode": "values", "values": [value]}
    api = cast(
        ParameterValuesBindingRequest,
        TypeAdapter(ParameterBindingRequest).validate_python(payload),
    )
    snapshot = cast(
        SnapshotParameterValuesBinding,
        TypeAdapter(SnapshotParameterBinding).validate_python(payload),
    )

    assert api.values == [value]
    assert snapshot.values == [value]
    if isinstance(value, int) and not isinstance(value, bool):
        assert isinstance(api.values[0], int)
        assert isinstance(snapshot.values[0], int)


@pytest.mark.parametrize(
    "value",
    (-(2**53), 2**53, float("inf"), float("-inf"), float("nan"), [], {}),
)
def test_parameter_scalar_api_and_snapshot_boundaries_reject_invalid_values(
    value: object,
) -> None:
    payload = {"parameter_key": "value", "mode": "values", "values": [value]}

    with pytest.raises(ValueError):
        TypeAdapter(ParameterBindingRequest).validate_python(payload)
    with pytest.raises(ValueError):
        TypeAdapter(SnapshotParameterBinding).validate_python(payload)


@pytest.mark.parametrize(
    ("values", "message"),
    (
        ([], "at least 1"),
        ([1, 1.0], "exact duplicates"),
        ([None, None], "exact duplicates"),
        ([0, None], "Base workflow first"),
    ),
)
def test_parameter_alternative_dtos_reject_invalid_shapes(
    values: list[object], message: str
) -> None:
    payload = {"parameter_key": "value", "mode": "values", "values": values}

    for model in (
        ParameterBindingRequest,
        SavedBatchParameterBindingRequest,
        SnapshotParameterBinding,
    ):
        with pytest.raises(ValueError, match=message):
            TypeAdapter(model).validate_python(payload)


def test_editable_range_intent_dtos_preserve_exact_decimal_text() -> None:
    payload = {
        "parameter_key": "cfg",
        "mode": "range",
        "include_base": True,
        "range": {"start": "-0.50", "end": "1.00", "step": "0.25"},
    }

    for model in (
        ParameterBindingRequest,
        SavedBatchParameterBindingRequest,
        SnapshotParameterBinding,
    ):
        parsed = cast(BaseModel, TypeAdapter(model).validate_python(payload))
        assert parsed.model_dump(mode="json") == payload


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
        self.submitted_workflows: list[dict[str, object]] = []

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
        self.submitted_workflows.append(copy.deepcopy(dict(workflow)))
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
        data_root=tmp_path,
        database_path=tmp_path / "batchcraft.sqlite3",
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
            "values": ["dog", "cat"],
        }
    ]
    if include_unused_binding:
        bindings.append(
            {
                "placeholder": "unused",
                "values": ["value"],
            }
        )
    profile = {
        "id": "profile-id",
        "name": "Profile",
        "mappings": {
            "prompt": {"node_id": "34", "input_name": "prompt", "value_type": "string"},
            "seed": {"node_id": "7", "input_name": "seed", "value_type": "integer"},
            "output_prefix": {
                "node_id": "41",
                "input_name": "filename_prefix",
                "value_type": "string",
            },
        },
        "image_inputs": [
            {"key": "reference", "label": "Reference", "node_id": "25", "input_name": "image"},
            {"key": "style", "label": "Style", "node_id": "26", "input_name": "image"},
        ],
        "parameters": [],
    }
    if invalid_profile:
        mappings = profile["mappings"]
        assert isinstance(mappings, dict)
        mappings.pop("output_prefix")
    project = {"id": "project-id", "filesystem_key": "project_key", "name": "Project"}
    batch = {"id": "batch-id", "filesystem_key": "batch_key", "name": "Batch"}
    prompt_versions = [
        {"id": "prompt-v1", "name": "Portrait prompt", "text": "Portrait of {{animal}}"}
    ]
    assert len(asset_ids) <= 2
    image_bindings = [
        {
            "slot_key": slot_key,
            "values": [asset_ids[index] if index < len(asset_ids) else None],
        }
        for index, slot_key in enumerate(("reference", "style"))
    ]
    seeds = {"mode": "explicit", "values": [9, 3]}
    workflow = {
        "7": {"class_type": "KSampler", "inputs": {"seed": 0}},
        "25": {"class_type": "LoadImage", "inputs": {"image": "original.png"}},
        "26": {"class_type": "LoadImage", "inputs": {"image": "style-original.png"}},
        "34": {"class_type": "TextEncode", "inputs": {"prompt": "original"}},
        "41": {"class_type": "SaveImage", "inputs": {"filename_prefix": "original"}},
    }
    return {
        "project": project,
        "batch": batch,
        "prompt_versions": prompt_versions,
        "variable_bindings": bindings,
        "image_bindings": image_bindings,
        "parameter_bindings": [],
        "linked_parameter_sets": [],
        "seeds": seeds,
        "workflow": workflow,
        "workflow_profile": profile,
        "batch_snapshot": {
            "snapshot_version": 6,
            "project": copy.deepcopy(project),
            "source_saved_batch": None,
            "batch": {**batch, "description": None},
            "prompt_versions": copy.deepcopy(prompt_versions),
            "variable_bindings": copy.deepcopy(bindings),
            "image_bindings": copy.deepcopy(image_bindings),
            "parameter_bindings": [],
            "linked_parameter_sets": [],
            "seed_intent": {**seeds, "random_seed_count": None},
            "workflow_selection": {
                "workflow_id": None,
                "workflow_version_id": None,
                "workflow_profile_id": None,
                "workflow_profile_version_id": None,
                "workflow": copy.deepcopy(workflow),
                "workflow_profile": copy.deepcopy(profile),
            },
        },
    }


def _sync_batch_snapshot(request: dict[str, object]) -> None:
    snapshot = request["batch_snapshot"]
    assert isinstance(snapshot, dict)
    snapshot["prompt_versions"] = request["prompt_versions"]
    snapshot["variable_bindings"] = request["variable_bindings"]
    snapshot["image_bindings"] = request["image_bindings"]
    snapshot["parameter_bindings"] = request["parameter_bindings"]
    snapshot["linked_parameter_sets"] = request["linked_parameter_sets"]
    workflow_selection = snapshot["workflow_selection"]
    assert isinstance(workflow_selection, dict)
    workflow_selection["workflow"] = request["workflow"]
    workflow_selection["workflow_profile"] = request["workflow_profile"]


def _create_run(http: TestClient, request: dict[str, object]) -> str:
    response = http.post("/api/runs", json=request)
    assert response.status_code == 201, response.text
    return str(response.json()["run_id"])


def test_preview_and_run_expose_resolved_workflow_parameters(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(())
    workflow = request["workflow"]
    profile = request["workflow_profile"]
    assert isinstance(workflow, dict)
    assert isinstance(profile, dict)
    workflow["7"]["inputs"]["steps"] = 20
    profile["parameters"] = [
        {
            "key": "steps",
            "label": "Steps",
            "node_id": "7",
            "input_name": "steps",
            "value_type": "integer",
        }
    ]
    request["parameter_bindings"] = [
        {"parameter_key": "steps", "mode": "values", "values": [None, -5, 0]}
    ]
    _sync_batch_snapshot(request)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        preview = http.post("/api/batches/preview", json=request)
        created = http.post("/api/runs", json=request)
        run = http.get(f"/api/runs/{created.json()['run_id']}")

        zero = copy.deepcopy(request)
        zero_bindings = cast(list[dict[str, object]], zero["parameter_bindings"])
        zero_bindings[0]["values"] = []
        _sync_batch_snapshot(zero)
        duplicate = copy.deepcopy(request)
        duplicate_bindings = cast(list[dict[str, object]], duplicate["parameter_bindings"])
        duplicate_bindings[0]["values"] = [1, 1]
        _sync_batch_snapshot(duplicate)

        assert http.post("/api/batches/preview", json=zero).status_code == 422
        assert http.post("/api/batches/preview", json=duplicate).status_code == 422

    assert preview.status_code == 200
    assert preview.json()["job_count"] == 12
    assert [job["resolved_parameters"][0]["value"] for job in preview.json()["jobs"]] == [
        None,
        None,
        -5,
        -5,
        0,
        0,
    ] * 2
    assert created.status_code == 201
    assert run.json()["plan"]["jobs"][0]["resolved_parameters"] == [
        {"parameter_key": "steps", "label": "Steps", "value": None}
    ]
    assert run.json()["batch_snapshot"]["parameter_bindings"] == [
        {"parameter_key": "steps", "mode": "values", "values": [None, -5, 0]}
    ]


def test_linked_parameter_sets_preview_run_and_execute_as_scalar_overrides(tmp_path: Path) -> None:
    request = _batch_request(())
    workflow = cast(dict[str, object], request["workflow"])
    profile = cast(dict[str, object], request["workflow_profile"])
    sampler_inputs = cast(dict[str, object], cast(dict[str, object], workflow["7"])["inputs"])
    sampler_inputs.update({"width": 512, "height": 512})
    profile["parameters"] = [
        {
            "key": "width",
            "label": "Width",
            "node_id": "7",
            "input_name": "width",
            "value_type": "integer",
        },
        {
            "key": "height",
            "label": "Height",
            "node_id": "7",
            "input_name": "height",
            "value_type": "integer",
        },
    ]
    request["linked_parameter_sets"] = [
        {
            "set_key": "resolution",
            "set_label": "Resolution",
            "members": ["height", "width"],
            "rows": [
                {
                    "row_label": "Landscape",
                    "values": {"width": 1024, "height": 768},
                },
                {
                    "row_label": None,
                    "values": {"height": 1024, "width": 768},
                },
            ],
        }
    ]
    _sync_batch_snapshot(request)
    client = FakeComfyUIClient()

    with TestClient(
        create_app(_settings(tmp_path), client_factory=lambda _settings: client)
    ) as http:
        preview = http.post("/api/batches/preview", json=request)
        run_id = _create_run(http, request)
        run = http.get(f"/api/runs/{run_id}")
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        _wait_for_status(http, run_id, "succeeded")

    assert preview.status_code == 200
    assert preview.json()["job_count"] == 8
    assert preview.json()["jobs"][0]["resolved_parameters"] == [
        {"parameter_key": "width", "label": "Width", "value": 1024},
        {"parameter_key": "height", "label": "Height", "value": 768},
    ]
    assert preview.json()["jobs"][0]["resolved_parameter_sets"] == [
        {
            "set_key": "resolution",
            "set_label": "Resolution",
            "row_ordinal": 1,
            "row_label": "Landscape",
        }
    ]
    assert run.json()["plan"]["jobs"][2]["resolved_parameter_sets"][0]["row_ordinal"] == 2
    submitted_sizes = [
        (
            cast(dict[str, object], cast(dict[str, object], item["7"])["inputs"])["width"],
            cast(dict[str, object], cast(dict[str, object], item["7"])["inputs"])["height"],
        )
        for item in client.submitted_workflows
    ]
    assert submitted_sizes == ([(1024, 768)] * 2 + [(768, 1024)] * 2) * 2
    assert all(
        all(not isinstance(value, (dict, list)) for value in size) for size in submitted_sizes
    )


def test_linked_parameter_set_request_rejects_missing_or_extra_row_values() -> None:
    request = _batch_request(())
    request["linked_parameter_sets"] = [
        {
            "set_key": "resolution",
            "set_label": "Resolution",
            "members": ["width", "height"],
            "rows": [{"row_label": None, "values": {"width": 512, "extra": 512}}],
        }
    ]
    _sync_batch_snapshot(request)

    with pytest.raises(ValueError, match="exactly match set members"):
        BatchRequest.model_validate(request)


def test_batch_request_rejects_numeric_type_only_snapshot_mismatches() -> None:
    independent = _batch_request(())
    independent_profile = cast(dict[str, object], independent["workflow_profile"])
    independent_profile["parameters"] = [
        {
            "key": "cfg",
            "label": "CFG",
            "node_id": "7",
            "input_name": "cfg",
            "value_type": "float",
        }
    ]
    independent["parameter_bindings"] = [{"parameter_key": "cfg", "mode": "values", "values": [1]}]
    _sync_batch_snapshot(independent)
    independent_snapshot = cast(dict[str, object], independent["batch_snapshot"])
    independent_snapshot["parameter_bindings"] = [
        {"parameter_key": "cfg", "mode": "values", "values": [1.0]}
    ]

    linked = _batch_request(())
    linked_profile = cast(dict[str, object], linked["workflow_profile"])
    linked_profile["parameters"] = [
        {
            "key": key,
            "label": key.title(),
            "node_id": "7",
            "input_name": key,
            "value_type": "float",
        }
        for key in ("width", "height")
    ]
    linked["linked_parameter_sets"] = [
        {
            "set_key": "resolution",
            "set_label": "Resolution",
            "members": ["width", "height"],
            "rows": [{"row_label": None, "values": {"width": 1, "height": 2}}],
        }
    ]
    _sync_batch_snapshot(linked)
    linked_snapshot = cast(dict[str, object], linked["batch_snapshot"])
    linked_snapshot["linked_parameter_sets"] = [
        {
            "set_key": "resolution",
            "set_label": "Resolution",
            "members": ["width", "height"],
            "rows": [{"row_label": None, "values": {"width": 1.0, "height": 2}}],
        }
    ]

    with pytest.raises(ValueError, match="parameter bindings do not match"):
        BatchRequest.model_validate(independent)
    with pytest.raises(ValueError, match="linked parameter sets do not match"):
        BatchRequest.model_validate(linked)


def test_batch_request_materializes_range_intent_before_compilation(tmp_path: Path) -> None:
    request = _batch_request(())
    workflow = cast(dict[str, object], request["workflow"])
    profile = cast(dict[str, object], request["workflow_profile"])
    node_inputs = cast(dict[str, object], cast(dict[str, object], workflow["7"])["inputs"])
    node_inputs["steps"] = 20
    profile["parameters"] = [
        {
            "key": "steps",
            "label": "Steps",
            "node_id": "7",
            "input_name": "steps",
            "value_type": "integer",
        }
    ]
    request["parameter_bindings"] = [
        {
            "parameter_key": "steps",
            "mode": "range",
            "include_base": True,
            "range": {"start": "10", "end": "30", "step": "10"},
        }
    ]
    _sync_batch_snapshot(request)

    parsed = BatchRequest.model_validate(request)
    creation = parsed.to_creation_input()
    client = FakeComfyUIClient()
    with TestClient(
        create_app(_settings(tmp_path), client_factory=lambda _settings: client)
    ) as http:
        response = http.post("/api/batches/preview", json=request)
        run_id = _create_run(http, request)
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        _wait_for_status(http, run_id, "succeeded")

    assert creation.definition.parameter_bindings[0].values == (None, 10, 20, 30)
    assert response.status_code == 200
    assert response.json()["job_count"] == 16
    assert [job["resolved_parameters"][0]["value"] for job in response.json()["jobs"][:8]] == [
        None,
        None,
        10,
        10,
        20,
        20,
        30,
        30,
    ]
    submitted_steps = [
        cast(
            dict[str, object],
            cast(dict[str, object], submitted["7"])["inputs"],
        )["steps"]
        for submitted in client.submitted_workflows
    ]
    assert submitted_steps == [20, 20, 10, 10, 20, 20, 30, 30] * 2
    assert all(not isinstance(value, (dict, list)) for value in submitted_steps)


@pytest.mark.parametrize(
    ("old_field", "old_value"),
    (
        ("variable_list", {"id": "animals", "values": ["cat", "dog"]}),
        ("mode", "all"),
        ("selected_values", ["dog", "cat"]),
        ("fixed_value", "dog"),
    ),
)
def test_executable_bindings_reject_old_fields(old_field: str, old_value: object) -> None:
    request = _batch_request(())
    request["variable_bindings"] = [
        {
            "placeholder": "animal",
            "values": ["dog", "cat"],
            old_field: old_value,
        }
    ]
    _sync_batch_snapshot(request)

    with pytest.raises(ValueError):
        BatchRequest.model_validate(request)


@pytest.mark.parametrize(
    ("old_field", "old_value"),
    (
        ("variable_list_id", "animals"),
        ("selected_values", ["dog", "cat"]),
        ("mode", "all"),
        ("fixed_value", "dog"),
    ),
)
def test_saved_batch_bindings_reject_old_fields(old_field: str, old_value: object) -> None:
    with pytest.raises(ValueError):
        SavedBatchVariableBindingRequest.model_validate(
            {
                "placeholder": "animal",
                "values": ["dog", "cat"],
                old_field: old_value,
            }
        )


@pytest.mark.parametrize("invalid_version", (1, True, 2.0))
def test_batch_request_rejects_snapshot_version_one_and_non_integer_aliases(
    invalid_version: object,
) -> None:
    request = _batch_request(())
    snapshot = request["batch_snapshot"]
    assert isinstance(snapshot, dict)
    snapshot["snapshot_version"] = invalid_version

    with pytest.raises(ValueError):
        BatchRequest.model_validate(request)


def _saved_batch_definition(
    http: TestClient, project_id: str, *, linked_parameters: bool = False
) -> dict[str, object]:
    request = _batch_request(())
    workflow = request["workflow"]
    profile = request["workflow_profile"]
    assert isinstance(workflow, dict)
    assert isinstance(profile, dict)
    mappings = profile["mappings"]
    assert isinstance(mappings, dict)
    if linked_parameters:
        sampler_inputs = cast(dict[str, object], cast(dict[str, object], workflow["7"])["inputs"])
        sampler_inputs.update({"width": 512, "height": 512})
        profile["parameters"] = [
            {
                "key": "width",
                "label": "Width",
                "node_id": "7",
                "input_name": "width",
                "value_type": "integer",
            },
            {
                "key": "height",
                "label": "Height",
                "node_id": "7",
                "input_name": "height",
                "value_type": "integer",
            },
        ]
    prompt = http.post(
        f"/api/projects/{project_id}/prompts",
        json={"name": "Saved prompt", "text": "Portrait of {{animal}}"},
    ).json()
    workflow_created = http.post(
        f"/api/projects/{project_id}/workflows",
        json={"name": "Saved workflow", "workflow": workflow},
    ).json()
    workflow_version = workflow_created["version"]
    profile_created = http.post(
        f"/api/workflows/{workflow_created['workflow']['id']}/profiles",
        json={
            "name": "Saved profile",
            "workflow_version_id": workflow_version["id"],
            "mappings": mappings,
            "image_inputs": profile["image_inputs"],
            "parameters": profile["parameters"],
        },
    ).json()
    profile_version = profile_created["version"]
    return {
        "name": "Saved experiment",
        "description": "Editable definition",
        "prompt_selections": [
            {
                "prompt_version_id": prompt["version"]["id"],
                "name_snapshot": prompt["version"]["name_snapshot"],
                "text": prompt["version"]["text"],
            }
        ],
        "variable_bindings": [
            {
                "placeholder": "animal",
                "values": ["dog", "cat"],
            }
        ],
        "image_bindings": [
            {"slot_key": "reference", "values": ["asset-2"]},
            {"slot_key": "style", "values": [None]},
        ],
        "parameter_bindings": [],
        "linked_parameter_sets": (
            [
                {
                    "set_key": "resolution",
                    "set_label": "Resolution",
                    "members": ["width", "height"],
                    "rows": [
                        {
                            "row_label": "Square",
                            "values": {"width": 512, "height": 512},
                        },
                        {
                            "row_label": "Landscape",
                            "values": {"width": 1024, "height": 768},
                        },
                    ],
                }
            ]
            if linked_parameters
            else []
        ),
        "seed_intent": {"mode": "explicit", "values": [9, 3], "random_seed_count": None},
        "selected_workflow_version": {
            "id": workflow_version["id"],
            "content_sha256": workflow_version["content_sha256"],
            "workflow": workflow_version["workflow"],
        },
        "selected_workflow_profile_id": profile_created["workflow_profile"]["id"],
        "selected_workflow_profile_version": {
            "id": profile_version["id"],
            "workflow_profile_id": profile_version["workflow_profile_id"],
            "workflow_version_id": profile_version["workflow_version_id"],
            "content_sha256": profile_version["content_sha256"],
            "profile": profile_version["profile"],
        },
    }


def test_project_and_prompt_library_lifecycle(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    client = FakeComfyUIClient()

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        project_response = http.post(
            "/api/projects",
            json={
                "name": "Portrait studies",
                "filesystem_key": "portrait_studies",
                "description": "Initial description",
            },
        )
        assert project_response.status_code == 201
        project = project_response.json()
        project_id = project["id"]
        assert project["description"] == "Initial description"

        update_project_response = http.patch(
            f"/api/projects/{project_id}",
            json={"name": "Portrait archive"},
        )
        assert update_project_response.status_code == 200
        assert update_project_response.json()["name"] == "Portrait archive"
        assert update_project_response.json()["description"] == "Initial description"
        clear_project_description = http.patch(
            f"/api/projects/{project_id}", json={"description": None}
        )
        assert clear_project_description.status_code == 200
        assert clear_project_description.json()["name"] == "Portrait archive"
        assert clear_project_description.json()["description"] is None
        assert http.patch(f"/api/projects/{project_id}", json={}).status_code == 422
        owner = ProjectOwnerStore(settings.projects_root).read("portrait_studies")
        assert owner.name == "Portrait studies"

        prompt_response = http.post(
            f"/api/projects/{project_id}/prompts",
            json={
                "name": "Studio portrait",
                "description": "Lighting baseline",
                "text": "portrait of {{subject}}",
                "note": "Initial",
            },
        )
        assert prompt_response.status_code == 201
        created = prompt_response.json()
        prompt_id = created["prompt"]["id"]
        version_one = created["version"]
        assert version_one["version_number"] == 1
        assert version_one["name_snapshot"] == "Studio portrait"
        assert version_one["placeholders"] == ["subject"]

        update_prompt_response = http.patch(
            f"/api/prompts/{prompt_id}",
            json={"name": "Editorial portrait"},
        )
        assert update_prompt_response.status_code == 200
        assert update_prompt_response.json()["description"] == "Lighting baseline"
        description_only_response = http.patch(
            f"/api/prompts/{prompt_id}", json={"description": "Updated"}
        )
        assert description_only_response.status_code == 200
        assert description_only_response.json()["name"] == "Editorial portrait"
        assert description_only_response.json()["description"] == "Updated"
        assert http.patch(f"/api/prompts/{prompt_id}", json={"name": None}).status_code == 422

        version_two_response = http.post(
            f"/api/prompts/{prompt_id}/versions",
            json={"text": "editorial portrait of {{subject}}", "note": "Editorial pass"},
        )
        assert version_two_response.status_code == 201
        version_two = version_two_response.json()
        assert version_two["version_number"] == 2
        assert version_two["name_snapshot"] == "Editorial portrait"
        assert version_two["placeholders"] == ["subject"]

        archive_version_response = http.post(f"/api/prompt-versions/{version_one['id']}/archive")
        assert archive_version_response.status_code == 200
        assert archive_version_response.json()["archived_at"] is not None

        versions_response = http.get(f"/api/prompts/{prompt_id}/versions")
        assert versions_response.status_code == 200
        assert [item["version_number"] for item in versions_response.json()["prompt_versions"]] == [
            2
        ]

        restore_response = http.post(f"/api/prompt-versions/{version_one['id']}/restore")
        assert restore_response.status_code == 201
        restored = restore_response.json()
        assert restored["version_number"] == 3
        assert restored["name_snapshot"] == "Editorial portrait"
        assert restored["text"] == version_one["text"]

        assert http.post(f"/api/prompts/{prompt_id}/archive").status_code == 200
        assert http.get(f"/api/projects/{project_id}/prompts").json() == {"prompts": []}
        all_prompts = http.get(
            f"/api/projects/{project_id}/prompts", params={"include_archived": True}
        )
        assert len(all_prompts.json()["prompts"]) == 1

        assert http.post(f"/api/projects/{project_id}/archive").status_code == 200
        assert http.get("/api/projects").json() == {"projects": []}
        all_projects = http.get("/api/projects", params={"include_archived": True})
        assert len(all_projects.json()["projects"]) == 1


def test_prompt_response_defers_malformed_placeholder_validation(tmp_path: Path) -> None:
    settings = _settings(tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        project = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project"}
        ).json()
        malformed = http.post(
            f"/api/projects/{project['id']}/prompts",
            json={"name": "Malformed", "text": "portrait of {{subject"},
        )

        assert malformed.status_code == 201
        assert malformed.json()["version"]["placeholders"] == []


def test_prompt_list_returns_latest_active_version_and_preserves_prompt_filter(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        project = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project"}
        ).json()
        first_created = http.post(
            f"/api/projects/{project['id']}/prompts",
            json={"name": "Original name", "text": "First text"},
        ).json()
        prompt_id = first_created["prompt"]["id"]
        first_version = first_created["version"]
        assert (
            http.patch(f"/api/prompts/{prompt_id}", json={"name": "Current name"}).status_code
            == 200
        )
        second_version = http.post(
            f"/api/prompts/{prompt_id}/versions", json={"text": "Second text"}
        ).json()
        archived_prompt = http.post(
            f"/api/projects/{project['id']}/prompts",
            json={"name": "Archived Prompt", "text": "Archived Prompt text"},
        ).json()
        assert (
            http.post(f"/api/prompts/{archived_prompt['prompt']['id']}/archive").status_code == 200
        )

        active_list = http.get(f"/api/projects/{project['id']}/prompts").json()["prompts"]
        all_list = http.get(
            f"/api/projects/{project['id']}/prompts", params={"include_archived": True}
        ).json()["prompts"]
        direct = http.get(f"/api/prompts/{prompt_id}").json()

        assert [item["id"] for item in active_list] == [prompt_id]
        assert [item["id"] for item in all_list] == [
            prompt_id,
            archived_prompt["prompt"]["id"],
        ]
        assert active_list[0]["latest_active_version"] == second_version
        assert active_list[0]["latest_active_version"]["name_snapshot"] == "Current name"
        assert all_list[1]["latest_active_version"] == archived_prompt["version"]
        assert "latest_active_version" not in direct

        assert http.post(f"/api/prompt-versions/{second_version['id']}/archive").status_code == 200
        fallback = http.get(f"/api/projects/{project['id']}/prompts").json()["prompts"][0]
        assert fallback["latest_active_version"] == first_version
        assert fallback["latest_active_version"]["name_snapshot"] == "Original name"

        assert http.post(f"/api/prompt-versions/{first_version['id']}/archive").status_code == 200
        all_archived = http.get(f"/api/projects/{project['id']}/prompts").json()["prompts"][0]
        assert all_archived["latest_active_version"] is None


def test_workflow_and_profile_library_lifecycle_persists_across_restart(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(())
    workflow_data = request["workflow"]
    profile_data = request["workflow_profile"]
    assert isinstance(workflow_data, dict)
    assert isinstance(profile_data, dict)
    profile_mappings = profile_data["mappings"]
    assert isinstance(profile_mappings, dict)
    mappings = dict(profile_mappings)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        project = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project"}
        ).json()
        workflow_created_response = http.post(
            f"/api/projects/{project['id']}/workflows",
            json={
                "name": "Imported workflow",
                "description": "Initial",
                "workflow": workflow_data,
                "note": "v1",
            },
        )
        assert workflow_created_response.status_code == 201
        workflow_created = workflow_created_response.json()
        workflow_id = workflow_created["workflow"]["id"]
        workflow_version_one = workflow_created["version"]

        assert (
            http.patch(
                f"/api/workflows/{workflow_id}", json={"name": "Renamed workflow"}
            ).status_code
            == 200
        )
        duplicate_workflow_version = http.post(
            f"/api/workflows/{workflow_id}/versions",
            json={"workflow": dict(reversed(tuple(workflow_data.items())))},
        )
        assert duplicate_workflow_version.status_code == 201
        workflow_version_two = duplicate_workflow_version.json()
        assert workflow_version_two["version_number"] == 2
        assert workflow_version_two["name_snapshot"] == "Renamed workflow"
        assert workflow_version_two["content_sha256"] == workflow_version_one["content_sha256"]

        listed_workflow = http.get(f"/api/projects/{project['id']}/workflows").json()["workflows"][
            0
        ]
        assert listed_workflow["latest_active_version"]["id"] == workflow_version_two["id"]
        assert listed_workflow["latest_active_version"]["workflow"] == workflow_data
        assert (
            http.get(f"/api/workflow-versions/{workflow_version_one['id']}").json()["workflow"]
            == workflow_data
        )

        profile_created_response = http.post(
            f"/api/workflows/{workflow_id}/profiles",
            json={
                "name": "Default profile",
                "workflow_version_id": workflow_version_one["id"],
                "mappings": mappings,
                "parameters": [],
            },
        )
        assert profile_created_response.status_code == 201
        profile_created = profile_created_response.json()
        profile_id = profile_created["workflow_profile"]["id"]
        profile_version_one = profile_created["version"]
        assert profile_created["workflow_profile"]["project_id"] == project["id"]
        assert profile_version_one["project_id"] == project["id"]
        assert profile_version_one["workflow_id"] == workflow_id
        assert profile_version_one["profile"] == {
            "id": profile_id,
            "name": "Default profile",
            "mappings": mappings,
            "image_inputs": [],
            "parameters": [],
        }

        assert (
            http.patch(
                f"/api/workflow-profiles/{profile_id}", json={"name": "Renamed profile"}
            ).status_code
            == 200
        )
        without_compatible_version = http.get(
            f"/api/workflows/{workflow_id}/profiles",
            params={"workflow_version_id": workflow_version_two["id"]},
        ).json()["workflow_profiles"]
        assert [item["id"] for item in without_compatible_version] == [profile_id]
        assert without_compatible_version[0]["latest_compatible_version"] is None

        profile_version_two_response = http.post(
            f"/api/workflow-profiles/{profile_id}/versions",
            json={
                "workflow_version_id": workflow_version_two["id"],
                "mappings": mappings,
                "parameters": [],
            },
        )
        assert profile_version_two_response.status_code == 201
        profile_version_two = profile_version_two_response.json()
        assert profile_version_two["name_snapshot"] == "Renamed profile"
        assert (
            len(http.get(f"/api/workflows/{workflow_id}/profiles").json()["workflow_profiles"]) == 1
        )

        compatible = http.get(
            f"/api/workflows/{workflow_id}/profiles",
            params={"workflow_version_id": workflow_version_one["id"]},
        ).json()["workflow_profiles"]
        assert compatible[0]["latest_compatible_version"]["id"] == profile_version_one["id"]

        assert (
            http.post(
                f"/api/workflow-profile-versions/{profile_version_two['id']}/archive"
            ).status_code
            == 200
        )
        assert http.post(f"/api/workflow-profiles/{profile_id}/archive").status_code == 200
        assert (
            http.post(f"/api/workflow-versions/{workflow_version_two['id']}/archive").status_code
            == 200
        )
        assert http.post(f"/api/workflows/{workflow_id}/archive").status_code == 200

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as restarted:
        assert (
            restarted.get(f"/api/workflow-versions/{workflow_version_one['id']}").status_code == 200
        )
        persisted_profile = restarted.get(
            f"/api/workflow-profile-versions/{profile_version_one['id']}"
        )
        assert persisted_profile.status_code == 200
        assert persisted_profile.json()["profile"]["mappings"] == mappings
        assert restarted.get(f"/api/projects/{project['id']}/workflows").json() == {"workflows": []}
        assert (
            len(
                restarted.get(
                    f"/api/projects/{project['id']}/workflows",
                    params={"include_archived": True},
                ).json()["workflows"]
            )
            == 1
        )


def test_workflow_profile_api_rejects_invalid_mapping_and_cross_project_target(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(())
    workflow = request["workflow"]
    profile = request["workflow_profile"]
    assert isinstance(workflow, dict)
    assert isinstance(profile, dict)
    mappings = profile["mappings"]
    assert isinstance(mappings, dict)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        first = http.post("/api/projects", json={"name": "First", "filesystem_key": "first"}).json()
        second = http.post(
            "/api/projects", json={"name": "Second", "filesystem_key": "second"}
        ).json()
        target = http.post(
            f"/api/projects/{first['id']}/workflows",
            json={"name": "Workflow", "workflow": workflow},
        ).json()["version"]
        foreign_target = http.post(
            f"/api/projects/{second['id']}/workflows",
            json={"name": "Foreign workflow", "workflow": workflow},
        ).json()["version"]

        invalid_mappings = dict(mappings)
        invalid_mappings.pop("prompt")
        invalid = http.post(
            f"/api/workflows/{target['workflow_id']}/profiles",
            json={
                "name": "Invalid",
                "workflow_version_id": target["id"],
                "mappings": invalid_mappings,
                "parameters": [],
            },
        )
        foreign = http.post(
            f"/api/workflows/{target['workflow_id']}/profiles",
            json={
                "name": "Foreign",
                "workflow_version_id": foreign_target["id"],
                "mappings": mappings,
                "parameters": [],
            },
        )

    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "invalid_library_input"
    assert foreign.status_code == 422
    assert foreign.json()["error"]["code"] == "invalid_workflow_profile_target"


def test_project_adoption_preserves_owner_identity_and_rejects_ownerless_directory(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    owner_store = ProjectOwnerStore(settings.projects_root)
    owner_store.publish(
        ProjectIdentity(id="existing-project", filesystem_key="existing", name="Initial name")
    )
    (settings.projects_root / "ownerless" / "assets").mkdir(parents=True)
    client = FakeComfyUIClient()

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        create_ownerless_response = http.post(
            "/api/projects",
            json={"name": "Ownerless", "filesystem_key": "ownerless"},
        )
        assert create_ownerless_response.status_code == 409
        assert create_ownerless_response.json()["error"]["code"] == ("project_publication_failed")
        assert not (settings.projects_root / "ownerless" / "project.json").exists()

        response = http.post(
            "/api/projects/adopt",
            json={
                "filesystem_key": "existing",
                "project_id": "existing-project",
                "name": "Current name",
            },
        )
        assert response.status_code == 201
        assert response.json()["id"] == "existing-project"
        assert response.json()["name"] == "Current name"
        assert owner_store.read("existing").name == "Initial name"

        mismatched_id_response = http.post(
            "/api/projects/adopt",
            json={
                "filesystem_key": "existing",
                "project_id": "different-project",
                "name": "Current name",
            },
        )
        assert mismatched_id_response.status_code == 422
        assert mismatched_id_response.json()["error"]["code"] == "project_adoption_failed"

        ownerless_response = http.post("/api/projects/adopt", json={"filesystem_key": "ownerless"})
        assert ownerless_response.status_code == 422
        assert ownerless_response.json()["error"]["code"] == "project_adoption_failed"

        missing_id_response = http.post(
            "/api/projects/adopt",
            json={"filesystem_key": "ownerless", "name": "Imported assets"},
        )
        assert missing_id_response.status_code == 422
        assert missing_id_response.json()["error"]["code"] == "project_adoption_failed"
        assert not (settings.projects_root / "ownerless" / "project.json").exists()

        adopted_ownerless_response = http.post(
            "/api/projects/adopt",
            json={
                "filesystem_key": "ownerless",
                "project_id": "imported-assets-project",
                "name": "Imported assets",
            },
        )
        assert adopted_ownerless_response.status_code == 201
        adopted_ownerless = adopted_ownerless_response.json()
        assert adopted_ownerless["id"] == "imported-assets-project"
        assert adopted_ownerless["name"] == "Imported assets"
        assert owner_store.read("ownerless").id == "imported-assets-project"


def test_adoptable_project_discovery_filters_registered_projects_and_is_read_only(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    owner_store = ProjectOwnerStore(settings.projects_root)
    owner_store.publish(
        ProjectIdentity(id="available-id", filesystem_key="z_available", name="Available")
    )
    (settings.projects_root / "a_ownerless" / "assets").mkdir(parents=True)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        active = http.post(
            "/api/projects", json={"name": "Active", "filesystem_key": "active"}
        ).json()
        archived = http.post(
            "/api/projects", json={"name": "Archived", "filesystem_key": "archived"}
        ).json()
        assert http.post(f"/api/projects/{archived['id']}/archive").status_code == 200
        owner_store.publish(
            ProjectIdentity(
                id=active["id"],
                filesystem_key="conflicting_key",
                name="Conflicting owner",
            )
        )
        before = {
            path.relative_to(settings.projects_root): (
                path.read_bytes() if path.is_file() and not path.is_symlink() else None
            )
            for path in settings.projects_root.rglob("*")
        }

        response = http.get("/api/projects/adoptable")

        after = {
            path.relative_to(settings.projects_root): (
                path.read_bytes() if path.is_file() and not path.is_symlink() else None
            )
            for path in settings.projects_root.rglob("*")
        }

    assert response.status_code == 200
    assert response.json() == {
        "projects": [
            {
                "filesystem_key": "a_ownerless",
                "owner_state": "ownerless",
                "project_id": None,
                "initial_name": None,
            },
            {
                "filesystem_key": "z_available",
                "owner_state": "owned",
                "project_id": "available-id",
                "initial_name": "Available",
            },
        ]
    }
    assert before == after


def test_adoptable_project_discovery_failure_is_sanitized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)

    def fail_discovery(_store: ProjectOwnerStore) -> NoReturn:
        raise ProjectOwnerDiscoveryError("private filesystem detail")

    monkeypatch.setattr(ProjectOwnerStore, "discover", fail_discovery)
    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient()),
        raise_server_exceptions=False,
    ) as http:
        response = http.get("/api/projects/adoptable")

    assert response.status_code == 500
    assert response.json() == {
        "error": {
            "code": "project_discovery_failed",
            "message": "Projects could not be discovered",
        }
    }
    assert "private filesystem detail" not in response.text


def test_adoptable_project_discovery_does_not_create_an_absent_projects_root(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.get("/api/projects/adoptable")

    assert response.status_code == 200
    assert response.json() == {"projects": []}
    assert not settings.projects_root.exists()


def test_invalid_project_input_does_not_publish_an_owner(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    client = FakeComfyUIClient()

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        unsafe = http.post("/api/projects", json={"name": "Unsafe", "filesystem_key": "../unsafe"})
        assert unsafe.status_code == 422
        assert unsafe.json()["error"]["code"] == "invalid_library_input"

        blank_description = http.post(
            "/api/projects",
            json={"name": "Project", "filesystem_key": "project", "description": " "},
        )
        assert blank_description.status_code == 422
        assert blank_description.json()["error"]["code"] == "invalid_library_input"
        assert not (settings.projects_root / "project").exists()


def test_project_and_prompt_conflicts_use_stable_error_envelope(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    client = FakeComfyUIClient()

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        first = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project_one"}
        )
        assert first.status_code == 201
        project_id = first.json()["id"]

        conflict = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project_two"}
        )
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "library_conflict"
        assert ProjectOwnerStore(settings.projects_root).read("project_two").filesystem_key == (
            "project_two"
        )

        missing = http.get("/api/prompts/missing")
        assert missing.status_code == 404
        assert missing.json() == {
            "error": {"code": "prompt_not_found", "message": "Prompt was not found"}
        }

        first_prompt = http.post(
            f"/api/projects/{project_id}/prompts",
            json={"name": "Prompt", "text": "first"},
        )
        assert first_prompt.status_code == 201
        prompt_conflict = http.post(
            f"/api/projects/{project_id}/prompts",
            json={"name": "Prompt", "text": "second"},
        )
        assert prompt_conflict.status_code == 409
        assert prompt_conflict.json()["error"]["code"] == "library_conflict"


def test_saved_batch_lifecycle_is_durable_lightweight_and_project_scoped(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        first_project = http.post(
            "/api/projects", json={"name": "First", "filesystem_key": "first"}
        ).json()
        second_project = http.post(
            "/api/projects", json={"name": "Second", "filesystem_key": "second"}
        ).json()
        definition = _saved_batch_definition(http, first_project["id"])
        created = http.post(
            f"/api/projects/{first_project['id']}/batches",
            json={"filesystem_key": "shared_key", **definition},
        )
        assert created.status_code == 201, created.text
        batch = created.json()
        assert batch["revision"] == 1
        assert batch["image_bindings"] == definition["image_bindings"]
        assert batch["prompt_selections"][0]["prompt_name"] == "Saved prompt"
        assert batch["prompt_selections"][0]["version_number"] == 1
        assert batch["selected_workflow_version"]["workflow_name"] == "Saved workflow"
        assert (
            batch["selected_workflow_profile_version"]["workflow_profile_name"] == "Saved profile"
        )
        assert batch["selected_workflow_profile_name"] == "Saved profile"

        listed = http.get(f"/api/projects/{first_project['id']}/batches").json()["batches"]
        assert [item["id"] for item in listed] == [batch["id"]]
        for omitted in (
            "prompt_selections",
            "variable_bindings",
            "image_bindings",
            "selected_workflow_version",
        ):
            assert omitted not in listed[0]

        incomplete: dict[str, object] = {
            "filesystem_key": "shared_key",
            "name": "Incomplete",
            "description": None,
            "prompt_selections": [],
            "variable_bindings": [
                {
                    "placeholder": "",
                    "values": [],
                }
            ],
            "image_bindings": [],
            "seed_intent": {"mode": "random", "values": [], "random_seed_count": 3},
            "selected_workflow_version": None,
            "selected_workflow_profile_id": None,
            "selected_workflow_profile_version": None,
        }
        other = http.post(f"/api/projects/{second_project['id']}/batches", json=incomplete)
        assert other.status_code == 201, other.text

        update = {**definition, "name": "Updated", "expected_revision": 1}
        updated = http.patch(f"/api/batches/{batch['id']}", json=update)
        stale = http.patch(f"/api/batches/{batch['id']}", json=update)
        assert updated.status_code == 200
        assert updated.json()["revision"] == 2
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "saved_batch_revision_conflict"
        archived = http.post(f"/api/batches/{batch['id']}/archive")
        assert archived.status_code == 200
        assert archived.json()["archived_at"] is not None
        assert http.get(f"/api/projects/{first_project['id']}/batches").json() == {"batches": []}
        assert (
            len(
                http.get(
                    f"/api/projects/{first_project['id']}/batches",
                    params={"include_archived": True},
                ).json()["batches"]
            )
            == 1
        )

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as restarted:
        persisted = restarted.get(f"/api/batches/{batch['id']}")
        assert persisted.status_code == 200
        assert persisted.json()["name"] == "Updated"


def test_saved_batch_api_roundtrips_linked_parameter_sets(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        project = http.post(
            "/api/projects", json={"name": "Linked", "filesystem_key": "linked"}
        ).json()
        definition = _saved_batch_definition(http, project["id"], linked_parameters=True)
        created = http.post(
            f"/api/projects/{project['id']}/batches",
            json={"filesystem_key": "linked_batch", **definition},
        )
        assert created.status_code == 201, created.text
        loaded = http.get(f"/api/batches/{created.json()['id']}")

    assert loaded.status_code == 200
    assert loaded.json()["parameter_bindings"] == []
    assert loaded.json()["linked_parameter_sets"] == definition["linked_parameter_sets"]


def test_saved_batch_owner_orphans_and_explicit_adoption(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        project = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project"}
        ).json()
        definition = _saved_batch_definition(http, project["id"])
        invalid = copy.deepcopy(definition)
        invalid_prompts = invalid["prompt_selections"]
        assert isinstance(invalid_prompts, list)
        invalid_prompts[0]["text"] = "not the immutable library text"
        rejected = http.post(
            f"/api/projects/{project['id']}/batches",
            json={"filesystem_key": "orphan", **invalid},
        )
        assert rejected.status_code == 422
        assert rejected.json()["error"]["code"] == "saved_batch_integrity_error"
        orphan_owner = BatchOwnerStore(settings.projects_root / "project").read("orphan")
        assert orphan_owner.name == "Saved experiment"
        publication_conflict = http.post(
            f"/api/projects/{project['id']}/batches",
            json={"filesystem_key": "orphan", **definition},
        )
        assert publication_conflict.status_code == 409
        assert publication_conflict.json()["error"]["code"] == "saved_batch_publication_conflict"
        assert http.get("/api/batches/missing").json()["error"]["code"] == ("saved_batch_not_found")

        owners = BatchOwnerStore(settings.projects_root / "project")
        owners.publish(BatchIdentity("owned-id", "owned", "Initial owned name"))
        (settings.projects_root / "project" / "batches" / "ownerless").mkdir()
        adoptable = http.get(f"/api/projects/{project['id']}/batches/adoptable").json()["batches"]
        assert [(item["filesystem_key"], item["owner_state"]) for item in adoptable] == [
            ("orphan", "owned"),
            ("owned", "owned"),
            ("ownerless", "ownerless"),
        ]

        owned = http.post(
            f"/api/projects/{project['id']}/batches/adopt",
            json={"filesystem_key": "owned", **definition},
        )
        assert owned.status_code == 201, owned.text
        assert owned.json()["id"] == "owned-id"
        missing_identity = http.post(
            f"/api/projects/{project['id']}/batches/adopt",
            json={"filesystem_key": "ownerless", **definition},
        )
        assert missing_identity.status_code == 422
        adopted = http.post(
            f"/api/projects/{project['id']}/batches/adopt",
            json={"filesystem_key": "ownerless", "batch_id": "ownerless-id", **definition},
        )
        assert adopted.status_code == 201, adopted.text
        assert adopted.json()["id"] == "ownerless-id"
        remaining = http.get(f"/api/projects/{project['id']}/batches/adoptable").json()["batches"]
        assert [item["filesystem_key"] for item in remaining] == ["orphan"]


@pytest.mark.parametrize(
    "seed_intent",
    (
        {"mode": "fixed", "values": [7], "random_seed_count": None},
        {"mode": "explicit", "values": [7, 11], "random_seed_count": None},
        {"mode": "random", "values": [], "random_seed_count": 4},
    ),
)
def test_saved_batch_accepts_all_seed_intents(
    tmp_path: Path, seed_intent: dict[str, object]
) -> None:
    settings = _settings(tmp_path)
    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        project = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project"}
        ).json()
        response = http.post(
            f"/api/projects/{project['id']}/batches",
            json={
                "filesystem_key": f"batch_{seed_intent['mode']}",
                "name": "Seed draft",
                "description": None,
                "seed_intent": seed_intent,
            },
        )
    assert response.status_code == 201, response.text
    assert response.json()["seed_mode"] == seed_intent["mode"]


def test_fresh_state_smoke_persists_empty_binding_run_and_discard_across_restart(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        project = http.post(
            "/api/projects",
            json={"name": "Smoke Project", "filesystem_key": "smoke_project"},
        ).json()
        definition = _saved_batch_definition(http, project["id"])
        definition["variable_bindings"] = [{"placeholder": "animal", "values": [""]}]
        definition["image_bindings"] = [
            {"slot_key": "reference", "values": [None]},
            {"slot_key": "style", "values": [None]},
        ]
        definition["seed_intent"] = {
            "mode": "fixed",
            "values": [11],
            "random_seed_count": None,
        }
        saved_response = http.post(
            f"/api/projects/{project['id']}/batches",
            json={"filesystem_key": "smoke_batch", **definition},
        )
        assert saved_response.status_code == 201, saved_response.text
        saved = saved_response.json()
        prompt = saved["prompt_selections"][0]
        workflow = saved["selected_workflow_version"]
        profile = saved["selected_workflow_profile_version"]
        binding = {"placeholder": "animal", "values": [""]}
        request = {
            "project": {
                "id": project["id"],
                "filesystem_key": project["filesystem_key"],
                "name": project["name"],
            },
            "batch": {
                "id": saved["id"],
                "filesystem_key": saved["filesystem_key"],
                "name": saved["name"],
            },
            "prompt_versions": [
                {
                    "id": prompt["prompt_version_id"],
                    "name": prompt["name_snapshot"],
                    "text": prompt["text"],
                }
            ],
            "variable_bindings": [binding],
            "image_bindings": [
                {"slot_key": "reference", "values": [None]},
                {"slot_key": "style", "values": [None]},
            ],
            "parameter_bindings": [],
            "linked_parameter_sets": [],
            "seeds": {"mode": "fixed", "values": [11]},
            "workflow": workflow["workflow"],
            "workflow_profile": profile["profile"],
            "batch_snapshot": {
                "snapshot_version": 6,
                "project": {
                    "id": project["id"],
                    "filesystem_key": project["filesystem_key"],
                    "name": project["name"],
                },
                "source_saved_batch": {"id": saved["id"], "revision": saved["revision"]},
                "batch": {
                    "id": saved["id"],
                    "filesystem_key": saved["filesystem_key"],
                    "name": saved["name"],
                    "description": saved["description"],
                },
                "prompt_versions": [
                    {
                        "id": prompt["prompt_version_id"],
                        "prompt_id": prompt["prompt_id"],
                        "version_number": prompt["version_number"],
                        "name": prompt["name_snapshot"],
                        "text": prompt["text"],
                    }
                ],
                "variable_bindings": [binding],
                "image_bindings": [
                    {"slot_key": "reference", "values": [None]},
                    {"slot_key": "style", "values": [None]},
                ],
                "parameter_bindings": [],
                "linked_parameter_sets": [],
                "seed_intent": {
                    "mode": "fixed",
                    "values": [11],
                    "random_seed_count": None,
                },
                "workflow_selection": {
                    "workflow_id": workflow["workflow_id"],
                    "workflow_version_id": workflow["id"],
                    "workflow_name": workflow["workflow_name"],
                    "workflow_version_number": workflow["version_number"],
                    "workflow_profile_id": profile["workflow_profile_id"],
                    "workflow_profile_version_id": profile["id"],
                    "workflow_profile_name": profile["workflow_profile_name"],
                    "workflow_profile_version_number": profile["version_number"],
                    "workflow": workflow["workflow"],
                    "workflow_profile": profile["profile"],
                },
            },
        }

        preview = http.post("/api/batches/preview", json=request)
        assert preview.status_code == 200, preview.text
        assert preview.json()["job_count"] == 1
        assert preview.json()["jobs"][0]["resolved_prompt"] == "Portrait of "
        created = http.post("/api/runs", json=request)
        assert created.status_code == 201, created.text
        run_id = created.json()["run_id"]
        discarded = http.post(f"/api/runs/{run_id}/discard")
        assert discarded.status_code == 200, discarded.text
        assert discarded.json()["status"] == "cancelled"

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as restarted:
        reloaded_batch = restarted.get(f"/api/batches/{saved['id']}")
        reloaded_run = restarted.get(f"/api/runs/{run_id}")

    assert reloaded_batch.status_code == 200
    assert reloaded_batch.json()["variable_bindings"] == [binding]
    assert reloaded_run.status_code == 200
    assert reloaded_run.json()["batch_snapshot"]["variable_bindings"] == [binding]
    assert reloaded_run.json()["execution"]["status"] == "cancelled"


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


def test_project_assets_upload_list_deduplicate_and_serve_content(tmp_path: Path) -> None:
    settings = _settings(tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        empty = http.get("/api/projects/project_key/assets")
        imported = http.post(
            "/api/projects/project_key/assets",
            files=[
                ("files", ("nested/portrait.png", PNG_A, "image/png")),
                ("files", ("second.png", PNG_B, "image/png")),
                ("files", ("duplicate.png", PNG_A, "image/png")),
            ],
        )
        listed = http.get("/api/projects/project_key/assets")
        first_asset = imported.json()["assets"][0]
        content = http.get(first_asset["content_url"])

    assert empty.status_code == 200
    assert empty.json() == {"assets": []}
    assert imported.status_code == 201
    assert len(imported.json()["assets"]) == 2
    assert first_asset["original_filename"] == "portrait.png"
    assert first_asset["content_type"] == "image/png"
    assert first_asset["byte_size"] == len(PNG_A)
    assert first_asset["content_url"].startswith("/api/projects/project_key/assets/")
    assert "stored_path" not in first_asset
    assert listed.status_code == 200
    assert {asset["asset_id"] for asset in listed.json()["assets"]} == {
        asset["asset_id"] for asset in imported.json()["assets"]
    }
    assert content.status_code == 200
    assert content.headers["content-type"] == "image/png"
    assert content.content == PNG_A
    assert not (settings.projects_root / "project_key" / "project.json").exists()


@pytest.mark.parametrize(
    ("filename", "content", "content_type"),
    (
        ("image.gif", b"GIF89a", "image/gif"),
        ("image.png", b"not a png", "image/png"),
        ("image.jpg", b"\xff\xd8\xffimage", "image/png"),
    ),
)
def test_project_asset_upload_rejects_unsupported_or_mismatched_images(
    tmp_path: Path, filename: str, content: bytes, content_type: str
) -> None:
    settings = _settings(tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post(
            "/api/projects/project_key/assets",
            files={"files": (filename, content, content_type)},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_asset_upload"
    assert not (settings.projects_root / "project_key" / "assets").exists()


def test_project_asset_routes_reject_unsafe_project_paths(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    settings.projects_root.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (settings.projects_root / "linked").symlink_to(outside, target_is_directory=True)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        unsafe_key = http.get("/api/projects/bad%5Ckey/assets")
        symlink = http.get("/api/projects/linked/assets")

    assert unsafe_key.status_code == 422
    assert unsafe_key.json()["error"]["code"] == "invalid_project_key"
    assert symlink.status_code == 422
    assert symlink.json()["error"]["code"] == "invalid_project_key"


def test_project_asset_listing_is_lightweight_but_content_is_fully_verified(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        imported = http.post(
            "/api/projects/project_key/assets",
            files={"files": ("image.png", PNG_A, "image/png")},
        ).json()["assets"][0]
        content_path = next(settings.projects_root.glob("project_key/assets/sha256/*/*/content"))
        content_path.write_bytes(b"\x89PNG\r\n\x1a\nchanged")
        listed = http.get("/api/projects/project_key/assets")
        content = http.get(imported["content_url"])

    assert listed.status_code == 200
    assert [asset["asset_id"] for asset in listed.json()["assets"]] == [imported["asset_id"]]
    assert content.status_code == 500
    assert content.json()["error"]["code"] == "invalid_asset_data"


def test_preview_uses_production_compiler_order_and_preserves_warnings(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    _import_asset(settings, tmp_path, "asset-1")
    _import_asset(settings, tmp_path, "asset-2")
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
    assert body.job_count == 4
    assert [
        (
            job.resolved_prompt,
            [(item.slot_key, item.asset_id) for item in job.resolved_image_inputs],
            job.seed,
        )
        for job in body.jobs
    ] == [
        ("Portrait of dog", [("reference", "asset-1"), ("style", "asset-2")], 9),
        ("Portrait of dog", [("reference", "asset-1"), ("style", "asset-2")], 3),
        ("Portrait of cat", [("reference", "asset-1"), ("style", "asset-2")], 9),
        ("Portrait of cat", [("reference", "asset-1"), ("style", "asset-2")], 3),
    ]
    assert body.warnings[0].code == "unused_binding"


def test_preview_rejects_a_selected_project_asset_that_does_not_exist(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(("missing-asset",))

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)

    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "project_asset_not_found",
            "message": "Project assets were not found: missing-asset",
        }
    }


def test_preview_expands_ordered_image_alternatives_before_seeds(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    for asset_id in ("asset-1", "asset-2", "asset-3"):
        _import_asset(settings, tmp_path, asset_id)
    request = _batch_request(())
    request["prompt_versions"] = [{"id": "fixed", "name": "Fixed", "text": "Prompt"}]
    request["variable_bindings"] = []
    request["image_bindings"] = [
        {"slot_key": "style", "values": ["asset-3"]},
        {"slot_key": "reference", "values": [None, "asset-1", "asset-2"]},
    ]
    _sync_batch_snapshot(request)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)

    assert response.status_code == 200
    assert [
        (
            [
                (input_["slot_key"], input_["asset_id"], input_["filename"])
                for input_ in job["resolved_image_inputs"]
            ],
            job["seed"],
        )
        for job in response.json()["jobs"]
    ] == [
        ([("reference", None, None), ("style", "asset-3", "asset-3.png")], 9),
        ([("reference", None, None), ("style", "asset-3", "asset-3.png")], 3),
        ([("reference", "asset-1", "asset-1.png"), ("style", "asset-3", "asset-3.png")], 9),
        ([("reference", "asset-1", "asset-1.png"), ("style", "asset-3", "asset-3.png")], 3),
        ([("reference", "asset-2", "asset-2.png"), ("style", "asset-3", "asset-3.png")], 9),
        ([("reference", "asset-2", "asset-2.png"), ("style", "asset-3", "asset-3.png")], 3),
    ]


@pytest.mark.parametrize(
    "values",
    ([], ["asset-1", "asset-1"], [None, None], ["asset-1", None]),
)
def test_preview_rejects_invalid_image_alternative_arrays(
    tmp_path: Path, values: list[str | None]
) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(())
    request["image_bindings"] = [
        {"slot_key": "reference", "values": values},
        {"slot_key": "style", "values": [None]},
    ]
    _sync_batch_snapshot(request)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize(
    "mismatch",
    ("project", "batch", "prompts", "bindings", "images", "workflow", "profile", "seeds"),
)
def test_batch_request_rejects_snapshot_mismatches(tmp_path: Path, mismatch: str) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(("asset-1", "asset-2"))
    snapshot = request["batch_snapshot"]
    assert isinstance(snapshot, dict)
    if mismatch == "project":
        snapshot_project = snapshot["project"]
        assert isinstance(snapshot_project, dict)
        snapshot_project["name"] = "Other Project"
    elif mismatch == "batch":
        snapshot_batch = snapshot["batch"]
        assert isinstance(snapshot_batch, dict)
        snapshot_batch["name"] = "Other Batch"
    elif mismatch == "prompts":
        prompts = snapshot["prompt_versions"]
        assert isinstance(prompts, list)
        prompts[0] = {**prompts[0], "text": "Changed"}
    elif mismatch == "bindings":
        bindings = snapshot["variable_bindings"]
        assert isinstance(bindings, list)
        bindings[0] = {**bindings[0], "values": ["cat"]}
    elif mismatch == "images":
        image_bindings = snapshot["image_bindings"]
        assert isinstance(image_bindings, list)
        image_bindings.reverse()
    elif mismatch in {"workflow", "profile"}:
        selection = snapshot["workflow_selection"]
        assert isinstance(selection, dict)
        selection["workflow" if mismatch == "workflow" else "workflow_profile"] = {}
    else:
        intent = snapshot["seed_intent"]
        assert isinstance(intent, dict)
        intent["values"] = [9]

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_random_seed_snapshot_validates_dual_state_and_is_written_to_manifest_v8(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(())
    request["seeds"] = {"mode": "explicit", "values": [101, 202, 303]}
    snapshot = request["batch_snapshot"]
    assert isinstance(snapshot, dict)
    snapshot["source_saved_batch"] = {"id": "saved-batch", "revision": 7}
    snapshot["seed_intent"] = {
        "mode": "random",
        "values": [],
        "random_seed_count": 3,
    }
    workflow_selection = snapshot["workflow_selection"]
    assert isinstance(workflow_selection, dict)
    workflow_selection.update(
        {
            "workflow_name": "KREA2 Outfit",
            "workflow_version_number": 4,
            "workflow_profile_name": "General",
            "workflow_profile_version_number": 4,
        }
    )

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        preview = http.post("/api/batches/preview", json=request)
        created = http.post("/api/runs", json=request)
        run = http.get(f"/api/runs/{created.json()['run_id']}")

    assert preview.status_code == 200
    assert created.status_code == 201
    run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
    manifest = json.loads((run_path / "manifest.json").read_text())
    assert manifest["format_version"] == 9
    expected_snapshot = BatchRequest.model_validate(request).batch_snapshot.model_dump(mode="json")
    assert manifest["batch_snapshot"] == expected_snapshot
    assert [job["seed"] for job in manifest["jobs"]] == [
        101,
        202,
        303,
        101,
        202,
        303,
    ]
    assert run.json()["batch_snapshot"]["seed_intent"] == {
        "mode": "random",
        "values": [],
        "random_seed_count": 3,
    }
    returned_workflow = run.json()["batch_snapshot"]["workflow_selection"]
    assert returned_workflow["workflow_name"] == "KREA2 Outfit"
    assert returned_workflow["workflow_version_number"] == 4
    assert returned_workflow["workflow_profile_name"] == "General"
    assert returned_workflow["workflow_profile_version_number"] == 4
    assert sorted({job["seed"] for job in run.json()["plan"]["jobs"]}) == [101, 202, 303]

    invalid = copy.deepcopy(request)
    invalid["seeds"] = {"mode": "explicit", "values": [101, 202]}
    with TestClient(
        create_app(
            _settings(tmp_path / "invalid"), client_factory=lambda _settings: FakeComfyUIClient()
        )
    ) as http:
        mismatch = http.post("/api/batches/preview", json=invalid)
    assert mismatch.status_code == 422
    assert mismatch.json()["error"]["code"] == "invalid_request"


def test_run_api_requires_complete_snapshot_v5_and_rejects_malformed_durable_snapshot(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(())
    expected_snapshot = BatchRequest.model_validate(request).batch_snapshot.model_dump(mode="json")
    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        run_id = _create_run(http, request)
        valid = http.get(f"/api/runs/{run_id}")
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
        manifest_path = run_path / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        snapshot = manifest["batch_snapshot"]
        assert isinstance(snapshot, dict)
        snapshot.pop("workflow_selection")
        manifest_path.write_text(
            json.dumps(manifest, allow_nan=False, separators=(",", ":"), sort_keys=True) + "\n"
        )

        malformed = http.get(f"/api/runs/{run_id}")

    assert valid.status_code == 200
    assert valid.json()["batch_snapshot"] == expected_snapshot
    assert valid.json()["batch_snapshot"] is not None
    assert malformed.status_code == 500
    assert malformed.json()["error"]["code"] == "invalid_run_data"


def test_preview_and_run_creation_allow_zero_image_input_slots(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(())
    profile = request["workflow_profile"]
    assert isinstance(profile, dict)
    profile["image_inputs"] = []
    request["image_bindings"] = []
    _sync_batch_snapshot(request)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        preview = http.post("/api/batches/preview", json=request)
        created = http.post("/api/runs", json=request)
        run = http.get(f"/api/runs/{created.json()['run_id']}")

    assert preview.status_code == 200
    body = PreviewResponse.model_validate(preview.json())
    assert body.job_count == 4
    assert [job.resolved_image_inputs for job in body.jobs] == [[], [], [], []]
    assert created.status_code == 201
    assert all(job["resolved_image_inputs"] == [] for job in run.json()["plan"]["jobs"])

    run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
    manifest = json.loads((run_path / "manifest.json").read_text())
    assert all(job["resolved_image_inputs"] == [] for job in manifest["jobs"])
    assert not (settings.projects_root / "project_key" / "assets").exists()


def test_preview_rejects_image_bindings_that_do_not_match_profile_slots(
    tmp_path: Path,
) -> None:
    request = _batch_request(("asset-1",))
    profile = request["workflow_profile"]
    assert isinstance(profile, dict)
    profile["image_inputs"] = []
    _sync_batch_snapshot(request)

    with TestClient(
        create_app(_settings(tmp_path), client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_batch"
    assert "unknown slots" in response.json()["error"]["message"]


def test_api_requires_plural_prompts_and_returns_count_order_and_provenance(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    request = _batch_request((asset_id,))
    request["prompt_versions"] = [
        {"id": "animal", "name": "Animal", "text": "Portrait of {{animal}}"},
        {"id": "fixed", "name": "Fixed", "text": "A fixed portrait"},
    ]
    _sync_batch_snapshot(request)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        preview = http.post("/api/batches/preview", json=request)
        created = http.post("/api/runs", json=request)
        run = http.get(f"/api/runs/{created.json()['run_id']}")
        singular_request = dict(request)
        singular_request.pop("prompt_versions")
        singular_request["prompt_version"] = {
            "id": "old",
            "name": "Old",
            "text": "Old",
        }
        singular = http.post("/api/batches/preview", json=singular_request)

    assert preview.status_code == 200
    preview_body = preview.json()
    assert preview_body["job_count"] == 6
    assert [
        (job["prompt_version_id"], job["prompt_version_name"], job["resolved_prompt"])
        for job in preview_body["jobs"]
    ] == [
        ("animal", "Animal", "Portrait of dog"),
        ("animal", "Animal", "Portrait of dog"),
        ("animal", "Animal", "Portrait of cat"),
        ("animal", "Animal", "Portrait of cat"),
        ("fixed", "Fixed", "A fixed portrait"),
        ("fixed", "Fixed", "A fixed portrait"),
    ]
    assert created.status_code == 201
    assert "prompt_versions" not in created.json()
    assert run.json()["prompt_versions"] == request["prompt_versions"]
    assert [job["prompt_version_id"] for job in run.json()["jobs"]] == [
        "animal",
        "animal",
        "animal",
        "animal",
        "fixed",
        "fixed",
    ]
    assert [
        (
            job["prompt_version_name"],
            job["resolved_prompt"],
            job["resolved_variables"],
            [(item["slot_key"], item["filename"]) for item in job["resolved_image_inputs"]],
            job["seed"],
        )
        for job in run.json()["plan"]["jobs"]
    ] == [
        (
            job["prompt_version_name"],
            job["resolved_prompt"],
            job["resolved_variables"],
            [("reference", "asset-1.png"), ("style", None)],
            job["seed"],
        )
        for job in preview_body["jobs"]
    ]
    assert singular.status_code == 422


def test_api_rejects_an_empty_prompt_collection_with_stable_error_envelope(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(("asset-1",))
    request["prompt_versions"] = []

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)

    assert response.status_code == 422
    assert response.json() == {
        "error": {"code": "invalid_request", "message": "Request data is invalid"}
    }


def test_api_rejects_duplicate_prompt_version_ids_as_an_invalid_batch(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(("asset-1",))
    request["prompt_versions"] = [
        {"id": "duplicate", "name": "One", "text": "One"},
        {"id": "duplicate", "name": "Two", "text": "Two"},
    ]
    _sync_batch_snapshot(request)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/batches/preview", json=request)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_batch"
    assert "duplicate PromptVersion ID" in response.json()["error"]["message"]


def test_invalid_binding_returns_api_error(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(("asset-1",))
    bindings = request["variable_bindings"]
    assert isinstance(bindings, list)
    bindings[0]["values"] = []
    _sync_batch_snapshot(request)

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

    run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
    published = RunFilesystemStore(settings.projects_root).load_run(run_path)
    assert published.run_id == run_id
    assert published.path.name == "001-run"
    assert published.name is None
    assert published.description is None
    assert published.filesystem_key == "001-run"
    assert created["job_count"] == 4
    assert created["durable_status"] == "created"
    assert created["run_name"] is None
    assert created["run_description"] is None
    assert created["filesystem_key"] == "001-run"
    assert lookup.status_code == 200
    assert lookup.json()["execution"]["status"] == "created"
    assert not (run_path / "execution.json").exists()
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "run_not_found"


def test_named_run_api_round_trips_provenance_without_changing_plan_or_results(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    batch_request = _batch_request((asset_id,))
    create_request = {
        **batch_request,
        "run_name": "  Café / Baseline #1  ",
        "run_description": "  First named comparison.  ",
    }
    client = FakeComfyUIClient(artifact_count=1)

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        preview = http.post("/api/batches/preview", json=batch_request)
        created = http.post("/api/runs", json=create_request)
        body = created.json()
        lookup = http.get(f"/api/runs/{body['run_id']}")
        assert http.post(f"/api/runs/{body['run_id']}/execute").status_code == 202
        terminal = _wait_for_status(http, body["run_id"], "succeeded")
        results = http.get(f"/api/runs/{body['run_id']}/results")
        result_content = http.get(results.json()["results"][0]["download_url"])

    assert preview.status_code == 200
    assert created.status_code == 201
    assert body["run_name"] == "Café / Baseline #1"
    assert body["run_description"] == "First named comparison."
    assert body["filesystem_key"] == "001-cafe-baseline-1"
    assert lookup.json()["run_name"] == body["run_name"]
    assert lookup.json()["run_description"] == body["run_description"]
    assert lookup.json()["filesystem_key"] == body["filesystem_key"]
    assert lookup.json()["plan"]["jobs"] == preview.json()["jobs"]
    assert terminal.status == "succeeded"
    assert result_content.status_code == 200
    assert result_content.content == b"bytes:prompt-1-1.png"


def test_discard_pristine_run_is_durable_terminal_and_preserves_frozen_run(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    client = FakeComfyUIClient()
    discarded_at = datetime(2026, 8, 31, 12, 30, tzinfo=UTC)
    request = _batch_request((asset_id,))

    with TestClient(
        create_app(
            settings,
            client_factory=lambda _settings: client,
            clock=lambda: discarded_at,
        )
    ) as http:
        run_id = _create_run(http, request)
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
        immutable_before = {
            name: (run_path / name).read_bytes()
            for name in (
                "run.json",
                "manifest.json",
                "manifest.csv",
                "workflow.json",
                "workflow-profile.json",
            )
        }

        discarded = http.post(f"/api/runs/{run_id}/discard")
        repeated = http.post(f"/api/runs/{run_id}/discard")
        lookup = http.get(f"/api/runs/{run_id}")
        plan = http.get(f"/api/runs/{run_id}").json()["plan"]
        execute = http.post(f"/api/runs/{run_id}/execute")

        changed_request = copy.deepcopy(request)
        changed_prompts = changed_request["prompt_versions"]
        assert isinstance(changed_prompts, list)
        assert isinstance(changed_prompts[0], dict)
        changed_prompts[0]["text"] = "Changed {{animal}}"
        _sync_batch_snapshot(changed_request)
        next_run = http.post("/api/runs", json=changed_request)

    expected: dict[str, object] = {
        "run_id": run_id,
        "status": "cancelled",
        "execution_task_active": False,
        "started_at": None,
        "completed_at": "2026-08-31T12:30:00Z",
        "current_job_ordinal": None,
        "error": None,
        "diagnostics": ["discarded_before_start"],
        "jobs": [
            {
                "ordinal": ordinal,
                "status": "pending",
                "prompt_id": None,
                "started_at": None,
                "completed_at": None,
                "error": None,
                "diagnostics": [],
                "result_count": 0,
            }
            for ordinal in range(1, 5)
        ],
        "cancellation": {
            "mode": "after_current_job",
            "requested_at": None,
            "state": "cancelled",
        },
    }
    assert discarded.status_code == 200
    assert discarded.json() == expected
    assert repeated.status_code == 200
    assert repeated.json() == expected
    assert lookup.status_code == 200
    assert lookup.json()["execution"] == expected
    assert plan["jobs"][0]["resolved_prompt"] == "Portrait of dog"
    assert execute.status_code == 409
    assert execute.json()["error"]["code"] == "execution_not_eligible"
    assert next_run.status_code == 201
    assert next_run.json()["run_id"] != run_id
    assert client.submission_count == 0
    assert run_path.is_dir()
    assert json.loads((run_path / "execution.json").read_text())["format_version"] == 3
    assert {name: (run_path / name).read_bytes() for name in immutable_before} == immutable_before


def test_discard_accepts_persisted_exact_initial_state(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
        run = RunFilesystemStore(settings.projects_root).load_run(run_path)
        initial = ExecutionStateStore(run_path).initialize(run)

        response = http.post(f"/api/runs/{run_id}/discard")

    assert initial.status is RunExecutionStatus.CREATED
    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"


def test_discard_persists_no_intermediate_created_state_when_write_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    def fail_write(*_args: object, **_kwargs: object) -> NoReturn:
        raise ExecutionStateError("simulated discard write failure")

    monkeypatch.setattr(ExecutionStateStore, "_atomic_replace", fail_write)
    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient()),
        raise_server_exceptions=False,
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))

        response = http.post(f"/api/runs/{run_id}/discard")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "invalid_run_data"
    assert not (run_path / "execution.json").exists()


def test_discard_is_durable_across_application_restart(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        first = http.post(f"/api/runs/{run_id}/discard")

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as restarted:
        lookup = restarted.get(f"/api/runs/{run_id}")
        repeated = restarted.post(f"/api/runs/{run_id}/discard")

    assert first.status_code == 200
    assert lookup.json()["execution"] == first.json()
    assert repeated.json() == first.json()


@pytest.mark.parametrize(
    "case",
    [
        "running",
        "preparing",
        "submitting",
        "submitted",
        "submission_unknown",
        "blocked",
        "submission_metadata",
        "result",
    ],
)
def test_discard_rejects_nonpristine_or_submission_bearing_state(tmp_path: Path, case: str) -> None:
    settings = _settings(tmp_path / case)
    asset_id = _import_asset(settings, tmp_path, f"asset-{case}")

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
        run = RunFilesystemStore(settings.projects_root).load_run(run_path)
        store = ExecutionStateStore(run_path)
        state = store.initialize(run)
        job = state.jobs[0]

        if case == "running":
            state = replace(state, status=RunExecutionStatus.RUNNING, started_at="started")
        elif case == "preparing":
            state = replace(
                state,
                status=RunExecutionStatus.RUNNING,
                started_at="started",
                jobs=(replace(job, status=JobExecutionStatus.PREPARING), *state.jobs[1:]),
            )
        elif case == "submitting":
            state = replace(
                state,
                status=RunExecutionStatus.RUNNING,
                started_at="started",
                jobs=(replace(job, status=JobExecutionStatus.SUBMITTING), *state.jobs[1:]),
            )
        elif case in {"submitted", "blocked"}:
            state = replace(
                state,
                status=(
                    RunExecutionStatus.BLOCKED if case == "blocked" else RunExecutionStatus.RUNNING
                ),
                started_at="started",
                jobs=(
                    replace(
                        job,
                        status=JobExecutionStatus.SUBMITTED,
                        submission_disposition=SubmissionDisposition.ACCEPTED,
                        prompt_id="prompt-1",
                    ),
                    *state.jobs[1:],
                ),
            )
        elif case == "submission_unknown":
            state = replace(
                state,
                status=RunExecutionStatus.BLOCKED,
                started_at="started",
                jobs=(
                    replace(
                        job,
                        status=JobExecutionStatus.SUBMISSION_UNKNOWN,
                        submission_disposition=SubmissionDisposition.UNKNOWN,
                    ),
                    *state.jobs[1:],
                ),
            )
        elif case == "submission_metadata":
            state = replace(
                state,
                jobs=(
                    replace(
                        job,
                        client_id="submission-client",
                        submission_disposition=SubmissionDisposition.ACCEPTED,
                        submission_http_status=200,
                        submission_response={"prompt_id": "prompt-1"},
                        prompt_id="prompt-1",
                    ),
                    *state.jobs[1:],
                ),
            )
        else:
            result = store.persist_result(
                job_id=job.job_id,
                job_ordinal=job.ordinal,
                artifact_ordinal=1,
                downloaded=DownloadedArtifact(
                    remote=RemoteOutputArtifact("41", "images", "result.png", "", "output"),
                    content=PNG_A,
                    content_type="image/png",
                    sha256=hashlib.sha256(PNG_A).hexdigest(),
                ),
            )
            state = replace(
                state,
                jobs=(replace(job, results=(result,)), *state.jobs[1:]),
            )
        store.state_path.unlink()
        store.save(run, state)

        response = http.post(f"/api/runs/{run_id}/discard")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "run_discard_not_eligible"
    assert store.read_for_query(run) == state
    if case == "result":
        assert (run.path / state.jobs[0].results[0].local_path).read_bytes() == PNG_A


def test_discard_missing_run_uses_existing_not_found_error(tmp_path: Path) -> None:
    with TestClient(
        create_app(_settings(tmp_path), client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        response = http.post("/api/runs/missing/discard")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "run_not_found"


def test_repeated_multi_prompt_run_creation_freezes_identical_plans_with_new_identities(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    request = _batch_request((asset_id,))
    request["prompt_versions"] = [
        {"id": "animal", "name": "Animal", "text": "Portrait of {{animal}}"},
        {"id": "fixed", "name": "Fixed", "text": "A fixed portrait"},
    ]
    _sync_batch_snapshot(request)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        first_response = http.post("/api/runs", json=request)
        second_response = http.post("/api/runs", json=request)

    assert first_response.status_code == 201
    assert second_response.status_code == 201
    assert first_response.json()["run_id"] != second_response.json()["run_id"]
    assert (first_response.json()["run_number"], second_response.json()["run_number"]) == (1, 2)

    store = RunFilesystemStore(settings.projects_root)
    first_path, second_path = sorted(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
    first = store.load_run(first_path)
    second = store.load_run(second_path)

    assert first.compiled_plan == second.compiled_plan
    assert first.compiled_plan.prompt_versions == (
        PromptVersion(id="animal", name="Animal", text="Portrait of {{animal}}"),
        PromptVersion(id="fixed", name="Fixed", text="A fixed portrait"),
    )
    assert [job.compiled_job.prompt_version_id for job in first.jobs] == [
        "animal",
        "animal",
        "animal",
        "animal",
        "fixed",
        "fixed",
    ]
    assert {job.job_id for job in first.jobs}.isdisjoint(job.job_id for job in second.jobs)


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
        target_path, unrelated_path = sorted(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
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
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
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
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
        duplicate_path = (
            settings.projects_root / "duplicate_project" / "batches" / "batch_key" / "001-run"
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
    assert not tuple(settings.projects_root.glob("*/batches/*/[0-9]*-*"))


def test_preview_validates_the_same_workflow_profile_pair_as_run_creation(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    request = _batch_request((), invalid_profile=True)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        preview = http.post("/api/batches/preview", json=request)
        creation = http.post("/api/runs", json=request)

    assert preview.status_code == creation.status_code == 422
    assert preview.json()["error"]["code"] == "invalid_workflow_profile"
    assert creation.json()["error"]["code"] == "invalid_workflow_profile"


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
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
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
        discard = http.post(f"/api/runs/{run_id}/discard")

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
    assert discard.status_code == 409
    assert discard.json()["error"]["code"] == "run_discard_not_eligible"
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
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
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
        cancellation_control: RunCancellationControl,
    ) -> RunExecutionState:
        assert client is not None
        assert config.history_timeout_seconds == 1
        assert not cancellation_control.cancellation_requested()
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
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
        first = http.post(f"/api/runs/{run_id}/execute")
        assert first.status_code == 202
        assert started.wait(timeout=1)

        second = http.post(f"/api/runs/{run_id}/execute")
        discard = http.post(f"/api/runs/{run_id}/discard")
        other_run_id = _create_run(http, _batch_request((asset_id,)))
        other_run = http.post(f"/api/runs/{other_run_id}/execute")
        execution = http.get(f"/api/runs/{run_id}/execution")
        run_response = http.get(f"/api/runs/{run_id}")

        assert second.status_code == 409
        assert second.json()["error"]["code"] == "execution_already_active"
        assert discard.status_code == 409
        assert discard.json()["error"]["code"] == "run_discard_not_eligible"
        assert other_run.status_code == 409
        assert other_run.json()["error"]["code"] == "execution_already_active"
        assert execution.json()["status"] == "running"
        assert execution.json()["execution_task_active"] is True
        assert run_response.json()["execution"]["execution_task_active"] is True

    assert cancelled.is_set()
    assert client.closed
    published = RunFilesystemStore(settings.projects_root).load_run(run_path)
    assert ExecutionStateStore(run_path).load(published).status is RunExecutionStatus.RUNNING

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as restarted_http:
        restored_execution = restarted_http.get(f"/api/runs/{run_id}/execution")
        restored_run = restarted_http.get(f"/api/runs/{run_id}")

    assert restored_execution.json()["status"] == "running"
    assert restored_execution.json()["execution_task_active"] is False
    assert restored_run.json()["execution"]["execution_task_active"] is False


def test_execution_start_and_discard_race_has_exactly_one_winner(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    async def blocking_executor(
        *,
        run: PublishedRun,
        client: ExecutionClient,
        config: ExecutionConfig,
        cancellation_control: RunCancellationControl,
    ) -> RunExecutionState:
        assert client is not None
        assert config.history_timeout_seconds == 1
        assert not cancellation_control.cancellation_requested()
        store = ExecutionStateStore(run.path)
        state = store.initialize(run)
        running = replace(state, status=RunExecutionStatus.RUNNING, started_at="started")
        store.save(run, running)
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    with TestClient(
        create_app(
            settings,
            client_factory=lambda _settings: FakeComfyUIClient(),
            executor=blocking_executor,
        )
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        barrier = threading.Barrier(2)

        def request(path: str) -> Response:
            barrier.wait(timeout=2)
            return cast(Response, http.post(path))

        with ThreadPoolExecutor(max_workers=2) as executor:
            start_future = executor.submit(request, f"/api/runs/{run_id}/execute")
            discard_future = executor.submit(request, f"/api/runs/{run_id}/discard")
            started = start_future.result(timeout=5)
            discarded = discard_future.result(timeout=5)

        if started.status_code == 202:
            assert discarded.status_code == 409
            assert discarded.json()["error"]["code"] == "run_discard_not_eligible"
        else:
            assert started.status_code == 409
            assert started.json()["error"]["code"] == "execution_not_eligible"
            assert discarded.status_code == 200
            assert discarded.json()["status"] == "cancelled"


def test_execution_rejects_unsafe_outputs_before_starting_task(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    client = FakeComfyUIClient()

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        run_path = next(settings.projects_root.glob("*/batches/*/[0-9]*-*"))
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
        failed_discard = http.post(f"/api/runs/{failed_run}/discard")

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
    assert failed_discard.status_code == 409
    assert failed_discard.json()["error"]["code"] == "run_discard_not_eligible"
    assert blocked_restart.status_code == 409


def test_run_cancellation_rejects_unknown_invalid_and_inactive_runs(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        unknown = http.post("/api/runs/missing/cancel", json={"mode": "after_current_job"})
        inactive = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})
        unsupported = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "immediate"})
        extra = http.post(
            f"/api/runs/{run_id}/cancel",
            json={"mode": "after_current_job", "extra": True},
        )

    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "run_not_found"
    assert inactive.status_code == 409
    assert inactive.json()["error"]["code"] == "run_cancellation_not_eligible"
    assert unsupported.status_code == 422
    assert extra.status_code == 422
    assert (
        RunCancellationRequestStore(settings.database_path).get(
            run_id, RunCancellationMode.AFTER_CURRENT_JOB
        )
        is None
    )


@pytest.mark.parametrize(
    "client",
    (
        FakeComfyUIClient(),
        FakeComfyUIClient(upload_error=RuntimeError("upload failed")),
        FakeComfyUIClient(submission_disposition=SubmissionDisposition.UNKNOWN),
    ),
)
def test_new_run_cancellation_request_rejects_terminal_execution_states(
    tmp_path: Path, client: FakeComfyUIClient
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        terminal = _wait_for_status(
            http,
            run_id,
            "blocked"
            if client.submission_disposition is SubmissionDisposition.UNKNOWN
            else "failed"
            if client.upload_error is not None
            else "succeeded",
        )
        response = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})

    assert terminal.status in {"succeeded", "failed", "blocked"}
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "run_cancellation_not_eligible"
    assert (
        RunCancellationRequestStore(settings.database_path).get(
            run_id, RunCancellationMode.AFTER_CURRENT_JOB
        )
        is None
    )
    store = RunCancellationRequestStore(settings.database_path)
    record, created = store.request(run_id, RunCancellationMode.AFTER_CURRENT_JOB)
    assert created
    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as restarted:
        repeated = restarted.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})
        read_model = restarted.get(f"/api/runs/{run_id}/execution")
    assert repeated.status_code == 202
    assert repeated.json()["created"] is False
    assert repeated.json()["requested_at"] == record.requested_at.isoformat().replace("+00:00", "Z")
    assert repeated.json()["state"] == "finished"
    assert read_model.json()["cancellation"]["state"] == "finished"


def test_active_cancellation_is_prompt_durable_idempotent_and_releases_registry(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    crossed_admission = threading.Event()
    request_seen = threading.Event()
    finish_current = threading.Event()
    second_started = threading.Event()
    calls = 0

    async def controlled_executor(
        *,
        run: PublishedRun,
        client: ExecutionClient,
        config: ExecutionConfig,
        cancellation_control: RunCancellationControl,
    ) -> RunExecutionState:
        nonlocal calls
        calls += 1
        assert client is not None
        assert config.history_timeout_seconds == 1
        store = ExecutionStateStore(run.path)
        state = store.initialize(run)
        state = replace(
            state,
            status=RunExecutionStatus.RUNNING,
            started_at="2026-09-01T10:00:00Z",
            current_job_ordinal=1,
        )
        store.save(run, state)
        preparing = replace(
            state.jobs[0],
            status=JobExecutionStatus.PREPARING,
            client_id="client-1",
            started_at="2026-09-01T10:00:01Z",
        )
        state = replace(state, jobs=(preparing, *state.jobs[1:]))
        store.save(run, state)
        async with cancellation_control.submission_admission() as admitted:
            assert admitted
            submitting = replace(preparing, status=JobExecutionStatus.SUBMITTING)
            state = replace(state, jobs=(submitting, *state.jobs[1:]))
            store.save(run, state)

        if calls > 1:
            second_started.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        crossed_admission.set()
        while not cancellation_control.cancellation_requested():
            await asyncio.sleep(0.001)
        request_seen.set()
        await asyncio.to_thread(finish_current.wait)

        submitted = replace(
            submitting,
            status=JobExecutionStatus.SUBMITTED,
            submission_disposition=SubmissionDisposition.ACCEPTED,
            submission_http_status=200,
            submission_response={"prompt_id": "prompt-1"},
            prompt_id="prompt-1",
        )
        state = replace(state, jobs=(submitted, *state.jobs[1:]))
        store.save(run, state)
        succeeded = replace(
            submitted,
            status=JobExecutionStatus.SUCCEEDED,
            completed_at="2026-09-01T10:00:02Z",
        )
        cancelled_jobs = tuple(
            replace(
                job,
                status=JobExecutionStatus.CANCELLED,
                completed_at="2026-09-01T10:00:02Z",
            )
            for job in state.jobs[1:]
        )
        state = replace(state, jobs=(succeeded, *cancelled_jobs))
        store.save(run, state)
        state = replace(
            state,
            status=RunExecutionStatus.CANCELLED,
            completed_at="2026-09-01T10:00:02Z",
            current_job_ordinal=None,
            diagnostics=(STOPPED_AFTER_CURRENT_JOB,),
        )
        store.save(run, state)
        return state

    with TestClient(
        create_app(
            settings,
            client_factory=lambda _settings: FakeComfyUIClient(),
            executor=controlled_executor,
            clock=lambda: datetime(2026, 9, 1, 10, 0, 1, tzinfo=UTC),
        )
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        assert crossed_admission.wait(timeout=1)

        started_at = time.monotonic()
        first = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})
        elapsed = time.monotonic() - started_at
        assert request_seen.wait(timeout=1)
        repeated = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})
        execution = http.get(f"/api/runs/{run_id}/execution")
        run_lookup = http.get(f"/api/runs/{run_id}")

        assert first.status_code == 202
        assert elapsed < 0.5
        assert first.json() == {
            "run_id": run_id,
            "mode": "after_current_job",
            "requested_at": "2026-09-01T10:00:01Z",
            "created": True,
            "state": "stopping_after_current_job",
        }
        assert repeated.json() == {**first.json(), "created": False}
        assert execution.json()["cancellation"] == {
            "mode": "after_current_job",
            "requested_at": "2026-09-01T10:00:01Z",
            "state": "stopping_after_current_job",
        }
        assert run_lookup.json()["execution"]["cancellation"] == execution.json()["cancellation"]
        persisted = RunCancellationRequestStore(settings.database_path).get(
            run_id, RunCancellationMode.AFTER_CURRENT_JOB
        )
        assert persisted is not None
        assert persisted.requested_at == datetime(2026, 9, 1, 10, 0, 1, tzinfo=UTC)

        finish_current.set()
        terminal = _wait_for_status(http, run_id, "cancelled")
        terminal_request = http.post(
            f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"}
        )
        other_run_id = _create_run(http, _batch_request((asset_id,)))
        other_started = http.post(f"/api/runs/{other_run_id}/execute")
        assert second_started.wait(timeout=1)

        assert terminal.cancellation is not None
        assert terminal.cancellation.state == "cancelled"
        assert terminal_request.status_code == 202
        assert terminal_request.json()["created"] is False
        assert terminal_request.json()["state"] == "cancelled"
        assert other_started.status_code == 202


def test_cancelled_run_without_intent_is_idempotent_without_creating_one(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        assert http.post(f"/api/runs/{run_id}/discard").status_code == 200
        response = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})

    assert response.status_code == 202
    assert response.json() == {
        "run_id": run_id,
        "mode": "after_current_job",
        "requested_at": None,
        "created": False,
        "state": "cancelled",
    }
    assert (
        RunCancellationRequestStore(settings.database_path).get(
            run_id, RunCancellationMode.AFTER_CURRENT_JOB
        )
        is None
    )


def test_cancellation_before_submission_admission_reports_stop_requested(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    ready_for_admission = threading.Event()
    allow_admission = threading.Event()

    async def admission_losing_executor(
        *,
        run: PublishedRun,
        client: ExecutionClient,
        config: ExecutionConfig,
        cancellation_control: RunCancellationControl,
    ) -> RunExecutionState:
        assert client is not None
        assert config is not None
        store = ExecutionStateStore(run.path)
        state = store.initialize(run)
        preparing = replace(
            state.jobs[0],
            status=JobExecutionStatus.PREPARING,
            client_id="client-1",
            started_at="2026-09-01T11:00:01Z",
        )
        state = replace(
            state,
            status=RunExecutionStatus.RUNNING,
            started_at="2026-09-01T11:00:00Z",
            current_job_ordinal=1,
            jobs=(preparing, *state.jobs[1:]),
        )
        store.save(run, state)
        ready_for_admission.set()
        await asyncio.to_thread(allow_admission.wait)
        async with cancellation_control.submission_admission() as admitted:
            assert not admitted

        cancelled_jobs = tuple(
            replace(
                job,
                status=JobExecutionStatus.CANCELLED,
                completed_at="2026-09-01T11:00:02Z",
            )
            for job in state.jobs
        )
        state = replace(state, jobs=cancelled_jobs)
        store.save(run, state)
        state = replace(
            state,
            status=RunExecutionStatus.CANCELLED,
            completed_at="2026-09-01T11:00:02Z",
            current_job_ordinal=None,
            diagnostics=(STOPPED_AFTER_CURRENT_JOB,),
        )
        store.save(run, state)
        return state

    with TestClient(
        create_app(
            settings,
            client_factory=lambda _settings: FakeComfyUIClient(),
            executor=admission_losing_executor,
        )
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        assert ready_for_admission.wait(timeout=1)
        requested = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})
        assert requested.status_code == 202
        assert requested.json()["state"] == "stop_requested"
        assert http.get(f"/api/runs/{run_id}/execution").json()["cancellation"]["state"] == (
            "stop_requested"
        )

        allow_admission.set()
        terminal = _wait_for_status(http, run_id, "cancelled")
        assert terminal.cancellation is not None
        assert terminal.cancellation.state == "cancelled"


def test_run_cancellation_store_failure_is_sanitized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)

    def fail_request(*_args: object, **_kwargs: object) -> NoReturn:
        raise RunCancellationStoreError("private database detail")

    async def blocking_executor(
        *,
        run: PublishedRun,
        client: ExecutionClient,
        config: ExecutionConfig,
        cancellation_control: RunCancellationControl,
    ) -> RunExecutionState:
        assert run is not None
        assert client is not None
        assert config is not None
        assert not cancellation_control.cancellation_requested()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    with TestClient(
        create_app(
            settings,
            client_factory=lambda _settings: FakeComfyUIClient(),
            executor=blocking_executor,
        ),
        raise_server_exceptions=False,
    ) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        monkeypatch.setattr(RunCancellationRequestStore, "request", fail_request)
        response = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})

    assert response.status_code == 500
    assert response.json() == {
        "error": {
            "code": "run_cancellation_store_failed",
            "message": "Run cancellation data is unavailable",
        }
    }
    assert "private database detail" not in response.text


def test_detach_is_durable_idempotent_blocks_and_does_not_resume_after_restart(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    history_started = threading.Event()
    history_cancelled = threading.Event()

    class HangingHistoryClient(FakeComfyUIClient):
        def __init__(self) -> None:
            super().__init__()
            self.global_queue_operations: list[str] = []

        async def get_history(self, prompt_id: str) -> ExecutionOutcome | None:
            assert prompt_id == "prompt-1"
            history_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                history_cancelled.set()
                raise
            raise AssertionError("unreachable")

        async def interrupt(self) -> None:
            self.global_queue_operations.append("interrupt")

        async def clear_queue(self) -> None:
            self.global_queue_operations.append("clear_queue")

    client = HangingHistoryClient()
    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
        assert history_started.wait(timeout=1)

        after_current = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "after_current_job"})
        started_at = time.monotonic()
        detached = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "detach"})
        elapsed = time.monotonic() - started_at

        assert after_current.status_code == 202
        assert detached.status_code == 202
        assert elapsed < 0.5
        assert detached.json()["mode"] == "detach"
        assert detached.json()["created"] is True
        assert detached.json()["state"] in {"detach_requested", "detached"}
        terminal = _wait_for_status(http, run_id, "blocked")
        repeated = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "detach"})

        assert history_cancelled.wait(timeout=1)
        assert terminal.error == USER_DETACHED_FROM_CURRENT_JOB
        assert terminal.diagnostics == [USER_DETACHED_FROM_CURRENT_JOB]
        assert terminal.jobs[0].status == "submitted"
        assert terminal.jobs[0].prompt_id == "prompt-1"
        assert terminal.jobs[1].status == "pending"
        assert terminal.cancellation is not None
        assert terminal.cancellation.mode == "detach"
        assert terminal.cancellation.state == "detached"
        assert repeated.status_code == 202
        assert repeated.json()["created"] is False
        assert repeated.json()["state"] == "detached"
        assert client.submission_count == 1
        assert client.global_queue_operations == []

    store = RunCancellationRequestStore(settings.database_path)
    assert store.get(run_id, RunCancellationMode.AFTER_CURRENT_JOB) is not None
    assert store.get(run_id, RunCancellationMode.DETACH) is not None

    restarted_client = FakeComfyUIClient()
    with TestClient(
        create_app(settings, client_factory=lambda _settings: restarted_client)
    ) as restarted:
        recovered = restarted.get(f"/api/runs/{run_id}/execution")
        next_run_id = _create_run(restarted, _batch_request((asset_id,)))
        assert restarted.post(f"/api/runs/{next_run_id}/execute").status_code == 202
        next_terminal = _wait_for_status(restarted, next_run_id, "succeeded")

    assert recovered.json()["status"] == "blocked"
    assert recovered.json()["cancellation"]["state"] == "detached"
    assert next_terminal.status == "succeeded"
    assert restarted_client.submission_count == len(next_terminal.jobs)


@pytest.mark.parametrize("terminal_status", ("succeeded", "failed", "blocked", "cancelled"))
def test_detach_does_not_rewrite_terminal_runs(
    tmp_path: Path,
    terminal_status: str,
) -> None:
    settings = _settings(tmp_path)
    asset_id = _import_asset(settings, tmp_path)
    client = (
        FakeComfyUIClient(upload_error=RuntimeError("upload failed"))
        if terminal_status == "failed"
        else FakeComfyUIClient(submission_disposition=SubmissionDisposition.UNKNOWN)
        if terminal_status == "blocked"
        else FakeComfyUIClient()
    )

    with TestClient(create_app(settings, client_factory=lambda _settings: client)) as http:
        run_id = _create_run(http, _batch_request((asset_id,)))
        if terminal_status == "cancelled":
            assert http.post(f"/api/runs/{run_id}/discard").status_code == 200
        else:
            assert http.post(f"/api/runs/{run_id}/execute").status_code == 202
            _wait_for_status(http, run_id, terminal_status)
        before = http.get(f"/api/runs/{run_id}/execution").json()
        response = http.post(f"/api/runs/{run_id}/cancel", json={"mode": "detach"})
        after = http.get(f"/api/runs/{run_id}/execution").json()

    assert response.status_code == 202
    assert response.json()["created"] is False
    assert response.json()["requested_at"] is None
    assert response.json()["state"] == (
        "cancelled" if terminal_status == "cancelled" else "finished"
    )
    assert after == before
    assert (
        RunCancellationRequestStore(settings.database_path).get(run_id, RunCancellationMode.DETACH)
        is None
    )
