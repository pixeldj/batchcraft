import copy
import hashlib
import sqlite3
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from batchcraft.api import Settings, create_app
from batchcraft.application import ApplicationComfyUIClient
from batchcraft.db import ProjectStore, PromptStore, WorkflowProfileStore, WorkflowStore
from batchcraft.files._io import canonical_json_bytes


class UnusedClient:
    async def aclose(self) -> None:
        return None


def _client(_settings: Settings) -> ApplicationComfyUIClient:
    return cast(ApplicationComfyUIClient, UnusedClient())


def _settings(tmp_path: Path, *, database_name: str = "batchcraft.sqlite3") -> Settings:
    return Settings(
        projects_root=tmp_path / "projects",
        comfyui_base_url="http://unused",
        comfyui_timeout_seconds=1,
        websocket_timeout_seconds=1,
        history_timeout_seconds=1,
        history_poll_interval_seconds=0.01,
        frontend_origin="http://localhost:5173",
        server_host="127.0.0.1",
        server_port=8000,
        data_root=tmp_path / "data",
        database_path=tmp_path / "data" / database_name,
    )


def _create_linked_run(
    http: TestClient,
    *,
    historical_prompt_texts: tuple[str, str] | None = None,
    omit_historical_logical_ids: bool = False,
    database_path: Path | None = None,
    equivalent_workflow_hash_mismatch: bool = False,
    equivalent_profile_hash_mismatch: bool = False,
) -> tuple[str, dict[str, Any]]:
    project = http.post(
        "/api/projects",
        json={"name": "Project", "filesystem_key": "project_key"},
    ).json()
    prompts = [
        http.post(
            f"/api/projects/{project['id']}/prompts",
            json={"name": name, "text": text},
        ).json()
        for name, text in (("First", "First prompt"), ("Second", "Second prompt"))
    ]
    workflow = {
        "7": {"class_type": "KSampler", "inputs": {"seed": 0}},
        "34": {"class_type": "TextEncode", "inputs": {"prompt": "original"}},
        "41": {"class_type": "SaveImage", "inputs": {"filename_prefix": "original"}},
    }
    workflow_created = http.post(
        f"/api/projects/{project['id']}/workflows",
        json={"name": "Workflow", "workflow": workflow},
    ).json()
    workflow_record = workflow_created["workflow"]
    workflow_version = workflow_created["version"]
    if equivalent_workflow_hash_mismatch:
        assert database_path is not None
        stored_workflow = copy.deepcopy(workflow_version["workflow"])
        stored_workflow["7"]["inputs"]["seed"] = False
        content = canonical_json_bytes(stored_workflow)
        with sqlite3.connect(database_path) as connection:
            connection.execute("DROP TRIGGER workflow_version_immutable")
            connection.execute(
                "UPDATE workflow_version SET workflow_json = ?, content_sha256 = ? WHERE id = ?",
                (
                    content.decode("ascii"),
                    hashlib.sha256(content).hexdigest(),
                    workflow_version["id"],
                ),
            )
    mappings = {
        "prompt": {"node_id": "34", "input_name": "prompt", "value_type": "string"},
        "seed": {"node_id": "7", "input_name": "seed", "value_type": "integer"},
        "output_prefix": {
            "node_id": "41",
            "input_name": "filename_prefix",
            "value_type": "string",
        },
    }
    profile_created = http.post(
        f"/api/workflows/{workflow_record['id']}/profiles",
        json={
            "name": "Profile",
            "workflow_version_id": workflow_version["id"],
            "mappings": mappings,
            "image_inputs": [],
            "parameters": [],
        },
    ).json()
    profile_record = profile_created["workflow_profile"]
    profile_version = profile_created["version"]
    if equivalent_profile_hash_mismatch:
        assert database_path is not None
        stored_profile = copy.deepcopy(profile_version["profile"])
        stored_profile["hash_marker"] = False
        content = canonical_json_bytes(stored_profile)
        with sqlite3.connect(database_path) as connection:
            connection.execute("DROP TRIGGER workflow_profile_version_immutable")
            connection.execute(
                "UPDATE workflow_profile_version SET profile_json = ?, content_sha256 = ? WHERE id = ?",
                (
                    content.decode("ascii"),
                    hashlib.sha256(content).hexdigest(),
                    profile_version["id"],
                ),
            )
        profile_version["profile"]["hash_marker"] = 0
    ordered_prompts = [prompts[1]["version"], prompts[0]["version"]]
    prompt_snapshots = [
        {
            "id": item["id"],
            "prompt_id": item["prompt_id"],
            "version_number": item["version_number"],
            "name": item["name_snapshot"],
            "text": item["text"],
        }
        for item in ordered_prompts
    ]
    if historical_prompt_texts is not None:
        for item, text in zip(prompt_snapshots, historical_prompt_texts, strict=True):
            item["text"] = text
    batch = {"id": "batch-id", "filesystem_key": "batch_key", "name": "Batch"}
    workflow_selection = {
        "workflow_id": workflow_record["id"],
        "workflow_version_id": workflow_version["id"],
        "workflow_name": workflow_record["name"],
        "workflow_version_number": workflow_version["version_number"],
        "workflow_profile_id": profile_record["id"],
        "workflow_profile_version_id": profile_version["id"],
        "workflow_profile_name": profile_record["name"],
        "workflow_profile_version_number": profile_version["version_number"],
        "workflow": workflow_version["workflow"],
        "workflow_profile": profile_version["profile"],
    }
    if omit_historical_logical_ids:
        for prompt in prompt_snapshots:
            prompt["prompt_id"] = None
        workflow_selection["workflow_id"] = None
        workflow_selection["workflow_profile_id"] = None
    request = {
        "project": {
            "id": project["id"],
            "filesystem_key": project["filesystem_key"],
            "name": project["name"],
        },
        "batch": batch,
        "prompt_versions": [
            {"id": item["id"], "name": item["name"], "text": item["text"]}
            for item in prompt_snapshots
        ],
        "variable_bindings": [],
        "image_bindings": [],
        "parameter_bindings": [],
        "linked_parameter_sets": [],
        "seeds": {"mode": "fixed", "values": [11]},
        "workflow": workflow_version["workflow"],
        "workflow_profile": profile_version["profile"],
        "batch_snapshot": {
            "format": "batchcraft.batch-snapshot",
            "format_version": 1,
            "project": {
                "id": project["id"],
                "filesystem_key": project["filesystem_key"],
                "name": project["name"],
            },
            "source_saved_batch": None,
            "batch": {**batch, "description": None},
            "prompt_versions": prompt_snapshots,
            "variable_bindings": [],
            "image_bindings": [],
            "parameter_bindings": [],
            "linked_parameter_sets": [],
            "seed_intent": {"mode": "fixed", "values": [11], "random_seed_count": None},
            "workflow_selection": workflow_selection,
        },
    }
    created = http.post("/api/runs", json=request)
    assert created.status_code == 201, created.text
    return str(created.json()["run_id"]), request


