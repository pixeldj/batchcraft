import base64
import copy
import json
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from api_client import LoopbackTestClient as TestClient
from api_support import _client
from api_support import _history_settings as _settings

from batchcraft.api import create_app
from batchcraft.db import WorkflowStore, open_connection


def _setup(http: TestClient) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    project = http.post("/api/projects", json={"name": "A", "filesystem_key": "a"}).json()
    workflow = http.post(
        f"/api/projects/{project['id']}/workflows",
        json={
            "name": "Reusable",
            "workflow": {
                "1": {
                    "class_type": "Example",
                    "inputs": {
                        "prompt": "base",
                        "seed": 1,
                        "prefix": "base",
                        "image": "base.png",
                        "steps": 10,
                        "enabled": False,
                        "text": "",
                        "cfg": 1.5,
                    },
                }
            },
        },
    ).json()
    profile = http.post(
        f"/api/workflows/{workflow['workflow']['id']}/profiles",
        json={
            "name": "Mappings",
            "workflow_version_id": workflow["version"]["id"],
            "mappings": {
                key: {"node_id": "1", "input_name": field, "value_type": kind}
                for key, field, kind in (
                    ("prompt", "prompt", "string"),
                    ("seed", "seed", "integer"),
                    ("output_prefix", "prefix", "string"),
                )
            },
            "image_inputs": [
                {"key": "ref", "label": "Reference", "node_id": "1", "input_name": "image"}
            ],
            "parameters": [
                {"key": key, "label": key, "node_id": "1", "input_name": key, "value_type": kind}
                for key, kind in (
                    ("text", "string"),
                    ("enabled", "boolean"),
                    ("steps", "integer"),
                    ("cfg", "float"),
                )
            ],
        },
    ).json()
    assert "version" in profile, profile
    return project, workflow, profile


