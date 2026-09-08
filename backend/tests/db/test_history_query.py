import base64
import json
import sqlite3
from contextlib import closing
from dataclasses import FrozenInstanceError, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

import pytest

from batchcraft.db import apply_migrations, open_connection
from batchcraft.db import history_query as queries
from batchcraft.db.history import HistoricalProjectionError, HistoricalProjectionStore
from batchcraft.db.history_query import (
    HistoryGenerationChangedError,
    HistoryQuery,
    HistoryQueryError,
    query_results,
    query_runs,
)
from batchcraft.files.history import ProjectHistoryScan
from batchcraft.files.models import ProjectIdentity

GENERATION = "a" * 32
SCANNED_AT = "2026-09-07T12:00:00.000000Z"


def _seed_run(
    connection: sqlite3.Connection,
    run_id: str,
    created_at: str = "2026-09-07T12:00:00Z",
    *,
    project_id: str = "project",
    batch_id: str = "batch",
    name: str | None = None,
    description: str | None = None,
    execution_status: str | None = "succeeded",
    execution_available: bool = True,
    artifacts: tuple[int, ...] = (2, 1),
) -> None:
    connection.execute(
        "INSERT INTO historical_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            run_id,
            project_id,
            batch_id,
            batch_id,
            "Batch",
            1,
            run_id,
            name,
            description,
            created_at,
            f"batches/{batch_id}/{run_id}",
            len(artifacts),
            int(execution_available),
            execution_status,
            None,
            None,
            "verified",
            1,
        ),
    )
    for job, count in enumerate(artifacts, 1):
        job_id = f"{run_id}-job-{job}"
        connection.execute(
            "INSERT INTO historical_job VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                project_id,
                run_id,
                job_id,
                job,
                "prompt",
                "text",
                "[]",
                "[]",
                1,
                "output",
                execution_status,
                None,
                None,
                None,
                None,
                "[]",
            ),
        )
        for artifact in range(1, count + 1):
            connection.execute(
                "INSERT INTO historical_result VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    project_id,
                    run_id,
                    job_id,
                    job,
                    artifact,
                    "9",
                    "images",
                    "image.png",
                    "",
                    "output",
                    f"outputs/{job}-{artifact}.png",
                    "image/png",
                    12,
                    "a" * 64,
                    "verified",
                ),
            )


@pytest.fixture
def database(tmp_path: Path) -> Path:
    path = tmp_path / "history.sqlite3"
    with closing(open_connection(path)) as connection:
        apply_migrations(connection)
        for project in ("project", "other"):
            connection.execute(
                "INSERT INTO project VALUES (?, ?, ?, NULL, ?, ?, NULL)",
                (project, project, project, SCANNED_AT, SCANNED_AT),
            )
            connection.execute(
                "INSERT INTO historical_projection_state VALUES (?, ?, ?)",
                (project, GENERATION, SCANNED_AT),
            )
        _seed_run(connection, "a", "2026-09-07T13:00:00+01:00", name="Portrait")
        _seed_run(connection, "b", "2026-09-07T12:00:00Z", batch_id="second", artifacts=(1, 3))
        _seed_run(connection, "c", "2026-09-07T07:00:00-05:00", artifacts=())
        _seed_run(connection, "later", "2026-09-07T12:00:00.001Z", execution_status="running")
        _seed_run(connection, "earlier", "2026-09-07T12:30:00+01:00", execution_status="failed")
        _seed_run(
            connection,
            "unknown-a",
            "not a timestamp",
            execution_available=False,
            execution_status=None,
        )
        _seed_run(connection, "unknown-b", "", execution_status="blocked")
        _seed_run(connection, "unknown-c", "now", execution_status="created")
        _seed_run(connection, "foreign", project_id="other", execution_status="cancelled")
        connection.commit()
    return path


