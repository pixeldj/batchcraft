import base64
import importlib
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

from batchcraft.db import apply_migrations, open_connection
from batchcraft.db import global_workflows as module
from batchcraft.db.global_workflows import GlobalWorkflowStore
from batchcraft.db.workflows import (
    WorkflowConflictError,
    WorkflowProfileValidationError,
    WorkflowValidationError,
)
from db.test_global_workflows import _source
from db.test_migrations import _migration_package
from db.test_workflows import _database, _image_inputs, _mappings, _workflow


def _setup(store: GlobalWorkflowStore) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    workflow = store.save_workflow(request_id="create", name="Direct", workflow=_workflow())
    request = dict(
        workflow_id=workflow["workflow"]["id"],
        workflow_version_id=workflow["version"]["id"],
        name="Profile",
        mappings=_mappings(),
        image_inputs=_image_inputs(),
        parameters=[],
    )
    profile = store.save_profile(request_id="profile", **request)
    sibling = store.save_profile(request_id="sibling", **{**request, "name": "Sibling"})
    return workflow, profile, sibling


def test_direct_edit_repair_preserves_snapshots_siblings_and_copy_receipts(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = GlobalWorkflowStore(path)
    w, p, sibling = _setup(store)
    wid, pid = w["workflow"]["id"], p["workflow_profile"]["id"]
    assert w["workflow"]["source"] == {"scope": "library"}
    copied_request = dict(
        direction="use",
        request_id="create",
        project_id="project-2",
        workflow_version_id=w["version"]["id"],
        profiles=[{"version_id": p["version"]["id"]}],
    )
    copied = store.copy(**copied_request)
    store.update_metadata(
        wid, request_id="rename", changes={"name": "Renamed", "description": "New description"}
    )
    store.update_metadata(
        pid, request_id="rename-profile", profile=True, changes={"name": "Repaired"}
    )
    new = store.save_workflow(
        request_id="edit", workflow_id=wid, workflow=_workflow("new_seed"), note="New target"
    )
    families = store.history(wid, kind="profiles", workflow_version_id=new["id"])["items"]
    assert len(families) == 2
    assert all(row["latest_compatible_version"] is None for row in families)
    assert {row["latest_active_version_id"] for row in families} == {
        p["version"]["id"],
        sibling["version"]["id"],
    }
    request = dict(
        profile_id=pid,
        workflow_version_id=new["id"],
        mappings=_mappings(),
        image_inputs=_image_inputs(),
        parameters=[],
    )
    with pytest.raises(WorkflowProfileValidationError):
        store.save_profile(request_id="repair", **request)
    repaired = store.save_profile(
        request_id="repair", **{**request, "mappings": _mappings("new_seed")}
    )
    assert repaired["version_number"] == 2 and repaired["name_snapshot"] == "Repaired"
    assert repaired["profile"]["id"] == pid
    assert repaired["profile"]["image_inputs"] == p["version"]["profile"]["image_inputs"]
    assert new["name_snapshot"] == "Renamed" and new["version_number"] == 2
    for original, profile in (
        (w["version"], False),
        (p["version"], True),
        (sibling["version"], True),
    ):
        assert store.get_version(original["id"], profile=profile) == original
    assert store.copy(**copied_request) == copied
    assert (
        store.history(wid, kind="profiles", workflow_version_id=w["version"]["id"])["items"][0][
            "latest_compatible_version_id"
        ]
        == p["version"]["id"]
    )
    other = store.save_workflow(request_id="other", name="Other", workflow=_workflow())
    with pytest.raises(WorkflowValidationError, match="family"):
        store.save_profile(
            request_id="cross-family", **{**request, "workflow_version_id": other["version"]["id"]}
        )
    with pytest.raises(WorkflowValidationError, match="family"):
        store.history(wid, kind="profiles", workflow_version_id=other["version"]["id"])


@pytest.mark.parametrize(
    "kind", ["workflow", "workflow_profile", "workflow_version", "workflow_profile_version"]
)
def test_archive_explicit_retry_and_names_remain_reserved(tmp_path: Path, kind: str) -> None:
    store = GlobalWorkflowStore(_database(tmp_path))
    w, p, _ = _setup(store)
    row = {
        "workflow": w["workflow"],
        "workflow_version": w["version"],
        "workflow_profile": p["workflow_profile"],
        "workflow_profile_version": p["version"],
    }[kind]
    request = dict(row_id=row["id"], request_id="archive", archived=True, kind=kind)
    archived = store.set_archived(**request)
    assert archived["archived_at"] is not None
    if kind == "workflow":
        assert store.browse()["items"] == []
        assert len(store.browse(include_archived=True)["items"]) == 1
        with pytest.raises(WorkflowConflictError):
            store.save_workflow(request_id="collision", name="Direct", workflow=_workflow())
    if kind == "workflow_profile":
        assert len(store.history(w["workflow"]["id"], kind="profiles")["items"]) == 1
        with pytest.raises(WorkflowConflictError):
            store.save_profile(
                request_id="collision",
                workflow_id=w["workflow"]["id"],
                workflow_version_id=w["version"]["id"],
                name="Profile",
                mappings=_mappings(),
                image_inputs=[],
                parameters=[],
            )
    if kind == "workflow_version":
        assert store.get_workflow(w["workflow"]["id"])["latest_version_id"] is None
        assert store.history(w["workflow"]["id"], kind="workflows")["items"] == []
        assert (
            len(
                store.history(w["workflow"]["id"], kind="workflows", include_archived=True)["items"]
            )
            == 1
        )
    if kind == "workflow_profile_version":
        family = store.history(w["workflow"]["id"], kind="profiles")["items"][0]
        assert family["latest_active_version_id"] is None
        assert family["latest_compatible_version"] is None
    unarchived = store.set_archived(**{**request, "request_id": "restore", "archived": False})
    assert unarchived["archived_at"] is None
    assert GlobalWorkflowStore(store.database_path).set_archived(**request) == archived
    with pytest.raises(WorkflowConflictError):
        store.set_archived(**{**request, "archived": False})
    if kind.endswith("version"):
        assert unarchived == row


@pytest.mark.parametrize(
    "operation", ["create", "append", "profile", "repair", "metadata", "archive"]
)
def test_authoring_receipt_failure_rolls_back_and_retries_original_response(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    path = _database(tmp_path)
    store = GlobalWorkflowStore(path)
    w, p, _ = _setup(store)
    wid, pid = w["workflow"]["id"], p["workflow_profile"]["id"]
    methods: dict[str, tuple[Any, dict[str, Any]]] = {
        "create": (store.save_workflow, dict(name="Fresh", workflow=_workflow())),
        "append": (store.save_workflow, dict(workflow_id=wid, workflow=_workflow())),
        "profile": (
            store.save_profile,
            dict(
                workflow_id=wid,
                name="Fresh",
                workflow_version_id=w["version"]["id"],
                mappings=_mappings(),
                image_inputs=[],
                parameters=[],
            ),
        ),
        "repair": (
            store.save_profile,
            dict(
                profile_id=pid,
                workflow_version_id=w["version"]["id"],
                mappings=_mappings(),
                image_inputs=[],
                parameters=[],
            ),
        ),
        "metadata": (store.update_metadata, dict(row_id=wid, changes={"description": "Changed"})),
        "archive": (store.set_archived, dict(row_id=pid, kind="workflow_profile", archived=True)),
    }
    method, request = methods[operation]
    request["request_id"] = "operation"
    with closing(open_connection(path)) as c:
        before = list(c.iterdump())
    insert = module._insert

    def fail(c: sqlite3.Connection, table: str, values: dict[str, Any]) -> None:
        insert(c, table, values)
        if table == "global_workflow_authoring_receipt":
            raise RuntimeError("receipt failure")

    monkeypatch.setattr(module, "_insert", fail)
    with pytest.raises(RuntimeError, match="receipt failure"):
        method(**request)
    with closing(open_connection(path)) as c:
        assert list(c.iterdump()) == before
    monkeypatch.setattr(module, "_insert", insert)
    response = method(**request)
    store.update_metadata(wid, request_id="later-rename", changes={"name": "Later"})
    store.set_archived(wid, request_id="later-archive", kind="workflow", archived=True)
    assert method(**request) == response
    with pytest.raises(WorkflowConflictError):
        store.update_metadata(wid, request_id="operation", changes={"name": "Conflicting"})


def test_simultaneous_append_retry_waits_for_committed_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _database(tmp_path)
    store = GlobalWorkflowStore(path)
    w, _, _ = _setup(store)
    entered, release, second_started = threading.Event(), threading.Event(), threading.Event()
    insert = module._insert

    def pause(c: sqlite3.Connection, table: str, values: dict[str, Any]) -> None:
        insert(c, table, values)
        if table == "global_workflow_authoring_receipt":
            entered.set()
            assert release.wait(5)

    monkeypatch.setattr(module, "_insert", pause)
    request = dict(request_id="concurrent", workflow_id=w["workflow"]["id"], workflow=_workflow())

    def retry() -> dict[str, Any]:
        second_started.set()
        return GlobalWorkflowStore(path).save_workflow(**request)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(store.save_workflow, **request)
        try:
            assert entered.wait(5)
            second = pool.submit(retry)
            assert second_started.wait(5)
            assert not second.done()
        finally:
            release.set()
        assert first.result(timeout=5) == second.result(timeout=5)
    assert len(store.history(w["workflow"]["id"], kind="workflows")["items"]) == 2


def test_metadata_history_bounds_scope_and_no_payload_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = GlobalWorkflowStore(_database(tmp_path))
    w, p, _ = _setup(store)
    wid, pid = w["workflow"]["id"], p["workflow_profile"]["id"]
    for i in range(3):
        store.save_workflow(
            request_id=f"w{i}", workflow_id=wid, workflow=_workflow(), note="%_note"
        )
        store.save_profile(
            request_id=f"p{i}",
            profile_id=pid,
            workflow_version_id=w["version"]["id"],
            mappings=_mappings(),
            image_inputs=[],
            parameters=[],
            note="%_note",
        )
    monkeypatch.setattr(
        module, "_verified_json_object", lambda *args: pytest.fail("parsed payload")
    )
    for kind, owner in (("workflows", wid), ("profiles", wid), ("profile_versions", pid)):
        request = dict(owner_id=owner, kind=kind, limit=1)
        first = store.history(**request)
        assert first["next_cursor"]
        seen = {first["items"][0]["id"]}
        page = first
        while page["next_cursor"]:
            page = store.history(**request, cursor=page["next_cursor"])
            assert len(page["items"]) == 1
            assert page["items"][0]["id"] not in seen
            seen.add(page["items"][0]["id"])
        for change in (
            {"kind": "profiles" if kind != "profiles" else "workflows"},
            {"owner_id": "other"},
            {"workflow_version_id": w["version"]["id"]},
            {"include_archived": True},
            {"q": "other"},
            {"limit": 2},
        ):
            with pytest.raises(WorkflowValidationError, match="cursor"):
                store.history(**{**request, **change, "cursor": first["next_cursor"]})
        binding = json.loads(base64.urlsafe_b64decode(first["next_cursor"]))["binding"]
        invalid_values: list[Any] = [
            None,
            [],
            1,
            "x",
            {},
            {"binding": binding, "after": ["\ud800", ""]},
            {"binding": binding, "after": {}},
            {"binding": binding, "after": [1, ""]},
        ]
        for invalid in invalid_values:
            cursor = base64.urlsafe_b64encode(json.dumps(invalid).encode()).decode()
            with pytest.raises(WorkflowValidationError):
                store.history(**request, cursor=cursor)
        assert "workflow_json" not in str(first) and "profile_json" not in str(first)
    assert len(store.history(wid, kind="workflows", q="%_note")["items"]) == 3
    assert (
        len(
            store.history(pid, kind="profile_versions", workflow_version_id=w["version"]["id"])[
                "items"
            ]
        )
        == 4
    )


def test_migration_five_to_six_preserves_catalog_project_and_copy_receipts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    migration_root = Path(module.__file__).parent / "migrations"
    prior = _migration_package(
        tmp_path,
        "prior_global_authoring",
        {path.name: path.read_text() for path in sorted(migration_root.glob("*.sql"))[:5]},
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()
    path = tmp_path / "prior.sqlite3"
    with closing(open_connection(path)) as c:
        apply_migrations(c, package=prior)
        c.execute(
            "INSERT INTO project VALUES ('project-1','one','One',NULL,'created','updated',NULL)"
        )
        c.commit()
    store = GlobalWorkflowStore(path)
    request = _source(path)
    imported = store.copy(**request)
    with closing(open_connection(path)) as c:
        tables = [row[0] for row in c.execute("SELECT name FROM sqlite_schema WHERE type='table'")]
        before = {table: c.execute(f"SELECT * FROM {table}").fetchall() for table in tables}
        apply_migrations(c)
        for table in tables:
            after = c.execute(f"SELECT * FROM {table}").fetchall()
            assert (
                after[:5] == before[table]
                if table == "schema_migration"
                else after == before[table]
            )
        assert c.execute("PRAGMA foreign_key_check").fetchall() == []
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            c.execute("UPDATE global_workflow_copy_receipt SET created_at='changed'")
    assert store.copy(**request) == imported
    created = store.save_workflow(request_id="import-1", name="Direct", workflow=_workflow())
    assert created["version"]["version_number"] == 1
    with (
        closing(open_connection(path)) as c,
        pytest.raises(sqlite3.IntegrityError, match="immutable"),
    ):
        c.execute("UPDATE global_workflow_authoring_receipt SET created_at='changed'")
