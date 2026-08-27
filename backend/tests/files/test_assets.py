import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

from batchcraft.files import ProjectAssetStore

FIXED_TIME = datetime(2026, 8, 27, 12, 30, tzinfo=UTC)


def test_import_calculates_sha256_and_stores_metadata(tmp_path: Path) -> None:
    source = tmp_path / "portrait.png"
    content = b"not really a png"
    source.write_bytes(content)
    project_path = tmp_path / "project"
    store = ProjectAssetStore(
        project_path,
        id_factory=lambda: "asset-1",
        clock=lambda: FIXED_TIME,
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
        "format_version": 1,
        "asset_id": "asset-1",
        "sha256": expected_sha256,
        "original_filename": "portrait.png",
        "mime_type": "image/png",
        "byte_size": len(content),
        "stored_path": asset.stored_path,
        "created_at": "2026-08-27T12:30:00Z",
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
