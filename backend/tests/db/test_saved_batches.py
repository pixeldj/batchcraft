import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from batchcraft.db import (
    ProjectStore,
    PromptStore,
    SavedBatchConflictError,
    SavedBatchDefinition,
    SavedBatchImageBinding,
    SavedBatchIntegrityError,
    SavedBatchPromptSelection,
    SavedBatchSeedIntent,
    SavedBatchSeedMode,
    SavedBatchStore,
    SavedBatchStoreError,
    SavedBatchValidationError,
    SavedBatchVariableBinding,
    SavedBatchWorkflowProfileVersionSnapshot,
    SavedBatchWorkflowVersionSnapshot,
    WorkflowProfileStore,
    WorkflowStore,
    apply_migrations,
    open_connection,
)

NOW = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)


def _workflow() -> dict[str, object]:
    return {
        "7": {"class_type": "KSampler", "inputs": {"seed": 1}},
        "25": {
            "class_type": "LoadImage",
            "inputs": {"image": "input.png", "mask": "mask.png"},
        },
        "34": {"class_type": "TextEncode", "inputs": {"prompt": "original"}},
        "41": {"class_type": "SaveImage", "inputs": {"filename_prefix": "original"}},
    }


def _mappings() -> dict[str, object]:
    return {
        "prompt": {"node_id": "34", "input_name": "prompt", "value_type": "string"},
        "seed": {"node_id": "7", "input_name": "seed", "value_type": "integer"},
        "output_prefix": {
            "node_id": "41",
            "input_name": "filename_prefix",
            "value_type": "string",
        },
    }


def _image_inputs() -> list[object]:
    return [
        {"key": "reference", "label": "Reference", "node_id": "25", "input_name": "image"},
        {"key": "mask", "label": "Mask", "node_id": "25", "input_name": "mask"},
    ]


def _database(tmp_path: Path) -> Path:
    path = tmp_path / "batchcraft.sqlite3"
    with closing(open_connection(path)) as connection:
        apply_migrations(connection)
    projects = ProjectStore(path, clock=lambda: NOW)
    projects.create("One", "one", project_id="project-1")
    projects.create("Two", "two", project_id="project-2")
    return path


def _complete_definition(path: Path, project_id: str = "project-1") -> SavedBatchDefinition:
    prompts = PromptStore(path, clock=lambda: NOW)
    _, first = prompts.create(
        project_id,
        "First",
        "{{subject}} one",
        prompt_id=f"prompt-{project_id}-1",
        version_id=f"prompt-version-{project_id}-1",
    )
    _, second = prompts.create(
        project_id,
        "Second",
        "{{subject}} two",
        prompt_id=f"prompt-{project_id}-2",
        version_id=f"prompt-version-{project_id}-2",
    )
    workflows = WorkflowStore(path, clock=lambda: NOW)
    workflow, version = workflows.create(
        project_id,
        "Workflow",
        _workflow(),
        workflow_id=f"workflow-{project_id}",
        version_id=f"workflow-version-{project_id}",
    )
    profiles = WorkflowProfileStore(path, clock=lambda: NOW)
    profile, profile_version = profiles.create(
        workflow.id,
        "Profile",
        version.id,
        _mappings(),
        _image_inputs(),
        profile_id=f"profile-{project_id}",
        version_id=f"profile-version-{project_id}",
    )
    return SavedBatchDefinition(
        name="Complete",
        description="Description",
        seed_intent=SavedBatchSeedIntent(SavedBatchSeedMode.EXPLICIT, (7, 11)),
        prompt_selections=(
            SavedBatchPromptSelection(second.id, second.name_snapshot, second.text),
            SavedBatchPromptSelection(first.id, first.name_snapshot, first.text),
        ),
        variable_bindings=(
            SavedBatchVariableBinding("subject", ("dog", "cat")),
            SavedBatchVariableBinding("style", ("",)),
        ),
        image_bindings=(
            SavedBatchImageBinding("reference", (None, "asset-2", "asset-1")),
            SavedBatchImageBinding("mask", ("asset-mask-2", "asset-mask-1")),
        ),
        selected_workflow_version=SavedBatchWorkflowVersionSnapshot(
            version.id, version.content_sha256, version.workflow
        ),
        selected_workflow_profile_id=profile.id,
        selected_workflow_profile_version=SavedBatchWorkflowProfileVersionSnapshot(
            profile_version.id,
            profile.id,
            version.id,
            profile_version.content_sha256,
            profile_version.profile,
        ),
    )