def test_batch_reconstruction_detaches_resources_against_empty_library(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, request = _create_linked_run(http)

    empty_settings = _settings(tmp_path, database_name="empty.sqlite3")
    with TestClient(create_app(empty_settings, client_factory=_client)) as http:
        response = http.get(f"/api/runs/{run_id}/batch-reconstruction")

    assert response.status_code == 200
    body = response.json()
    assert body["batch_snapshot"] == request["batch_snapshot"]
    resources = body["resources"]
    assert [item["status"] for item in resources["prompt_versions"]] == [
        "detached",
        "detached",
    ]
    assert resources["workflow_version"]["status"] == "detached"
    assert resources["workflow_profile_version"]["status"] == "detached"
    assert [item["historical_version_id"] for item in resources["prompt_versions"]] == [
        item["id"] for item in request["batch_snapshot"]["prompt_versions"]
    ]
    assert (
        resources["workflow_version"]["historical_version_id"]
        == request["batch_snapshot"]["workflow_selection"]["workflow_version_id"]
    )


def test_batch_reconstruction_links_exact_resources_and_preserves_prompt_order(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, request = _create_linked_run(http)
        response = http.get(f"/api/runs/{run_id}/batch-reconstruction")

    assert response.status_code == 200
    body = response.json()
    expected_prompts = request["batch_snapshot"]["prompt_versions"]
    resources = body["resources"]
    assert [item["linked_version_id"] for item in resources["prompt_versions"]] == [
        item["id"] for item in expected_prompts
    ]
    assert [item["position"] for item in resources["prompt_versions"]] == [0, 1]
    assert [item["status"] for item in resources["prompt_versions"]] == [
        "linked",
        "linked",
    ]
    assert resources["workflow_version"]["status"] == "linked"
    assert resources["workflow_profile_version"]["status"] == "linked"
    assert [item["linked_resource_id"] for item in resources["prompt_versions"]] == [
        item["prompt_id"] for item in expected_prompts
    ]
    assert (
        resources["workflow_version"]["linked_resource_id"]
        == request["batch_snapshot"]["workflow_selection"]["workflow_id"]
    )
    assert (
        resources["workflow_profile_version"]["linked_resource_id"]
        == request["batch_snapshot"]["workflow_selection"]["workflow_profile_id"]
    )


@pytest.mark.parametrize(
    ("profile_name", "expected_profile_status"),
    (("Profile", "conflict"), ("Conflicting profile", "conflict")),
)
def test_batch_reconstruction_reports_same_id_content_conflicts(
    tmp_path: Path,
    profile_name: str,
    expected_profile_status: str,
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, request = _create_linked_run(http)

    snapshot = request["batch_snapshot"]
    project = snapshot["project"]
    prompts = snapshot["prompt_versions"]
    selection = snapshot["workflow_selection"]
    changed_workflow = {
        **selection["workflow"],
        "extra": {"class_type": "Test", "inputs": {}},
    }
    conflict_settings = _settings(tmp_path, database_name="conflict.sqlite3")
    with TestClient(create_app(conflict_settings, client_factory=_client)) as http:
        ProjectStore(conflict_settings.database_path).create(
            project["name"],
            project["filesystem_key"],
            project_id=project["id"],
        )
        prompt_store = PromptStore(conflict_settings.database_path)
        for index, prompt in enumerate(prompts):
            prompt_store.create(
                project["id"],
                prompt["name"],
                "Conflict" if index == 0 else prompt["text"],
                prompt_id=prompt["prompt_id"],
                version_id=prompt["id"],
            )
        WorkflowStore(conflict_settings.database_path).create(
            project["id"],
            selection["workflow_name"],
            changed_workflow,
            workflow_id=selection["workflow_id"],
            version_id=selection["workflow_version_id"],
        )
        historical_profile = selection["workflow_profile"]
        WorkflowProfileStore(conflict_settings.database_path).create(
            selection["workflow_id"],
            profile_name,
            selection["workflow_version_id"],
            historical_profile["mappings"],
            historical_profile["image_inputs"],
            historical_profile["parameters"],
            profile_id=selection["workflow_profile_id"],
            version_id=selection["workflow_profile_version_id"],
        )
        response = http.get(f"/api/runs/{run_id}/batch-reconstruction")

    assert response.status_code == 200
    body = response.json()
    resources = body["resources"]
    assert resources["prompt_versions"][0]["status"] == "conflict"
    assert resources["prompt_versions"][1]["status"] == "linked"
    assert resources["workflow_version"]["status"] == "conflict"
    assert resources["workflow_profile_version"]["status"] == expected_profile_status


def test_batch_reconstruction_does_not_link_same_project_id_under_different_key(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, request = _create_linked_run(http)

    snapshot = request["batch_snapshot"]
    selection = snapshot["workflow_selection"]
    conflict_settings = _settings(tmp_path, database_name="different-key.sqlite3")
    with TestClient(create_app(conflict_settings, client_factory=_client)) as http:
        ProjectStore(conflict_settings.database_path).create(
            snapshot["project"]["name"],
            "different_project_key",
            project_id=snapshot["project"]["id"],
        )
        prompt_store = PromptStore(conflict_settings.database_path)
        for prompt in snapshot["prompt_versions"]:
            prompt_store.create(
                snapshot["project"]["id"],
                prompt["name"],
                prompt["text"],
                prompt_id=prompt["prompt_id"],
                version_id=prompt["id"],
            )
        WorkflowStore(conflict_settings.database_path).create(
            snapshot["project"]["id"],
            selection["workflow_name"],
            selection["workflow"],
            workflow_id=selection["workflow_id"],
            version_id=selection["workflow_version_id"],
        )
        WorkflowProfileStore(conflict_settings.database_path).create(
            selection["workflow_id"],
            selection["workflow_profile_name"],
            selection["workflow_version_id"],
            selection["workflow_profile"]["mappings"],
            selection["workflow_profile"]["image_inputs"],
            selection["workflow_profile"]["parameters"],
            profile_id=selection["workflow_profile_id"],
            version_id=selection["workflow_profile_version_id"],
        )

        response = http.get(f"/api/runs/{run_id}/batch-reconstruction")

    assert response.status_code == 200
    resources = response.json()["resources"]
    assert [item["status"] for item in resources["prompt_versions"]] == [
        "conflict",
        "conflict",
    ]
    assert resources["workflow_version"]["status"] == "conflict"
    assert resources["workflow_profile_version"]["status"] == "conflict"


def test_batch_reconstruction_recovers_linked_parents_when_snapshot_ids_are_null(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, request = _create_linked_run(http, omit_historical_logical_ids=True)
        response = http.get(f"/api/runs/{run_id}/batch-reconstruction")

    assert response.status_code == 200
    resources = response.json()["resources"]
    prompt_snapshots = request["batch_snapshot"]["prompt_versions"]
    assert all(item["prompt_id"] is None for item in prompt_snapshots)
    prompt_store = PromptStore(settings.database_path)
    assert [item["linked_resource_id"] for item in resources["prompt_versions"]] == [
        prompt_store.get_version(item["id"]).prompt_id for item in prompt_snapshots
    ]
    assert [item["historical_version_id"] for item in resources["prompt_versions"]] == [
        item["id"] for item in prompt_snapshots
    ]
    selection = request["batch_snapshot"]["workflow_selection"]
    assert selection["workflow_id"] is None
    assert selection["workflow_profile_id"] is None
    workflow_version = WorkflowStore(settings.database_path).get_version(
        selection["workflow_version_id"]
    )
    profile_version = WorkflowProfileStore(settings.database_path).get_version(
        selection["workflow_profile_version_id"]
    )
    assert resources["workflow_version"]["linked_resource_id"] == workflow_version.workflow_id
    assert (
        resources["workflow_profile_version"]["linked_resource_id"]
        == profile_version.workflow_profile_id
    )


@pytest.mark.parametrize(
    ("resource", "archive_version"),
    [
        ("prompt", False),
        ("prompt", True),
        ("workflow", False),
        ("workflow", True),
        ("profile", False),
        ("profile", True),
    ],
)
def test_batch_reconstruction_detaches_archived_resources_and_versions(
    tmp_path: Path,
    resource: str,
    archive_version: bool,
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, request = _create_linked_run(http)
        snapshot = request["batch_snapshot"]
        selection = snapshot["workflow_selection"]
        if resource == "prompt":
            target_id = snapshot["prompt_versions"][0]["id" if archive_version else "prompt_id"]
            endpoint = "prompt-versions" if archive_version else "prompts"
        elif resource == "workflow":
            target_id = selection["workflow_version_id" if archive_version else "workflow_id"]
            endpoint = "workflow-versions" if archive_version else "workflows"
        else:
            target_id = selection[
                "workflow_profile_version_id" if archive_version else "workflow_profile_id"
            ]
            endpoint = "workflow-profile-versions" if archive_version else "workflow-profiles"
        archived = http.post(f"/api/{endpoint}/{target_id}/archive")
        assert archived.status_code == 200, archived.text

        response = http.get(f"/api/runs/{run_id}/batch-reconstruction")

    assert response.status_code == 200
    resources = response.json()["resources"]
    if resource == "prompt":
        assert resources["prompt_versions"][0]["status"] == "detached"
    elif resource == "workflow":
        assert resources["workflow_version"]["status"] == "detached"
        assert resources["workflow_profile_version"]["status"] == "detached"
    else:
        assert resources["workflow_profile_version"]["status"] == "detached"


def test_batch_reconstruction_does_not_mutate_library_or_run_files(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, _request = _create_linked_run(http)
        run_path = next(settings.projects_root.glob("*/batches/*/*-*"))
        before_files = {
            path.relative_to(run_path): (
                hashlib.sha256(path.read_bytes()).hexdigest(),
                path.stat().st_mtime_ns,
            )
            for path in run_path.rglob("*")
            if path.is_file()
        }
        with sqlite3.connect(settings.database_path) as connection:
            before_library = tuple(connection.iterdump())

        response = http.get(f"/api/runs/{run_id}/batch-reconstruction")

        with sqlite3.connect(settings.database_path) as connection:
            after_library = tuple(connection.iterdump())
        after_files = {
            path.relative_to(run_path): (
                hashlib.sha256(path.read_bytes()).hexdigest(),
                path.stat().st_mtime_ns,
            )
            for path in run_path.rglob("*")
            if path.is_file()
        }

    assert response.status_code == 200
    assert after_library == before_library
    assert after_files == before_files


def test_clean_instance_reconstructs_previews_imports_and_creates_a_new_run(
    tmp_path: Path,
) -> None:
    source_settings = _settings(tmp_path)
    with TestClient(create_app(source_settings, client_factory=_client)) as source:
        run_id, original_request = _create_linked_run(source)
        original_plan = source.get(f"/api/runs/{run_id}").json()["plan"]

    original_run_path = next(source_settings.projects_root.glob("*/batches/*/*-*"))
    original_files = {
        path.relative_to(original_run_path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in original_run_path.rglob("*")
        if path.is_file()
    }
    target_settings = _settings(tmp_path, database_name="target.sqlite3")
    with TestClient(create_app(target_settings, client_factory=_client)) as target:
        imported = target.post("/api/projects/import", json={"filesystem_key": "project_key"})
        assert imported.status_code == 201, imported.text
        project_id = original_request["project"]["id"]
        assert [item["id"] for item in target.get("/api/projects").json()["projects"]] == [
            project_id
        ]
        assert target.get(f"/api/projects/{project_id}/prompts").json() == {"prompts": []}
        assert target.get(f"/api/projects/{project_id}/workflows").json() == {"workflows": []}

        reconstruction = target.get(f"/api/runs/{run_id}/batch-reconstruction")
        assert reconstruction.status_code == 200, reconstruction.text
        resources = reconstruction.json()["resources"]
        assert [item["status"] for item in resources["prompt_versions"]] == [
            "detached",
            "detached",
        ]
        assert resources["workflow_version"]["status"] == "detached"
        assert resources["workflow_profile_version"]["status"] == "detached"

        preview = target.post("/api/batches/preview", json=original_request)
        assert preview.status_code == 200, preview.text
        assert preview.json() == original_plan

        imported_prompts = [
            target.post(
                f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/{position}/import-copy",
                json={
                    "import_request_id": f"clean-prompt-{position}",
                    "name": f"Imported prompt {position + 1}",
                },
            ).json()
            for position in range(2)
        ]
        imported_workflow = target.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-version/import-copy",
            json={"import_request_id": "clean-workflow", "name": "Imported workflow"},
        )
        assert imported_workflow.status_code == 201, imported_workflow.text
        imported_profile = target.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy",
            json={
                "import_request_id": "clean-profile",
                "name": "Imported profile",
                "workflow_version_id": imported_workflow.json()["version"]["id"],
            },
        )
        assert imported_profile.status_code == 201, imported_profile.text

        new_request = copy.deepcopy(original_request)
        for position, imported_prompt in enumerate(imported_prompts):
            version = imported_prompt["version"]
            new_request["prompt_versions"][position] = {
                "id": version["id"],
                "name": version["name_snapshot"],
                "text": version["text"],
            }
            new_request["batch_snapshot"]["prompt_versions"][position] = {
                "id": version["id"],
                "prompt_id": version["prompt_id"],
                "version_number": version["version_number"],
                "name": version["name_snapshot"],
                "text": version["text"],
            }
        workflow = imported_workflow.json()
        profile = imported_profile.json()
        selection = new_request["batch_snapshot"]["workflow_selection"]
        selection.update(
            {
                "workflow_id": workflow["workflow"]["id"],
                "workflow_version_id": workflow["version"]["id"],
                "workflow_name": workflow["workflow"]["name"],
                "workflow_version_number": workflow["version"]["version_number"],
                "workflow_profile_id": profile["workflow_profile"]["id"],
                "workflow_profile_version_id": profile["version"]["id"],
                "workflow_profile_name": profile["workflow_profile"]["name"],
                "workflow_profile_version_number": profile["version"]["version_number"],
                "workflow": workflow["version"]["workflow"],
                "workflow_profile": profile["version"]["profile"],
            }
        )
        new_request["workflow"] = workflow["version"]["workflow"]
        new_request["workflow_profile"] = profile["version"]["profile"]
        created = target.post(
            "/api/runs",
            json={**new_request, "run_name": "Recovered copy"},
        )
        assert created.status_code == 201, created.text
        assert created.json()["run_id"] != run_id
        assert created.json()["run_number"] == 2

    assert {
        path.relative_to(original_run_path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in original_run_path.rglob("*")
        if path.is_file()
    } == original_files


def test_historical_resources_import_as_new_version_one_copies_from_run(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, request = _create_linked_run(http)

    imported_settings = _settings(tmp_path, database_name="imported.sqlite3")
    run_path = next(settings.projects_root.glob("*/batches/*/*-*"))
    before_files = {
        path.relative_to(run_path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in run_path.rglob("*")
        if path.is_file()
    }
    with TestClient(create_app(imported_settings, client_factory=_client)) as http:
        project_import = http.post("/api/projects/import", json={"filesystem_key": "project_key"})
        assert project_import.status_code == 201, project_import.text

        prompt_response = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json={
                "import_request_id": "copy-prompt",
                "name": "Imported second prompt",
                "description": "Prompt copy",
                "note": "Imported from Run",
            },
        )
        assert prompt_response.status_code == 201, prompt_response.text

        workflow_response = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-version/import-copy",
            json={
                "import_request_id": "copy-workflow",
                "name": "Imported workflow",
                "description": "Workflow copy",
                "note": "Imported from Run",
            },
        )
        assert workflow_response.status_code == 201, workflow_response.text
        workflow_version = workflow_response.json()["version"]

        profile_response = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy",
            json={
                "import_request_id": "copy-profile",
                "name": "Imported profile",
                "description": "Profile copy",
                "note": "Imported from Run",
                "workflow_version_id": workflow_version["id"],
            },
        )
        assert profile_response.status_code == 201, profile_response.text

        colliding_prompt = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json={"import_request_id": "colliding-prompt", "name": "Ignored prompt name"},
        )
        colliding_workflow = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-version/import-copy",
            json={"import_request_id": "colliding-workflow", "name": "Ignored workflow name"},
        )
        colliding_profile = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy",
            json={
                "import_request_id": "colliding-profile",
                "name": "Ignored profile name",
                "workflow_version_id": workflow_version["id"],
            },
        )
        numbered_prompt = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json={"import_request_id": "numbered-prompt", "name": "Ignored prompt name"},
        )
        for response in (
            colliding_prompt,
            colliding_workflow,
            colliding_profile,
            numbered_prompt,
        ):
            assert response.status_code == 201, response.text

    snapshot = request["batch_snapshot"]
    prompt = prompt_response.json()
    assert prompt["prompt"]["project_id"] == snapshot["project"]["id"]
    assert prompt["prompt"]["name"] == snapshot["prompt_versions"][0]["name"]
    assert prompt["prompt"]["description"] == "Prompt copy"
    assert prompt["version"]["version_number"] == 1
    assert prompt["version"]["text"] == snapshot["prompt_versions"][0]["text"]
    assert prompt["version"]["note"] == "Imported from Run"
    assert prompt["version"]["id"] != snapshot["prompt_versions"][0]["id"]
    assert prompt["version"]["prompt_id"] != snapshot["prompt_versions"][0]["prompt_id"]

    workflow = workflow_response.json()
    assert workflow["workflow"]["name"] == snapshot["workflow_selection"]["workflow_name"]
    assert workflow["workflow"]["description"] == "Workflow copy"
    assert workflow_version["version_number"] == 1
    assert workflow_version["workflow"] == snapshot["workflow_selection"]["workflow"]
    assert workflow_version["note"] == "Imported from Run"
    assert workflow_version["id"] != snapshot["workflow_selection"]["workflow_version_id"]
    assert workflow["workflow"]["id"] != snapshot["workflow_selection"]["workflow_id"]

    profile = profile_response.json()
    profile_version = profile["version"]
    frozen_profile = snapshot["workflow_selection"]["workflow_profile"]
    assert (
        profile["workflow_profile"]["name"]
        == snapshot["workflow_selection"]["workflow_profile_name"]
    )
    assert profile["workflow_profile"]["description"] == "Profile copy"
    assert profile_version["version_number"] == 1
    assert profile_version["workflow_version_id"] == workflow_version["id"]
    assert profile_version["note"] == "Imported from Run"
    assert profile_version["profile"]["mappings"] == frozen_profile["mappings"]
    assert profile_version["profile"]["image_inputs"] == frozen_profile["image_inputs"]
    assert profile_version["profile"]["parameters"] == frozen_profile["parameters"]
    assert profile_version["id"] != snapshot["workflow_selection"]["workflow_profile_version_id"]
    assert (
        profile["workflow_profile"]["id"] != snapshot["workflow_selection"]["workflow_profile_id"]
    )
    assert colliding_prompt.json()["prompt"]["name"] == "Second (imported)"
    assert colliding_workflow.json()["workflow"]["name"] == "Workflow (imported)"
    assert colliding_profile.json()["workflow_profile"]["name"] == "Profile (imported)"
    assert numbered_prompt.json()["prompt"]["name"] == "Second (imported 2)"

    after_files = {
        path.relative_to(run_path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in run_path.rglob("*")
        if path.is_file()
    }
    assert after_files == before_files


def test_historical_prompt_import_rejects_invalid_position(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, _request = _create_linked_run(http)
        response = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/2/import-copy",
            json={"import_request_id": "missing-prompt", "name": "Missing prompt"},
        )

    assert response.status_code == 422
    assert response.json() == {
        "error": {
            "code": "invalid_historical_resource_import",
            "message": "Historical PromptVersion position 2 is outside the available range 0..1",
        }
    }


def test_historical_prompt_import_rejects_empty_frozen_text(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, _request = _create_linked_run(http, historical_prompt_texts=("", "First prompt"))
        response = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json={"import_request_id": "empty-prompt", "name": "Empty prompt"},
        )

    assert response.status_code == 422
    assert response.json() == {
        "error": {
            "code": "invalid_historical_resource_import",
            "message": (
                "Historical PromptVersion at position 0 has empty text and cannot be imported as "
                "a mutable Prompt"
            ),
        }
    }


@pytest.mark.parametrize("mismatch", ["content", "project"])
def test_historical_profile_import_rejects_target_workflow_mismatch(
    tmp_path: Path, mismatch: str
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, request = _create_linked_run(http)
        historical_project_id = request["batch_snapshot"]["project"]["id"]
        if mismatch == "project":
            project = http.post(
                "/api/projects",
                json={"name": "Other Project", "filesystem_key": "other_project"},
            ).json()
            project_id = project["id"]
            workflow = request["batch_snapshot"]["workflow_selection"]["workflow"]
        else:
            project_id = historical_project_id
            workflow = {"1": {"class_type": "Different", "inputs": {}}}
        target = http.post(
            f"/api/projects/{project_id}/workflows",
            json={"name": f"Mismatch {mismatch}", "workflow": workflow},
        )
        assert target.status_code == 201, target.text

        response = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy",
            json={
                "import_request_id": f"mismatch-{mismatch}",
                "name": "Imported profile",
                "workflow_version_id": target.json()["version"]["id"],
            },
        )

    assert response.status_code == 422
    assert response.json() == {
        "error": {
            "code": "invalid_historical_resource_import",
            "message": (
                "Target WorkflowVersion must belong to the historical Run Project and exactly "
                "match its frozen Workflow"
            ),
        }
    }


@pytest.mark.parametrize("archive_version", [False, True])
def test_historical_profile_import_rejects_archived_workflow_targets(
    tmp_path: Path,
    archive_version: bool,
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, request = _create_linked_run(http)
        selection = request["batch_snapshot"]["workflow_selection"]
        endpoint = "workflow-versions" if archive_version else "workflows"
        target_id = selection["workflow_version_id" if archive_version else "workflow_id"]
        archived = http.post(f"/api/{endpoint}/{target_id}/archive")
        assert archived.status_code == 200, archived.text

        response = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy",
            json={
                "import_request_id": f"archived-{archive_version}",
                "name": "Imported profile",
                "workflow_version_id": selection["workflow_version_id"],
            },
        )

    assert response.status_code == 422
    assert response.json() == {
        "error": {
            "code": "invalid_historical_resource_import",
            "message": "Target Workflow and WorkflowVersion must both be active",
        }
    }


def test_historical_import_copy_replays_after_metadata_changes_and_restart(
    tmp_path: Path,
) -> None:
    source_settings = _settings(tmp_path)
    with TestClient(create_app(source_settings, client_factory=_client)) as http:
        run_id, _request = _create_linked_run(http)
    run_path = next(source_settings.projects_root.glob("*/batches/*/*-*"))
    before_files = {
        path.relative_to(run_path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in run_path.rglob("*")
        if path.is_file()
    }

    target_settings = _settings(tmp_path, database_name="replay.sqlite3")
    prompt_request = {
        "import_request_id": "prompt-replay",
        "name": "Imported prompt",
        "description": "Initial prompt description",
        "note": "Initial prompt note",
    }
    workflow_request = {
        "import_request_id": "workflow-replay",
        "name": "Imported workflow",
        "description": "Initial workflow description",
        "note": "Initial workflow note",
    }
    with TestClient(create_app(target_settings, client_factory=_client)) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        prompt = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json=prompt_request,
        )
        workflow = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-version/import-copy",
            json=workflow_request,
        )
        assert prompt.status_code == 201, prompt.text
        assert workflow.status_code == 201, workflow.text
        profile_request = {
            "import_request_id": "profile-replay",
            "name": "Imported profile",
            "description": "Initial profile description",
            "note": "Initial profile note",
            "workflow_version_id": workflow.json()["version"]["id"],
        }
        profile = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy",
            json=profile_request,
        )
        assert profile.status_code == 201, profile.text
        first_ids = {
            "prompt": (prompt.json()["prompt"]["id"], prompt.json()["version"]["id"]),
            "workflow": (workflow.json()["workflow"]["id"], workflow.json()["version"]["id"]),
            "profile": (
                profile.json()["workflow_profile"]["id"],
                profile.json()["version"]["id"],
            ),
        }
        assert all(UUID(value).version == 5 for pair in first_ids.values() for value in pair)
        assert (
            http.patch(
                f"/api/prompts/{first_ids['prompt'][0]}",
                json={"name": "Renamed prompt", "description": "Changed"},
            ).status_code
            == 200
        )
        assert (
            http.patch(
                f"/api/workflows/{first_ids['workflow'][0]}",
                json={"name": "Renamed workflow", "description": "Changed"},
            ).status_code
            == 200
        )
        assert (
            http.patch(
                f"/api/workflow-profiles/{first_ids['profile'][0]}",
                json={"name": "Renamed profile", "description": "Changed"},
            ).status_code
            == 200
        )

    with TestClient(create_app(target_settings, client_factory=_client)) as http:
        prompt_replay = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json={**prompt_request, "note": "Retry metadata is ignored"},
        )
        workflow_replay = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-version/import-copy",
            json={**workflow_request, "note": "Retry metadata is ignored"},
        )
        profile_replay = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy",
            json={**profile_request, "note": "Retry metadata is ignored"},
        )
        for response in (prompt_replay, workflow_replay, profile_replay):
            assert response.status_code == 201, response.text
        assert (
            prompt_replay.json()["prompt"]["id"],
            prompt_replay.json()["version"]["id"],
        ) == first_ids["prompt"]
        assert (
            workflow_replay.json()["workflow"]["id"],
            workflow_replay.json()["version"]["id"],
        ) == first_ids["workflow"]
        assert (
            profile_replay.json()["workflow_profile"]["id"],
            profile_replay.json()["version"]["id"],
        ) == first_ids["profile"]

        second_prompt = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json={**prompt_request, "import_request_id": "prompt-copy-2", "name": "Prompt two"},
        )
        second_workflow = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-version/import-copy",
            json={
                **workflow_request,
                "import_request_id": "workflow-copy-2",
                "name": "Workflow two",
            },
        )
        assert second_prompt.status_code == 201, second_prompt.text
        assert second_workflow.status_code == 201, second_workflow.text
        second_profile = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy",
            json={
                **profile_request,
                "import_request_id": "profile-copy-2",
                "name": "Profile two",
                "workflow_version_id": second_workflow.json()["version"]["id"],
            },
        )
        assert second_profile.status_code == 201, second_profile.text
        assert prompt.json()["prompt"]["name"] == "Second"
        assert workflow.json()["workflow"]["name"] == "Workflow"
        assert profile.json()["workflow_profile"]["name"] == "Profile"
        assert second_prompt.json()["prompt"]["name"] == "Second"
        assert second_workflow.json()["workflow"]["name"] == "Workflow"
        assert second_profile.json()["workflow_profile"]["name"] == "Profile"
        assert second_prompt.json()["prompt"]["id"] != first_ids["prompt"][0]
        assert second_prompt.json()["version"]["id"] != first_ids["prompt"][1]
        assert second_workflow.json()["workflow"]["id"] != first_ids["workflow"][0]
        assert second_workflow.json()["version"]["id"] != first_ids["workflow"][1]
        assert second_profile.json()["workflow_profile"]["id"] != first_ids["profile"][0]
        assert second_profile.json()["version"]["id"] != first_ids["profile"][1]

        third_prompt = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json={**prompt_request, "import_request_id": "prompt-copy-3"},
        )
        colliding_profile = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy",
            json={
                **profile_request,
                "import_request_id": "profile-copy-same-workflow",
                "workflow_version_id": workflow.json()["version"]["id"],
            },
        )
        assert third_prompt.status_code == 201, third_prompt.text
        assert colliding_profile.status_code == 201, colliding_profile.text
        assert third_prompt.json()["prompt"]["name"] == "Second (imported)"
        assert colliding_profile.json()["workflow_profile"]["name"] == "Profile"

    assert {
        path.relative_to(run_path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in run_path.rglob("*")
        if path.is_file()
    } == before_files


def test_historical_import_copy_rejects_incoherent_deterministic_id_collision(
    tmp_path: Path,
) -> None:
    source_settings = _settings(tmp_path)
    with TestClient(create_app(source_settings, client_factory=_client)) as http:
        run_id, _request = _create_linked_run(http)
    target_settings = _settings(tmp_path, database_name="collision.sqlite3")
    request = {"import_request_id": "collision", "name": "Imported prompt"}
    with TestClient(create_app(target_settings, client_factory=_client)) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        first = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json=request,
        )
        assert first.status_code == 201, first.text
        archived = http.post(f"/api/prompt-versions/{first.json()['version']['id']}/archive")
        assert archived.status_code == 200, archived.text
        replay = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/prompt-versions/0/import-copy",
            json=request,
        )

    assert replay.status_code == 409
    assert replay.json() == {
        "error": {
            "code": "historical_resource_import_conflict",
            "message": (
                "Historical Prompt import request IDs are occupied by incoherent library records"
            ),
        }
    }


@pytest.mark.parametrize("resource", ["workflow", "profile"])
def test_batch_reconstruction_uses_frozen_canonical_hashes_for_exact_classification(
    tmp_path: Path, resource: str
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, _request = _create_linked_run(
            http,
            database_path=settings.database_path,
            equivalent_workflow_hash_mismatch=resource == "workflow",
            equivalent_profile_hash_mismatch=resource == "profile",
        )
        response = http.get(f"/api/runs/{run_id}/batch-reconstruction")

    assert response.status_code == 200, response.text
    resources = response.json()["resources"]
    if resource == "workflow":
        assert resources["workflow_version"]["status"] == "conflict"
    else:
        assert resources["workflow_version"]["status"] == "linked"
        assert resources["workflow_profile_version"]["status"] == "conflict"


def test_historical_import_copy_requires_import_request_id(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        run_id, _request = _create_linked_run(http)
        response = http.post(
            f"/api/runs/{run_id}/batch-reconstruction/workflow-version/import-copy",
            json={"name": "Imported workflow"},
        )

    assert response.status_code == 422
