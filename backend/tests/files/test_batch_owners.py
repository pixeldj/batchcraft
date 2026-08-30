import json
from pathlib import Path

import pytest

from batchcraft.files import (
    AdoptableBatch,
    BatchIdentity,
    BatchOwnerError,
    BatchOwnerStore,
)

BATCH = BatchIdentity(id="batch-id", filesystem_key="batch_key", name="Initial name")


def _project(tmp_path: Path) -> Path:
    path = tmp_path / "project"
    path.mkdir()
    return path


def test_publish_read_and_conflict_preserve_canonical_initial_identity(tmp_path: Path) -> None:
    project_path = _project(tmp_path)
    store = BatchOwnerStore(project_path)
    assert store.publish(BATCH) == BATCH
    assert store.publish(BatchIdentity(BATCH.id, BATCH.filesystem_key, "Renamed")) == BATCH
    expected = {
        "batch_id": "batch-id",
        "filesystem_key": "batch_key",
        "format_version": 1,
        "name": "Initial name",
    }
    assert (project_path / "batches" / "batch_key" / "batch.json").read_bytes() == (
        json.dumps(expected, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()
    with pytest.raises(BatchOwnerError, match="belongs to another ID"):
        store.publish(BatchIdentity("other", "batch_key", "Other"))


def test_create_refuses_ownerless_and_explicit_adoption_succeeds(tmp_path: Path) -> None:
    project_path = _project(tmp_path)
    ownerless = project_path / "batches" / "batch_key"
    ownerless.mkdir(parents=True)
    store = BatchOwnerStore(project_path)
    with pytest.raises(BatchOwnerError, match="adopt its owner explicitly"):
        store.create(BATCH)
    assert not (ownerless / "batch.json").exists()
    assert store.adopt_ownerless(BATCH) == BATCH


@pytest.mark.parametrize(
    "batch",
    (
        BatchIdentity("", "key", "Name"),
        BatchIdentity("bad/id", "key", "Name"),
        BatchIdentity("id", "../key", "Name"),
        BatchIdentity("id", "key", ""),
    ),
)
def test_rejects_unsafe_identity(tmp_path: Path, batch: BatchIdentity) -> None:
    with pytest.raises(BatchOwnerError):
        BatchOwnerStore(_project(tmp_path)).publish(batch)


def test_rejects_symlinked_project_batches_batch_and_owner(tmp_path: Path) -> None:
    external = tmp_path / "external"
    external.mkdir()

    project_link = tmp_path / "project-link"
    project_link.symlink_to(external, target_is_directory=True)
    with pytest.raises(BatchOwnerError, match="symlink"):
        BatchOwnerStore(project_link).publish(BATCH)

    project = _project(tmp_path)
    (project / "batches").symlink_to(external, target_is_directory=True)
    with pytest.raises(BatchOwnerError, match="symlink"):
        BatchOwnerStore(project).publish(BATCH)

    (project / "batches").unlink()
    batches = project / "batches"
    batches.mkdir()
    (batches / "batch_key").symlink_to(external, target_is_directory=True)
    with pytest.raises(BatchOwnerError, match="symlink"):
        BatchOwnerStore(project).read("batch_key")

    (batches / "batch_key").unlink()
    batch_path = batches / "batch_key"
    batch_path.mkdir()
    external_owner = external / "batch.json"
    external_owner.write_text("{}")
    (batch_path / "batch.json").symlink_to(external_owner)
    with pytest.raises(BatchOwnerError, match="symlink"):
        BatchOwnerStore(project).read("batch_key")


def test_discover_is_immediate_safe_and_does_not_invent_orphan_identity(tmp_path: Path) -> None:
    project = _project(tmp_path)
    store = BatchOwnerStore(project)
    store.publish(BatchIdentity("owned-id", "z_owned", "Initial"))
    (project / "batches" / "a_ownerless" / "run-001").mkdir(parents=True)
    malformed = project / "batches" / "malformed" / "batch.json"
    malformed.parent.mkdir()
    malformed.write_text("not json")
    (project / "batches" / "ordinary-file").write_text("ignored")
    external = tmp_path / "elsewhere"
    external.mkdir()
    (project / "batches" / "linked").symlink_to(external, target_is_directory=True)

    assert store.discover() == (
        AdoptableBatch("a_ownerless", "ownerless", None, None),
        AdoptableBatch("z_owned", "owned", "owned-id", "Initial"),
    )
    with pytest.raises(BatchOwnerError, match="has no batch.json"):
        store.read("a_ownerless")
    assert not (project / "batches" / "a_ownerless" / "batch.json").exists()
