import hashlib
import multiprocessing
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, cast

import pytest

from batchcraft.application.errors import AssetDataError, RunDataError
from batchcraft.application.service import _read_asset_content, _read_result
from batchcraft.execution import ResultRecord
from batchcraft.files import AssetRecord
from batchcraft.files._io import open_regular_file
from batchcraft.files.history import _result_integrity


def _result(content: bytes) -> ResultRecord:
    return ResultRecord(
        job_id="job-1",
        job_ordinal=1,
        artifact_ordinal=1,
        producing_node_id="1",
        output_name="images",
        remote_filename="result.png",
        remote_subfolder="",
        remote_type="output",
        local_path="result.png",
        content_type="image/png",
        byte_size=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
    )


def _asset(content: bytes) -> AssetRecord:
    return AssetRecord(
        asset_id="asset-1",
        sha256=hashlib.sha256(content).hexdigest(),
        original_filename="result.png",
        mime_type="image/png",
        byte_size=len(content),
        stored_path="result.png",
        created_at="2026-01-01T00:00:00Z",
    )


def _reject_fifo(path: Path, reader: str) -> None:
    if reader == "history":
        assert _result_integrity(path.parent, _result(b""))[0] == "corrupt"
    elif reader == "result":
        with pytest.raises(RunDataError, match="not a regular file"):
            _read_result(path, _result(b""))
    elif reader == "asset":
        with (
            tempfile.TemporaryFile() as destination,
            pytest.raises(AssetDataError, match="not a regular file"),
        ):
            _read_asset_content(path, _asset(b""), destination)
    else:
        with pytest.raises(ValueError, match="not a regular file"), open_regular_file(path):
            pytest.fail("FIFO must not be yielded")


@pytest.mark.parametrize("reader", ["history", "result", "asset", "helper"])
def test_fifo_without_writer_is_rejected_with_deadline(tmp_path: Path, reader: str) -> None:
    path = tmp_path / "result.png"
    os.mkfifo(path)
    process = multiprocessing.get_context("spawn").Process(target=_reject_fifo, args=(path, reader))
    process.start()
    try:
        process.join(timeout=5)
        assert not process.is_alive(), f"{reader} blocked opening a FIFO"
        assert process.exitcode == 0
    finally:
        if process.is_alive():
            process.terminate()
            process.join(timeout=5)
        process.close()


@pytest.mark.parametrize("kind", ["regular", "corrupt", "symlink", "directory", "missing"])
def test_readers_preserve_integrity_checks(tmp_path: Path, kind: str) -> None:
    content = b"result-bytes"
    path = tmp_path / "result.png"
    if kind in {"regular", "corrupt"}:
        path.write_bytes(content if kind == "regular" else b"wrong-bytes!")
    elif kind == "symlink":
        target = tmp_path / "target.png"
        target.write_bytes(content)
        path.symlink_to(target)
    elif kind == "directory":
        path.mkdir()
    expected = (
        "verified"
        if kind == "regular"
        else "missing"
        if kind in {"symlink", "missing"}
        else "corrupt"
    )
    assert _result_integrity(tmp_path, _result(content))[0] == expected
    if kind == "regular":
        with tempfile.TemporaryFile() as destination:
            _read_result(path, _result(content), destination=destination)
            destination.seek(0)
            assert destination.read() == content
        with tempfile.TemporaryFile() as destination:
            _read_asset_content(path, _asset(content), destination)
            destination.seek(0)
            assert destination.read() == content
        _read_result(path, _result(content))
    else:
        with pytest.raises(RunDataError):
            _read_result(path, _result(content))
        with tempfile.TemporaryFile() as destination, pytest.raises(AssetDataError):
            _read_asset_content(path, _asset(content), destination)


def test_integrity_only_reads_are_chunked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    content = b"x" * (2 * 1024 * 1024 + 17)
    path = tmp_path / "result.png"
    path.write_bytes(content)
    read_sizes: list[int] = []

    @contextmanager
    def bounded_reader(path: Path) -> Iterator[BinaryIO]:
        with open_regular_file(path) as file:

            class Reader:
                def read(self, size: int = -1) -> bytes:
                    assert 0 < size <= 1024 * 1024
                    read_sizes.append(size)
                    return file.read(size)

            yield cast(BinaryIO, Reader())

    monkeypatch.setattr("batchcraft.files.history.open_regular_file", bounded_reader)
    monkeypatch.setattr("batchcraft.application.service.open_regular_file", bounded_reader)
    assert _result_integrity(tmp_path, _result(content)) == ("verified", None)
    _read_result(path, _result(content))
    assert len(read_sizes) == 14
