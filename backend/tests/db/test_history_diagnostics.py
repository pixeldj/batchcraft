import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from batchcraft.db import history_diagnostics as queries
from batchcraft.db import open_connection
from batchcraft.db.history import HistoricalProjectionError, HistoricalProjectionStore
from batchcraft.db.history_query import (
    HistoryQuery,
    HistoryQueryError,
    _decode_cursor,
    _encode_cursor,
    query_runs,
)

from .test_history_query import _scan
from .test_history_query import database as database


def seed(database: Path) -> None:
    with closing(open_connection(database)) as connection:
        connection.executemany(
            "INSERT INTO historical_diagnostic VALUES ('project', ?, 'run', ?, NULL, 'invalid_run', 'secret')",
            [(1, "001-broken"), (2, "x" * 600), (3, "../../secret")],
        )
        connection.executemany(
            "INSERT INTO historical_diagnostic VALUES ('project', ?, ?, ?, ?, ?, 'secret')",
            [
                (4, "execution", "001-run", "a", "invalid_execution"),
                (5, "result", "outputs/missing.png", "a-job-1:1", "missing_result"),
            ],
        )
        connection.commit()


@pytest.mark.parametrize("continuation", [False, True])
def test_diagnostics_share_generation_bookmark_and_page_snapshot(
    database: Path, monkeypatch: pytest.MonkeyPatch, continuation: bool
) -> None:
    seed(database)
    first = queries.query_diagnostics(database, "project", 1)
    cursor = first.next_cursor if continuation else None
    expected = queries.query_diagnostics(database, "project", cursor=cursor)
    replaced: list[bool] = []

    def connect(path: Path) -> sqlite3.Connection:
        connection = open_connection(path)

        def trace(sql: str) -> None:
            if (
                sql.startswith("SELECT")
                and "historical_projection_state" not in sql
                and not replaced
            ):
                assert connection.in_transaction
                HistoricalProjectionStore(database).replace_project(_scan(database), register=False)
                replaced.append(True)

        connection.set_trace_callback(trace)
        return connection

    monkeypatch.setattr(queries, "open_connection", connect)

    def forbidden(*args: object, **kwargs: object) -> None:
        pytest.fail("No Project filesystem access on diagnostic GET")

    for name in ("read_bytes", "read_text", "open", "iterdir", "stat", "lstat", "resolve"):
        monkeypatch.setattr(Path, name, forbidden)
    assert queries.query_diagnostics(database, "project", cursor=cursor) == expected
    assert replaced == [True]


def test_diagnostic_rollback_and_strict_bookmarks(database: Path) -> None:
    seed(database)
    first = queries.query_diagnostics(database, "project", 1)
    assert first.items[0].name_excerpt == "001-broken"
    rest = queries.query_diagnostics(database, "project", cursor=first.next_cursor)
    assert len(rest.items[0].name_excerpt or "") == 256 and rest.items[0].display_truncated
    assert rest.items[1].name_excerpt is None
    assert rest.items[2].scope == "execution" and rest.items[2].name_excerpt == "Portrait"
    assert rest.items[3].scope == "result" and rest.items[3].entity_id == "a-job-1:1"
    assert rest.items[3].name_excerpt is None
    with closing(open_connection(database)) as connection:
        connection.execute("""CREATE TRIGGER reject_generation BEFORE UPDATE ON historical_projection_state
            BEGIN SELECT RAISE(ABORT, 'generation rejected'); END""")
        connection.commit()
    with pytest.raises(HistoricalProjectionError):
        HistoricalProjectionStore(database).replace_project(_scan(database), register=False)
    assert queries.query_diagnostics(database, "project", 1) == first
    assert queries.query_diagnostics(database, "project", cursor=first.next_cursor) == rest
    assert first.next_cursor is not None
    payload = _decode_cursor(first.next_cursor)
    for invalid in (
        {**payload, "rowid": True},
        {**payload, "rowid": 999},
        {**payload, "extra": 1},
        {**payload, "v": 1},
    ):
        with pytest.raises(HistoryQueryError):
            queries.query_diagnostics(database, "project", cursor=_encode_cursor(invalid))
    run_cursor = query_runs(database, "project", HistoryQuery(limit=1)).next_cursor
    with pytest.raises(HistoryQueryError):
        queries.query_diagnostics(database, "project", cursor=run_cursor)
    with pytest.raises(HistoryQueryError):
        query_runs(database, "project", HistoryQuery(cursor=first.next_cursor))
