import hashlib
import json
import shutil
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient

from batchcraft.api import Settings, create_app
from batchcraft.application import ApplicationComfyUIClient

FIXTURE = Path(__file__).parent.parent / "fixtures" / "v1_project" / "project_key"


class UnusedClient:
    async def aclose(self) -> None:
        return None


def _client(_settings: Settings) -> ApplicationComfyUIClient:
    return cast(ApplicationComfyUIClient, UnusedClient())


def _settings(tmp_path: Path) -> Settings:
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
        database_path=tmp_path / "data" / "batchcraft.sqlite3",
    )


def _copy_fixture(settings: Settings) -> Path:
    settings.projects_root.mkdir()
    project = settings.projects_root / "project_key"
    shutil.copytree(FIXTURE, project)
    # Git does not preserve the fixture's empty outputs directory.
    (project / "batches" / "batch_key" / "001-run" / "outputs").mkdir(exist_ok=True)
    return project


def _add_result(project: Path) -> Path:
    run = project / "batches" / "batch_key" / "001-run"
    result_path = run / "outputs" / "000001-01.png"
    content = b"result-bytes"
    result_path.write_bytes(content)
    execution_path = run / "execution.json"
    execution = json.loads(execution_path.read_text())
    execution["jobs"][0]["results"] = [
        {
            "job_id": "job-1",
            "job_ordinal": 1,
            "artifact_ordinal": 1,
            "producing_node_id": "301",
            "output_name": "images",
            "remote_filename": "result.png",
            "remote_subfolder": "",
            "remote_type": "output",
            "local_path": "outputs/000001-01.png",
            "content_type": "image/png",
            "byte_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    ]
    execution_path.write_text(json.dumps(execution, sort_keys=True, separators=(",", ":")) + "\n")
    return result_path


def test_import_reindex_history_and_existing_run_detail_work_without_library_rows(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    _copy_fixture(settings)

    with TestClient(create_app(settings, client_factory=_client)) as http:
        imported = http.post("/api/projects/import", json={"filesystem_key": "project_key"})
        repeated = http.post("/api/projects/import", json={"filesystem_key": "project_key"})
        history = http.get("/api/projects/project-id/runs")
        detail = http.get("/api/runs/run-id")
        reindexed = http.post("/api/projects/project-id/reindex")

    assert imported.status_code == repeated.status_code == 201
    assert (
        imported.json()
        == repeated.json()
        == {
            "project_id": "project-id",
            "filesystem_key": "project_key",
            "name": "Portrait tests",
            "batch_count": 1,
            "asset_count": 1,
            "run_count": 1,
            "diagnostic_count": 0,
        }
    )
    assert reindexed.status_code == 200
    assert history.status_code == 200
    item = history.json()["runs"][0]
    assert item["run_id"] == "run-id"
    assert item["execution_available"] is True
    assert item["execution_status"] == "created"
    assert detail.status_code == 200
    assert detail.json()["plan"]["job_count"] == 4


def test_imported_result_listing_retains_metadata_and_download_refuses_missing_bytes(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    result_path = _add_result(project)

    with TestClient(
        create_app(settings, client_factory=_client),
        raise_server_exceptions=False,
    ) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        healthy = http.get("/api/runs/run-id/results")
        downloaded = http.get("/api/runs/run-id/results/1/1")
        result_path.unlink()
        missing = http.get("/api/runs/run-id/results")
        refused = http.get("/api/runs/run-id/results/1/1")

    assert healthy.status_code == 200
    assert healthy.json()["results"][0]["integrity_status"] == "verified"
    assert healthy.json()["results"][0]["remote_filename"] == "result.png"
    assert downloaded.content == b"result-bytes"
    assert missing.status_code == 200
    assert missing.json()["results"][0]["integrity_status"] == "missing"
    assert refused.status_code == 500
    assert refused.json()["error"]["code"] == "invalid_run_data"


def test_degraded_import_exposes_history_but_refuses_execution_and_download(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    _add_result(project)
    asset_content = next((project / "assets" / "sha256").glob("*/*/content"))
    asset_content.unlink()
    shutil.rmtree(project / "batches" / "batch_key" / "001-run" / "outputs")

    with TestClient(
        create_app(settings, client_factory=_client),
        raise_server_exceptions=False,
    ) as http:
        imported = http.post("/api/projects/import", json={"filesystem_key": "project_key"})
        detail = http.get("/api/runs/run-id")
        results = http.get("/api/runs/run-id/results")
        execution = http.post("/api/runs/run-id/execute")
        download = http.get("/api/runs/run-id/results/1/1")

    assert imported.status_code == 201
    assert detail.status_code == 200
    assert detail.json()["plan"]["job_count"] == 4
    assert results.status_code == 200
    assert results.json()["results"][0]["integrity_status"] == "missing"
    assert execution.status_code == 500
    assert execution.json()["error"]["code"] == "invalid_run_data"
    assert download.status_code == 500
    assert download.json()["error"]["code"] == "invalid_run_data"


def test_import_rejects_wrong_owner_without_project_registration(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    owner_path = project / "project.json"
    owner = json.loads(owner_path.read_text())
    owner["filesystem_key"] = "other_key"
    owner_path.write_text(json.dumps(owner))

    with TestClient(create_app(settings, client_factory=_client)) as http:
        response = http.post("/api/projects/import", json={"filesystem_key": "project_key"})
        projects = http.get("/api/projects")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "project_import_failed"
    assert projects.json() == {"projects": []}
