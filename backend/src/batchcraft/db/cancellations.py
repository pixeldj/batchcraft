import sqlite3
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from batchcraft.db.connection import open_connection
from batchcraft.db.models import RunCancellationMode, RunCancellationRequestRecord


class RunCancellationStoreError(ValueError):
    """A Run cancellation persistence operation failed."""


class RunCancellationValidationError(RunCancellationStoreError):
    """Run cancellation input is invalid."""


class RunCancellationRequestStore:
    def __init__(
        self,
        database_path: Path,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.database_path = database_path
        self._clock = clock or (lambda: datetime.now(UTC))

    def request(
        self,
        run_id: str,
        mode: RunCancellationMode,
    ) -> tuple[RunCancellationRequestRecord, bool]:
        _validate_nonblank(run_id, "Run ID")
        mode = _validate_mode(mode)
        try:
            with closing(open_connection(self.database_path)) as connection:
                try:
                    connection.execute("BEGIN IMMEDIATE")
                    record = _get(connection, run_id, mode)
                    newly_created = record is None
                    if record is None:
                        requested_at = _timestamp(self._clock)
                        connection.execute(
                            """
                            INSERT INTO run_cancellation_request (run_id, mode, requested_at)
                            VALUES (?, ?, ?)
                            """,
                            (run_id, mode.value, requested_at),
                        )
                        record = _get(connection, run_id, mode)
                        if record is None:
                            raise RunCancellationStoreError(
                                "Run cancellation request was not persisted"
                            )
                    connection.commit()
                except BaseException:
                    connection.rollback()
                    raise
        except RunCancellationStoreError:
            raise
        except sqlite3.Error as error:
            raise RunCancellationStoreError("Run cancellation database operation failed") from error
        return record, newly_created

    def get(
        self,
        run_id: str,
        mode: RunCancellationMode,
    ) -> RunCancellationRequestRecord | None:
        _validate_nonblank(run_id, "Run ID")
        mode = _validate_mode(mode)
        try:
            with closing(open_connection(self.database_path)) as connection:
                return _get(connection, run_id, mode)
        except RunCancellationStoreError:
            raise
        except sqlite3.Error as error:
            raise RunCancellationStoreError("Run cancellation database operation failed") from error


def _get(
    connection: sqlite3.Connection,
    run_id: str,
    mode: RunCancellationMode,
) -> RunCancellationRequestRecord | None:
    row = connection.execute(
        """
        SELECT run_id, mode, requested_at
        FROM run_cancellation_request
        WHERE run_id = ? AND mode = ?
        """,
        (run_id, mode.value),
    ).fetchone()
    if row is None:
        return None
    return _record(row)


def _record(row: tuple[object, ...]) -> RunCancellationRequestRecord:
    run_id = row[0]
    if not isinstance(run_id, str) or not run_id.strip():
        raise RunCancellationStoreError("run_cancellation_request.run_id must be nonblank")
    persisted_mode = row[1]
    if not isinstance(persisted_mode, str):
        raise RunCancellationStoreError("run_cancellation_request.mode is unsupported")
    try:
        mode = RunCancellationMode(persisted_mode)
    except (TypeError, ValueError) as error:
        raise RunCancellationStoreError("run_cancellation_request.mode is unsupported") from error
    return RunCancellationRequestRecord(
        run_id=run_id,
        mode=mode,
        requested_at=_parse_timestamp(row[2]),
    )


def _validate_nonblank(value: object, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise RunCancellationValidationError(f"{label} must be a nonempty string")


def _validate_mode(mode: object) -> RunCancellationMode:
    if not isinstance(mode, str):
        raise RunCancellationValidationError("Run cancellation mode is unsupported")
    try:
        return RunCancellationMode(mode)
    except (TypeError, ValueError) as error:
        raise RunCancellationValidationError("Run cancellation mode is unsupported") from error


def _timestamp(clock: Callable[[], datetime]) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise RunCancellationValidationError("clock must return an aware datetime")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: object) -> datetime:
    if not isinstance(value, str):
        raise RunCancellationStoreError(
            "run_cancellation_request.requested_at must be a timestamp string"
        )
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RunCancellationStoreError(
            "run_cancellation_request.requested_at is not a valid timestamp"
        ) from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RunCancellationStoreError(
            "run_cancellation_request.requested_at must include a UTC offset"
        )
    return parsed.astimezone(UTC)
