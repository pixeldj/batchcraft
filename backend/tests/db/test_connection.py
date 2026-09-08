from pathlib import Path

import pytest

from batchcraft.db import open_connection


def test_connect_database_applies_required_pragmas(tmp_path: Path) -> None:
    connection = open_connection(tmp_path / "batchcraft.sqlite3")
    try:
        assert connection.execute("PRAGMA foreign_keys").fetchone() == (1,)
        assert connection.execute("PRAGMA busy_timeout").fetchone() == (5000,)
        assert connection.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        assert connection.execute("PRAGMA synchronous").fetchone() == (2,)
        assert connection.isolation_level == "DEFERRED"
    finally:
        connection.close()


def test_connect_database_returns_independent_connections(tmp_path: Path) -> None:
    path = tmp_path / "batchcraft.sqlite3"
    first = open_connection(path)
    second = open_connection(path)
    try:
        assert first is not second
        first.execute("CREATE TABLE marker (value TEXT)")
        second.execute("INSERT INTO marker VALUES ('visible')")
        second.commit()
        assert first.execute("SELECT value FROM marker").fetchone() == ("visible",)
    finally:
        first.close()
        second.close()


@pytest.mark.parametrize(
    "value,expected",
    [
        ("1970-01-01", 0),
        ("19700101", 0),
        ("1970-01-01T00:00:00.000001Z", 1),
        ("1970-01-01 00:00:00.000002", 2),
        ("1970-01-01T01:00:00.123456+01:00", 123456),
        ("1969-12-31T19:00:00.123456-05:00", 123456),
        ("1969-12-31T23:59:59.999999Z", -1),
        ("0001-01-01T00:00:00Z", -62135596800000000),
        ("9999-12-31T23:59:59.999999Z", 253402300799999999),
        (None, None),
        (1, None),
        ("", None),
        ("invalid", None),
        ("now", None),
        ("subsec", None),
        ("subsecond", None),
        ("1970-01-01" + "x" * 65, None),
    ],
)
def test_history_timestamp_function_is_registered_exact_and_deterministic(
    tmp_path: Path, value: object, expected: int | None
) -> None:
    connection = open_connection(tmp_path / "batchcraft.sqlite3")
    try:
        assert connection.execute("SELECT history_timestamp_us(?)", (value,)).fetchone() == (
            expected,
        )
        flags = connection.execute(
            "SELECT flags FROM pragma_function_list WHERE name = 'history_timestamp_us'"
        ).fetchone()[0]
        assert flags & 2048  # SQLITE_DETERMINISTIC permits expression indexes.
    finally:
        connection.close()
