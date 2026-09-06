import hashlib
import json
import os
import stat
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO, cast

_FILESYSTEM_KEY_CHARACTERS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
)


def is_safe_filesystem_key(value: str) -> bool:
    return bool(
        value
        and value not in {".", ".."}
        and value[0] in _FILESYSTEM_KEY_CHARACTERS
        and all(character in _FILESYSTEM_KEY_CHARACTERS for character in value)
    )


def canonical_json_bytes(value: object) -> bytes:
    try:
        serialized = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise ValueError(f"value is not JSON serializable: {error}") from error
    return f"{serialized}\n".encode()


def write_bytes(path: Path, content: bytes) -> None:
    with path.open("xb") as file:
        file.write(content)
        file.flush()
        os.fsync(file.fileno())


def write_json(path: Path, value: object) -> None:
    write_bytes(path, canonical_json_bytes(value))


@contextmanager
def open_regular_file(path: Path) -> Iterator[BinaryIO]:
    """Open a non-symlink regular file without waiting for a FIFO writer.

    Parent directories are traversed without following symlinks. Callers still
    validate the path's domain-specific containment and identity.
    Trusted configured storage anchors must already be canonical; do not resolve
    an artifact path here, since that would hide symlinks inside the store.
    """
    # Anchor every parent lookup to its descriptor, not a checked pathname.
    if ".." in path.parts:
        raise ValueError("parent traversal is not allowed")
    absolute = path.absolute()
    parent = os.open(absolute.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in absolute.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        descriptor = os.open(
            absolute.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent
        )
    finally:
        os.close(parent)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError(f"not a regular file: {path}")
        file = os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise
    with file:
        yield file


def read_json_object(path: Path) -> dict[str, object]:
    try:
        with open_regular_file(path) as file:
            value: object = json.load(file)
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read valid JSON from {path}: {error}") from error
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError(f"expected a JSON object in {path}")
    return cast(dict[str, object], value)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open_regular_file(path) as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_timestamp(clock: Callable[[], datetime]) -> str:
    value = clock()
    if value.tzinfo is None:
        raise ValueError("clock must return a timezone-aware datetime")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def ensure_directory(path: Path) -> None:
    if path.is_dir():
        return
    ensure_directory(path.parent)
    try:
        path.mkdir()
    except FileExistsError:
        if not path.is_dir():
            raise
    fsync_directory(path.parent)
