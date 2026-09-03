import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from batchcraft.files import (
    AssetStoreError,
    ProjectAssetStore,
    ProjectIdentity,
    ProjectOwnerStore,
)

FIXED_TIME = datetime(2026, 8, 27, 12, 30, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _publish_project_owner(tmp_path: Path) -> None:
    ProjectOwnerStore(tmp_path).publish(ProjectIdentity("project-id", "project", "Project"))


def test_import_calculates_sha256_and_stores_metadata(tmp_path: Path) -> None:
    source = tmp_path / "portrait.png"
    content = b"not really a png"
    source.write_bytes(content)
    project_path = tmp_path / "project"
    store = ProjectAssetStore(
        project_path,
        id_factory=lambda: "asset-1",
        clock=lambda: FIXED_TIME,
        producer_version="fixture-version",
    )

    asset = store.import_file(source)

    expected_sha256 = hashlib.sha256(content).hexdigest()
    assert asset.asset_id == "asset-1"
    assert asset.sha256 == expected_sha256
    assert asset.original_filename == "portrait.png"
    assert asset.mime_type == "image/png"
    assert asset.byte_size == len(content)
    assert asset.created_at == "2026-08-27T12:30:00Z"
    assert asset.stored_path == f"assets/sha256/{expected_sha256[:2]}/{expected_sha256}/content"
    assert (project_path / asset.stored_path).read_bytes() == content

    metadata_path = project_path / asset.stored_path
    metadata = json.loads(metadata_path.with_name("asset.json").read_text())
    assert metadata == {
        "format": "batchcraft.asset",
        "format_version": 1,
        "created_by": {"batchcraft_version": "fixture-version"},
        "asset_id": "asset-1",
        "sha256": expected_sha256,
        "original_filename": "portrait.png",
        "mime_type": "image/png",
        "byte_size": len(content),
        "stored_path": asset.stored_path,
        "created_at": "2026-08-27T12:30:00Z",
        "project": {"project_id": "project-id", "filesystem_key": "project"},
    }
    assert store.load(expected_sha256) == asset


def test_identical_content_deduplicates_independent_of_filename(tmp_path: Path) -> None:
    first_source = tmp_path / "first.jpg"
    second_source = tmp_path / "renamed.png"
    first_source.write_bytes(b"same bytes")
    second_source.write_bytes(b"same bytes")
    generated_ids = iter(("asset-1", "asset-2"))
    store = ProjectAssetStore(
        tmp_path / "project",
        id_factory=lambda: next(generated_ids),
        clock=lambda: FIXED_TIME,
    )

    first = store.import_file(first_source)
    second = store.import_file(second_source)

    assert second == first
    assert second.asset_id == "asset-1"
    assert second.original_filename == "first.jpg"
    content_files = tuple((tmp_path / "project" / "assets" / "sha256").glob("*/*/content"))
    assert len(content_files) == 1


@pytest.mark.parametrize("invalid_version", (True, 1.0))
def test_asset_format_version_requires_a_json_integer(
    tmp_path: Path, invalid_version: object
) -> None:
    source = tmp_path / "portrait.png"
    source.write_bytes(b"asset bytes")
    store = ProjectAssetStore(tmp_path / "project", id_factory=lambda: "asset-1")
    asset = store.import_file(source)
    metadata_path = (store.project_path / asset.stored_path).with_name("asset.json")
    metadata = json.loads(metadata_path.read_text())
    metadata["format_version"] = invalid_version
    metadata_path.write_text(json.dumps(metadata))

    with pytest.raises(AssetStoreError, match="unsupported format version"):
        store.read_metadata(asset.sha256)
    with pytest.raises(AssetStoreError, match="unsupported format version"):
        store.read_asset_id(asset.sha256)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    (
        ("format", "batchcraft.other", "wrong format identity"),
        ("format_version", 2, "unsupported format version"),
        ("extra", "value", "unexpected extra"),
    ),
)
def test_asset_rejects_invalid_v1_format_shape(
    tmp_path: Path, field: str, value: object, message: str
) -> None:
    source = tmp_path / "portrait.png"
    source.write_bytes(b"asset bytes")
    store = ProjectAssetStore(tmp_path / "project", id_factory=lambda: "asset-1")
    asset = store.import_file(source)
    metadata_path = (store.project_path / asset.stored_path).with_name("asset.json")
    metadata = json.loads(metadata_path.read_text())
    metadata[field] = value
    metadata_path.write_text(json.dumps(metadata))

    with pytest.raises(AssetStoreError, match=message):
        store.read_metadata(asset.sha256)


