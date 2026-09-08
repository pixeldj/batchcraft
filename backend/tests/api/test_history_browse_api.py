import json
from contextlib import closing
from pathlib import Path
from typing import cast
from urllib.parse import quote

import pytest
from api_client import LoopbackTestClient as TestClient
from test_history_api import _add_result, _client, _copy_fixture, _settings

from batchcraft.api import create_app
from batchcraft.application.service import BatchcraftService
from batchcraft.db import open_connection


def test_browsing_uses_projected_metadata_and_preserves_strict_downloads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    output = _add_result(project)
    before = {path: path.read_bytes() for path in project.rglob("*") if path.is_file()}
    app = create_app(settings, client_factory=_client)
    with TestClient(app, raise_server_exceptions=False) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        service = cast(BatchcraftService, app.state.service)

        def forbidden(*args: object, **kwargs: object) -> None:
            raise AssertionError("Browsing must not load or scan filesystem Runs")

        with monkeypatch.context() as scoped:
            scoped.setattr(service.history_scanner, "scan", forbidden)
            scoped.setattr(service, "get_run", forbidden)
            scoped.setattr(service, "list_results", forbidden)
            runs = http.get("/api/projects/project-id/history/runs")
            results = http.get("/api/projects/project-id/history/results")

        assert runs.status_code == results.status_code == 200
        page = runs.json()
        assert page["generation"] and page["scanned_at"]
        assert page["next_cursor"] is None and page["has_more"] is False
        assert page["items"][0]["result_count"] == 1
        assert page["items"][0]["run"]["run_id"] == "run-id"
        item = results.json()["items"][0]
        assert results.json()["generation"] == page["generation"]
        assert item["run"]["batch_id"] == "batch-id"
        assert item["job_id"] == "job-1"
        assert item["job_ordinal"] == item["artifact_ordinal"] == 1
        assert item["filename_excerpt"] == "result.png"
        assert item["integrity_status"] == "verified"
        assert item["download_url"] == "/api/runs/run-id/results/1/1"
        assert "relative_path" not in item["run"] and "local_path" not in item
        assert before == {path: path.read_bytes() for path in before}

        # The index can be stale, but cannot authorize serving changed/missing bytes.
        output.unlink()
        assert (
            http.get("/api/projects/project-id/history/results").json()["items"][0][
                "integrity_status"
            ]
            == "verified"
        )
        assert http.get(item["download_url"]).status_code == 500
        assert http.post("/api/projects/project-id/reindex").status_code == 200
        missing = http.get("/api/projects/project-id/history/results").json()["items"][0]
        assert missing["integrity_status"] == "missing"
        assert missing["download_url"] is None