@pytest.mark.parametrize("sort", ["newest", "oldest"])
@pytest.mark.parametrize("limit", [1, 2, 3, 7, 100])
def test_keyset_pagination_normalizes_instants_and_retains_unknowns(
    database: Path, sort: Literal["newest", "oldest"], limit: int
) -> None:
    expected = (
        ["later", "a", "b", "c", "earlier"]
        if sort == "newest"
        else ["earlier", "a", "b", "c", "later"]
    ) + ["unknown-a", "unknown-b", "unknown-c"]
    query = HistoryQuery(limit=limit, sort=sort)
    runs: list[str] = []
    counts: dict[str, int] = {}
    while True:
        page = query_runs(database, "project", query)
        assert page.generation == GENERATION
        assert page.scanned_at == SCANNED_AT
        assert len(page.items) <= limit
        for item in page.items:
            runs.append(item.run.run_id)
            counts[item.run.run_id] = item.result_count
        if not page.has_more:
            break
        assert page.next_cursor is not None and len(page.next_cursor) <= 8192
        query = replace(query, cursor=page.next_cursor)
        assert len(runs) < len(expected)
    assert runs == expected
    assert counts == {run: (0 if run == "c" else 4 if run == "b" else 3) for run in expected}

    results: list[tuple[str, int, int]] = []
    query = HistoryQuery(limit=limit, sort=sort)
    while True:
        result_page = query_results(database, "project", query)
        assert result_page.generation == GENERATION
        assert result_page.scanned_at == SCANNED_AT
        assert len(result_page.items) <= limit
        for result_item in result_page.items:
            result = result_item.result
            assert result_item.run.project_id == "project"
            assert result_item.run.run_id == result.run_id
            assert result.job_id == f"{result.run_id}-job-{result.job_ordinal}"
            results.append((result.run_id, result.job_ordinal, result.artifact_ordinal))
        if not result_page.has_more:
            break
        query = replace(query, cursor=result_page.next_cursor)
        assert len(results) < 100
    assert results == [
        (run, job, artifact)
        for run in expected
        for job, count in enumerate(() if run == "c" else (1, 3) if run == "b" else (2, 1), 1)
        for artifact in range(1, count + 1)
    ]


@pytest.mark.parametrize("kind", ["runs", "results"])
def test_filters_and_literal_full_notes_search(database: Path, kind: str) -> None:
    query_fn = query_runs if kind == "runs" else query_results
    notes = "x" * 1000 + " MAGIC 100%_quote' \\ " + "\u00c9"
    with closing(open_connection(database)) as connection:
        connection.execute("UPDATE historical_run SET description = ? WHERE run_id = 'a'", (notes,))
        connection.commit()
    for text in ("MAGIC", "magic", "%", "_", "quote'", "\\", "\u00c9", "Portrait", "portRAIT"):
        page = query_fn(database, "project", HistoryQuery(q=text))
        assert {item.run.run_id for item in page.items} == {"a"}
        assert all(item.run.description == notes[:513] for item in page.items)
    for text in ("100X", "' OR 1=1 --", "\u00e9", "missing"):
        assert query_fn(database, "project", HistoryQuery(q=text)).items == ()
    for query, expected in (
        (HistoryQuery(run_id="b"), {"b"}),
        (HistoryQuery(batch_id="second"), {"b"}),
        (HistoryQuery(execution_status="failed"), {"earlier"}),
        (HistoryQuery(execution_available=False), {"unknown-a"}),
        (HistoryQuery(execution_available=True, run_id="unknown-a"), set()),
        (
            HistoryQuery(
                execution_status="succeeded",
                q="magic",
                batch_id="batch",
                run_id="a",
                execution_available=True,
            ),
            {"a"},
        ),
        (HistoryQuery(run_id="foreign"), set()),
        (HistoryQuery(run_id="' OR 1=1 --"), set()),
    ):
        assert {item.run.run_id for item in query_fn(database, "project", query).items} == expected
    assert {item.run.run_id for item in query_fn(database, "other", HistoryQuery()).items} == {
        "foreign"
    }