def test_incomplete_saved_batch_roundtrips(tmp_path: Path) -> None:
    path = _database(tmp_path)
    definition = SavedBatchDefinition(
        name="Draft",
        description=None,
        seed_intent=SavedBatchSeedIntent(SavedBatchSeedMode.RANDOM, random_seed_count=3),
        variable_bindings=(SavedBatchVariableBinding("", ()),),
    )

    saved = SavedBatchStore(path, id_factory=lambda: "batch-1", clock=lambda: NOW).create(
        "project-1", "batch_key", definition
    )

    assert saved.id == "batch-1"
    assert saved.revision == 1
    assert saved.prompt_selections == ()
    assert saved.selected_workflow_version is None
    assert saved.variable_bindings == definition.variable_bindings
    assert SavedBatchStore(path).list("project-1")[0].name == "Draft"
    with closing(open_connection(path)) as connection:
        assert connection.execute(
            "SELECT placeholder, values_json FROM batch_variable_binding WHERE batch_id = ?",
            (saved.id,),
        ).fetchone() == ("", "[]\n")


def test_complete_roundtrip_preserves_binding_order_and_canonical_rows(
    tmp_path: Path,
) -> None:
    path = _database(tmp_path)
    definition = _complete_definition(path)
    saved = SavedBatchStore(path, clock=lambda: NOW).create(
        "project-1", "complete", definition, batch_id="batch-complete"
    )

    assert tuple(item.prompt_version_id for item in saved.prompt_selections) == (
        "prompt-version-project-1-2",
        "prompt-version-project-1-1",
    )
    assert saved.variable_bindings == definition.variable_bindings
    assert saved.image_bindings == definition.image_bindings
    assert saved.selected_workflow_version is not None
    assert definition.selected_workflow_version is not None
    assert saved.selected_workflow_version.id == definition.selected_workflow_version.id
    assert saved.selected_workflow_version.workflow_name == "Workflow"
    assert saved.selected_workflow_version.version_number == 1
    assert saved.selected_workflow_version.name_snapshot == "Workflow"
    assert saved.selected_workflow_profile_version is not None
    assert definition.selected_workflow_profile_version is not None
    assert (
        saved.selected_workflow_profile_version.id
        == definition.selected_workflow_profile_version.id
    )
    assert saved.selected_workflow_profile_version.workflow_profile_name == "Profile"
    assert saved.selected_workflow_profile_version.version_number == 1
    assert saved.selected_workflow_profile_name == "Profile"
    assert saved.selected_workflow_profile_archived_at is None
    assert saved.prompt_selections[0].prompt_id == "prompt-project-1-2"
    assert saved.prompt_selections[0].prompt_name == "Second"
    assert saved.prompt_selections[0].version_number == 1
    with closing(open_connection(path)) as connection:
        assert connection.execute(
            "SELECT seed_values_json FROM batch WHERE id = 'batch-complete'"
        ).fetchone() == ("[7,11]\n",)
        assert connection.execute(
            "SELECT batch_id, position, placeholder, values_json "
            "FROM batch_variable_binding WHERE batch_id = 'batch-complete' "
            "ORDER BY position"
        ).fetchall() == [
            ("batch-complete", 1, "subject", '["dog","cat"]\n'),
            ("batch-complete", 2, "style", '[""]\n'),
        ]
        assert connection.execute(
            "SELECT position, slot_key FROM batch_image_binding "
            "WHERE batch_id = 'batch-complete' ORDER BY position"
        ).fetchall() == [(1, "reference"), (2, "mask")]
        assert connection.execute(
            "SELECT binding_position, value_position, asset_id "
            "FROM batch_image_binding_value WHERE batch_id = 'batch-complete' "
            "ORDER BY binding_position, value_position"
        ).fetchall() == [
            (1, 1, None),
            (1, 2, "asset-2"),
            (1, 3, "asset-1"),
            (2, 1, "asset-mask-2"),
            (2, 2, "asset-mask-1"),
        ]

    logical_profile_only = replace(
        definition,
        image_bindings=(),
        selected_workflow_profile_version=None,
    )
    saved_without_profile_version = SavedBatchStore(path).create(
        "project-1",
        "logical_profile_only",
        logical_profile_only,
        batch_id="batch-logical-profile",
    )
    assert saved_without_profile_version.selected_workflow_version is not None
    assert saved_without_profile_version.selected_workflow_profile_id == "profile-project-1"
    assert saved_without_profile_version.selected_workflow_profile_name == "Profile"
    assert saved_without_profile_version.selected_workflow_profile_version is None


