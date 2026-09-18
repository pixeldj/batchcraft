import asyncio
import hashlib
import json
import shutil
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from api_client import LoopbackTestClient as TestClient
from fastapi import FastAPI
from test_history_api import _client, _copy_fixture, _settings

from batchcraft.api import create_app
from batchcraft.api.app import _library, _service
from batchcraft.api.artifacts import ReadCapacity
from batchcraft.api.global_library import (
    GlobalCopyResponse,
    RunSetupResponse,
    global_library_router,
)
from batchcraft.db import global_workflows as store_module
from batchcraft.db import open_connection
from batchcraft.db.global_workflows import HistoricalSetupImport

REQUEST = dict(
    request_id="historical-copy", run_id="run-id", name="Reusable", profile_name="Mappings"
)


def _hashes(project: Path) -> dict[str, str]:
    return {
        str(path.relative_to(project)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in project.rglob("*")
        if path.is_file()
    }


def _dump(database: Path) -> list[str]:
    with closing(open_connection(database)) as c:
        return list(c.iterdump())


def _register(http: TestClient) -> None:
    response = http.post("/api/projects/import", json={"filesystem_key": "project_key"})
    assert response.status_code == 201, response.text


def _post(http: TestClient, **changes: Any) -> httpx.Response:
    return cast(
        httpx.Response, http.post("/api/library/workflows/import-run", json={**REQUEST, **changes})
    )


def _rewrite_snapshots(run: Path, manifest: dict[str, Any]) -> None:
    """Emit valid, deliberately formatted raw snapshots and repair their byte descriptors."""
    metadata = json.loads((run / "run.json").read_text())
    selection = manifest["batch_snapshot"]["workflow_selection"]
    for key, filename in (
        ("workflow", "workflow.json"),
        ("workflow_profile", "workflow-profile.json"),
    ):
        content = json.dumps(selection[key], indent=2).encode()
        (run / filename).write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        metadata[key + "_sha256"] = digest
        manifest[key + "_snapshot"]["sha256"] = digest
        for job in manifest["jobs"]:
            job[key + "_sha256"] = digest
    (run / "run.json").write_text(json.dumps(metadata))
    (run / "manifest.json").write_text(json.dumps(manifest))


def test_fixture_to_global_to_project_saved_batch_preview_run(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    before = _hashes(project)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        _register(http)
        with closing(open_connection(settings.database_path)) as c:
            for table in ("workflow", "workflow_version", "workflow_profile", "global_workflow"):
                assert c.execute(f"SELECT count(*) FROM {table}").fetchone() == (0,)
        database_before = _dump(settings.database_path)
        review = http.get("/api/library/run-setup", params={"run_id": "run-id"})
        assert review.status_code == 200, review.text
        setup = review.json()
        assert _dump(settings.database_path) == database_before
        assert setup["run_number"] == "1"
        assert setup["source"]["workflow"]["id"] is None
        assert setup["source"]["profiles"][0]["workflow_profile_id"] is None
        assert setup["source"]["profiles"][0]["version_number"] is None
        assert set(setup) == {
            "run_id",
            "project_id",
            "batch_id",
            "project_name",
            "batch_name",
            "run_name",
            "run_number",
            "workflow_name",
            "profile_name",
            "workflow",
            "profile",
            "source",
        }
        response = _post(
            http,
            expected_workflow_sha256=setup["source"]["workflow"]["content_sha256"],
            expected_profile_sha256=setup["source"]["profiles"][0]["content_sha256"],
        )
        assert response.status_code == 200, response.text
        imported = response.json()
        assert imported["source"] == setup["source"]
        w, p = imported["workflow"]["version"], imported["profiles"][0]["version"]
        assert w["workflow"] == setup["workflow"]
        assert w["workflow"]["104"]["inputs"]["text"] == "original"
        assert w["workflow"]["114"]["inputs"]["seed"] == 0
        assert w["workflow"]["221"]["inputs"]["image"] == "original.png"
        assert p["profile"]["id"] != setup["profile"]["id"]
        assert w["version_number"] == p["version_number"] == 1
        destination = http.post(
            "/api/projects", json={"name": "Destination", "filesystem_key": "dest"}
        ).json()
        copied = http.post(
            "/api/library/workflows/use-in-project",
            json={
                "request_id": "to-project",
                "project_id": destination["id"],
                "workflow_version_id": w["id"],
                "profiles": [{"version_id": p["id"]}],
            },
        )
        assert copied.status_code == 200, copied.text
        w, p = copied.json()["workflow"]["version"], copied.json()["profiles"][0]["version"]
        for key in ("mappings", "image_inputs", "parameters"):
            assert p["profile"][key] == setup["profile"][key]
        prompt = http.post(
            f"/api/projects/{destination['id']}/prompts", json={"name": "P", "text": "new prompt"}
        ).json()["version"]
        definition = {
            "name": "New Batch",
            "description": None,
            "prompt_selections": [
                {"prompt_version_id": prompt["id"], "name_snapshot": "P", "text": "new prompt"}
            ],
            "variable_bindings": [],
            "image_bindings": [{"slot_key": "reference", "values": [None]}],
            "parameter_bindings": [],
            "linked_parameter_sets": [],
            "seed_intent": {"mode": "fixed", "values": [77], "random_seed_count": None},
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
            f"/api/projects/{destination['id']}/batches",
            json={"filesystem_key": "new_batch", **definition},
        )
        assert saved_response.status_code == 201, saved_response.text
        saved = saved_response.json()
        project_identity = {k: destination[k] for k in ("id", "name", "filesystem_key")}
        batch = {k: saved[k] for k in ("id", "name", "filesystem_key")}
        prompts = [{"id": prompt["id"], "name": "P", "text": "new prompt"}]
        request = {
            "project": project_identity,
            "batch": batch,
            "prompt_versions": prompts,
            "variable_bindings": [],
            "image_bindings": definition["image_bindings"],
            "parameter_bindings": [],
            "linked_parameter_sets": [],
            "seeds": {"mode": "fixed", "values": [77]},
            "workflow": w["workflow"],
            "workflow_profile": p["profile"],
            "batch_snapshot": {
                "format": "batchcraft.batch-snapshot",
                "format_version": 1,
                "project": project_identity,
                "batch": {**batch, "description": None},
                "source_saved_batch": {"id": saved["id"], "revision": saved["revision"]},
                "prompt_versions": [
                    {**prompts[0], "prompt_id": prompt["prompt_id"], "version_number": 1}
                ],
                "variable_bindings": [],
                "image_bindings": definition["image_bindings"],
                "parameter_bindings": [],
                "linked_parameter_sets": [],
                "seed_intent": definition["seed_intent"],
                "workflow_selection": {
                    "workflow_id": w["workflow_id"],
                    "workflow_version_id": w["id"],
                    "workflow_profile_id": p["workflow_profile_id"],
                    "workflow_profile_version_id": p["id"],
                    "workflow": w["workflow"],
                    "workflow_profile": p["profile"],
                },
            },
        }
        preview = http.post("/api/batches/preview", json=request)
        assert preview.status_code == 200, preview.text
        created = http.post("/api/runs", json=request)
        assert created.status_code == 201, created.text
        assert _hashes(project) == before


@pytest.mark.parametrize("execution", ["missing", "corrupt"])
def test_missing_assets_outputs_and_unavailable_execution_do_not_block_setup(
    tmp_path: Path, execution: str
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    run = project / "batches/batch_key/001-run"
    shutil.rmtree(project / "assets")
    shutil.rmtree(run / "outputs")
    if execution == "missing":
        (run / "execution.json").unlink()
    else:
        (run / "execution.json").write_text("corrupt")
    before = _hashes(project)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        _register(http)
        assert http.get("/api/library/run-setup", params={"run_id": "run-id"}).status_code == 200
        response = _post(http)
        assert response.status_code == 200, response.text
    assert _hashes(project) == before


@pytest.mark.parametrize(
    "damage", ["tamper", "missing", "symlink", "duplicate", "unsupported", "owner"]
)
def test_invalid_immutable_source_rejected_without_writes(tmp_path: Path, damage: str) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    run = project / "batches/batch_key/001-run"
    with TestClient(create_app(settings, client_factory=_client)) as http:
        _register(http)
        if damage == "duplicate":
            shutil.copytree(run, run.parent / "002-run")
        elif damage == "owner":
            path = run.parent / "batch.json"
            value = json.loads(path.read_text())
            value["batch_id"] = "other"
            path.write_text(json.dumps(value))
        elif damage == "unsupported":
            path = run / "manifest.json"
            value = json.loads(path.read_text())
            value["format_version"] = 2
            path.write_text(json.dumps(value))
        elif damage == "tamper":
            (run / "workflow.json").write_text("{}")
        else:
            (run / "workflow.json").unlink()
            if damage == "symlink":
                (run / "workflow.json").symlink_to(run / "workflow-profile.json")
        before, database = _hashes(project), _dump(settings.database_path)
        for response in (
            http.get("/api/library/run-setup", params={"run_id": "run-id"}),
            _post(http),
        ):
            assert response.status_code == 500
            assert response.json()["error"]["code"] == "invalid_run_data"
            assert str(project) not in response.text
        assert _dump(settings.database_path) == database
        assert _hashes(project) == before


def test_project_registration_and_ownership_are_required(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    _copy_fixture(settings)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        for operation in (
            lambda: http.get("/api/library/run-setup", params={"run_id": "run-id"}),
            lambda: _post(http),
        ):
            assert operation().status_code == 404
        assert http.get("/api/projects").json() == {"projects": []}
        _register(http)
        with closing(open_connection(settings.database_path)) as c:
            c.execute("UPDATE project SET filesystem_key='other'")
            c.commit()
        before = _dump(settings.database_path)
        assert _post(http).status_code == 422
        assert _dump(settings.database_path) == before


def test_historical_unbounded_metadata_and_formatted_byte_hashes(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    run = project / "batches/batch_key/001-run"
    manifest = json.loads((run / "manifest.json").read_text())
    selection = manifest["batch_snapshot"]["workflow_selection"]
    long_id, huge = "historical/" + "x" * 250, 2**100
    selection.update(
        workflow_id="w" * 250,
        workflow_version_id="v" * 250,
        workflow_name="W" * 250,
        workflow_version_number=huge,
        workflow_profile_id="p" * 250,
        workflow_profile_version_id="pv" * 250,
        workflow_profile_name="P" * 250,
        workflow_profile_version_number=huge,
    )
    # The v1 Profile envelope need not agree with optional library ancestry.
    selection["workflow_profile"].update(id="raw" * 250, name="raw name" * 250)
    types = [
        ("text", "string", "base", "override"),
        ("flag", "boolean", True, False),
        ("steps", "integer", 10, 20),
        ("cfg", "float", 1.5, 2.5),
    ]
    for key, kind, base, override in types:
        selection["workflow"]["114"]["inputs"][key] = base
        selection["workflow_profile"]["parameters"].append(
            dict(key=key, label=key, node_id="114", input_name=key, value_type=kind)
        )
        manifest["parameters"].append(
            dict(
                parameter_key=key,
                parameter_label=key,
                node_id="114",
                input_name=key,
                value_type=kind,
            )
        )
        manifest["batch_snapshot"]["parameter_bindings"].append(
            dict(parameter_key=key, mode="values", values=[override])
        )
        for job in manifest["jobs"]:
            job["resolved_parameters"].append(dict(parameter_key=key, value=override))
    _rewrite_snapshots(run, manifest)
    for filename in ("run.json", "manifest.json"):
        path = run / filename
        data = json.loads(path.read_text())
        identity = data if filename == "run.json" else data["run"]
        identity.update(run_id=long_id, run_number=huge, filesystem_key=f"{huge}-run")
        for job in data.get("jobs", []):
            job["output_prefix"] = f"batchcraft/{long_id}/{job['job_id']}/result"
        path.write_text(json.dumps(data))
    run.rename(run.parent / f"{huge}-run")
    before = _hashes(project)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        # Register the owner without depending on historical index numeric storage.
        response = http.post("/api/projects/adopt", json={"filesystem_key": "project_key"})
        assert response.status_code == 201, response.text
        review = http.get("/api/library/run-setup", params={"run_id": long_id})
        assert review.status_code == 200, review.text
        setup = review.json()
        assert setup["run_number"] == str(huge)
        assert setup["workflow_name"] == "W" * 250
        assert setup["source"]["workflow"]["version_number"] == str(huge)
        assert setup["source"]["profiles"][0]["version_number"] == str(huge)
        bad = _post(http, run_id=long_id, name=setup["workflow_name"])
        assert bad.status_code == 422
        response = _post(http, run_id=long_id)
        assert response.status_code == 200, response.text
        copied = response.json()
        assert copied["workflow"]["version"]["workflow"] == setup["workflow"]
        assert (
            copied["workflow"]["version"]["content_sha256"]
            != setup["source"]["workflow"]["content_sha256"]
        )
        assert (
            copied["profiles"][0]["version"]["profile"]["parameters"]
            == selection["workflow_profile"]["parameters"]
        )
        assert copied["source"] == setup["source"]
        assert copied["workflow"]["version"]["version_number"] == 1
    assert _hashes(project) == before


def test_replay_after_restart_and_source_removal_precedes_loader(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        _register(http)
        review = http.get("/api/library/run-setup", params={"run_id": "run-id"}).json()
        preconditions = dict(
            expected_workflow_sha256=review["source"]["workflow"]["content_sha256"],
            expected_profile_sha256=review["source"]["profiles"][0]["content_sha256"],
        )
        response = _post(http, **preconditions)
        assert response.status_code == 200, response.text
        receipt = response.json()
    shutil.rmtree(project)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        monkeypatch.setattr(
            app.state.service,
            "get_historical_setup",
            lambda *a, **kw: pytest.fail("replay read source"),
        )
        assert _post(http, **preconditions).json() == receipt
        for change in (
            {"run_id": "different"},
            {"name": "Different"},
            {"profile_name": "Different"},
            {"description": "Changed"},
            {"expected_workflow_sha256": "0" * 64},
            {"expected_profile_sha256": None},
        ):
            assert _post(http, **{**preconditions, **change}).status_code == 409
        for direction in ("import-project", "use-in-project"):
            assert (
                http.post(
                    f"/api/library/workflows/{direction}",
                    json={
                        "request_id": REQUEST["request_id"],
                        "project_id": "none",
                        "workflow_version_id": "none",
                    },
                ).status_code
                == 409
            )
        # Authoring has its own namespace, unchanged by copy receipts.
        assert (
            http.post(
                "/api/library/workflows",
                json={
                    "request_id": REQUEST["request_id"],
                    "name": "Authored",
                    "workflow": review["workflow"],
                },
            ).status_code
            == 201
        )


def test_concurrent_import_rechecks_receipt_under_write_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    before = _hashes(project)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        _register(http)
        original = app.state.service.get_historical_setup
        barrier = threading.Barrier(2)

        def load(*args: Any, **kwargs: Any) -> Any:
            result = original(*args, **kwargs)
            barrier.wait(timeout=5)
            return result

        monkeypatch.setattr(app.state.service, "get_historical_setup", load)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(
                    app.state.service.import_historical_setup,
                    HistoricalSetupImport(**REQUEST),
                    library=app.state.library_service,
                )
                for _ in range(2)
            ]
            first, second = [future.result() for future in futures]
        assert first == second
        with closing(open_connection(settings.database_path)) as c:
            for table in (
                "global_workflow",
                "global_workflow_version",
                "global_workflow_profile",
                "global_workflow_profile_version",
                "global_workflow_copy_receipt",
            ):
                assert c.execute(f"SELECT count(*) FROM {table}").fetchone() == (1,)
    assert _hashes(project) == before


@pytest.mark.parametrize(
    "table",
    [
        "global_workflow",
        "global_workflow_version",
        "global_workflow_profile",
        "global_workflow_profile_version",
        "global_workflow_copy_receipt",
    ],
)
def test_each_insert_failure_rolls_back_setup_and_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, table: str
) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        _register(http)
        before, database = _hashes(project), _dump(settings.database_path)
        original = store_module._insert

        def insert(connection: sqlite3.Connection, target: str, values: dict[str, Any]) -> None:
            original(connection, target, values)
            if target == table:
                raise RuntimeError("injected insertion failure")

        monkeypatch.setattr(store_module, "_insert", insert)
        with pytest.raises(RuntimeError, match="injected"):
            app.state.service.import_historical_setup(
                HistoricalSetupImport(**REQUEST), library=app.state.library_service
            )
        assert _dump(settings.database_path) == database
        assert _hashes(project) == before


def test_stale_preconditions_and_reserved_name_conflicts(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    project = _copy_fixture(settings)
    before = _hashes(project)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        _register(http)
        database = _dump(settings.database_path)
        for key in ("expected_workflow_sha256", "expected_profile_sha256"):
            assert _post(http, **{key: "0" * 64}).status_code == 409
        assert _dump(settings.database_path) == database
        result = _post(http).json()
        http.post(
            f"/api/library/workflows/{result['workflow']['workflow']['id']}/archive",
            json={"request_id": "archive", "archived": True},
        )
        database = _dump(settings.database_path)
        conflict = _post(http, request_id="new")
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "library_conflict"
        assert _dump(settings.database_path) == database
    assert _hashes(project) == before


@pytest.mark.parametrize(
    "change",
    [
        {"workflow": {}},
        {"source": {}},
        {"path": "x"},
        {"run_id": ""},
        {"run_id": "\ud800"},
        {"name": " "},
        {"profile_name": "x" * 201},
        {"request_id": "x" * 201},
        {"description": "x" * 2001},
        {"expected_profile_sha256": "bad"},
    ],
)
def test_import_request_validation(tmp_path: Path, change: dict[str, Any]) -> None:
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, client_factory=_client)) as http:
        before = _dump(settings.database_path)
        response = http.post(
            "/api/library/workflows/import-run",
            content=json.dumps({**REQUEST, **change}),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422, response.text
        assert _dump(settings.database_path) == before


@pytest.mark.parametrize("method", ["get", "post"])
def test_setup_operations_hold_admission_until_cancelled_worker_joins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, method: str
) -> None:
    settings = _settings(tmp_path)
    _copy_fixture(settings)
    app = create_app(settings, client_factory=_client)
    with TestClient(app) as http:
        _register(http)
        isolated = FastAPI()
        isolated.state.service = app.state.service
        isolated.state.library_service = app.state.library_service
        capacity = ReadCapacity(1)
        isolated.include_router(
            global_library_router(settings.database_path, capacity, _service, _library)
        )
        entered, release = threading.Event(), threading.Event()
        original = app.state.service.get_historical_setup

        async def check() -> None:
            event_thread = threading.get_ident()

            def load(*args: Any, **kwargs: Any) -> Any:
                assert threading.get_ident() != event_thread
                entered.set()
                assert release.wait(5)
                return original(*args, **kwargs)

            model_type = RunSetupResponse if method == "get" else GlobalCopyResponse
            serialize = model_type.model_dump_json

            def serialize_off_loop(self: Any, *args: Any, **kwargs: Any) -> str:
                assert threading.get_ident() != event_thread
                return serialize(self, *args, **kwargs)

            monkeypatch.setattr(app.state.service, "get_historical_setup", load)
            monkeypatch.setattr(model_type, "model_dump_json", serialize_off_loop)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(isolated), base_url="http://test"
            ) as client:

                def request() -> Any:
                    return (
                        client.get("/api/library/run-setup", params={"run_id": "run-id"})
                        if method == "get"
                        else client.post("/api/library/workflows/import-run", json=REQUEST)
                    )

                pending = asyncio.create_task(request())
                waiting = None
                try:
                    assert await asyncio.to_thread(entered.wait, 2)
                    waiting = asyncio.create_task(request())
                    await asyncio.sleep(0.02)
                    assert capacity.active == 1 and len(capacity._waiters) == 1
                    waiting.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await waiting
                    pending.cancel()
                    await asyncio.sleep(0.02)
                    assert capacity.active == 1 and not pending.done()
                finally:
                    release.set()
                with pytest.raises(asyncio.CancelledError):
                    await pending
                assert capacity.active == 0

        asyncio.run(check())
        if method == "post":
            assert len(http.get("/api/library/workflows").json()["items"]) == 1
