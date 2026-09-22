"""Fresh Batch request builders and Project/Run setup for API tests."""

import copy
from pathlib import Path
from typing import cast

from api_client import LoopbackTestClient as TestClient

from batchcraft.api import Settings
from batchcraft.files import ProjectAssetStore, ProjectIdentity, ProjectOwnerStore


def _publish_project_owner(settings: Settings) -> None:
    ProjectOwnerStore(settings.projects_root).publish(
        ProjectIdentity(id="project-id", filesystem_key="project_key", name="Project")
    )


def _import_asset(settings: Settings, tmp_path: Path, asset_id: str = "asset-1") -> str:
    _publish_project_owner(settings)
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
            "format": "batchcraft.batch-snapshot",
            "format_version": 1,
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
