import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

from batchcraft.db import ProjectStore, WorkflowProfileStore, WorkflowStore, open_connection
from batchcraft.db import global_workflows as module
from batchcraft.db.global_workflows import GlobalWorkflowStore
from batchcraft.db.workflows import WorkflowConflictError, WorkflowValidationError
from db.test_workflows import _database, _image_inputs, _mappings, _workflow


def _source(path: Path) -> dict[str, Any]:
    workflow, version = WorkflowStore(path).create("project-1", "Original", _workflow())
    profiles = [
        WorkflowProfileStore(path).create(
            workflow.id, name, version.id, _mappings(), _image_inputs()
        )[1]
        for name in ("First", "Second")
    ]
    return dict(
        direction="import",
        request_id="import-1",
        project_id="project-1",
        workflow_version_id=version.id,
        profiles=[{"version_id": p.id, "name": None} for p in profiles],
    )


def test_copy_round_trip_receipt_survives_changes_archival_and_restart(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = GlobalWorkflowStore(path)
    request = _source(path)
    source = WorkflowStore(path).get_version(request["workflow_version_id"])
    result = store.copy(**request)
    WorkflowStore(path).update_metadata(source.workflow_id, name="Renamed")
    WorkflowStore(path).create_version(source.workflow_id, _workflow())
    WorkflowStore(path).archive(source.workflow_id)
    WorkflowStore(path).archive_version(source.id)
    ProjectStore(path).archive("project-1")
    assert GlobalWorkflowStore(path).copy(**request) == result
    assert result["workflow"]["version"]["version_number"] == 1
    assert result["workflow"]["workflow"]["name"] == "Original"
    with pytest.raises(WorkflowConflictError, match="different copy request"):
        store.copy(**{**request, "name": "Different"})
    duplicate = store.copy(**{**request, "request_id": "deliberate", "name": "Independent"})
    assert duplicate["workflow"]["workflow"]["id"] != result["workflow"]["workflow"]["id"]
    use = dict(
        direction="use",
        request_id="use-1",
        project_id="project-2",
        workflow_version_id=result["workflow"]["version"]["id"],
        profiles=[
            {"version_id": p["version"]["id"], "name": p["workflow_profile"]["name"]}
            for p in result["profiles"]
        ],
    )
    copied = store.copy(**use)
    assert copied["workflow"]["version"]["project_id"] == "project-2"
    for original, imported, target in zip(
        request["profiles"], result["profiles"], copied["profiles"], strict=True
    ):
        frozen = WorkflowProfileStore(path).get_version(original["version_id"])
        assert imported["version"]["profile"]["image_inputs"] == frozen.profile["image_inputs"]
        assert target["version"]["profile"]["image_inputs"] == frozen.profile["image_inputs"]
        assert imported["version"]["content_sha256"] != frozen.content_sha256
        assert (
            result["source"]["profiles"][request["profiles"].index(original)]["content_sha256"]
            == frozen.content_sha256
        )
        assert (
            WorkflowProfileStore(path).get_version(target["version"]["id"]).workflow_version_id
            == copied["workflow"]["version"]["id"]
        )
    with closing(open_connection(path)) as c:
        c.execute("UPDATE global_workflow SET name=name || ' changed', archived_at='archived'")
        c.commit()
    assert store.copy(**use) == copied
    assert store.browse()["items"] == []
    assert store.get_version(use["workflow_version_id"])["workflow"] == source.workflow
    with pytest.raises(WorkflowConflictError):
        store.copy(**{**use, "request_id": "another"})
    ProjectStore(path).archive("project-2")
    with pytest.raises(WorkflowValidationError, match="active"):
        store.copy(**{**use, "request_id": "archived-destination", "name": "New"})


@pytest.mark.parametrize("direction", ["import", "use"])
def test_mid_profile_failure_rolls_back_entire_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, direction: str
) -> None:
    path = _database(tmp_path)
    request = _source(path)
    store = GlobalWorkflowStore(path)
    if direction == "use":
        imported = store.copy(**request)
        request = dict(
            direction="use",
            request_id="use",
            project_id="project-2",
            workflow_version_id=imported["workflow"]["version"]["id"],
            profiles=[{"version_id": p["version"]["id"]} for p in imported["profiles"]],
        )
    with closing(open_connection(path)) as c:
        before = list(c.iterdump())
    insert = module._insert
    count = 0

    def fail(c: sqlite3.Connection, table: str, values: dict[str, Any]) -> None:
        nonlocal count
        insert(c, table, values)
        if table.endswith("workflow_profile_version"):
            count += 1
            if count == 2:
                raise RuntimeError("injected failure")

    monkeypatch.setattr(module, "_insert", fail)
    with pytest.raises(RuntimeError, match="injected"):
        store.copy(**request)
    with closing(open_connection(path)) as c:
        assert list(c.iterdump()) == before
    monkeypatch.setattr(module, "_insert", insert)
    assert store.copy(**request)["request_id"] == request["request_id"]


