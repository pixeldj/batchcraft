import asyncio
import base64
import copy
import json
import sqlite3
import threading
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from api_client import LoopbackTestClient as TestClient
from api_support import _client
from api_support import _history_settings as _settings

from batchcraft.api import create_app
from batchcraft.api.artifacts import ReadCapacity
from batchcraft.api.global_library import global_library_router
from batchcraft.db import apply_migrations, open_connection
from batchcraft.db import global_workflows as store_module
from batchcraft.db.global_workflows import GlobalWorkflowStore


def _workflow(seed: str = "seed") -> dict[str, Any]:
    return {"1": {"class_type": "Example", "inputs": {seed: 1, "prompt": "base", "prefix": "base"}}}


def _mappings(seed: str = "seed") -> dict[str, Any]:
    return {
        "prompt": {"node_id": "1", "input_name": "prompt", "value_type": "string"},
        "seed": {"node_id": "1", "input_name": seed, "value_type": "integer"},
        "output_prefix": {"node_id": "1", "input_name": "prefix", "value_type": "string"},
    }


def test_direct_authoring_metadata_repair_history_and_restart(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    create = {
        "request_id": "create",
        "name": "Global",
        "description": "Original",
        "workflow": _workflow(),
    }
    with TestClient(create_app(settings, client_factory=_client)) as http:
        response = http.post("/api/library/workflows", json=create)
        assert response.status_code == 201, response.text
        w = response.json()
        wid = w["workflow"]["id"]
        assert http.get("/api/projects").json() == {"projects": []}
        profile_request = dict(
            request_id="profile",
            name="Mapping",
            description="Profile description",
            workflow_version_id=w["version"]["id"],
            mappings=_mappings(),
            image_inputs=[],
            parameters=[],
        )
        response = http.post(f"/api/library/workflows/{wid}/profiles", json=profile_request)
        assert response.status_code == 201, response.text
        p = response.json()
        pid = p["workflow_profile"]["id"]
        assert http.post(f"/api/library/workflows/{wid}/profiles", json=profile_request).json() == p
        edit = dict(request_id="edit", workflow=_workflow("new_seed"), note="New version")
        response = http.post(f"/api/library/workflows/{wid}/versions", json=edit)
        assert response.status_code == 201, response.text
        v2 = response.json()
        families_url = f"/api/library/workflows/{wid}/profiles"
        families = http.get(families_url, params={"workflow_version_id": v2["id"]}).json()
        assert families["items"][0]["id"] == pid
        assert families["items"][0]["latest_compatible_version_id"] is None
        assert families["items"][0]["latest_active_version_id"] == p["version"]["id"]
        assert http.get(f"/api/library/workflow-versions/{v2['id']}/profiles").json()["items"] == []
        for path, name in (
            (f"workflows/{wid}", "Renamed"),
            (f"workflow-profiles/{pid}", "Repaired"),
        ):
            request = {"request_id": path, "name": name, "description": None}
            response = http.patch("/api/library/" + path, json=request)
            assert response.status_code == 200, response.text
            assert response.json()["name"] == name and response.json()["description"] is None
            assert http.patch("/api/library/" + path, json=request).json() == response.json()
        repair = dict(
            request_id="repair",
            workflow_version_id=v2["id"],
            mappings=_mappings(),
            image_inputs=[],
            parameters=[],
        )
        url = f"/api/library/workflow-profiles/{pid}/versions"
        assert http.post(url, json=repair).status_code == 422
        repair["mappings"] = _mappings("new_seed")
        response = http.post(url, json=repair)
        assert response.status_code == 201, response.text
        repaired = response.json()
        assert repaired["version_number"] == 2
        assert repaired["profile"]["id"] == pid and repaired["profile"]["name"] == "Repaired"
        assert http.post(url, json=repair).json() == repaired
        families = http.get(families_url, params={"workflow_version_id": v2["id"]}).json()["items"]
        assert families[0]["latest_compatible_version"]["id"] == repaired["id"]
        assert "profile" not in families[0]["latest_compatible_version"]
        assert http.get(f"/api/library/workflows/{wid}").json()["latest_version_id"] == v2["id"]
        for version, prefix in (
            (w["version"], "workflow-versions"),
            (p["version"], "workflow-profile-versions"),
        ):
            assert http.get(f"/api/library/{prefix}/{version['id']}").json() == version
        history_url = f"/api/library/workflows/{wid}/versions"
        first = http.get(history_url, params={"limit": 1}).json()
        second = http.get(history_url, params={"limit": 1, "cursor": first["next_cursor"]}).json()
        assert first["items"][0]["id"] == w["version"]["id"]
        assert second["items"][0]["id"] == v2["id"] and second["next_cursor"] is None
        assert "workflow" not in first["items"][0]
        history = http.get(url, params={"workflow_version_id": v2["id"]}).json()["items"]
        assert [row["id"] for row in history] == [repaired["id"]]
        assert "profile" not in history[0]
        for path in (
            f"workflow-versions/{v2['id']}",
            f"workflow-profile-versions/{repaired['id']}",
            f"workflow-profiles/{pid}",
            f"workflows/{wid}",
        ):
            archive = {"request_id": "archive-" + path, "archived": True}
            response = http.post(f"/api/library/{path}/archive", json=archive)
            assert response.status_code == 200 and response.json()["archived_at"] is not None
            archived = response.json()
            assert (
                http.post(
                    f"/api/library/{path}/archive",
                    json={"request_id": "restore-" + path, "archived": False},
                ).json()["archived_at"]
                is None
            )
            assert http.post(f"/api/library/{path}/archive", json=archive).json() == archived
        assert http.post("/api/library/workflows", json=create).json() == w
        assert (
            http.post("/api/library/workflows", json={**create, "name": "Changed"}).status_code
            == 409
        )
        assert (
            http.post(
                f"/api/library/workflows/{wid}/versions", json={**edit, "request_id": "create"}
            ).status_code
            == 409
        )
    with TestClient(create_app(settings, client_factory=_client)) as http:
        assert http.post("/api/library/workflows", json=create).json() == w
        assert http.post(f"/api/library/workflows/{wid}/versions", json=edit).json() == v2
        assert http.post(url, json=repair).json() == repaired


@pytest.mark.parametrize("field", ["name", "description", "note", "request_id", "workflow"])
def test_nested_and_metadata_surrogates_rejected(tmp_path: Path, field: str) -> None:
    request: dict[str, Any] = dict(request_id="create", name="Test", workflow=_workflow())
    request[field] = (
        {"1": {"class_type": "Node", "inputs": {"text": "\ud800"}}}
        if field == "workflow"
        else "\ud800"
    )
    with TestClient(create_app(_settings(tmp_path), client_factory=_client)) as http:
        response = http.post(
            "/api/library/workflows",
            content=json.dumps(request),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422, response.text
        assert http.get("/api/library/workflows").json()["items"] == []


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        [],
        1,
        "text",
        {},
        {"binding": [], "after": {}},
        {"binding": [], "after": ["\ud800", ""]},
    ],
)
def test_all_metadata_endpoints_reject_malformed_cursor(tmp_path: Path, invalid: object) -> None:
    token = base64.urlsafe_b64encode(json.dumps(invalid).encode()).decode()
    with TestClient(create_app(_settings(tmp_path), client_factory=_client)) as http:
        for path in (
            "workflows",
            "workflows/missing/versions",
            "workflows/missing/profiles",
            "workflow-profiles/missing/versions",
            "workflow-versions/missing/profiles",
        ):
            response = http.get("/api/library/" + path, params={"cursor": token})
            assert response.status_code == 422, response.text


