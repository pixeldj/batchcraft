import sqlite3
from pathlib import Path


def open_connection(path: str | Path) -> sqlite3.Connection:
    """Open one configured SQLite connection owned by the caller."""
    connection = sqlite3.connect(path, isolation_level="DEFERRED")
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
    except BaseException:
        connection.close()
        raise
    return connection


connect_database = open_connection
