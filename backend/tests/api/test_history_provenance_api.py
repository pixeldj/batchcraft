import json
from contextlib import closing
from pathlib import Path
from typing import Any, cast

import pytest
from api_client import LoopbackTestClient as TestClient
from test_history_api import _add_result, _client, _copy_fixture, _settings

from batchcraft.api import create_app
from batchcraft.application.service import BatchcraftService
from batchcraft.db import open_connection
from batchcraft.db.history import HistoricalProjectionError
from batchcraft.files import RunFilesystemStore


def test_provenance_api_reindex_and_choices(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    _add_result(project)
    before = {p: p.read_bytes() for p in project.rglob("*") if p.is_file()}
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        service = cast(BatchcraftService, app.state.service)

        def forbidden(*args: object, **kwargs: object) -> None:
            raise AssertionError("No filesystem reads on choices or filters")

        with monkeypatch.context() as scoped:
            scoped.setattr(service.history_scanner, "scan", forbidden)
            scoped.setattr(service, "get_run", forbidden)
            for kind in (
                "parameter",
                "prompt",
                "prompt_version",
                "workflow_version",
                "profile_version",
                "saved_batch",
                "batch",
                "image_slot",
                "asset",
            ):
                response = http.get(
                    "/api/projects/project-id/history/choices", params={"kind": kind}
                )
                assert response.status_code == 200, response.text
                assert response.json()["generation"]
                for item in response.json()["items"]:
                    assert len(item["label"]) <= 256
                    assert len(item["detail"]) <= 256
            assert (
                http.get(
                    "/api/projects/project-id/history/runs",
                    params={"filters": json.dumps({"seed": 17})},
                ).status_code
                == 200
            )
        for params in (
            {"kind": "bad"},
            {"kind": "asset", "limit": 51},
            {"kind": "asset", "q": "x" * 201},
        ):
            assert (
                http.get("/api/projects/project-id/history/choices", params=params).status_code
                == 422
            )
        invalid = http.get(
            "/api/projects/project-id/history/results",
            params={"filters": '{"seed":"secret-value"}'},
        )
        assert invalid.status_code == 422 and "secret-value" not in invalid.text
        assert (
            http.get("/api/projects/foreign/history/choices", params={"kind": "asset"}).status_code
            == 404
        )
        with closing(open_connection(service.history_store.database_path)) as connection:
            connection.execute("DELETE FROM historical_provenance_state")
            connection.commit()
        assert http.get("/api/projects/project-id/history/runs").json()["items"]
        unavailable = http.get("/api/projects/project-id/history/choices", params={"kind": "asset"})
        assert unavailable.status_code == 409 and "history_reindex_required" in unavailable.text
        assert http.post("/api/projects/project-id/reindex").status_code == 200
        assert (
            http.get(
                "/api/projects/project-id/history/choices", params={"kind": "asset"}
            ).status_code
            == 200
        )
        tables = (
            "historical_projection_state",
            "historical_provenance_state",
            "historical_parameter_value",
            "historical_prompt_snapshot",
            "historical_run_provenance",
        )
        with closing(open_connection(service.history_store.database_path)) as connection:
            prior = {
                table: connection.execute(f"SELECT * FROM {table}").fetchall() for table in tables
            }
        original_insert = service.history_store._insert_projection

        def fail_after_insert(*args: Any, **kwargs: Any) -> None:
            original_insert(*args, **kwargs)
            raise HistoricalProjectionError("Simulated failure after enrichment")

        with monkeypatch.context() as scoped:
            scoped.setattr(service.history_store, "_insert_projection", fail_after_insert)
            assert http.post("/api/projects/project-id/reindex").status_code == 422
        with closing(open_connection(service.history_store.database_path)) as connection:
            assert prior == {
                table: connection.execute(f"SELECT * FROM {table}").fetchall() for table in tables
            }
    assert all(path.read_bytes() == content for path, content in before.items())


def test_valid_large_snapshot_revisions_reindex_without_libraries(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    _add_result(project)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        store = RunFilesystemStore(settings.projects_root)
        healthy = store.load_run(project / "batches" / "batch_key" / "001-run")
        snapshot = json.loads(json.dumps(healthy.batch_snapshot))
        revision = 2**63
        snapshot["source_saved_batch"] = {"id": "saved", "revision": revision}
        snapshot["prompt_versions"][0].update(prompt_id="logical", version_number=revision)
        snapshot["workflow_selection"].update(
            workflow_version_id="workflow-version",
            workflow_name="Landscape",
            workflow_version_number=revision,
            workflow_profile_version_id="profile-version",
            workflow_profile_name="Profile",
            workflow_profile_version_number=revision,
        )
        large = store.create_run(
            project=healthy.project,
            batch=healthy.batch,
            batch_snapshot=snapshot,
            plan=healthy.compiled_plan,
            workflow=healthy.workflow,
            workflow_profile=healthy.workflow_profile,
            image_assets={
                image.asset.asset_id: image.asset
                for job in healthy.jobs
                for image in job.image_inputs
                if image.asset is not None
            },
        )
        assert store.load_run(large.path).batch_snapshot == snapshot
        before = {p: p.read_bytes() for p in project.rglob("*") if p.is_file()}
        response = http.post("/api/projects/project-id/reindex")
        assert response.status_code == 200, response.text
        runs = http.get("/api/projects/project-id/history/runs").json()["items"]
        assert {item["run"]["run_id"] for item in runs} == {healthy.run_id, large.run_id}
        service = cast(BatchcraftService, app.state.service)
        with closing(open_connection(service.history_store.database_path)) as connection:
            assert (
                connection.execute(
                    "SELECT workflow_version_number, profile_version_number, saved_batch_revision FROM historical_run_provenance WHERE run_id = ?",
                    (large.run_id,),
                ).fetchone()
                == (str(revision),) * 3
            )
            assert connection.execute(
                "SELECT version_number FROM historical_prompt_snapshot WHERE run_id = ?",
                (large.run_id,),
            ).fetchone() == (str(revision),)
            for table in (
                "prompt",
                "prompt_version",
                "workflow",
                "workflow_version",
                "workflow_profile",
                "workflow_profile_version",
                "batch",
            ):
                assert connection.execute(f"SELECT count(*) FROM {table}").fetchone() == (0,)
        for kind, label in (
            ("workflow_version", "Landscape"),
            ("profile_version", "Profile"),
            ("prompt_version", "Portrait prompt"),
        ):
            choice = http.get(
                "/api/projects/project-id/history/choices",
                params={"kind": kind, "q": f"v{revision}"},
            )
            assert choice.status_code == 200, choice.text
            assert choice.json()["items"][0]["label"] == f"{label} v{revision}"
        saved = http.get("/api/projects/project-id/history/choices", params={"kind": "saved_batch"})
        assert saved.json()["items"][0]["label"] == "Prompt matrix"
        assert all(path.read_bytes() == content for path, content in before.items())
