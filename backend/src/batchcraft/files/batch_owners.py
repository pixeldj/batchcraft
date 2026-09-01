import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import uuid4

from batchcraft.files._io import (
    ensure_directory,
    fsync_directory,
    is_safe_filesystem_key,
    read_json_object,
    write_json,
)
from batchcraft.files.models import BatchIdentity

BATCH_OWNER_FORMAT_VERSION = 1


@dataclass(frozen=True, slots=True)
class AdoptableBatch:
    filesystem_key: str
    owner_state: Literal["owned", "ownerless"]
    batch_id: str | None
    initial_name: str | None


class BatchOwnerError(ValueError):
    """A Batch filesystem owner cannot be safely published or read."""


class BatchOwnerMissingError(BatchOwnerError):
    """An existing Batch directory has no owner binding."""


class BatchOwnerDiscoveryError(BatchOwnerError):
    """A Project's batches directory cannot be enumerated safely."""


class BatchOwnerStore:
    def __init__(self, project_path: Path) -> None:
        self.project_path = project_path
        self.batches_path = project_path / "batches"

    def publish(self, batch: BatchIdentity) -> BatchIdentity:
        _validate_identity(batch)
        batch_path = self.batches_path / batch.filesystem_key
        owner_path = batch_path / "batch.json"
        try:
            _require_project_directory(self.project_path)
            _reject_symlink(self.batches_path, "Batches directory")
            ensure_directory(self.batches_path)
            _require_directory(self.batches_path, "Batches directory")
            _reject_symlink(batch_path, "Batch directory")
            ensure_directory(batch_path)
            _require_directory(batch_path, "Batch directory")
            _reject_symlink(owner_path, "Batch owner file")
            temporary_path = batch_path / f".{owner_path.name}.{uuid4()}.tmp"
            try:
                write_json(
                    temporary_path,
                    {
                        "format_version": BATCH_OWNER_FORMAT_VERSION,
                        "batch_id": batch.id,
                        "filesystem_key": batch.filesystem_key,
                        "name": batch.name,
                    },
                )
                _require_directory(batch_path, "Batch directory")
                try:
                    os.link(temporary_path, owner_path)
                    fsync_directory(batch_path)
                except FileExistsError:
                    pass
            finally:
                temporary_path.unlink(missing_ok=True)
            existing = self.read(batch.filesystem_key)
        except (OSError, ValueError) as error:
            if isinstance(error, BatchOwnerError):
                raise
            raise BatchOwnerError(
                f"failed to publish Batch owner {batch.filesystem_key!r}: {error}"
            ) from error
        if existing.id != batch.id:
            raise BatchOwnerError(
                f"Batch filesystem key {batch.filesystem_key!r} belongs to another ID"
            )
        return existing

    def create(self, batch: BatchIdentity) -> BatchIdentity:
        _validate_identity(batch)
        _require_project_directory(self.project_path)
        _reject_symlink(self.batches_path, "Batches directory")
        ensure_directory(self.batches_path)
        _require_directory(self.batches_path, "Batches directory")
        batch_path = self.batches_path / batch.filesystem_key
        try:
            batch_path.mkdir()
            fsync_directory(self.batches_path)
        except FileExistsError as error:
            raise BatchOwnerError(
                f"Batch directory {batch.filesystem_key!r} already exists; adopt its owner explicitly"
            ) from error
        except OSError as error:
            raise BatchOwnerError(
                f"failed to create Batch directory {batch.filesystem_key!r}: {error}"
            ) from error
        try:
            return self.publish(batch)
        except BaseException:
            try:
                batch_path.rmdir()
                fsync_directory(self.batches_path)
            except OSError:
                pass
            raise

    def adopt_ownerless(self, batch: BatchIdentity) -> BatchIdentity:
        _validate_identity(batch)
        _require_project_directory(self.project_path)
        batch_path = self.batches_path / batch.filesystem_key
        owner_path = batch_path / "batch.json"
        _require_directory(batch_path, "Batch directory")
        _reject_symlink(owner_path, "Batch owner file")
        if owner_path.exists():
            raise BatchOwnerError(
                f"Batch directory {batch.filesystem_key!r} already has an owner file"
            )
        return self.publish(batch)

    def read(self, filesystem_key: str) -> BatchIdentity:
        if not is_safe_filesystem_key(filesystem_key):
            raise BatchOwnerError(f"Batch filesystem key is not path-safe: {filesystem_key!r}")
        _require_project_directory(self.project_path)
        batch_path = self.batches_path / filesystem_key
        owner_path = batch_path / "batch.json"
        try:
            _require_directory(batch_path, "Batch directory")
            _reject_symlink(owner_path, "Batch owner file")
            if not owner_path.is_file():
                if owner_path.exists():
                    raise BatchOwnerError(f"Batch owner file is unsafe: {owner_path}")
                raise BatchOwnerMissingError(
                    f"Batch directory {filesystem_key!r} has no batch.json owner file"
                )
            data = read_json_object(owner_path)
        except (OSError, ValueError) as error:
            if isinstance(error, BatchOwnerError):
                raise
            raise BatchOwnerError(f"invalid Batch owner file {owner_path}: {error}") from error
        if type(data.get("format_version")) is not int or (
            data["format_version"] != BATCH_OWNER_FORMAT_VERSION
        ):
            raise BatchOwnerError(f"unsupported Batch owner format in {owner_path}")
        batch_id = _required_string(data, "batch_id", owner_path)
        _validate_batch_id(batch_id)
        stored_key = _required_string(data, "filesystem_key", owner_path)
        name = _required_string(data, "name", owner_path)
        if not is_safe_filesystem_key(stored_key):
            raise BatchOwnerError(f"Batch owner file has an unsafe filesystem key: {stored_key!r}")
        if stored_key != filesystem_key:
            raise BatchOwnerError("Batch owner file has a mismatched key")
        return BatchIdentity(id=batch_id, filesystem_key=stored_key, name=name)

    def discover(self) -> tuple[AdoptableBatch, ...]:
        _require_project_directory(self.project_path)
        if self.batches_path.is_symlink():
            raise BatchOwnerDiscoveryError("Batches directory must not be a symlink")
        try:
            entries = tuple(self.batches_path.iterdir())
        except FileNotFoundError:
            return ()
        except OSError as error:
            raise BatchOwnerDiscoveryError("failed to enumerate Batches directory") from error
        candidates: list[AdoptableBatch] = []
        for entry in entries:
            if not is_safe_filesystem_key(entry.name):
                continue
            try:
                entry_status = entry.lstat()
            except OSError:
                continue
            if not stat.S_ISDIR(entry_status.st_mode):
                continue
            owner_path = entry / "batch.json"
            try:
                owner_status = owner_path.lstat()
            except FileNotFoundError:
                candidates.append(AdoptableBatch(entry.name, "ownerless", None, None))
                continue
            except OSError:
                continue
            if not stat.S_ISREG(owner_status.st_mode):
                continue
            try:
                owner = self.read(entry.name)
            except BatchOwnerError:
                continue
            candidates.append(AdoptableBatch(entry.name, "owned", owner.id, owner.name))
        return tuple(sorted(candidates, key=lambda candidate: candidate.filesystem_key))