@pytest.mark.parametrize("kind", ["runs", "results"])
def test_empty_and_unreconciled_projection_reads_existing_rows(database: Path, kind: str) -> None:
    query_fn = query_runs if kind == "runs" else query_results
    empty = query_fn(database, "missing", HistoryQuery())
    assert empty.items == ()
    assert empty.generation is None and empty.scanned_at is None and empty.next_cursor is None
    with closing(open_connection(database)) as connection:
        connection.execute("DELETE FROM historical_projection_state WHERE project_id = 'project'")
        connection.commit()
    page = query_fn(database, "project", HistoryQuery(limit=1))
    assert page.items and page.next_cursor
    assert page.generation is None and page.scanned_at is None
    assert query_fn(database, "project", HistoryQuery(limit=100, cursor=page.next_cursor)).items
    with closing(open_connection(database)) as connection:
        assert (
            connection.execute(
                "SELECT * FROM historical_projection_state WHERE project_id = 'project'"
            ).fetchall()
            == []
        )
        connection.execute(
            "INSERT INTO historical_projection_state VALUES ('project', ?, ?)",
            (GENERATION, SCANNED_AT),
        )
        connection.commit()
    with pytest.raises(HistoryGenerationChangedError):
        query_fn(database, "project", HistoryQuery(cursor=page.next_cursor))


@pytest.mark.parametrize(
    "change",
    [
        {"q": "different"},
        {"sort": "oldest"},
        {"run_id": "a"},
        {"batch_id": "batch"},
        {"execution_status": "running"},
        {"execution_available": False},
    ],
)
def test_cursor_binds_all_filters(database: Path, change: dict[str, Any]) -> None:
    for query_fn in (query_runs, query_results):
        cursor = query_fn(database, "project", HistoryQuery(limit=1)).next_cursor
        with pytest.raises(HistoryQueryError, match="mismatched"):
            query_fn(database, "project", HistoryQuery(cursor=cursor, **change))


def test_cursor_binds_project_and_kind_but_not_limit(database: Path) -> None:
    cursor = query_runs(database, "project", HistoryQuery(limit=1)).next_cursor
    assert cursor is not None
    with pytest.raises(HistoryQueryError):
        query_runs(database, "other", HistoryQuery(cursor=cursor))
    with pytest.raises(HistoryQueryError):
        query_results(database, "project", HistoryQuery(cursor=cursor))
    next_page = query_runs(database, "project", HistoryQuery(limit=100, cursor=cursor))
    assert len(next_page.items) == 7


@pytest.mark.parametrize("cursor", ["", "!", "not base64", "e30=", "W10=", "bnVsbA==", "////"])
def test_malformed_cursors(database: Path, cursor: str) -> None:
    with pytest.raises(HistoryQueryError):
        query_runs(database, "project", HistoryQuery(cursor=cursor))


@pytest.mark.parametrize(
    "field,value",
    [
        ("v", 1),
        ("v", True),
        ("binding", None),
        ("extra", 1),
        ("generation", 1),
        ("key", [0, 0, "a"]),
        ("rowid", None),
        ("rowid", []),
        ("rowid", False),
        ("rowid", 0),
        ("rowid", -1),
        ("rowid", "1"),
        ("rowid", 1.5),
        ("rowid", float("nan")),
        ("rowid", float("inf")),
        ("rowid", 2**63),
        ("rowid", 10**400),
    ],
)
@pytest.mark.parametrize("kind", ["runs", "results"])
def test_cursor_payload_validation(database: Path, field: str, value: object, kind: str) -> None:
    query_fn = query_runs if kind == "runs" else query_results
    cursor = query_fn(database, "project", HistoryQuery(limit=1)).next_cursor
    assert cursor is not None
    payload = json.loads(base64.urlsafe_b64decode(cursor))
    payload[field] = value
    malformed = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode()
    with pytest.raises(HistoryQueryError):
        query_fn(database, "project", HistoryQuery(cursor=malformed))


@pytest.mark.parametrize("kind", ["runs", "results"])
def test_missing_or_cross_project_bookmark_is_invalid(database: Path, kind: str) -> None:
    query_fn = query_runs if kind == "runs" else query_results
    cursor = query_fn(database, "project", HistoryQuery(limit=1)).next_cursor
    assert cursor is not None
    table = "historical_run" if kind == "runs" else "historical_result"
    with closing(open_connection(database)) as connection:
        foreign = connection.execute(
            f"SELECT rowid FROM {table} WHERE project_id = 'other'"
        ).fetchone()[0]
    for rowid in (foreign, 2**63 - 1):
        payload = json.loads(base64.urlsafe_b64decode(cursor))
        payload["rowid"] = rowid
        malformed = base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":")).encode()
        ).decode()
        with pytest.raises(HistoryQueryError):
            query_fn(database, "project", HistoryQuery(cursor=malformed))
    with closing(open_connection(database)) as connection:
        connection.execute(
            f"DELETE FROM {table} WHERE rowid = ?",
            (json.loads(base64.urlsafe_b64decode(cursor))["rowid"],),
        )
        connection.commit()
    with pytest.raises(HistoryQueryError, match="bookmark"):
        query_fn(database, "project", HistoryQuery(cursor=cursor))


