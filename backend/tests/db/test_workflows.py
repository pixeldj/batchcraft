import hashlib
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

import pytest

from batchcraft.db import (
    ProjectStore,
    WorkflowProfileOwnershipError,
    WorkflowProfileStore,
    WorkflowProfileValidationError,
    WorkflowStore,
    WorkflowValidationError,
    apply_migrations,
    open_connection,
)
from batchcraft.files._io import canonical_json_bytes

NOW = datetime(2026, 8, 30, 10, 0, tzinfo=UTC)


def _workflow(seed_input: str = "seed") -> dict[str, object]:
    return {
        "7": {"class_type": "KSampler", "inputs": {seed_input: 1}},
        "25": {"class_type": "LoadImage", "inputs": {"image": "original.png"}},
        "34": {"class_type": "TextEncode", "inputs": {"prompt": "original"}},
        "41": {"class_type": "SaveImage", "inputs": {"filename_prefix": "original"}},
    }


def _mappings(seed_input: str = "seed") -> dict[str, object]:
    return {
        "prompt": {"node_id": "34", "input_name": "prompt", "value_type": "string"},
        "seed": {"node_id": "7", "input_name": seed_input, "value_type": "integer"},
        "output_prefix": {
            "node_id": "41",
            "input_name": "filename_prefix",
            "value_type": "string",
        },
    }


def _image_inputs() -> list[object]:
    return [{"key": "reference", "label": "Reference", "node_id": "25", "input_name": "image"}]


def _database(tmp_path: Path) -> Path:
    path = tmp_path / "batchcraft.sqlite3"
    with closing(open_connection(path)) as connection:
        apply_migrations(connection)
    projects = ProjectStore(path, clock=lambda: NOW)
    projects.create("One", "one", project_id="project-1")
    projects.create("Two", "two", project_id="project-2")
    return path


def test_workflow_versions_are_canonical_hashed_snapshots_and_allow_duplicates(
    tmp_path: Path,
) -> None:
    path = _database(tmp_path)
    store = WorkflowStore(path, clock=lambda: NOW)
    value = _workflow()
    logical, first = store.create(
        "project-1",
        "Original",
        value,
        description="Description",
        workflow_id="workflow-1",
        version_id="workflow-version-1",
    )
    store.update_metadata(logical.id, name="Renamed")
    second = store.create_version(
        logical.id, dict(reversed(tuple(value.items()))), version_id="workflow-version-2"
    )

    expected = canonical_json_bytes(value)
    assert first.content_sha256 == hashlib.sha256(expected).hexdigest()
    assert second.content_sha256 == first.content_sha256
    assert second.version_number == 2
    assert first.name_snapshot == "Original"
    assert second.name_snapshot == "Renamed"
    assert WorkflowStore(path).get_version(first.id).workflow == value

    with closing(open_connection(path)) as connection:
        assert connection.execute(
            "SELECT workflow_json FROM workflow_version WHERE id = ?", (first.id,)
        ).fetchone() == (expected.decode("ascii"),)
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "UPDATE workflow_version SET content_sha256 = ? WHERE id = ?",
                ("0" * 64, first.id),
            )