def test_source_ownership_exact_target_and_name_collisions(tmp_path: Path) -> None:
    path = _database(tmp_path)
    request = _source(path)
    store = GlobalWorkflowStore(path)
    with pytest.raises(WorkflowValidationError, match="another Project"):
        store.copy(**{**request, "project_id": "project-2"})
    source = WorkflowStore(path).get_version(request["workflow_version_id"])
    later = WorkflowStore(path).create_version(source.workflow_id, source.workflow)
    with pytest.raises(WorkflowValidationError, match="exact"):
        store.copy(**{**request, "workflow_version_id": later.id})
    with pytest.raises(WorkflowValidationError, match="once"):
        store.copy(**{**request, "profiles": [request["profiles"][0]] * 2})
    with pytest.raises(WorkflowConflictError, match="review"):
        store.copy(**{**request, "profiles": [{**p, "name": "Same"} for p in request["profiles"]]})
    assert store.browse()["items"] == []


def test_metadata_pagination_is_literal_bounded_and_stable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _database(tmp_path)
    store = GlobalWorkflowStore(path)
    request = _source(path)
    for i in range(4):
        store.copy(**{**request, "request_id": str(i), "name": f"Name%_{i}"})
    first = store.browse(q="%_", limit=2)
    assert len(first["items"]) == 2
    assert "workflow_json" not in str(first) and "profile_json" not in str(first)
    with closing(open_connection(path)) as c:
        c.execute(
            "UPDATE global_workflow SET updated_at='later' WHERE id=?", (first["items"][0]["id"],)
        )
        c.commit()
    store.copy(**{**request, "request_id": "append", "name": "Name%_4"})
    second = store.browse(q="%_", limit=2, cursor=first["next_cursor"])
    assert not {i["id"] for i in first["items"]} & {i["id"] for i in second["items"]}
    assert len(store.browse(q="%_", limit=2, cursor=second["next_cursor"])["items"]) == 1
    assert store.browse(q="%missing")["items"] == []
    for kwargs in (
        {"q": "x" * 201},
        {"limit": 51},
        {"cursor": "invalid"},
        {"q": "other", "limit": 2, "cursor": first["next_cursor"]},
    ):
        with pytest.raises(WorkflowValidationError):
            store.browse(**kwargs)
    monkeypatch.setattr(
        module, "_verified_json_object", lambda *args: pytest.fail("metadata parsed payload")
    )
    assert store.browse()["items"]
    version_id = first["items"][0]["latest_version_id"]
    profiles = store.browse(workflow_version_id=version_id, limit=1)
    assert len(profiles["items"]) == 1 and profiles["next_cursor"]
    with pytest.raises(WorkflowValidationError):
        store.browse(workflow_version_id="different", limit=1, cursor=profiles["next_cursor"])