@pytest.mark.parametrize(
    "invalid",
    [
        {"limit": 0},
        {"limit": 101},
        {"limit": True},
        {"limit": 1.5},
        {"limit": "1"},
        {"sort": "bad"},
        {"q": "x" * 201},
        {"q": None},
        {"q": "\ud800"},
        {"cursor": "x" * 8193},
        {"cursor": 1},
        {"run_id": 1},
        {"run_id": "\ud800"},
        {"batch_id": []},
        {"batch_id": "\udfff"},
        {"execution_status": "pending"},
        {"execution_available": 1},
    ],
)
def test_query_validation(invalid: dict[str, Any]) -> None:
    with pytest.raises(HistoryQueryError):
        HistoryQuery(**invalid)


def test_query_boundaries_and_immutable_models(database: Path) -> None:
    query = HistoryQuery(q="x" * 200, run_id="r" * 7000, batch_id="b" * 7000, cursor="x" * 8192)
    for status in ("created", "running", "succeeded", "failed", "blocked", "cancelled"):
        HistoryQuery(execution_status=status)
    with pytest.raises(HistoryQueryError):
        query_runs(database, "\ud800", HistoryQuery())
    page = query_runs(database, "project", HistoryQuery())
    for model, name in ((query, "limit"), (page, "generation"), (page.items[0], "result_count")):
        with pytest.raises(FrozenInstanceError):
            setattr(model, name, None)


def _scan(database: Path) -> ProjectHistoryScan:
    return ProjectHistoryScan(
        project=ProjectIdentity(id="project", filesystem_key="project", name="project"),
        project_path=database.parent / "nonexistent-project",
        directory_identity=(0, 0, 0, 0),
        batches=(),
        assets=(),
        runs=(),
        diagnostics=(),
    )


@pytest.mark.parametrize("reconciled", [False, True])
def test_reindex_rotates_generation_and_failed_replacement_preserves_snapshot(
    database: Path,
    reconciled: bool,
) -> None:
    store = HistoricalProjectionStore(database)
    if not reconciled:
        with closing(open_connection(database)) as connection:
            connection.execute(
                "DELETE FROM historical_projection_state WHERE project_id = 'project'"
            )
            connection.commit()
    before = query_runs(database, "project", HistoryQuery(limit=1))
    before_results = query_results(database, "project", HistoryQuery())
    with closing(open_connection(database)) as connection:
        operation = "UPDATE" if reconciled else "INSERT"
        connection.execute(f"""
            CREATE TRIGGER reject_generation BEFORE {operation} ON historical_projection_state
            BEGIN SELECT RAISE(ABORT, 'generation rejected'); END
        """)
        connection.commit()
    with pytest.raises(HistoricalProjectionError, match="generation rejected"):
        store.replace_project(_scan(database), register=False)
    assert query_runs(database, "project", HistoryQuery(limit=1)) == before
    assert query_results(database, "project", HistoryQuery()) == before_results
    with closing(open_connection(database)) as connection:
        connection.execute("DROP TRIGGER reject_generation")
        connection.commit()
    start = datetime.now(UTC)
    store.replace_project(_scan(database), register=False)
    page = query_runs(database, "project", HistoryQuery())
    assert page.items == () and page.next_cursor is None
    assert page.generation is not None and page.generation != GENERATION
    assert UUID(hex=page.generation).version == 4 and len(page.generation) == 32
    assert page.scanned_at is not None and page.scanned_at.endswith("Z")
    assert start <= datetime.fromisoformat(page.scanned_at) <= datetime.now(UTC)
    with pytest.raises(HistoryGenerationChangedError):
        query_runs(database, "project", HistoryQuery(cursor=before.next_cursor))
    store.replace_project(_scan(database), register=False)
    assert query_runs(database, "project", HistoryQuery()).generation != page.generation
    assert query_runs(database, "other", HistoryQuery()).generation == GENERATION
    assert query_results(database, "other", HistoryQuery()).items


