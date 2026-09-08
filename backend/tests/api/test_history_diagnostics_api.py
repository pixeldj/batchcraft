from contextlib import closing
from pathlib import Path
from typing import cast

import pytest
from api_client import LoopbackTestClient as TestClient
from test_history_api import _client, _copy_fixture, _settings

from batchcraft.api import create_app
from batchcraft.application.service import BatchcraftService
from batchcraft.db import open_connection


def test_diagnostic_pages_are_bounded_scoped_sanitized_and_sql_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    _copy_fixture(settings)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        assert (
            http.post("/api/projects/import", json={"filesystem_key": "project_key"}).status_code
            == 201
        )
        other = http.post(
            "/api/projects", json={"name": "Other", "filesystem_key": "other"}
        ).json()["id"]
        identity = "exact-" + "x" * 1000
        with closing(open_connection(settings.database_path)) as connection:
            connection.execute("DELETE FROM historical_diagnostic")
            connection.execute(
                "UPDATE historical_run SET run_id = ?, name = ?", (identity, "N" * 600)
            )
            connection.executemany(
                "INSERT INTO historical_diagnostic VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        "project-id",
                        i,
                        "run",
                        "/private/secret",
                        identity,
                        "invalid_run",
                        "/private/secret",
                    )
                    for i in range(1, 106)
                ]
                + [(other, 1, "run", None, "foreign", "unknown /secret", "secret")],
            )
            connection.execute("DELETE FROM historical_provenance_state")
            connection.commit()
        service = cast(BatchcraftService, app.state.service)

        def forbidden(*args: object, **kwargs: object) -> None:
            raise AssertionError("GET must not read filesystem history")

        monkeypatch.setattr(service.history_scanner, "scan", forbidden)
        monkeypatch.setattr(service, "get_run", forbidden)
        monkeypatch.setattr(service, "list_project_diagnostics", forbidden)
        url = "/api/projects/project-id/history/diagnostics"
        first = http.get(url).json()
        assert len(first["items"]) == 25 and first["has_more"]
        item = first["items"][0]
        assert item["ordinal"] == 1 and item["entity_id"] == identity
        assert len(item["name_excerpt"]) == 256 and item["display_truncated"]
        assert len(item["message"]) <= 512
        assert "secret" not in str(first) and "filesystem_key" not in item
        second = http.get(url, params={"limit": 100, "cursor": first["next_cursor"]}).json()
        assert [i["ordinal"] for i in second["items"]] == list(range(26, 106))
        assert not second["has_more"]
        assert second["generation"] == first["generation"]
        assert (
            http.get(
                f"/api/projects/{other}/history/diagnostics",
                params={"cursor": first["next_cursor"]},
            ).status_code
            == 422
        )
        assert http.get("/api/projects/missing/history/diagnostics").status_code == 404
        assert http.get("/api/projects/%2E%2E%2Fsecret/history/diagnostics").status_code == 404
        assert (
            http.get(f"/api/projects/{other}/history/diagnostics").json()["items"][0]["code"]
            == "historical_data_invalid"
        )
        for params in (
            {"limit": 0},
            {"limit": 101},
            {"limit": "1.5"},
            {"cursor": "bad"},
            {"cursor": "x" * 8193},
            {"sort": "oldest"},
        ):
            assert http.get(url, params=params).status_code == 422
        with closing(open_connection(settings.database_path)) as connection:
            connection.execute("UPDATE historical_projection_state SET generation = 'next'")
            connection.commit()
        stale = http.get(url, params={"cursor": first["next_cursor"]})
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "history_generation_changed"
        with closing(open_connection(settings.database_path)) as connection:
            connection.execute("DELETE FROM historical_projection_state")
            connection.commit()
        unknown = http.get(url).json()
        assert unknown["generation"] is None and unknown["scanned_at"] is None
        assert len(unknown["items"]) == 25