@pytest.mark.parametrize("values", (("cat", "cat"), ("", "")))
def test_saved_batch_writes_reject_duplicate_binding_values(
    tmp_path: Path, values: tuple[str, ...]
) -> None:
    path = _database(tmp_path)
    invalid = SavedBatchDefinition(
        "Draft",
        None,
        SavedBatchSeedIntent.fixed(1),
        variable_bindings=(SavedBatchVariableBinding("animal", values),),
    )
    store = SavedBatchStore(path)

    with pytest.raises(SavedBatchValidationError, match="exact duplicates"):
        store.create("project-1", "duplicate", invalid)

    created = store.create(
        "project-1",
        "valid",
        SavedBatchDefinition("Valid", None, SavedBatchSeedIntent.fixed(1)),
        batch_id="valid-batch",
    )
    with pytest.raises(SavedBatchValidationError, match="exact duplicates"):
        store.update(created.id, invalid, expected_revision=created.revision)
    assert store.get(created.id).revision == created.revision


@pytest.mark.parametrize(
    ("values_json", "message"),
    (("[1]\n", "string array"), ('["cat","cat"]\n', "exact duplicates")),
)
def test_saved_batch_reads_reject_invalid_binding_values(
    tmp_path: Path, values_json: str, message: str
) -> None:
    path = _database(tmp_path)
    store = SavedBatchStore(path)
    store.create(
        "project-1",
        "invalid",
        SavedBatchDefinition("Invalid", None, SavedBatchSeedIntent.fixed(1)),
        batch_id="invalid-batch",
    )
    with closing(open_connection(path)) as connection:
        connection.execute(
            """
            INSERT INTO batch_variable_binding (batch_id, position, placeholder, values_json)
            VALUES (?, ?, ?, ?)
            """,
            ("invalid-batch", 1, "animal", values_json),
        )
        connection.commit()

    with pytest.raises(SavedBatchStoreError, match=message):
        store.get("invalid-batch")


@pytest.mark.parametrize(
    "slot_key", ("Reference", "reference-slot", "_reference", "reference__slot")
)
def test_saved_batch_rejects_invalid_image_binding_keys(tmp_path: Path, slot_key: str) -> None:
    path = _database(tmp_path)
    definition = SavedBatchDefinition(
        "Invalid",
        None,
        SavedBatchSeedIntent.fixed(1),
        image_bindings=(SavedBatchImageBinding(slot_key, ()),),
    )

    with pytest.raises(SavedBatchValidationError, match="lowercase ASCII snake case"):
        SavedBatchStore(path).create("project-1", "invalid", definition)


def test_saved_batch_rejects_zero_value_image_binding(tmp_path: Path) -> None:
    path = _database(tmp_path)
    definition = SavedBatchDefinition(
        "Draft",
        None,
        SavedBatchSeedIntent.fixed(1),
        image_bindings=(SavedBatchImageBinding("reference", ()),),
    )

    with pytest.raises(SavedBatchValidationError, match="at least one"):
        SavedBatchStore(path).create("project-1", "draft_images", definition)


@pytest.mark.parametrize("values", (("asset", "asset"), (None, None)))
def test_saved_batch_rejects_duplicate_image_binding_values(
    tmp_path: Path, values: tuple[str | None, ...]
) -> None:
    path = _database(tmp_path)
    definition = SavedBatchDefinition(
        "Draft",
        None,
        SavedBatchSeedIntent.fixed(1),
        image_bindings=(SavedBatchImageBinding("reference", values),),
    )

    with pytest.raises(SavedBatchValidationError, match="exact duplicates"):
        SavedBatchStore(path).create("project-1", "duplicate_images", definition)