@pytest.mark.parametrize("kind", ["runs", "results"])
@pytest.mark.parametrize("continuation", [False, True])
def test_one_read_transaction_and_no_filesystem_access(
    database: Path, monkeypatch: pytest.MonkeyPatch, kind: str, continuation: bool
) -> None:
    query_fn = query_runs if kind == "runs" else query_results
    cursor = (
        query_fn(database, "project", HistoryQuery(limit=1)).next_cursor if continuation else None
    )
    query = HistoryQuery(cursor=cursor)
    expected = query_fn(database, "project", query)
    calls = 0
    statements: list[str] = []
    replacements: list[bool] = []

    def connect(path: Path) -> sqlite3.Connection:
        nonlocal calls
        calls += 1
        connection = open_connection(path)

        def trace(sql: str) -> None:
            statements.append(sql)
            if (
                sql.startswith("SELECT")
                and "historical_projection_state" not in sql
                and not replacements
            ):
                assert connection.in_transaction
                # Replace between generation and bookmark/page reads. Bookmark,
                # page and correlated counts must all see the old WAL snapshot.
                HistoricalProjectionStore(database).replace_project(_scan(database), register=False)
                replacements.append(True)

        connection.set_trace_callback(trace)
        return connection

    def forbidden(*args: object, **kwargs: object) -> Any:
        pytest.fail("history queries must not access Project files or legacy list methods")

    monkeypatch.setattr(queries, "open_connection", connect)
    for name in ("read_bytes", "read_text", "open", "iterdir", "stat", "lstat", "resolve"):
        monkeypatch.setattr(Path, name, forbidden)
    monkeypatch.setattr(HistoricalProjectionStore, "list_runs", forbidden)
    monkeypatch.setattr(HistoricalProjectionStore, "list_results", forbidden)
    assert query_fn(database, "project", query) == expected
    assert calls == 1
    assert replacements == [True]
    assert statements[0:2] == ["PRAGMA query_only = ON", "BEGIN"]
    assert statements[-1] == "ROLLBACK"
    assert len([sql for sql in statements if sql.startswith("SELECT")]) == (
        3 if continuation else 2
    )
    assert not any("OFFSET" in sql for sql in statements)


def test_project_deletes_do_not_expand_run_ids_and_clean_orphans(
    database: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from batchcraft.db import history

    with closing(open_connection(database)) as connection:
        for index in range(24):
            _seed_run(connection, f"extra-{index}", artifacts=())
        for project in ("project", "other"):
            connection.execute(
                "INSERT INTO historical_resolved_parameter VALUES (?, ?, ?, 1, 'p', 'P', '1')",
                (project, project + "-orphan", "job"),
            )
            connection.execute(
                "INSERT INTO historical_image_input VALUES (?, ?, ?, 1, 'i', 'I', NULL)",
                (project, project + "-orphan", "job"),
            )
            connection.execute(
                "INSERT INTO historical_asset_use VALUES (?, 'asset', ?, ?, 'i')",
                (project, project + "-orphan", "job"),
            )
        connection.commit()

    def limited_connection(path: Path) -> sqlite3.Connection:
        connection = open_connection(path)
        connection.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 18)
        return connection

    monkeypatch.setattr(history, "open_connection", limited_connection)
    HistoricalProjectionStore(database).replace_project(_scan(database), register=False)
    with closing(open_connection(database)) as connection:
        for table in (
            "historical_run",
            "historical_job",
            "historical_result",
            "historical_resolved_parameter",
            "historical_image_input",
            "historical_asset_use",
        ):
            assert connection.execute(
                f"SELECT count(*) FROM {table} WHERE project_id = 'project'"
            ).fetchone() == (0,)
            assert (
                connection.execute(
                    f"SELECT count(*) FROM {table} WHERE project_id = 'other'"
                ).fetchone()[0]
                > 0
            )


