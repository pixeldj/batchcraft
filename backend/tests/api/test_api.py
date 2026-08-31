import asyncio
import copy
import hashlib
import json
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
from batchcraft.api.schemas import BatchRequest, ExecutionResponse, PreviewResponse, ResultsResponse
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
from batchcraft.domain import PromptVersion
from batchcraft.execution import (
    ExecutionClient,
    ExecutionConfig,
    ExecutionStateError,
    ExecutionStateStore,
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

PNG_A = b"\x89PNG\r\n\x1a\nimage-a"
PNG_B = b"\x89PNG\r\n\x1a\nimage-b"


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
    project = {"id": "project-id", "filesystem_key": "project_key", "name": "Project"}
    batch = {"id": "batch-id", "filesystem_key": "batch_key", "name": "Batch"}
    prompt_versions = [
        {"id": "prompt-v1", "name": "Portrait prompt", "text": "Portrait of {{animal}}"}
    ]
    references = [{"asset_id": asset_id} for asset_id in asset_ids]
    seeds = {"mode": "explicit", "values": [9, 3]}
    workflow = {
        "7": {"class_type": "KSampler", "inputs": {"seed": 0}},
        "25": {"class_type": "LoadImage", "inputs": {"image": "original.png"}},
        "34": {"class_type": "TextEncode", "inputs": {"prompt": "original"}},
        "41": {"class_type": "SaveImage", "inputs": {"filename_prefix": "original"}},
    }
    return {
        "project": project,
        "batch": batch,
        "prompt_versions": prompt_versions,
        "variable_bindings": bindings,
        "references": references,
        "seeds": seeds,
        "workflow": workflow,
        "workflow_profile": profile,
        "batch_snapshot": {
            "snapshot_version": 1,
            "project": copy.deepcopy(project),
            "source_saved_batch": None,
            "batch": {**batch, "description": None},
            "prompt_versions": copy.deepcopy(prompt_versions),
            "variable_bindings": copy.deepcopy(bindings),
            "references": copy.deepcopy(references),
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
    snapshot["references"] = request["references"]
    workflow_selection = snapshot["workflow_selection"]
    assert isinstance(workflow_selection, dict)
    workflow_selection["workflow"] = request["workflow"]
    workflow_selection["workflow_profile"] = request["workflow_profile"]


def _create_run(http: TestClient, request: dict[str, object]) -> str:
    response = http.post("/api/runs", json=request)
    assert response.status_code == 201, response.text
    return str(response.json()["run_id"])


def _saved_batch_definition(http: TestClient, project_id: str) -> dict[str, object]:
    request = _batch_request(())
    workflow = request["workflow"]
    profile = request["workflow_profile"]
    assert isinstance(workflow, dict)
    assert isinstance(profile, dict)
    mappings = profile["mappings"]
    assert isinstance(mappings, dict)
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
                "variable_list_id": "animals",
                "values": ["cat", "dog"],
                "selected_values": ["dog", "cat"],
                "mode": "all",
                "fixed_value": None,
            }
        ],
        "reference_selections": [{"asset_id": "asset-2"}, {"asset_id": "asset-1"}],
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
    mappings = profile_data["mappings"]
    assert isinstance(mappings, dict)

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
        assert (
            restarted.get(f"/api/workflow-profile-versions/{profile_version_one['id']}").status_code
            == 200
        )
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
        invalid_mappings.pop("reference_image")
        invalid = http.post(
            f"/api/workflows/{target['workflow_id']}/profiles",
            json={
                "name": "Invalid",
                "workflow_version_id": target["id"],
                "mappings": invalid_mappings,
            },
        )
        foreign = http.post(
            f"/api/workflows/{target['workflow_id']}/profiles",
            json={
                "name": "Foreign",
                "workflow_version_id": foreign_target["id"],
                "mappings": mappings,
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
        assert [item["asset_id"] for item in batch["reference_selections"]] == [
            "asset-2",
            "asset-1",
        ]
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
            "reference_selections",
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
                    "variable_list_id": "",
                    "values": [],
                    "selected_values": [],
                    "mode": "all",
                    "fixed_value": None,
                }
            ],
            "reference_selections": [],
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


@pytest.mark.parametrize(
    "mismatch",
    ("project", "batch", "prompts", "bindings", "references", "workflow", "profile", "seeds"),
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
        bindings[0] = {**bindings[0], "selected_values": ["cat"]}
    elif mismatch == "references":
        references = snapshot["references"]
        assert isinstance(references, list)
        references.reverse()
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


def test_random_seed_snapshot_validates_dual_state_and_is_written_to_manifest_v4(
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
    run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
    manifest = json.loads((run_path / "manifest.json").read_text())
    assert manifest["format_version"] == 4
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


def test_preview_and_run_creation_allow_no_reference_assets(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(())

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        preview = http.post("/api/batches/preview", json=request)
        created = http.post("/api/runs", json=request)
        run = http.get(f"/api/runs/{created.json()['run_id']}")

    assert preview.status_code == 200
    body = PreviewResponse.model_validate(preview.json())
    assert body.job_count == 4
    assert [job.reference_asset_id for job in body.jobs] == [None, None, None, None]
    assert created.status_code == 201
    assert all(job["reference_asset_id"] is None for job in run.json()["plan"]["jobs"])
    assert all(job["reference_filename"] is None for job in run.json()["plan"]["jobs"])

    run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
    manifest = json.loads((run_path / "manifest.json").read_text())
    assert all(job["reference_asset"] is None for job in manifest["jobs"])
    assert not (settings.projects_root / "project_key" / "assets").exists()


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
            job["reference_filename"],
            job["seed"],
        )
        for job in run.json()["plan"]["jobs"]
    ] == [
        (
            job["prompt_version_name"],
            job["resolved_prompt"],
            job["resolved_variables"],
            "asset-1.png",
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
    bindings[0]["selected_values"] = ["horse"]
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


def test_run_lookup_degrades_gracefully_for_manifest_v3_without_batch_intent(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    request = _batch_request(())

    with TestClient(
        create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    ) as http:
        created = http.post("/api/runs", json=request)
        assert created.status_code == 201
        run_path = next(settings.projects_root.glob("*/batches/*/run-*"))
        manifest_path = run_path / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["format_version"] = 3
        manifest.pop("batch_snapshot")
        manifest_path.write_text(
            json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
        )

        lookup = http.get(f"/api/runs/{created.json()['run_id']}")

    assert lookup.status_code == 200
    assert lookup.json()["batch_snapshot"] is None
    assert lookup.json()["plan"]["job_count"] == 4
    assert lookup.json()["plan"]["jobs"][0]["resolved_prompt"] == "Portrait of dog"


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
    first_path, second_path = sorted(settings.projects_root.glob("*/batches/*/run-*"))
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
