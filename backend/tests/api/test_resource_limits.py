import copy
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
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
from test_history_api import _add_result, _copy_fixture

from batchcraft.api import Settings, create_app
from batchcraft.api.schemas import BatchRequest
from batchcraft.application.service import BatchcraftService, RunCreationInput, _read_result
from batchcraft.db import SavedBatchStore
from batchcraft.domain import CompilationError, CompiledRunPlan, SeedInput
from batchcraft.files import AssetRecord


@pytest.mark.parametrize("endpoint", ["/api/batches/preview", "/api/runs"])
def test_small_cartesian_request_rejected_before_expansion_or_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, endpoint: str
) -> None:
    settings = _settings(tmp_path)
    _publish_project_owner(settings)
    request = _batch_request(())
    names = [f"axis_{index}" for index in range(30)]
    request["prompt_versions"] = [
        {"id": "prompt-v1", "name": "Huge", "text": " ".join("{{" + name + "}}" for name in names)}
    ]
    request["variable_bindings"] = [{"placeholder": name, "values": ["a", "b"]} for name in names]
    _sync_batch_snapshot(request)
    expansion = Mock(side_effect=AssertionError("must reject before Cartesian materialization"))
    monkeypatch.setattr("batchcraft.domain.compiler.product", expansion)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app) as http:
        response = http.post(endpoint, json=request)
    assert response.status_code == 422
    assert "maximum of 10000 Jobs" in response.text
    expansion.assert_not_called()
    assert not (settings.projects_root / "project_key" / "batches").exists()


def test_constructor_budget_boundary_random_preview_and_historical_readability(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    _publish_project_owner(settings)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    creation = BatchRequest.model_validate(_batch_request(())).to_creation_input()
    with TestClient(app):
        original = cast(BatchcraftService, app.state.service)
        seeds = Mock(side_effect=range(100))
        service = BatchcraftService(
            projects_root=settings.projects_root,
            comfyui_client=original.comfyui_client,
            task_registry=original.task_registry,
            cancellation_store=original.cancellation_store,
            execution_config=original.execution_config,
            max_jobs=4,
            random_seed_source=seeds,
        )
        plan, _ = service.preview_batch(creation)
        assert plan.job_count == 4
        run = service.create_run(creation)
        random_creation = replace(
            creation, definition=replace(creation.definition, seeds=SeedInput.fixed(0))
        )
        random_plan, _ = service.preview_random_batch(random_creation, 2)
        assert random_plan.job_count == 4
        assert len({job.seed for job in random_plan.jobs}) == 4
        seeds.reset_mock()
        expansion = Mock(side_effect=AssertionError("must reject before expansion"))
        with monkeypatch.context() as patch:
            patch.setattr("batchcraft.domain.compiler.product", expansion)
            with pytest.raises(CompilationError, match="maximum"):
                service.preview_random_batch(random_creation, 3)
            with pytest.raises(CompilationError, match="maximum"):
                service.preview_random_batch(random_creation, 5)
        seeds.assert_not_called()
        expansion.assert_not_called()

        service.max_jobs = 1
        with pytest.raises(CompilationError, match="maximum of 1 Jobs"):
            service.preview_batch(creation)
        with pytest.raises(CompilationError, match="maximum of 1 Jobs"):
            service.create_run(creation)
        assert service.get_historical_run(run.run_id).compiled_plan.job_count == 4
        assert service.get_batch_reconstruction(run.run_id).run_id == run.run_id
        assert list(run.path.parent.glob("[0-9]*-*/run.json")) == [run.path / "run.json"]


@pytest.mark.parametrize("budget", [0, -1, True, None, 1.5])
def test_constructor_rejects_invalid_budget(tmp_path: Path, budget: object) -> None:
    settings = _settings(tmp_path)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app):
        service = cast(BatchcraftService, app.state.service)
        with pytest.raises(ValueError, match="max_jobs must be a positive integer"):
            BatchcraftService(
                projects_root=settings.projects_root,
                comfyui_client=service.comfyui_client,
                task_registry=service.task_registry,
                cancellation_store=service.cancellation_store,
                execution_config=service.execution_config,
                max_jobs=cast(int, budget),
            )


def test_result_listing_verifies_without_retaining_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    result_path = _add_result(project)
    reader = Mock(wraps=_read_result)
    monkeypatch.setattr("batchcraft.application.service._read_result", reader)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app) as http:
        response = http.get("/api/runs/run-id/results")
    assert response.status_code == 200
    assert response.json()["results"][0]["integrity_status"] == "verified"
    reader.assert_called_once()
    assert reader.call_args.args[0] == result_path
    assert reader.call_args.kwargs == {"include_content": False}


def test_settings_default_and_environment_job_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BATCHCRAFT_MAX_JOBS", raising=False)
    assert Settings.from_env().max_jobs == 10_000
    monkeypatch.setenv("BATCHCRAFT_MAX_JOBS", "27")
    assert Settings.from_env().max_jobs == 27


