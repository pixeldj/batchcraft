from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from batchcraft.db import (
    ProjectFilesystemKeyConflictError,
    ProjectIdConflictError,
    ProjectNameConflictError,
    ProjectNotFoundError,
    ProjectStore,
    ProjectValidationError,
    apply_migrations,
    open_connection,
)

CREATED_AT = datetime(2026, 8, 28, 10, 0, tzinfo=UTC)
UPDATED_AT = CREATED_AT + timedelta(hours=1)


def _database(tmp_path: Path) -> Path:
    path = tmp_path / "batchcraft.sqlite3"
    with closing(open_connection(path)) as connection:
        apply_migrations(connection)
    return path


def test_create_get_update_and_archive_project(tmp_path: Path) -> None:
    times = iter((CREATED_AT, UPDATED_AT, UPDATED_AT + timedelta(hours=1)))
    store = ProjectStore(
        _database(tmp_path),
        id_factory=lambda: "project-1",
        clock=lambda: next(times),
    )

    created = store.create(
        "Portraits", "project_portraits", description="Initial Project description"
    )

    assert created.id == "project-1"
    assert created.created_at == CREATED_AT
    assert created.updated_at == CREATED_AT
    assert created.archived_at is None
    assert created.description == "Initial Project description"
    assert store.get(created.id) == created
    assert store.list() == (created,)

    updated = store.update_metadata(
        created.id, name="Portrait studies", description="Current Project description"
    )
    assert updated.name == "Portrait studies"
    assert updated.filesystem_key == created.filesystem_key
    assert updated.description == "Current Project description"
    assert updated.updated_at == UPDATED_AT

    archived = store.archive(created.id)
    assert archived.archived_at == UPDATED_AT + timedelta(hours=1)
    assert store.list() == ()
    assert store.list(include_archived=True) == (archived,)
    assert store.get(created.id) == archived


@pytest.mark.parametrize(
    ("project_id", "name", "filesystem_key", "error_type"),
    (
        ("project-1", "Other", "other", ProjectIdConflictError),
        ("project-2", "Portraits", "other", ProjectNameConflictError),
        ("project-2", "Other", "project_portraits", ProjectFilesystemKeyConflictError),
    ),
)
def test_create_maps_project_conflicts(
    tmp_path: Path,
    project_id: str,
    name: str,
    filesystem_key: str,
    error_type: type[Exception],
) -> None:
    store = ProjectStore(_database(tmp_path), clock=lambda: CREATED_AT)
    store.create("Portraits", "project_portraits", project_id="project-1")

    with pytest.raises(error_type):
        store.create(name, filesystem_key, project_id=project_id)


def test_update_maps_name_conflict_and_missing_project(tmp_path: Path) -> None:
    store = ProjectStore(_database(tmp_path), clock=lambda: CREATED_AT)
    store.create("First", "first", project_id="project-1")
    store.create("Second", "second", project_id="project-2")

    with pytest.raises(ProjectNameConflictError):
        store.update_metadata("project-2", name="First")
    with pytest.raises(ProjectNotFoundError):
        store.archive("missing")


@pytest.mark.parametrize(("name", "key"), (("", "key"), ("name", "  ")))
def test_create_rejects_blank_project_values(tmp_path: Path, name: str, key: str) -> None:
    store = ProjectStore(_database(tmp_path), id_factory=lambda: "project-1")

    with pytest.raises(ProjectValidationError):
        store.create(name, key)


def test_project_rejects_blank_optional_description(tmp_path: Path) -> None:
    store = ProjectStore(_database(tmp_path), id_factory=lambda: "project-1")

    with pytest.raises(ProjectValidationError):
        store.create("Project", "project", description=" ")