def _validate_identity(batch: BatchIdentity) -> None:
    _validate_batch_id(batch.id)
    if not isinstance(batch.name, str) or not batch.name.strip():
        raise BatchOwnerError("Batch display name must not be empty")
    if not is_safe_filesystem_key(batch.filesystem_key):
        raise BatchOwnerError(f"Batch filesystem key is not path-safe: {batch.filesystem_key!r}")


def _validate_batch_id(batch_id: object) -> None:
    if not isinstance(batch_id, str) or not batch_id.strip():
        raise BatchOwnerError("Batch ID must not be empty")
    if (
        batch_id in {".", ".."}
        or "/" in batch_id
        or "\\" in batch_id
        or any(ord(character) < 32 for character in batch_id)
    ):
        raise BatchOwnerError(f"Batch ID is not route-safe: {batch_id!r}")


def _required_string(data: dict[str, object], name: str, path: Path) -> str:
    value = data.get(name)
    if not isinstance(value, str) or not value.strip():
        raise BatchOwnerError(f"{name} must be a non-empty string in {path}")
    return value


def _reject_symlink(path: Path, description: str) -> None:
    if path.is_symlink():
        raise BatchOwnerError(f"{description} must not be a symlink: {path}")


def _require_project_directory(path: Path) -> None:
    _require_directory(path, "Project directory")


def _require_directory(path: Path, description: str) -> None:
    _reject_symlink(path, description)
    if not path.is_dir():
        raise BatchOwnerError(f"{description} is missing or unsafe: {path}")