def test_global_catalog_to_project_saved_batch_preview_and_run(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        assert http.get("/api/library/workflows").json() == {"items": [], "next_cursor": None}
        assert http.get("/api/projects").json() == {"projects": []}
        project_a, workflow, profile = _setup(http)
        request = {
            "request_id": "import",
            "project_id": project_a["id"],
            "workflow_version_id": workflow["version"]["id"],
            "profiles": [{"version_id": profile["version"]["id"]}],
        }
        response = http.post("/api/library/workflows/import-project", json=request)
        assert response.status_code == 200, response.text
        imported = response.json()
        global_version = imported["workflow"]["version"]
        assert "project_id" not in global_version
        catalog = http.get("/api/library/workflows").json()
        assert catalog["items"][0]["latest_version_id"] == global_version["id"]
        assert "workflow" not in catalog["items"][0]
        assert (
            http.get(f"/api/library/workflow-versions/{global_version['id']}").json()
            == global_version
        )
        profiles = http.get(
            f"/api/library/workflow-versions/{global_version['id']}/profiles"
        ).json()
        assert "profile" not in profiles["items"][0]
        pv = imported["profiles"][0]["version"]
        assert http.get(f"/api/library/workflow-profile-versions/{pv['id']}").json() == pv
        WorkflowStore(settings.database_path).update_metadata(
            workflow["workflow"]["id"], name="Changed"
        )
        assert http.post("/api/library/workflows/import-project", json=request).json() == imported
        mismatch = http.post(
            "/api/library/workflows/import-project", json={**request, "name": "Other"}
        )
        assert mismatch.status_code == 409
        project_b = http.post("/api/projects", json={"name": "B", "filesystem_key": "b"}).json()
        use = {
            "request_id": "use",
            "project_id": project_b["id"],
            "workflow_version_id": global_version["id"],
            "profiles": [{"version_id": pv["id"], "name": "Reviewed Profile"}],
            "name": "Reviewed Workflow",
        }
        response = http.post("/api/library/workflows/use-in-project", json=use)
        assert response.status_code == 200, response.text
        copied = response.json()
        w = copied["workflow"]["version"]
        p = copied["profiles"][0]["version"]
        for key in ("mappings", "image_inputs", "parameters"):
            assert p["profile"][key] == profile["version"]["profile"][key]
        prompt = http.post(
            f"/api/projects/{project_b['id']}/prompts", json={"name": "Prompt", "text": "test"}
        ).json()["version"]
        parameters = [
            {"parameter_key": key, "mode": "values", "values": [None, value]}
            for key, value in (("text", ""), ("enabled", False), ("steps", 0), ("cfg", 0.0))
        ]
        images = [{"slot_key": "ref", "values": [None]}]
        definition = {
            "name": "Batch",
            "description": None,
            "prompt_selections": [
                {
                    "prompt_version_id": prompt["id"],
                    "name_snapshot": prompt["name_snapshot"],
                    "text": prompt["text"],
                }
            ],
            "variable_bindings": [],
            "image_bindings": images,
            "parameter_bindings": parameters,
            "linked_parameter_sets": [],
            "seed_intent": {"mode": "fixed", "values": [1], "random_seed_count": None},
            "selected_workflow_version": {k: w[k] for k in ("id", "workflow", "content_sha256")},
            "selected_workflow_profile_id": p["workflow_profile_id"],
            "selected_workflow_profile_version": {
                k: p[k]
                for k in (
                    "id",
                    "workflow_profile_id",
                    "workflow_version_id",
                    "profile",
                    "content_sha256",
                )
            },
        }
        saved_response = http.post(
            f"/api/projects/{project_b['id']}/batches",
            json={"filesystem_key": "batch", **definition},
        )
        assert saved_response.status_code == 201, saved_response.text
        saved = http.get(f"/api/batches/{saved_response.json()['id']}").json()
        assert saved["selected_workflow_version"]["id"] == w["id"] != global_version["id"]
        invalid = copy.deepcopy(definition)
        invalid["selected_workflow_version"] = {
            k: global_version[k] for k in ("id", "workflow", "content_sha256")
        }
        assert http.post(
            f"/api/projects/{project_b['id']}/batches",
            json={"filesystem_key": "invalid", **invalid},
        ).status_code in (400, 422)
        project = {k: project_b[k] for k in ("id", "name", "filesystem_key")}
        batch = {k: saved[k] for k in ("id", "name", "filesystem_key")}
        prompts = [{"id": prompt["id"], "name": prompt["name_snapshot"], "text": prompt["text"]}]
        preview_request = {
            "project": project,
            "batch": batch,
            "prompt_versions": prompts,
            "variable_bindings": [],
            "image_bindings": images,
            "parameter_bindings": parameters,
            "linked_parameter_sets": [],
            "seeds": {"mode": "fixed", "values": [1]},
            "workflow": w["workflow"],
            "workflow_profile": p["profile"],
            "batch_snapshot": {
                "format": "batchcraft.batch-snapshot",
                "format_version": 1,
                "project": project,
                "batch": {**batch, "description": None},
                "source_saved_batch": {"id": saved["id"], "revision": saved["revision"]},
                "prompt_versions": [
                    {
                        **prompts[0],
                        "prompt_id": prompt["prompt_id"],
                        "version_number": prompt["version_number"],
                    }
                ],
                "variable_bindings": [],
                "image_bindings": images,
                "parameter_bindings": parameters,
                "linked_parameter_sets": [],
                "seed_intent": definition["seed_intent"],
                "workflow_selection": {
                    "workflow_id": w["workflow_id"],
                    "workflow_version_id": w["id"],
                    "workflow_name": w["name_snapshot"],
                    "workflow_version_number": 1,
                    "workflow_profile_id": p["workflow_profile_id"],
                    "workflow_profile_version_id": p["id"],
                    "workflow_profile_name": p["name_snapshot"],
                    "workflow_profile_version_number": 1,
                    "workflow": w["workflow"],
                    "workflow_profile": p["profile"],
                },
            },
        }
        preview = http.post("/api/batches/preview", json=preview_request)
        assert preview.status_code == 200, preview.text
        assert preview.json()["job_count"] == 16
        run = http.post("/api/runs", json=preview_request)
        assert run.status_code == 201, run.text
    with TestClient(create_app(settings, client_factory=_client)) as http:
        assert http.post("/api/library/workflows/use-in-project", json=use).json() == copied
        assert http.get(f"/api/batches/{saved['id']}").json() == saved


@pytest.mark.parametrize("query", ["q=" + "a" * 201, "limit=51", "limit=0", "cursor=bad"])
def test_catalog_bounds(tmp_path: Path, query: str) -> None:
    with TestClient(create_app(_settings(tmp_path), client_factory=_client)) as http:
        assert http.get("/api/library/workflows?" + query).status_code in (400, 422)


@pytest.mark.parametrize("profile_list", [False, True])
@pytest.mark.parametrize("after", [["\ud800", ""], ["", "\udfff"]])
def test_list_cursor_rejects_surrogates_without_state_change(
    tmp_path: Path, profile_list: bool, after: list[str]
) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        version_id = None
        url = "/api/library/workflows"
        if profile_list:
            project, workflow, profile = _setup(http)
            imported = http.post(
                "/api/library/workflows/import-project",
                json={
                    "request_id": "import",
                    "project_id": project["id"],
                    "workflow_version_id": workflow["version"]["id"],
                    "profiles": [{"version_id": profile["version"]["id"]}],
                },
            )
            assert imported.status_code == 200, imported.text
            version_id = imported.json()["workflow"]["version"]["id"]
            url = f"/api/library/workflow-versions/{version_id}/profiles"
        token = base64.urlsafe_b64encode(
            json.dumps({"binding": ["", 25, version_id], "after": after}).encode("ascii")
        ).decode("ascii")
        assert len(token) <= 2048
        if not profile_list and after[0]:
            assert (
                token == "eyJiaW5kaW5nIjogWyIiLCAyNSwgbnVsbF0sICJhZnRlciI6IFsiXHVkODAwIiwgIiJdfQ=="
            )
        with closing(open_connection(settings.database_path)) as connection:
            before = list(connection.iterdump())
        response = http.get(url, params={"cursor": token})
        assert response.status_code == 422, response.text
        with closing(open_connection(settings.database_path)) as connection:
            assert list(connection.iterdump()) == before


def test_copy_request_validation_and_global_body_limit(tmp_path: Path) -> None:
    settings = replace(_settings(tmp_path), max_request_bytes=4096)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        for endpoint in ("import-project", "use-in-project"):
            url = f"/api/library/workflows/{endpoint}"
            response = http.post(
                url,
                json={
                    "request_id": "id",
                    "project_id": "missing",
                    "workflow_version_id": "missing",
                    "workflow": {},
                },
            )
            assert response.status_code == 422
            response = http.post(
                url,
                json={
                    "request_id": "id",
                    "project_id": "missing",
                    "workflow_version_id": "missing",
                    "profiles": [{"version_id": str(i)} for i in range(51)],
                },
            )
            assert response.status_code == 422
            response = http.post(
                url,
                content=b" " * (settings.max_request_bytes + 1),
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 413
