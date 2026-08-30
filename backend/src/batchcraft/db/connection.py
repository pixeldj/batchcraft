import sqlite3
import time
from pathlib import Path


def open_connection(path: str | Path) -> sqlite3.Connection:
    """Open one configured SQLite connection owned by the caller."""
    connection = sqlite3.connect(path, isolation_level="DEFERRED")
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        _enable_wal(connection)
        connection.execute("PRAGMA synchronous = FULL")
    except BaseException:
        connection.close()
        raise
    return connection


connect_database = open_connection


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
