import hashlib
import mimetypes
import os
import shutil
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from batchcraft.files._io import (
    ensure_directory,
    fsync_directory,
    read_json_object,
    sha256_file,
    utc_timestamp,
    write_json,
)
from batchcraft.files.models import AssetRecord

ASSET_FORMAT_VERSION = 1
_SHA256_LENGTH = 64


class AssetStoreError(ValueError):
    """Project asset bytes or metadata are invalid."""


class ProjectAssetStore:
    def __init__(
        self,
        project_path: Path,
        *,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.project_path = project_path
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._clock = clock or (lambda: datetime.now(UTC))

    @property
    def assets_path(self) -> Path:
        return self.project_path / "assets"

    def import_file(self, source: Path) -> AssetRecord:
        if not source.is_file():
            raise AssetStoreError(f"asset source is not a file: {source}")

        staging_root = self.assets_path / ".staging"
        ensure_directory(staging_root)
        staging_path = staging_root / str(uuid4())
        staging_path.mkdir()
        fsync_directory(staging_root)
        staged_content = staging_path / "content"

        try:
            digest = hashlib.sha256()
            byte_size = 0
            with source.open("rb") as input_file, staged_content.open("xb") as output_file:
                for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
                    digest.update(chunk)
                    byte_size += len(chunk)
                    output_file.write(chunk)
                output_file.flush()
                os.fsync(output_file.fileno())

            sha256 = digest.hexdigest()
            final_path = self._asset_path(sha256)
            if final_path.exists():
                return self.load(sha256)

            mime_type, _ = mimetypes.guess_type(source.name)
            stored_path = self._content_path(sha256).relative_to(self.project_path).as_posix()
            asset_id = self._id_factory()
            _validate_asset_id(asset_id)
            metadata = {
                "format_version": ASSET_FORMAT_VERSION,
                "asset_id": asset_id,
                "sha256": sha256,
                "original_filename": source.name,
                "mime_type": mime_type,
                "byte_size": byte_size,
                "stored_path": stored_path,
                "created_at": utc_timestamp(self._clock),
            }
            write_json(staging_path / "asset.json", metadata)
            fsync_directory(staging_path)
            ensure_directory(final_path.parent)

            try:
                staging_path.rename(final_path)
                fsync_directory(final_path.parent)
            except OSError:
                if not final_path.exists():
                    raise

            return self.load(sha256)
        except (OSError, ValueError) as error:
            if isinstance(error, AssetStoreError):
                raise
            raise AssetStoreError(f"failed to import asset {source}: {error}") from error
        finally:
            if staging_path.exists():
                shutil.rmtree(staging_path)

    def load(self, sha256: str) -> AssetRecord:
        record = self.read_metadata(sha256)
        content_path = self._content_path(sha256)
        if sha256_file(content_path) != sha256:
            raise AssetStoreError(f"asset content digest does not match metadata for {sha256}")
        return record

    def read_metadata(self, sha256: str) -> AssetRecord:
        _validate_sha256(sha256)

        asset_path = self._asset_path(sha256)
        metadata_path = asset_path / "asset.json"
        content_path = asset_path / "content"
        self._validate_asset_paths(sha256)
        try:
            metadata = read_json_object(metadata_path)
            record = AssetRecord(
                asset_id=_required_string(metadata, "asset_id"),
                sha256=_required_string(metadata, "sha256"),
                original_filename=_required_string(metadata, "original_filename"),
                mime_type=_optional_string(metadata, "mime_type"),
                byte_size=_required_integer(metadata, "byte_size"),
                stored_path=_required_string(metadata, "stored_path"),
                created_at=_required_string(metadata, "created_at"),
            )
        except (OSError, ValueError) as error:
            raise AssetStoreError(f"invalid asset metadata for {sha256}: {error}") from error

        expected_stored_path = content_path.relative_to(self.project_path).as_posix()
        if metadata.get("format_version") != ASSET_FORMAT_VERSION:
            raise AssetStoreError(f"unsupported asset format version for {sha256}")
        _validate_asset_id(record.asset_id)
        if record.sha256 != sha256:
            raise AssetStoreError(f"asset metadata digest does not match path for {sha256}")
        if record.stored_path != expected_stored_path:
            raise AssetStoreError(f"asset stored path does not match content path for {sha256}")
        if not content_path.is_file():
            raise AssetStoreError(f"asset content is missing for {sha256}")
        if content_path.stat().st_size != record.byte_size:
            raise AssetStoreError(f"asset byte size does not match metadata for {sha256}")
        return record

    def list_metadata(self) -> tuple[AssetRecord, ...]:
        assets_root = self.assets_path / "sha256"
        if not assets_root.exists():
            return ()
        if assets_root.is_symlink() or not assets_root.is_dir():
            raise AssetStoreError("Project asset root is missing or unsafe")

        records: list[AssetRecord] = []
        asset_ids: set[str] = set()
        for metadata_path in sorted(assets_root.glob("*/*/asset.json")):
            candidate = metadata_path.parent
            if (
                metadata_path.is_symlink()
                or candidate.is_symlink()
                or candidate.parent.is_symlink()
                or not candidate.resolve().is_relative_to(assets_root.resolve())
            ):
                continue
            try:
                record = self.read_metadata(candidate.name)
            except AssetStoreError:
                continue
            if record.asset_id in asset_ids:
                raise AssetStoreError(f"duplicate Project asset ID: {record.asset_id}")
            asset_ids.add(record.asset_id)
            records.append(record)

        records.sort(key=lambda record: record.sha256)
        records.sort(key=lambda record: record.created_at, reverse=True)
        return tuple(records)

    def read_asset_id(self, sha256: str) -> str:
        _validate_sha256(sha256)
        metadata_path = self._asset_path(sha256) / "asset.json"
        if metadata_path.is_symlink() or not metadata_path.is_file():
            raise AssetStoreError(f"asset identity metadata is missing or unsafe for {sha256}")
        try:
            metadata = read_json_object(metadata_path)
            if metadata.get("format_version") != ASSET_FORMAT_VERSION:
                raise AssetStoreError(f"unsupported asset format version for {sha256}")
            asset_id = _required_string(metadata, "asset_id")
            _validate_asset_id(asset_id)
            return asset_id
        except (OSError, ValueError) as error:
            if isinstance(error, AssetStoreError):
                raise
            raise AssetStoreError(
                f"invalid asset identity metadata for {sha256}: {error}"
            ) from error

    def validate_record(self, record: AssetRecord) -> AssetRecord:
        stored = self.load(record.sha256)
        if stored != record:
            raise AssetStoreError(f"asset record does not match stored metadata: {record.asset_id}")
        return stored

    def _asset_path(self, sha256: str) -> Path:
        return self.assets_path / "sha256" / sha256[:2] / sha256

    def _content_path(self, sha256: str) -> Path:
        return self._asset_path(sha256) / "content"

    def _validate_asset_paths(self, sha256: str) -> None:
        assets_root = self.assets_path / "sha256"
        prefix_path = assets_root / sha256[:2]
        asset_path = prefix_path / sha256
        metadata_path = asset_path / "asset.json"
        content_path = asset_path / "content"
        if any(path.is_symlink() for path in (assets_root, prefix_path, asset_path)):
            raise AssetStoreError(f"asset directory is unsafe for {sha256}")
        if metadata_path.is_symlink() or not metadata_path.is_file():
            raise AssetStoreError(f"asset metadata is missing or unsafe for {sha256}")
        if content_path.is_symlink() or not content_path.is_file():
            raise AssetStoreError(f"asset content is missing or unsafe for {sha256}")


def _required_string(data: dict[str, object], name: str) -> str:
    value = data.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _validate_sha256(sha256: str) -> None:
    if len(sha256) != _SHA256_LENGTH or any(
        character not in "0123456789abcdef" for character in sha256
    ):
        raise AssetStoreError(f"invalid SHA-256 digest: {sha256!r}")


def _validate_asset_id(asset_id: str) -> None:
    if (
        asset_id in {".", ".."}
        or "/" in asset_id
        or "\\" in asset_id
        or any(ord(character) < 32 for character in asset_id)
    ):
        raise AssetStoreError(f"asset ID is not URL-safe: {asset_id!r}")


def _optional_string(data: dict[str, object], name: str) -> str | None:
    value = data.get(name)
    if value is not None and not isinstance(value, str):
        raise ValueError(f"{name} must be a string or null")
    return value


def _required_integer(data: dict[str, object], name: str) -> int:
    value = data.get(name)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value
