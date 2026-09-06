import hashlib
from dataclasses import replace
from pathlib import Path
from typing import cast
from unittest.mock import Mock

import pytest
from api_client import LoopbackTestClient as TestClient
from test_api import (
    FakeComfyUIClient,
    _batch_request,
    _publish_project_owner,
    _saved_batch_definition,
    _settings,
    _sync_batch_snapshot,
)

from batchcraft.api import create_app
from batchcraft.api.schemas import BatchRequest, RunCreateRequest
from batchcraft.application.service import BatchcraftService
from batchcraft.domain import CompilationError, SeedInput


@pytest.mark.parametrize("cause", ["parameter_product", "other_axes", "random", "text"])
def test_request_preflight_rejects_before_materializing_any_range(
    monkeypatch: pytest.MonkeyPatch,
    cause: str,
) -> None:
    request = _batch_request(())
    profile = request["workflow_profile"]
    workflow = request["workflow"]
    assert isinstance(profile, dict) and isinstance(workflow, dict)
    keys = ("width", "height") if cause == "parameter_product" else ("width",)
    profile["parameters"] = [
        {"key": key, "label": key, "node_id": "7", "input_name": key, "value_type": "integer"}
        for key in keys
    ]
    for key in keys:
        workflow["7"]["inputs"][key] = 1
    request["parameter_bindings"] = [
        {
            "parameter_key": key,
            "mode": "range",
            "include_base": False,
            "range": {
                "start": "0",
                "end": "9999" if cause == "parameter_product" else "3",
                "step": "1",
            },
        }
        for key in keys
    ]
    if cause == "random":
        request["seeds"] = {"mode": "random", "random_seed_count": 3, "values": []}
        snapshot = request["batch_snapshot"]
        assert isinstance(snapshot, dict)
        snapshot["seed_intent"] = {"mode": "random", "random_seed_count": 3, "values": []}
    _sync_batch_snapshot(request)
    allocation = Mock(side_effect=AssertionError("no Range values during schema/count preflight"))
    monkeypatch.setattr("batchcraft.domain.parameter_intents._materialize_range", allocation)
    model = BatchRequest.model_validate(request)
    with pytest.raises(CompilationError, match="maximum"):
        model.to_creation_input(
            seed_override=SeedInput.fixed(0) if cause == "random" else None,
            max_jobs=10000 if cause in ("parameter_product", "text") else 10,
            max_resolved_text_bytes=1 if cause == "text" else None,
        )
    if cause != "random":
        with pytest.raises(CompilationError, match="maximum"):
            RunCreateRequest.model_validate(request).to_creation_input(
                max_jobs=10000 if cause == "parameter_product" else 10,
            )
    allocation.assert_not_called()


@pytest.mark.parametrize("random", [False, True])
def test_service_text_limits_precede_expansion_rng_and_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    random: bool,
) -> None:
    settings = _settings(tmp_path)
    _publish_project_owner(settings)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    creation = BatchRequest.model_validate(_batch_request(())).to_creation_input()
    with TestClient(app):
        original = cast(BatchcraftService, app.state.service)
        rng = Mock(side_effect=AssertionError("no random assignments for rejected text"))
        service = BatchcraftService(
            projects_root=settings.projects_root,
            comfyui_client=original.comfyui_client,
            task_registry=original.task_registry,
            cancellation_store=original.cancellation_store,
            execution_config=original.execution_config,
            random_seed_source=rng,
            max_resolved_text_bytes=100,
        )
        allocation = Mock(side_effect=AssertionError("no Jobs for rejected text"))
        monkeypatch.setattr("batchcraft.domain.compiler.product", allocation)
        with pytest.raises(CompilationError, match="resolved text"):
            if random:
                service.preview_random_batch(
                    replace(
                        creation, definition=replace(creation.definition, seeds=SeedInput.fixed(0))
                    ),
                    4,
                )
            else:
                service.preview_batch(
                    replace(
                        creation,
                        definition=replace(
                            creation.definition, seeds=SeedInput.explicit((1, 2, 3, 4))
                        ),
                    )
                )
        allocation.assert_not_called()
        rng.assert_not_called()
    assert not (settings.projects_root / "project_key" / "batches").exists()


def test_valid_historical_run_above_default_prompt_budget_remains_readable_without_reresolution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    _publish_project_owner(settings)
    request = _batch_request(())
    request["prompt_versions"] = [{"id": "prompt-v1", "name": "Large", "text": "{{animal}}" * 1025}]
    request["variable_bindings"] = [{"placeholder": "animal", "values": ["x" * 1024]}]
    _sync_batch_snapshot(request)
    creation = BatchRequest.model_validate(request).to_creation_input()
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app):
        service = cast(BatchcraftService, app.state.service)
        service.max_prompt_bytes = 2 * 1024 * 1024
        published = service.create_run(creation)
        before = {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in published.path.iterdir()
            if path.is_file()
        }
        service.max_prompt_bytes = 1024 * 1024
        service.max_resolved_text_bytes = 1
        with pytest.raises(CompilationError, match="resolved prompt"):
            service.preview_batch(creation)
        allocation = Mock(
            side_effect=AssertionError("historical reads must not resolve another string")
        )
        monkeypatch.setattr("batchcraft.domain.compiler._resolve_prompt", allocation)
        assert service.get_historical_run(published.run_id).compiled_plan == published.compiled_plan
        assert service.get_batch_reconstruction(published.run_id).run_id == published.run_id
        allocation.assert_not_called()
        assert before == {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in published.path.iterdir()
            if path.is_file()
        }


def test_persisted_saved_batch_large_cartesian_reads_without_job_construction_after_lowering_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = replace(_settings(tmp_path), max_jobs=100_000_000)
    with TestClient(create_app(settings, client_factory=lambda _: FakeComfyUIClient())) as http:
        project = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project"}
        ).json()
        definition = _saved_batch_definition(http, project["id"], linked_parameters=True)
        definition["linked_parameter_sets"] = []
        definition["parameter_bindings"] = [
            {
                "parameter_key": key,
                "mode": "range",
                "include_base": False,
                "range": {"start": "0", "end": "9999", "step": "1"},
            }
            for key in ("width", "height")
        ]
        allocation = Mock(side_effect=AssertionError("Saved Batch validation must not expand Jobs"))
        monkeypatch.setattr("batchcraft.domain.compiler.product", allocation)
        response = http.post(
            f"/api/projects/{project['id']}/batches", json={"filesystem_key": "saved", **definition}
        )
        assert response.status_code == 201, response.text
        saved = response.json()
    with TestClient(
        create_app(replace(settings, max_jobs=1), client_factory=lambda _: FakeComfyUIClient())
    ) as http:
        assert http.get(f"/api/batches/{saved['id']}").json() == saved
        assert http.get(f"/api/projects/{project['id']}/batches").status_code == 200
    allocation.assert_not_called()
