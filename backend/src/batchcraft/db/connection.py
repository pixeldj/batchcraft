import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path


def open_connection(path: str | Path) -> sqlite3.Connection:
    """Open one configured SQLite connection owned by the caller."""
    connection = sqlite3.connect(path, isolation_level="DEFERRED")
    try:
        connection.create_function(
            "history_timestamp_us", 1, _history_timestamp_us, deterministic=True
        )
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        _enable_wal(connection)
        connection.execute("PRAGMA synchronous = FULL")
    except BaseException:
        connection.close()
        raise
    return connection


connect_database = open_connection


def _history_timestamp_us(value: object) -> int | None:
    """Normalize ISO dates/datetimes (at most 64 chars) to exact epoch microseconds.

    Naive values mean UTC. Unknown strings remain indexable as NULL, never as
    current time. This deterministic function serves only rebuilt history indexes.
    """
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        delta = parsed - datetime(1970, 1, 1, tzinfo=UTC)
    except (ValueError, OverflowError):
        return None
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def _enable_wal(connection: sqlite3.Connection) -> None:
    deadline = time.monotonic() + 5
    while True:
        try:
            connection.execute("PRAGMA journal_mode = WAL")
            return
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower() or time.monotonic() >= deadline:
                raise
            # WAL initialization on a new file may not honor busy_timeout.
            time.sleep(0.01)
