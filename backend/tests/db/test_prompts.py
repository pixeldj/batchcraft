import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

import pytest

from batchcraft.db import (
    ProjectStore,
    PromptConflictError,
    PromptNameConflictError,
    PromptNotFoundError,
    PromptProjectNotFoundError,
    PromptStore,
    PromptValidationError,
    PromptVersionIdConflictError,
    apply_migrations,
    open_connection,
)

CREATED_AT = datetime(2026, 8, 28, 10, 0, tzinfo=UTC)


@pytest.mark.parametrize("selected_revision", [1, 2])
@pytest.mark.parametrize("archived", [False, True])
def test_delete_referenced_prompt_is_atomic(
    tmp_path: Path, selected_revision: int, archived: bool
) -> None:
    path = _database(tmp_path)
    store = PromptStore(path)
    prompt, first = store.create("project-1", "Protected", "first", note="Immutable")
    second = store.create_version(prompt.id, "second")
    selected = first if selected_revision == 1 else second
    if archived:
        store.archive_version(selected.id)
    with closing(open_connection(path)) as connection:
        connection.execute(
            """INSERT INTO batch (id, project_id, filesystem_key, name, revision,
            seed_mode, seed_values_json, created_at, updated_at, archived_at)
            VALUES ('batch', 'project-1', 'batch', 'Protected Batch', 1,
            'fixed', '[1]', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z', ?)""",
            ("2026-09-20T00:00:00Z" if archived else None,),
        )
        connection.execute(
            "INSERT INTO batch_prompt_selection VALUES ('batch', 1, ?)", (selected.id,)
        )
        connection.commit()
        before = list(connection.iterdump())
    with pytest.raises(PromptConflictError, match="Saved Batch"):
        store.delete(prompt.id)
    with closing(open_connection(path)) as connection:
        assert list(connection.iterdump()) == before


def test_delete_cascades_all_versions_but_preserves_other_projects(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = PromptStore(path)
    prompt, _ = store.create("project-1", "Delete", "first")
    second = store.create_version(prompt.id, "second")
    store.archive_version(second.id)
    ProjectStore(path).create("Other", "other", project_id="project-2")
    other, other_version = store.create("project-2", "Delete", "unrelated")
    store.delete(prompt.id)
    with closing(open_connection(path)) as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM prompt_version WHERE prompt_id = ?", (prompt.id,)
            ).fetchone()[0]
            == 0
        )
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    assert store.get(other.id) == other
    assert store.get_version(other_version.id) == other_version
    assert store.create("project-1", "Delete", "name released")[0].id != prompt.id
    with pytest.raises(PromptNotFoundError):
        store.delete(prompt.id)


def _database(tmp_path: Path) -> Path:
    path = tmp_path / "batchcraft.sqlite3"
    with closing(open_connection(path)) as connection:
        apply_migrations(connection)
    ProjectStore(path, clock=lambda: CREATED_AT).create(
        "Portraits", "project_portraits", project_id="project-1"
    )
    return path


def test_create_prompt_and_v1_is_atomic(tmp_path: Path) -> None:
    path = _database(tmp_path)
    ids = iter(("prompt-1", "version-1", "prompt-2", "version-1"))
    store = PromptStore(path, id_factory=lambda: next(ids), clock=lambda: CREATED_AT)

    prompt, version = store.create(
        "project-1",
        "Studio portrait",
        "A portrait of {{subject}}",
        description="Initial Prompt description",
        note=None,
    )

    assert prompt.id == "prompt-1"
    assert prompt.created_at == CREATED_AT
    assert prompt.description == "Initial Prompt description"
    assert version.id == "version-1"
    assert version.version_number == 1
    assert version.name_snapshot == prompt.name
    assert version.text == "A portrait of {{subject}}"
    assert version.note is None

    with pytest.raises(PromptVersionIdConflictError):
        store.create("project-1", "Temporary", "This must roll back")
    assert tuple(item.name for item in store.list("project-1")) == ("Studio portrait",)


def test_prompt_metadata_archive_and_project_scoped_name_conflict(tmp_path: Path) -> None:
    store = PromptStore(_database(tmp_path), id_factory=lambda: "unused", clock=lambda: CREATED_AT)
    first, _ = store.create(
        "project-1",
        "First",
        "First text",
        prompt_id="prompt-1",
        version_id="version-1",
    )
    store.create(
        "project-1",
        "Second",
        "Second text",
        prompt_id="prompt-2",
        version_id="version-2",
    )

    with pytest.raises(PromptNameConflictError):
        store.update_metadata("prompt-2", name="First")

    updated = store.update_metadata(first.id, name="Renamed", description="Current description")
    assert updated.updated_at == CREATED_AT
    assert updated.description == "Current description"
    archived = store.archive(first.id)
    assert archived.archived_at is not None
    assert tuple(item.id for item in store.list("project-1")) == ("prompt-2",)
    assert tuple(item.id for item in store.list("project-1", include_archived=True)) == (
        "prompt-1",
        "prompt-2",
    )
    assert store.get(first.id) == archived


