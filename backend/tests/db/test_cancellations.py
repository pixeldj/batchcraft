import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import cast

import pytest

from batchcraft.db import (
    RunCancellationMode,
    RunCancellationRequestRecord,
    RunCancellationRequestStore,
    RunCancellationStoreError,
    RunCancellationValidationError,
    apply_migrations,
    open_connection,
)

REQUESTED_AT = datetime(2026, 9, 1, 12, 30, tzinfo=UTC)


def _database(tmp_path: Path) -> Path:
    path = tmp_path / "batchcraft.sqlite3"
    with closing(open_connection(path)) as connection:
        apply_migrations(connection)
    return path


def test_request_is_durable_across_store_reopen(tmp_path: Path) -> None:
    database_path = _database(tmp_path)
    store = RunCancellationRequestStore(
        database_path,
        clock=lambda: REQUESTED_AT.astimezone(timezone(timedelta(hours=-4))),
    )

    record, newly_created = store.request("run-1", RunCancellationMode.AFTER_CURRENT_JOB)

    assert newly_created is True
    assert record == RunCancellationRequestRecord(
        run_id="run-1",
        mode=RunCancellationMode.AFTER_CURRENT_JOB,
        requested_at=REQUESTED_AT,
    )
    assert (
        RunCancellationRequestStore(database_path).get(
            "run-1", RunCancellationMode.AFTER_CURRENT_JOB
        )
        == record
    )


def test_repeated_request_preserves_original_timestamp(tmp_path: Path) -> None:
    times = iter((REQUESTED_AT, REQUESTED_AT + timedelta(hours=1)))
    store = RunCancellationRequestStore(_database(tmp_path), clock=lambda: next(times))

    first, first_created = store.request("run-1", RunCancellationMode.AFTER_CURRENT_JOB)
    repeated, repeated_created = store.request("run-1", RunCancellationMode.AFTER_CURRENT_JOB)

    assert first_created is True
    assert repeated_created is False
    assert repeated == first
    assert repeated.requested_at == REQUESTED_AT


@pytest.mark.parametrize("run_id", ("", "  "))
def test_request_and_get_reject_blank_run_id(tmp_path: Path, run_id: str) -> None:
    store = RunCancellationRequestStore(_database(tmp_path))

    with pytest.raises(RunCancellationValidationError, match="Run ID"):
        store.request(run_id, RunCancellationMode.AFTER_CURRENT_JOB)
    with pytest.raises(RunCancellationValidationError, match="Run ID"):
        store.get(run_id, RunCancellationMode.AFTER_CURRENT_JOB)


def test_request_rejects_unsupported_mode_and_naive_clock(tmp_path: Path) -> None:
    database_path = _database(tmp_path)
    store = RunCancellationRequestStore(database_path)

    with pytest.raises(RunCancellationValidationError, match="mode is unsupported"):
        store.request("run-1", cast(RunCancellationMode, "immediate"))
    with pytest.raises(RunCancellationValidationError, match="aware datetime"):
        RunCancellationRequestStore(
            database_path,
            clock=lambda: datetime(2026, 9, 1, 12, 30),
        ).request("run-1", RunCancellationMode.AFTER_CURRENT_JOB)


def test_get_rejects_persisted_timestamp_without_utc_offset(tmp_path: Path) -> None:
    database_path = _database(tmp_path)
    with closing(open_connection(database_path)) as connection:
        connection.execute(
            "INSERT INTO run_cancellation_request VALUES (?, ?, ?)",
            ("run-1", RunCancellationMode.AFTER_CURRENT_JOB, "2026-09-01T12:30:00"),
        )
        connection.commit()

    with pytest.raises(RunCancellationStoreError, match="must include a UTC offset"):
        RunCancellationRequestStore(database_path).get(
            "run-1", RunCancellationMode.AFTER_CURRENT_JOB
        )


def test_concurrent_duplicate_requests_create_once(tmp_path: Path) -> None:
    database_path = _database(tmp_path)

    def request() -> tuple[RunCancellationRequestRecord, bool]:
        return RunCancellationRequestStore(
            database_path,
            clock=lambda: REQUESTED_AT,
        ).request("run-1", RunCancellationMode.AFTER_CURRENT_JOB)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = tuple(executor.map(lambda _index: request(), range(2)))

    assert sorted(newly_created for _record, newly_created in results) == [False, True]
    assert results[0][0] == results[1][0]


@pytest.mark.parametrize("operation", ("request", "get"))
def test_database_errors_use_declared_store_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    store = RunCancellationRequestStore(_database(tmp_path))

    def fail_open(_path: Path) -> None:
        raise sqlite3.OperationalError("private database detail")

    monkeypatch.setattr("batchcraft.db.cancellations.open_connection", fail_open)

    with pytest.raises(RunCancellationStoreError, match="database operation failed") as raised:
        getattr(store, operation)("run-1", RunCancellationMode.AFTER_CURRENT_JOB)

    assert "private database detail" not in str(raised.value)