def test_authoring_validation_bounds_and_body_middleware(tmp_path: Path) -> None:
    settings = replace(_settings(tmp_path), max_request_bytes=4096)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        request = dict(request_id="new", name="Test", workflow=_workflow())
        for field, value in (
            ("name", " "),
            ("name", "x" * 201),
            ("description", "x" * 2001),
            ("note", " "),
            ("request_id", " "),
            ("workflow", {}),
            ("workflow", []),
        ):
            response = http.post("/api/library/workflows", json={**request, field: value})
            assert response.status_code == 422, response.text
        w = http.post("/api/library/workflows", json=request).json()
        wid = w["workflow"]["id"]
        for changes in ({}, {"name": None}, {"name": " "}, {"unexpected": True}):
            assert (
                http.patch(
                    f"/api/library/workflows/{wid}", json={"request_id": "metadata", **changes}
                ).status_code
                == 422
            )
        for archived in (None, "true", 1):
            assert (
                http.post(
                    f"/api/library/workflows/{wid}/archive",
                    json={"request_id": "archive", "archived": archived},
                ).status_code
                == 422
            )
        profile = dict(
            request_id="profile",
            name="P",
            workflow_version_id=w["version"]["id"],
            mappings=_mappings(),
            image_inputs=[],
            parameters=[],
        )
        bad = copy.deepcopy(profile)
        bad["mappings"]["seed"]["input_name"] = "missing"
        assert http.post(f"/api/library/workflows/{wid}/profiles", json=bad).status_code == 422
        assert http.get(f"/api/library/workflows/{wid}/profiles").json()["items"] == []
        other = http.post(
            "/api/library/workflows", json={**request, "request_id": "other", "name": "Other"}
        ).json()
        assert (
            http.post(
                f"/api/library/workflows/{wid}/profiles",
                json={**profile, "workflow_version_id": other["version"]["id"]},
            ).status_code
            == 422
        )
        assert (
            http.get(
                f"/api/library/workflows/{wid}/profiles",
                params={"workflow_version_id": other["version"]["id"]},
            ).status_code
            == 422
        )
        for path in (
            "workflows",
            f"workflows/{wid}/versions",
            f"workflows/{wid}/profiles",
            "workflow-profiles/missing/versions",
        ):
            assert (
                http.post(
                    "/api/library/" + path,
                    content=b" " * 4097,
                    headers={"Content-Type": "application/json"},
                ).status_code
                == 413
            )
        assert http.get("/api/library/workflows/missing").status_code == 404


