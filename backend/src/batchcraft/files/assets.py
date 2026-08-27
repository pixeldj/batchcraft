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
            metadata = {
                "format_version": ASSET_FORMAT_VERSION,
                "asset_id": self._id_factory(),
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
        if len(sha256) != _SHA256_LENGTH or any(
            character not in "0123456789abcdef" for character in sha256
        ):
            raise AssetStoreError(f"invalid SHA-256 digest: {sha256!r}")

        asset_path = self._asset_path(sha256)
        metadata_path = asset_path / "asset.json"
        content_path = asset_path / "content"
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
        if record.sha256 != sha256:
            raise AssetStoreError(f"asset metadata digest does not match path for {sha256}")
        if record.stored_path != expected_stored_path:
            raise AssetStoreError(f"asset stored path does not match content path for {sha256}")
        if not content_path.is_file():
            raise AssetStoreError(f"asset content is missing for {sha256}")
        if content_path.stat().st_size != record.byte_size:
            raise AssetStoreError(f"asset byte size does not match metadata for {sha256}")
        if sha256_file(content_path) != sha256:
            raise AssetStoreError(f"asset content digest does not match metadata for {sha256}")
        return record

    def validate_record(self, record: AssetRecord) -> AssetRecord:
        stored = self.load(record.sha256)
        if stored != record:
            raise AssetStoreError(f"asset record does not match stored metadata: {record.asset_id}")
        return stored

    def _asset_path(self, sha256: str) -> Path:
        return self.assets_path / "sha256" / sha256[:2] / sha256

    def _content_path(self, sha256: str) -> Path:
        return self._asset_path(sha256) / "content"


def _required_string(data: dict[str, object], name: str) -> str:
    value = data.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


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