def test_profile_versions_validate_exact_target_and_list_latest_compatible(
    tmp_path: Path,
) -> None:
    path = _database(tmp_path)
    workflows = WorkflowStore(path, clock=lambda: NOW)
    _, target_one = workflows.create(
        "project-1",
        "Workflow",
        _workflow(),
        workflow_id="workflow-1",
        version_id="workflow-version-1",
    )
    target_two = workflows.create_version(
        "workflow-1",
        _workflow("noise_seed"),
        version_id="workflow-version-2",
    )
    target_three = workflows.create_version(
        "workflow-1",
        _workflow("another_seed"),
        version_id="workflow-version-3",
    )
    _, foreign_target = workflows.create(
        "project-2",
        "Foreign",
        _workflow(),
        workflow_id="workflow-2",
        version_id="workflow-version-foreign",
    )
    profiles = WorkflowProfileStore(path, clock=lambda: NOW)
    profile, first = profiles.create(
        "workflow-1",
        "Profile",
        target_one.id,
        _mappings(),
        _image_inputs(),
        profile_id="profile-1",
        version_id="profile-version-1",
    )
    profiles.update_metadata(profile.id, name="Renamed Profile")
    duplicate = profiles.create_version(
        profile.id,
        target_one.id,
        _mappings(),
        _image_inputs(),
        version_id="profile-version-2",
    )
    compatible_two = profiles.create_version(
        profile.id,
        target_two.id,
        _mappings("noise_seed"),
        _image_inputs(),
        version_id="profile-version-3",
    )

    assert first.project_id == "project-1"
    assert first.profile == {
        "id": profile.id,
        "name": "Profile",
        "mappings": _mappings(),
        "image_inputs": _image_inputs(),
    }
    assert duplicate.profile == {
        "id": profile.id,
        "name": "Renamed Profile",
        "mappings": _mappings(),
        "image_inputs": _image_inputs(),
    }
    assert duplicate.content_sha256 != first.content_sha256
    assert duplicate.name_snapshot == "Renamed Profile"
    assert (
        profiles.list("workflow-1", workflow_version_id=target_one.id)[0].latest_compatible_version
        == duplicate
    )
    assert (
        profiles.list("workflow-1", workflow_version_id=target_two.id)[0].latest_compatible_version
        == compatible_two
    )
    no_compatible_version = profiles.list("workflow-1", workflow_version_id=target_three.id)
    assert [item.id for item in no_compatible_version] == [profile.id]
    assert no_compatible_version[0].latest_compatible_version is None

    with pytest.raises(WorkflowProfileValidationError, match="missing input 'seed'"):
        profiles.create_version(profile.id, target_two.id, _mappings(), _image_inputs())
    with pytest.raises(WorkflowProfileOwnershipError):
        profiles.create_version(profile.id, foreign_target.id, _mappings(), _image_inputs())

    profiles.archive_version(compatible_two.id)
    assert profiles.list("workflow-1")[0].latest_compatible_version == duplicate


def test_profile_version_persists_without_image_inputs(tmp_path: Path) -> None:
    path = _database(tmp_path)
    workflows = WorkflowStore(path, clock=lambda: NOW)
    _, target = workflows.create(
        "project-1",
        "Workflow",
        _workflow(),
        workflow_id="workflow-1",
        version_id="workflow-version-1",
    )
    mappings = _mappings()

    _, version = WorkflowProfileStore(path, clock=lambda: NOW).create(
        "workflow-1",
        "Text only",
        target.id,
        mappings,
        [],
        profile_id="profile-1",
        version_id="profile-version-1",
    )

    assert version.profile["mappings"] == mappings
    assert version.profile["image_inputs"] == []


def test_database_enforces_profile_project_target_and_version_immutability(
    tmp_path: Path,
) -> None:
    path = _database(tmp_path)
    workflows = WorkflowStore(path, clock=lambda: NOW)
    _, target = workflows.create(
        "project-1",
        "Workflow",
        _workflow(),
        workflow_id="workflow-1",
        version_id="workflow-version-1",
    )
    profiles = WorkflowProfileStore(path, clock=lambda: NOW)
    _, version = profiles.create(
        "workflow-1",
        "Profile",
        target.id,
        _mappings(),
        _image_inputs(),
        profile_id="profile-1",
        version_id="profile-version-1",
    )

    with closing(open_connection(path)) as connection:
        row = connection.execute(
            "SELECT * FROM workflow_profile_version WHERE id = ?", (version.id,)
        ).fetchone()
        assert row is not None
        invalid = list(row)
        invalid[0] = "profile-version-invalid"
        invalid[2] = "workflow-2"
        invalid[3] = "project-2"
        invalid[5] = 2
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            connection.execute(
                "INSERT INTO workflow_profile_version VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                invalid,
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "UPDATE workflow_profile_version SET profile_json = '{}' WHERE id = ?",
                (version.id,),
            )


def test_version_reads_reject_noncanonical_or_mismatched_content(tmp_path: Path) -> None:
    path = _database(tmp_path)
    workflows = WorkflowStore(path, clock=lambda: NOW)
    _, version = workflows.create(
        "project-1",
        "Workflow",
        _workflow(),
        workflow_id="workflow-1",
        version_id="workflow-version-1",
    )

    with closing(open_connection(path)) as connection:
        connection.execute("DROP TRIGGER workflow_version_immutable")
        connection.execute(
            "UPDATE workflow_version SET workflow_json = ? WHERE id = ?",
            ('{ "changed": true }', version.id),
        )
        connection.commit()

    with pytest.raises(ValueError, match="canonical JSON"):
        workflows.get_version(version.id)


def test_create_validation_is_atomic_and_rejects_non_api_workflow(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = WorkflowStore(path, clock=lambda: NOW)

    with pytest.raises(WorkflowValidationError, match="class_type"):
        store.create(
            "project-1",
            "Invalid",
            {"1": {"inputs": {}}},
            workflow_id="workflow-invalid",
            version_id="workflow-version-invalid",
        )

    assert store.list("project-1") == ()
