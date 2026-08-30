from pathlib import Path

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