def test_global_version_foreign_keys_and_immutability(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = GlobalWorkflowStore(path)
    request = _source(path)
    first = store.copy(**request)
    second = store.copy(**{**request, "request_id": "second", "name": "Second"})
    with closing(open_connection(path)) as c:
        for table in (
            "global_workflow_version",
            "global_workflow_profile_version",
            "global_workflow_copy_receipt",
        ):
            with pytest.raises(sqlite3.IntegrityError, match="immutable"):
                c.execute(f"UPDATE {table} SET created_at='changed'")
        c.row_factory = sqlite3.Row
        row = dict(c.execute("SELECT * FROM global_workflow_profile_version LIMIT 1").fetchone())
        row.update(
            id="bad", version_number=2, workflow_version_id=second["workflow"]["version"]["id"]
        )
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            module._insert(c, "global_workflow_profile_version", row)
        assert c.execute("PRAGMA foreign_key_check").fetchall() == []
    assert first["workflow"]["version"]["id"] != second["workflow"]["version"]["id"]


def test_concurrent_retry_and_source_loss(tmp_path: Path) -> None:
    path = _database(tmp_path)
    request = _source(path)
    store = GlobalWorkflowStore(path)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(store.copy, **request) for _ in range(2)]
        first, second = [f.result() for f in futures]
    assert first == second
    with closing(open_connection(path)) as c:
        c.execute("DELETE FROM workflow_profile_version")
        c.execute("DELETE FROM workflow_profile")
        c.execute("DELETE FROM workflow_version")
        c.execute("DELETE FROM workflow")
        c.commit()
        assert c.execute("SELECT count(*) FROM global_workflow").fetchone() == (1,)
    assert store.copy(**request) == first
    assert store.get_version(first["workflow"]["version"]["id"])["workflow"] == _workflow()


def test_append_global_version_keeps_prior_copy_and_profile_target(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = GlobalWorkflowStore(path)
    imported = store.copy(**_source(path))
    old = imported["workflow"]["version"]
    new = store.create_version(old["workflow_id"], _workflow("new_seed"))
    assert new["version_number"] == 2
    assert store.get_version(old["id"]) == old
    assert store.browse()["items"][0]["latest_version_id"] == new["id"]
    assert store.browse(workflow_version_id=new["id"])["items"] == []
    with pytest.raises(WorkflowValidationError, match="exact"):
        store.copy(
            direction="use",
            request_id="wrong-target",
            project_id="project-2",
            workflow_version_id=new["id"],
            profiles=[{"version_id": imported["profiles"][0]["version"]["id"]}],
        )


@pytest.mark.parametrize(
    ("method", "kwargs"),
    [
        ("browse", {"q": "\ud800"}),
        ("browse", {"workflow_version_id": "\ud800"}),
        ("get_version", {"version_id": "\ud800"}),
        ("get_version", {"version_id": "\ud800", "profile": True}),
        ("create_version", {"workflow_id": "\ud800", "workflow": {}}),
    ],
)
def test_direct_catalog_inputs_reject_surrogates(
    tmp_path: Path, method: str, kwargs: dict[str, Any]
) -> None:
    path = _database(tmp_path)
    with pytest.raises(WorkflowValidationError, match="UTF-8"):
        getattr(GlobalWorkflowStore(path), method)(**kwargs)


@pytest.mark.parametrize(
    "field", ["request_id", "project_id", "workflow_version_id", "name", "description"]
)
def test_copy_text_inputs_reject_surrogates(tmp_path: Path, field: str) -> None:
    path = _database(tmp_path)
    request = _source(path)
    with pytest.raises(WorkflowValidationError, match="UTF-8"):
        GlobalWorkflowStore(path).copy(**{**request, field: "\ud800"})
    assert GlobalWorkflowStore(path).browse()["items"] == []


def test_unicode_search_cursor_round_trip_at_query_bound(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = GlobalWorkflowStore(path)
    request = _source(path)
    query = "\U0001f30d" * 200
    for index in range(2):
        store.copy(
            **{**request, "request_id": str(index), "name": str(index), "description": query}
        )
    first = store.browse(q=query, limit=1)
    assert len(first["next_cursor"]) <= 2048
    assert len(store.browse(q=query, limit=1, cursor=first["next_cursor"])["items"]) == 1