@pytest.mark.parametrize("raw", ["0", "-1", "1.5", "true", "", "invalid"])
def test_settings_reject_invalid_environment_job_budget(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    monkeypatch.setenv("BATCHCRAFT_MAX_JOBS", raw)
    with pytest.raises(ValueError, match="BATCHCRAFT_MAX_JOBS must be a positive integer"):
        Settings.from_env()


@pytest.mark.parametrize("budget", [0, -1, True, None, 1.5])
def test_settings_and_saved_store_reject_invalid_job_budget(tmp_path: Path, budget: object) -> None:
    with pytest.raises(ValueError, match="max_jobs must be a positive integer"):
        replace(_settings(tmp_path), max_jobs=cast(int, budget))
    with pytest.raises(ValueError, match="max_jobs must be a positive integer"):
        SavedBatchStore(tmp_path / "unused.sqlite3", max_jobs=cast(int, budget))


@pytest.mark.parametrize("endpoint", ["/api/batches/preview", "/api/runs"])
def test_settings_budget_reaches_application_service(tmp_path: Path, endpoint: str) -> None:
    settings = replace(_settings(tmp_path), max_jobs=3)
    _publish_project_owner(settings)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app) as http:
        response = http.post(endpoint, json=_batch_request(()))
    assert response.status_code == 422
    assert "maximum of 3 Jobs" in response.text
    assert not (settings.projects_root / "project_key" / "batches").exists()


@pytest.mark.parametrize("operation", ["create", "update", "adopt"])
def test_oversized_saved_batch_rejection_has_no_database_or_filesystem_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    settings = replace(_settings(tmp_path), max_jobs=3)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app) as http:
        project = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project"}
        ).json()
        definition = _saved_batch_definition(http, project["id"], linked_parameters=True)
        created = http.post(
            f"/api/projects/{project['id']}/batches",
            json={"filesystem_key": "existing", **definition},
        )
        assert created.status_code == 201, created.text
        saved = created.json()
        oversized = copy.deepcopy(definition)
        oversized["linked_parameter_sets"] = []
        oversized["parameter_bindings"] = [
            {
                "parameter_key": key,
                "mode": "range",
                "include_base": False,
                "range": {"start": "0", "end": "9999", "step": "1"},
            }
            for key in ("width", "height")
        ]
        ownerless = settings.projects_root / "project" / "batches" / "ownerless"
        ownerless.mkdir()
        with sqlite3.connect(settings.database_path) as connection:
            database_before = tuple(connection.iterdump())
        files_before = {
            path.relative_to(settings.projects_root): path.read_bytes()
            for path in settings.projects_root.rglob("*")
            if path.is_file()
        }
        directories_before = set(settings.projects_root.rglob("*"))
        expansion = Mock(side_effect=AssertionError("must reject before Cartesian materialization"))
        with monkeypatch.context() as patch:
            patch.setattr("batchcraft.domain.compiler.product", expansion)
            if operation == "update":
                response = http.patch(
                    f"/api/batches/{saved['id']}",
                    json={"expected_revision": saved["revision"], **oversized},
                )
            else:
                endpoint = f"/api/projects/{project['id']}/batches"
                if operation == "adopt":
                    endpoint += "/adopt"
                response = http.post(
                    endpoint,
                    json={
                        "filesystem_key": "ownerless" if operation == "adopt" else "oversized",
                        **({"batch_id": "adopted"} if operation == "adopt" else {}),
                        **oversized,
                    },
                )
        assert response.status_code == 422, response.text
        assert "maximum of 3 Jobs" in response.text
        expansion.assert_not_called()
        with sqlite3.connect(settings.database_path) as connection:
            assert tuple(connection.iterdump()) == database_before
        assert set(settings.projects_root.rglob("*")) == directories_before
        assert all(
            (settings.projects_root / path).read_bytes() == content
            for path, content in files_before.items()
        )
        assert http.get(f"/api/batches/{saved['id']}").json() == saved


@pytest.mark.parametrize("linked", [False, True])
def test_saved_batch_reads_survive_lower_budget_after_restart(tmp_path: Path, linked: bool) -> None:
    settings = replace(_settings(tmp_path), max_jobs=2 if linked else 4)
    with TestClient(create_app(settings, client_factory=lambda _: FakeComfyUIClient())) as http:
        project = http.post(
            "/api/projects", json={"name": "Project", "filesystem_key": "project"}
        ).json()
        definition = _saved_batch_definition(http, project["id"], linked_parameters=True)
        if not linked:
            definition["linked_parameter_sets"] = []
            definition["parameter_bindings"] = [
                {"parameter_key": key, "mode": "values", "values": [512, 1024]}
                for key in ("width", "height")
            ]
        response = http.post(
            f"/api/projects/{project['id']}/batches",
            json={"filesystem_key": "saved", **definition},
        )
        assert response.status_code == 201, response.text
        saved = response.json()
    with TestClient(
        create_app(replace(settings, max_jobs=1), client_factory=lambda _: FakeComfyUIClient())
    ) as http:
        response = http.get(f"/api/batches/{saved['id']}")
        assert response.status_code == 200, response.text
        assert response.json() == saved
        listed = http.get(f"/api/projects/{project['id']}/batches")
        assert listed.status_code == 200
        assert len(listed.json()["batches"]) == 1


def test_preview_worker_does_not_block_health_requests(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    _publish_project_owner(settings)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    entered = threading.Event()
    release = threading.Event()
    with TestClient(app) as http, ThreadPoolExecutor(max_workers=2) as pool:
        service = cast(BatchcraftService, app.state.service)
        original = service.preview_batch

        def blocked_preview(
            creation: RunCreationInput,
        ) -> tuple[CompiledRunPlan, dict[str, AssetRecord]]:
            entered.set()
            assert release.wait(timeout=5)
            return original(creation)

        monkeypatch.setattr(service, "preview_batch", blocked_preview)
        preview = pool.submit(http.post, "/api/batches/preview", json=_batch_request(()))
        try:
            assert entered.wait(timeout=5)
            health = pool.submit(http.get, "/api/health")
            assert health.result(timeout=2).status_code == 200
        finally:
            release.set()
        assert preview.result(timeout=5).status_code == 200