@pytest.mark.parametrize("unsafe_directory", (".staging", "sha256"))
def test_import_rejects_symlinked_internal_directory(tmp_path: Path, unsafe_directory: str) -> None:
    source = tmp_path / "portrait.png"
    source.write_bytes(b"asset bytes")
    project_path = tmp_path / "project"
    assets_path = project_path / "assets"
    assets_path.mkdir()
    external = tmp_path / "external"
    external.mkdir()
    (assets_path / unsafe_directory).symlink_to(external, target_is_directory=True)

    with pytest.raises(AssetStoreError, match="import path is unsafe"):
        ProjectAssetStore(project_path).import_file(source)
    assert not tuple(external.iterdir())


def test_import_rejects_empty_asset_id_before_publication(tmp_path: Path) -> None:
    source = tmp_path / "portrait.png"
    source.write_bytes(b"asset bytes")
    store = ProjectAssetStore(tmp_path / "project", id_factory=lambda: "")

    with pytest.raises(AssetStoreError, match="asset ID is not URL-safe"):
        store.import_file(source)
    assert not tuple((store.assets_path / "sha256").glob("*/*"))


def test_different_content_remains_distinct(tmp_path: Path) -> None:
    first_source = tmp_path / "image.png"
    second_source = tmp_path / "image-copy.png"
    first_source.write_bytes(b"first")
    second_source.write_bytes(b"second")
    generated_ids = iter(("asset-1", "asset-2"))
    store = ProjectAssetStore(
        tmp_path / "project",
        id_factory=lambda: next(generated_ids),
        clock=lambda: FIXED_TIME,
    )

    first = store.import_file(first_source)
    second = store.import_file(second_source)

    assert first.asset_id != second.asset_id
    assert first.sha256 != second.sha256
    assert first.stored_path != second.stored_path
    assert (tmp_path / "project" / first.stored_path).read_bytes() == b"first"
    assert (tmp_path / "project" / second.stored_path).read_bytes() == b"second"


def test_metadata_listing_is_deterministic_and_does_not_hash_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    generated_ids = iter(("asset-b", "asset-a"))
    times = iter(
        (
            datetime(2026, 8, 27, 12, 30, tzinfo=UTC),
            datetime(2026, 8, 27, 12, 31, tzinfo=UTC),
        )
    )
    store = ProjectAssetStore(
        tmp_path / "project",
        id_factory=lambda: next(generated_ids),
        clock=lambda: next(times),
    )
    first_source = tmp_path / "first.png"
    second_source = tmp_path / "second.png"
    first_source.write_bytes(b"first")
    second_source.write_bytes(b"second")
    first = store.import_file(first_source)
    second = store.import_file(second_source)
    monkeypatch.setattr(
        "batchcraft.files.assets.sha256_file",
        lambda _path: pytest.fail("metadata listing must not hash content"),
    )

    assert store.list_metadata() == (second, first)


def test_metadata_listing_skips_corrupt_unrelated_asset_and_rejects_duplicate_ids(
    tmp_path: Path,
) -> None:
    generated_ids = iter(("asset-1", "asset-2"))
    store = ProjectAssetStore(
        tmp_path / "project",
        id_factory=lambda: next(generated_ids),
        clock=lambda: FIXED_TIME,
    )
    first_source = tmp_path / "first.png"
    second_source = tmp_path / "second.png"
    first_source.write_bytes(b"first")
    second_source.write_bytes(b"second")
    first = store.import_file(first_source)
    second = store.import_file(second_source)
    second_metadata_path = store.project_path / second.stored_path
    second_metadata_path.with_name("asset.json").write_text("not json")

    assert store.list_metadata() == (first,)

    duplicate_metadata = {
        "format": "batchcraft.asset",
        "format_version": 1,
        "created_by": {"batchcraft_version": "fixture-version"},
        "asset_id": first.asset_id,
        "sha256": second.sha256,
        "original_filename": second.original_filename,
        "mime_type": second.mime_type,
        "byte_size": second.byte_size,
        "stored_path": second.stored_path,
        "created_at": second.created_at,
        "project": {"project_id": "project-id", "filesystem_key": "project"},
    }
    second_metadata_path.with_name("asset.json").write_text(json.dumps(duplicate_metadata))
    with pytest.raises(AssetStoreError, match="duplicate Project asset ID"):
        store.list_metadata()