def test_update_is_atomic_increments_revision_and_rejects_stale_concurrent_saves(
    tmp_path: Path,
) -> None:
    path = _database(tmp_path)
    store = SavedBatchStore(path, clock=lambda: NOW)
    created = store.create(
        "project-1",
        "draft",
        SavedBatchDefinition("Draft", None, SavedBatchSeedIntent.fixed(1)),
        batch_id="batch-1",
    )
    update = SavedBatchDefinition("Updated", None, SavedBatchSeedIntent.fixed(2))

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = tuple(
            executor.submit(store.update, created.id, update, expected_revision=1) for _ in range(2)
        )
    outcomes: list[int | str] = []
    for future in futures:
        try:
            outcomes.append(future.result().revision)
        except SavedBatchConflictError:
            outcomes.append("conflict")
    assert sorted(outcomes, key=str) == [2, "conflict"]
    assert store.get(created.id).name == "Updated"


def test_failed_child_replacement_rolls_back_root_and_children(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _database(tmp_path)
    store = SavedBatchStore(path, clock=lambda: NOW)
    original = SavedBatchDefinition("Draft", None, SavedBatchSeedIntent.fixed(1))
    store.create("project-1", "draft", original, batch_id="batch-1")

    def fail(*_args: object) -> None:
        raise SavedBatchIntegrityError("injected failure")

    monkeypatch.setattr("batchcraft.db.saved_batches._replace_children", fail)
    with pytest.raises(SavedBatchIntegrityError, match="injected"):
        store.update(
            "batch-1",
            SavedBatchDefinition("Changed", None, SavedBatchSeedIntent.fixed(2)),
            expected_revision=1,
        )
    assert store.get("batch-1").name == "Draft"
    assert store.get("batch-1").revision == 1


def test_archive_is_hidden_by_default_and_keeps_detail(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = SavedBatchStore(path, clock=lambda: NOW)
    store.create(
        "project-1",
        "draft",
        SavedBatchDefinition("Draft", None, SavedBatchSeedIntent.fixed(1)),
        batch_id="batch-1",
    )
    archived = store.archive("batch-1")
    assert archived.archived_at == NOW
    assert archived.revision == 2
    assert store.list("project-1") == ()
    assert [item.id for item in store.list("project-1", include_archived=True)] == ["batch-1"]


def test_rejects_cross_project_detached_and_content_conflicts(tmp_path: Path) -> None:
    path = _database(tmp_path)
    foreign = _complete_definition(path, "project-2")
    store = SavedBatchStore(path)
    with pytest.raises(SavedBatchIntegrityError, match="another Project"):
        store.create("project-1", "foreign", foreign)

    detached = SavedBatchDefinition(
        "Detached",
        None,
        SavedBatchSeedIntent.fixed(1),
        prompt_selections=(SavedBatchPromptSelection("missing", "Name", "Text"),),
    )
    with pytest.raises(SavedBatchIntegrityError, match="detached snapshots"):
        store.create("project-1", "detached", detached)

    complete = _complete_definition(path)
    selected = complete.selected_workflow_version
    assert selected is not None
    changed = replace(
        complete,
        selected_workflow_version=SavedBatchWorkflowVersionSnapshot(
            selected.id, selected.content_sha256, {"changed": {}}
        ),
    )
    with pytest.raises(SavedBatchIntegrityError, match="SHA-256"):
        store.create("project-1", "changed", changed)


def test_filesystem_key_is_unique_within_project(tmp_path: Path) -> None:
    path = _database(tmp_path)
    store = SavedBatchStore(path)
    definition = SavedBatchDefinition("One", None, SavedBatchSeedIntent.fixed(1))
    store.create("project-1", "same", definition, batch_id="batch-1")
    other = store.create("project-2", "same", definition, batch_id="batch-2")
    assert other.filesystem_key == "same"
    with pytest.raises(SavedBatchConflictError, match="filesystem key"):
        store.create("project-1", "same", definition, batch_id="batch-3")


def test_database_child_constraints_cascade_only_with_batch(tmp_path: Path) -> None:
    path = _database(tmp_path)
    definition = _complete_definition(path)
    SavedBatchStore(path).create("project-1", "complete", definition, batch_id="batch-1")
    with closing(open_connection(path)) as connection:
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            connection.execute(
                "DELETE FROM prompt_version WHERE id = ?",
                (definition.prompt_selections[0].prompt_version_id,),
            )
        connection.rollback()
        connection.execute("DELETE FROM batch WHERE id = 'batch-1'")
        assert connection.execute(
            "SELECT count(*) FROM batch_variable_binding WHERE batch_id = 'batch-1'"
        ).fetchone() == (0,)
        assert connection.execute(
            "SELECT count(*) FROM batch_image_binding WHERE batch_id = 'batch-1'"
        ).fetchone() == (0,)