@pytest.mark.parametrize("sort", ["newest", "oldest"])
def test_run_sort_uses_expression_index(
    database: Path, monkeypatch: pytest.MonkeyPatch, sort: Literal["newest", "oldest"]
) -> None:
    statements: list[str] = []

    def connect(path: Path) -> sqlite3.Connection:
        connection = open_connection(path)
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(queries, "open_connection", connect)
    query_runs(database, "project", HistoryQuery(sort=sort, limit=1))
    sql = next(sql for sql in statements if sql.startswith("SELECT r.run_id"))
    with closing(open_connection(database)) as connection:
        plan = " ".join(row[3] for row in connection.execute("EXPLAIN QUERY PLAN " + sql))
    assert f"historical_run_{sort}_idx" in plan
    assert "historical_result_project_idx" in plan
    assert "TEMP B-TREE" not in plan


@pytest.mark.parametrize("kind", ["runs", "results"])
@pytest.mark.parametrize("character", ["r", "\U0001f600"])
def test_long_ids_stay_exact_and_do_not_expand_cursors(
    database: Path, kind: str, character: str
) -> None:
    query_fn = query_runs if kind == "runs" else query_results
    project_id, batch_id = character * 7000 + "project", character * 7000 + "batch"
    identifiers = [character * 7000 + str(index) for index in range(2)]
    with closing(open_connection(database)) as connection:
        for identifier in identifiers:
            _seed_run(
                connection, identifier, project_id=project_id, batch_id=batch_id, artifacts=(1,)
            )
        connection.execute(
            "INSERT INTO historical_projection_state VALUES (?, ?, ?)",
            (project_id, GENERATION, SCANNED_AT),
        )
        connection.commit()
    query = HistoryQuery(limit=1, batch_id=batch_id)
    page = query_fn(database, project_id, query)
    assert page.items[0].run.run_id == identifiers[0]
    assert page.items[0].run.project_id == project_id
    assert page.items[0].run.batch_id == batch_id
    assert page.next_cursor and len(page.next_cursor) < 256
    payload = json.loads(base64.urlsafe_b64decode(page.next_cursor))
    assert set(payload) == {"v", "binding", "generation", "rowid"}
    assert isinstance(payload["rowid"], int)
    rest = query_fn(database, project_id, replace(query, cursor=page.next_cursor))
    assert [item.run.run_id for item in rest.items] == identifiers[1:]
    for identifier in identifiers:
        filtered = query_fn(
            database, project_id, HistoryQuery(run_id=identifier, batch_id=batch_id)
        )
        assert [item.run.run_id for item in filtered.items] == [identifier]
        if kind == "results":
            result_page = query_results(database, project_id, HistoryQuery(run_id=identifier))
            assert result_page.items[0].result.job_id == f"{identifier}-job-1"
    short_cursor = query_fn(database, "project", HistoryQuery(limit=1)).next_cursor
    assert short_cursor is not None
    assert abs(len(page.next_cursor) - len(short_cursor)) <= 4


@pytest.mark.parametrize("timestamp", ["now", "NOW\0suffix", "subsec", "SUBSECOND"])
def test_sqlite_current_time_tokens_are_stable_unknowns(database: Path, timestamp: str) -> None:
    with closing(open_connection(database)) as connection:
        _seed_run(connection, "z-unknown", timestamp)
        connection.commit()
    for query in (HistoryQuery(sort="newest"), HistoryQuery(sort="oldest")):
        page = query_runs(database, "project", query)
        assert page.items[-1].run.run_id == "z-unknown"