def test_prompt_list_includes_latest_active_version_with_stable_order(tmp_path: Path) -> None:
    store = PromptStore(_database(tmp_path), clock=lambda: CREATED_AT)
    _, first_version = store.create(
        "project-1",
        "Original name",
        "First text",
        prompt_id="prompt-b",
        version_id="version-b1",
    )
    store.update_metadata("prompt-b", name="Current name")
    second_version = store.create_version("prompt-b", "Second text", version_id="version-b2")
    store.create(
        "project-1",
        "Sorted first",
        "Other text",
        prompt_id="prompt-a",
        version_id="version-a1",
    )

    listed = store.list("project-1")

    assert tuple(item.id for item in listed) == ("prompt-a", "prompt-b")
    assert listed[1].latest_active_version == second_version
    assert listed[1].latest_active_version.name_snapshot == "Current name"

    store.archive_version(second_version.id)
    fallback = store.list("project-1")[1].latest_active_version
    assert fallback == first_version
    assert fallback.name_snapshot == "Original name"

    store.archive_version(first_version.id)
    assert store.list("project-1")[1].latest_active_version is None


def test_next_version_snapshots_current_name_and_restore_copies_content(tmp_path: Path) -> None:
    ids = iter(("version-2", "version-3"))
    store = PromptStore(_database(tmp_path), id_factory=lambda: next(ids), clock=lambda: CREATED_AT)
    _, first = store.create(
        "project-1",
        "Original name",
        "Original text",
        note="Initial note",
        prompt_id="prompt-1",
        version_id="version-1",
    )
    store.update_metadata("prompt-1", name="Current name")

    second = store.create_version("prompt-1", "Changed text", note=None)
    store.archive_version(first.id)
    restored = store.restore_version(first.id)

    assert second.version_number == 2
    assert second.name_snapshot == "Current name"
    assert restored.version_number == 3
    assert restored.name_snapshot == "Current name"
    assert restored.text == first.text
    assert restored.note == first.note
    assert tuple(item.id for item in store.list_versions("prompt-1")) == (
        "version-2",
        "version-3",
    )
    assert tuple(item.id for item in store.list_versions("prompt-1", include_archived=True)) == (
        "version-1",
        "version-2",
        "version-3",
    )


def test_concurrent_version_creation_allocates_unique_monotonic_numbers(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = PromptStore(path, clock=lambda: CREATED_AT)
    store.create(
        "project-1",
        "Prompt",
        "Initial text",
        prompt_id="prompt-1",
        version_id="version-1",
    )

    def create_version(index: int) -> int:
        version = PromptStore(path, clock=lambda: CREATED_AT).create_version(
            "prompt-1", f"Text {index}", version_id=f"version-{index + 2}"
        )
        return version.version_number

    with ThreadPoolExecutor(max_workers=2) as executor:
        numbers = tuple(executor.map(create_version, range(2)))

    assert set(numbers) == {2, 3}
    assert tuple(version.version_number for version in store.list_versions("prompt-1")) == (1, 2, 3)


def test_prompt_versions_are_immutable_except_for_archive(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = PromptStore(path, clock=lambda: CREATED_AT)
    store.create(
        "project-1",
        "Prompt",
        "Text",
        prompt_id="prompt-1",
        version_id="version-1",
    )

    with (
        closing(open_connection(path)) as connection,
        connection,
        pytest.raises(sqlite3.IntegrityError, match="immutable"),
    ):
        connection.execute(
            "UPDATE prompt_version SET text = ? WHERE id = ?", ("Changed", "version-1")
        )


def test_prompt_validation_and_not_found_errors_are_typed(tmp_path: Path) -> None:
    store = PromptStore(_database(tmp_path), clock=lambda: CREATED_AT)

    with pytest.raises(PromptProjectNotFoundError):
        store.create("missing", "Prompt", "Text", prompt_id="prompt-1", version_id="version-1")
    with pytest.raises(PromptValidationError):
        store.create("project-1", "Prompt", "  ", prompt_id="prompt-1", version_id="version-1")
    with pytest.raises(PromptValidationError):
        store.create(
            "project-1",
            "Prompt",
            "Text",
            note=" ",
            prompt_id="prompt-1",
            version_id="version-1",
        )
    with pytest.raises(PromptNotFoundError):
        store.create_version("missing", "Text", version_id="version-1")