def test_result_cursor_reindex_conflict_and_failed_scan_retention(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    first = _add_result(project)
    second = first.with_name("000001-02.png")
    second.write_bytes(first.read_bytes())
    execution_path = first.parent.parent / "execution.json"
    execution = json.loads(execution_path.read_text())
    result = dict(execution["jobs"][0]["results"][0])
    result.update(artifact_ordinal=2, local_path="outputs/000001-02.png")
    execution["jobs"][0]["results"].append(result)
    execution_path.write_text(json.dumps(execution))

    with TestClient(create_app(settings, client_factory=_client)) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        url = "/api/projects/project-id/history/results"
        first_page = http.get(url, params={"limit": 1}).json()
        cursor = first_page["next_cursor"]
        assert first_page["has_more"] and cursor
        second_page = http.get(url, params={"limit": 1, "cursor": cursor}).json()
        assert second_page["items"][0]["artifact_ordinal"] == 2
        assert second_page["has_more"] is False
        assert second_page["generation"] == first_page["generation"]
        mismatch = http.get(url, params={"cursor": cursor, "sort": "oldest"})
        assert mismatch.status_code == 422
        assert mismatch.json()["error"]["code"] == "invalid_history_query"

        # Failed reconciliation retains the old index and its valid continuation.
        owner_path = project / "project.json"
        owner = owner_path.read_bytes()
        owner_path.write_text("not JSON")
        assert http.post("/api/projects/project-id/reindex").status_code == 422
        assert http.get(url, params={"cursor": cursor}).status_code == 200
        owner_path.write_bytes(owner)
        assert http.post("/api/projects/project-id/reindex").status_code == 200
        obsolete = http.get(url, params={"cursor": cursor})
        assert obsolete.status_code == 409
        assert obsolete.json()["error"] == {
            "code": "history_generation_changed",
            "message": "History changed; restart browsing without a cursor",
        }
        assert http.get(url).json()["generation"] != first_page["generation"]


@pytest.mark.parametrize("kind", ["runs", "results"])
def test_browse_filters_and_unknown_scan_state(tmp_path: Path, kind: str) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    _add_result(project)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        url = f"/api/projects/project-id/history/{kind}"
        with closing(open_connection(settings.database_path)) as connection:
            connection.execute(
                "UPDATE historical_run SET name = ?, description = ?", ("CFG 100%_test", "N" * 700)
            )
            connection.execute("DELETE FROM historical_projection_state")
            connection.commit()
        page = http.get(
            url,
            params={
                "q": "%_",
                "batch_id": "batch-id",
                "execution_status": "created",
                "execution_available": "true",
            },
        ).json()
        assert len(page["items"]) == 1
        assert page["generation"] is None and page["scanned_at"] is None
        assert len(page["items"][0]["run"]["run_description_excerpt"]) == 512
        assert page["items"][0]["run"]["display_truncated"] is True
        assert http.get(url, params={"q": "CFG' OR 1=1"}).json()["items"] == []
        assert http.get(url, params={"run_id": "foreign"}).json()["items"] == []
        assert http.get(url, params={"execution_available": "false"}).json()["items"] == []
        assert http.get(f"/api/projects/unknown/history/{kind}").status_code == 404
        created = http.post("/api/projects", json={"name": "Empty", "filesystem_key": "empty"})
        assert created.status_code == 201
        empty = http.get(f"/api/projects/{created.json()['id']}/history/{kind}").json()
        assert empty["items"] == [] and empty["generation"] is None
        assert empty["has_more"] is False


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 101},
        {"limit": "1.5"},
        {"sort": "random"},
        {"execution_status": "unavailable"},
        {"execution_available": "maybe"},
        {"q": "x" * 201},
        {"cursor": "x" * 8193},
        {"cursor": "not-a-cursor"},
        {"unimplemented_filter": "value"},
    ],
)
@pytest.mark.parametrize("kind", ["runs", "results"])
def test_browse_rejects_invalid_queries_without_echoing_values(
    tmp_path: Path, params: dict[str, str | int], kind: str
) -> None:
    settings = _settings(tmp_path)
    _copy_fixture(settings)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        response = http.get(f"/api/projects/project-id/history/{kind}", params=params)
        assert response.status_code == 422
        assert response.json()["error"]["code"] in ("invalid_request", "invalid_history_query")
        assert "not-a-cursor" not in response.text and "unimplemented_filter" not in response.text


@pytest.mark.parametrize(
    "run_id, addressable",
    [
        (".", False),
        ("..", False),
        ("run/with/slash", False),
        ("run\\with\\slash", False),
        ("run\x00id", False),
        ("run ?#%", True),
        ("r" * 7000, True),
    ],
)
def test_browse_preserves_historical_ids_without_emitting_unusable_links(
    tmp_path: Path, run_id: str, addressable: bool
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    _add_result(project)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        with closing(open_connection(settings.database_path)) as connection:
            connection.execute("UPDATE historical_run SET run_id = ?", (run_id,))
            connection.execute("UPDATE historical_result SET run_id = ?", (run_id,))
            connection.commit()
        response = http.get("/api/projects/project-id/history/results", params={"run_id": run_id})
        assert response.status_code == 200
        item = response.json()["items"][0]
        assert item["run"]["run_id"] == run_id
        if addressable:
            assert item["download_url"] == f"/api/runs/{quote(run_id, safe='')}/results/1/1"
            assert item["download_unavailable_reason"] is None
        else:
            assert item["download_url"] is None
            assert item["download_unavailable_reason"] == "unaddressable_run_id"