def test_sql_browse_projection_bounds_large_fields_before_result_materialization(
    database: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    name = "n" * (10 * 1024 * 1024) + " needle-name"
    notes = "d" * 10000 + " needle-notes"
    detail = "unused-detail" * 1000
    with closing(open_connection(database)) as connection:
        _seed_run(connection, "large", name=name, description=notes, artifacts=(100,))
        connection.execute(
            """UPDATE historical_run SET batch_name = ?, batch_filesystem_key = ?,
                filesystem_key = ?, relative_path = ?, started_at = ?, completed_at = ?
                WHERE run_id = 'large'""",
            (detail,) * 6,
        )
        connection.execute(
            """UPDATE historical_result SET remote_filename = ?, local_path = ?,
                remote_subfolder = ?, remote_type = ?, producing_node_id = ?, output_name = ?,
                content_type = ? WHERE run_id = 'large'""",
            (detail,) * 7,
        )
        connection.commit()

    unused = {
        "historical_run": {
            "batch_filesystem_key",
            "filesystem_key",
            "relative_path",
            "started_at",
            "completed_at",
        },
        "historical_result": {
            "local_path",
            "remote_subfolder",
            "remote_type",
            "producing_node_id",
            "output_name",
        },
    }

    def connect(path: Path) -> sqlite3.Connection:
        connection = open_connection(path)

        def authorize(
            action: int,
            table: str | None,
            column: str | None,
            database_name: str | None,
            trigger: str | None,
        ) -> int:
            if action == sqlite3.SQLITE_READ and column in unused.get(table or "", set()):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        connection.set_authorizer(authorize)
        return connection

    monkeypatch.setattr(queries, "open_connection", connect)
    for text in ("needle-name", "needle-notes"):
        page = query_results(database, "project", HistoryQuery(limit=100, q=text))
        assert len(page.items) == 100 and page.next_cursor is None
        for item in page.items:
            assert item.run.name == name[:257]
            assert item.run.description == notes[:513]
            assert item.run.batch_name == detail[:257]
            assert (
                item.run.batch_filesystem_key
                == item.run.filesystem_key
                == item.run.relative_path
                == ""
            )
            assert item.run.started_at is None and item.run.completed_at is None
            assert item.result.remote_filename == detail[:257]
            assert item.result.content_type == detail[:257]
            assert (
                item.result.local_path
                == item.result.remote_subfolder
                == item.result.remote_type
                == ""
            )
            assert item.result.producing_node_id == item.result.output_name == ""
        run_page = query_runs(database, "project", HistoryQuery(q=text))
        assert run_page.items[0].run == page.items[0].run
        assert run_page.items[0].result_count == 100
    with closing(open_connection(database)) as connection:
        assert connection.execute(
            "SELECT length(name), length(description) FROM historical_run WHERE run_id = 'large'"
        ).fetchone() == (len(name), len(notes))


@pytest.mark.parametrize("kind", ["runs", "results"])
@pytest.mark.parametrize("sort", ["newest", "oldest"])
def test_exact_microsecond_pagination_with_offset_equivalence(
    database: Path, kind: str, sort: Literal["newest", "oldest"]
) -> None:
    query_fn = query_runs if kind == "runs" else query_results
    timestamps = (
        ("before", "1969-12-31T23:59:59.999999Z"),
        ("epoch", "1970-01-01"),
        ("z-micro", "2026-09-07T12:00:00.000001Z"),
        ("a-micro", "2026-09-07T12:00:00.000002Z"),
        ("equal-a", "2026-09-07T12:00:00.123456"),
        ("equal-b", "2026-09-07T13:00:00.123456+01:00"),
        ("equal-c", "2026-09-07T07:00:00.123456-05:00"),
        ("unknown", "not a date"),
    )
    with closing(open_connection(database)) as connection:
        for run_id, timestamp in timestamps:
            _seed_run(connection, run_id, timestamp, project_id="precision", artifacts=(2, 1))
        connection.commit()
    expected = [run_id for run_id, _ in timestamps]
    if sort == "newest":
        expected = [
            "equal-a",
            "equal-b",
            "equal-c",
            "a-micro",
            "z-micro",
            "epoch",
            "before",
            "unknown",
        ]
    if kind == "results":
        expected = [run_id for run_id in expected for _ in range(3)]
    query = HistoryQuery(limit=1, sort=sort)
    actual: list[str] = []
    while True:
        page = query_fn(database, "precision", query)
        actual.extend(item.run.run_id for item in page.items)
        if page.next_cursor is None:
            break
        query = replace(query, cursor=page.next_cursor)
        assert len(actual) < len(expected)
    assert actual == expected


def test_cursor_hash_binds_generation(database: Path) -> None:
    cursor = query_runs(database, "project", HistoryQuery(limit=1)).next_cursor
    assert cursor is not None
    payload = json.loads(base64.urlsafe_b64decode(cursor))
    payload["generation"] = "b" * 32
    altered = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    with pytest.raises(HistoryQueryError, match="mismatched") as error:
        query_runs(database, "project", HistoryQuery(cursor=altered))
    assert type(error.value) is HistoryQueryError
