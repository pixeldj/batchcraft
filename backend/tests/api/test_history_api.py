import json
import shutil
from pathlib import Path

from api_client import LoopbackTestClient as TestClient
from api_support import _client
from api_support import _history_settings as _settings
from history_fixture import _add_result, _copy_fixture

from batchcraft.api import create_app


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