def test_cancelled_http_authoring_joins_worker_and_retry_returns_one_creation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    app = create_app(_settings(tmp_path), client_factory=_client)
    insert = store_module._insert

    def pause(c: sqlite3.Connection, table: str, values: dict[str, Any]) -> None:
        insert(c, table, values)
        if table == "global_workflow_authoring_receipt":
            entered.set()
            assert release.wait(5)
            finished.set()

    async def check() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app),
                base_url="http://localhost:8002",
            ) as http,
        ):
            monkeypatch.setattr(store_module, "_insert", pause)
            body = dict(request_id="cancelled", name="Created once", workflow=_workflow())
            pending = asyncio.create_task(http.post("/api/library/workflows", json=body))
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                assert (await asyncio.wait_for(http.get("/api/health"), 1)).status_code == 200
                pending.cancel()
                await asyncio.sleep(0)
                pending.cancel()
                await asyncio.sleep(0)
                assert not pending.done() and not finished.is_set()
            finally:
                release.set()
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert finished.is_set()
            first, second = await asyncio.gather(
                *[http.post("/api/library/workflows", json=body) for _ in range(2)]
            )
            assert first.status_code == second.status_code == 201
            assert first.json() == second.json()
            assert len((await http.get("/api/library/workflows")).json()["items"]) == 1

    asyncio.run(check())


@pytest.mark.parametrize(
    "path,method",
    [
        ("workflows/{wid}", "get_workflow"),
        ("workflows/{wid}/versions", "history"),
        ("workflows/{wid}/profiles", "history"),
        ("workflow-profiles/{pid}/versions", "history"),
    ],
)
def test_new_metadata_reads_hold_capacity_until_cancelled_worker_finishes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    method: str,
) -> None:
    from fastapi import FastAPI

    from batchcraft.api.app import _library, _service

    database_path = tmp_path / "reads.sqlite3"
    with closing(open_connection(database_path)) as c:
        apply_migrations(c)
    store = GlobalWorkflowStore(database_path)
    w = store.save_workflow(request_id="w", name="W", workflow=_workflow())
    p = store.save_profile(
        request_id="p",
        workflow_id=w["workflow"]["id"],
        name="P",
        workflow_version_id=w["version"]["id"],
        mappings=_mappings(),
        image_inputs=[],
        parameters=[],
    )
    reads = ReadCapacity(1)
    app = FastAPI()
    app.include_router(global_library_router(database_path, reads, _service, _library))
    entered, release = threading.Event(), threading.Event()
    original = getattr(GlobalWorkflowStore, method)

    async def check() -> None:
        event_thread = threading.get_ident()

        def blocked(*args: Any, **kwargs: Any) -> Any:
            assert threading.get_ident() != event_thread
            entered.set()
            assert release.wait(5)
            return original(*args, **kwargs)

        monkeypatch.setattr(GlobalWorkflowStore, method, blocked)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as http:
            url = "/api/library/" + path.format(
                wid=w["workflow"]["id"], pid=p["workflow_profile"]["id"]
            )
            pending = asyncio.create_task(http.get(url))
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                assert reads.active == 1
                pending.cancel()
                await asyncio.sleep(0)
                pending.cancel()
                await asyncio.sleep(0)
                assert not pending.done() and reads.active == 1
            finally:
                release.set()
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert reads.active == 0

    asyncio.run(check())
