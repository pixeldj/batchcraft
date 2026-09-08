"""SQL-only browsing of the last committed historical projection.

Unknown timestamps sort last in either direction; ties use ascending Run ID,
then ascending Job and artifact ordinals. Search uses SQLite lower()/instr():
literal substrings with ASCII-only case folding, not Unicode case folding.
Browse records are not detail records: SQL clips display strings to one character
beyond the API excerpt limit and omits unused paths/detail fields. IDs stay exact.
Timestamps use exact microseconds via history_timestamp_us; naive ISO values mean UTC.
"""

import base64
import binascii
import hashlib
import json
from contextlib import closing
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any, Literal

from batchcraft.db.connection import open_connection
from batchcraft.db.history import HistoricalResultRecord, HistoricalRunRecord, _run_from_row

_STATUSES = ("created", "running", "succeeded", "failed", "blocked", "cancelled")
_TIMESTAMP = "history_timestamp_us(r.created_at)"
_RUN_COLUMNS = """r.run_id, r.project_id, r.batch_id, '', substr(r.batch_name, 1, 257),
    r.run_number, '', substr(r.name, 1, 257), substr(r.description, 1, 513),
    substr(r.created_at, 1, 65), '', r.job_count, r.execution_available,
    substr(r.execution_status, 1, 32), NULL, NULL, r.integrity_status, r.replayable"""
_RESULT_COLUMNS = """a.run_id, a.job_id, a.job_ordinal, a.artifact_ordinal, '', '',
    substr(a.remote_filename, 1, 257), '', '', '', substr(a.content_type, 1, 257),
    a.byte_size, a.sha256, a.integrity_status"""
_RUN_WIDTH = len(fields(HistoricalRunRecord))


class HistoryQueryError(ValueError):
    """A history query or continuation cursor is invalid."""


class HistoryGenerationChangedError(HistoryQueryError):
    """The projection changed; restart browsing without a cursor."""


@dataclass(frozen=True, slots=True)
class HistoryQuery:
    limit: int = 50
    cursor: str | None = None
    sort: Literal["newest", "oldest"] = "newest"
    q: str = ""
    run_id: str | None = None
    batch_id: str | None = None
    execution_status: str | None = None
    execution_available: bool | None = None

    def __post_init__(self) -> None:
        if type(self.limit) is not int or not 1 <= self.limit <= 100:
            raise HistoryQueryError("limit must be an integer between 1 and 100")
        if self.sort not in ("newest", "oldest"):
            raise HistoryQueryError("sort must be newest or oldest")
        _bounded_text("q", self.q, 200)
        for name, value, maximum in (
            ("cursor", self.cursor, 8192),
            ("run_id", self.run_id, None),
            ("batch_id", self.batch_id, None),
        ):
            if value is not None:
                _bounded_text(name, value, maximum)
        if self.execution_status is not None and self.execution_status not in _STATUSES:
            raise HistoryQueryError("execution_status must be one of " + ", ".join(_STATUSES))
        if self.execution_available is not None and type(self.execution_available) is not bool:
            raise HistoryQueryError("execution_available must be a boolean")


@dataclass(frozen=True, slots=True)
class HistoryRunItem:
    run: HistoricalRunRecord
    result_count: int


@dataclass(frozen=True, slots=True)
class HistoryResultItem:
    run: HistoricalRunRecord
    result: HistoricalResultRecord


@dataclass(frozen=True, slots=True)
class HistoryPage[T]:
    items: tuple[T, ...]
    generation: str | None
    scanned_at: str | None
    next_cursor: str | None

    @property
    def has_more(self) -> bool:
        return self.next_cursor is not None


def query_runs(
    database_path: Path, project_id: str, query: HistoryQuery
) -> HistoryPage[HistoryRunItem]:
    page = _query(database_path, project_id, query, "runs")
    return HistoryPage(
        tuple(HistoryRunItem(_run_from_row(row), row[_RUN_WIDTH]) for row in page.items),
        page.generation,
        page.scanned_at,
        page.next_cursor,
    )


def query_results(
    database_path: Path, project_id: str, query: HistoryQuery
) -> HistoryPage[HistoryResultItem]:
    page = _query(database_path, project_id, query, "results")
    return HistoryPage(
        tuple(
            HistoryResultItem(_run_from_row(row), HistoricalResultRecord(*row[_RUN_WIDTH:]))
            for row in page.items
        ),
        page.generation,
        page.scanned_at,
        page.next_cursor,
    )


def _query(
    database_path: Path, project_id: str, query: HistoryQuery, kind: Literal["runs", "results"]
) -> HistoryPage[tuple[Any, ...]]:
    _bounded_text("project_id", project_id)
    cursor = None if query.cursor is None else _decode_cursor(query.cursor)
    timestamp = (
        f"coalesce(-{_TIMESTAMP}, 0)" if query.sort == "newest" else f"coalesce({_TIMESTAMP}, 0)"
    )
    keys = [f"{_TIMESTAMP} IS NULL", timestamp, "r.run_id"]
    predicates = ["r.project_id = ?"]
    parameters: list[object] = [project_id]
    for column, value in (
        ("run_id", query.run_id),
        ("batch_id", query.batch_id),
        ("execution_status", query.execution_status),
        ("execution_available", query.execution_available),
    ):
        if value is not None:
            predicates.append(f"r.{column} = ?")
            parameters.append(value)
    if query.q:
        predicates.append(
            "(instr(lower(r.name), lower(?)) > 0 OR instr(lower(r.description), lower(?)) > 0)"
        )
        parameters.extend((query.q, query.q))
    source = "historical_run r"
    bookmark = "r.rowid"
    selection = (
        f"{_RUN_COLUMNS}, (SELECT count(*) FROM historical_result a "
        "WHERE a.project_id = r.project_id AND a.run_id = r.run_id)"
    )
    if kind == "results":
        source += " JOIN historical_result a ON a.project_id = r.project_id AND a.run_id = r.run_id"
        selection = f"{_RUN_COLUMNS}, {_RESULT_COLUMNS}"
        keys.extend(("a.job_ordinal", "a.artifact_ordinal"))
        bookmark = "a.rowid"
    key_sql = ", ".join(keys)

    with closing(open_connection(database_path)) as connection:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        try:
            state = connection.execute(
                "SELECT generation, scanned_at FROM historical_projection_state WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            generation, scanned_at = (None, None) if state is None else state
            # Bind semantic inputs and generation, not page size. Validate using
            # the cursor's generation first to distinguish mismatch from staleness.
            binding = hashlib.sha256(
                json.dumps(
                    [
                        project_id,
                        kind,
                        query.sort,
                        query.q,
                        query.run_id,
                        query.batch_id,
                        query.execution_status,
                        query.execution_available,
                        generation if cursor is None else cursor["generation"],
                    ],
                    ensure_ascii=True,
                    separators=(",", ":"),
                ).encode("ascii")
            ).hexdigest()
            if cursor is not None and cursor["binding"] != binding:
                raise HistoryQueryError("Malformed or mismatched history cursor")
            if cursor is not None and cursor["generation"] != generation:
                raise HistoryGenerationChangedError("History changed; restart without a cursor")
            if cursor is not None:
                key = connection.execute(
                    f"SELECT {key_sql} FROM {source} "
                    f"WHERE {' AND '.join(predicates)} AND {bookmark} = ?",
                    (*parameters, cursor["rowid"]),
                ).fetchone()
                if key is None:
                    raise HistoryQueryError("History cursor bookmark is missing or mismatched")
                predicates.append(f"({key_sql}) > ({', '.join('?' for _ in keys)})")
                parameters.extend(key)
            parameters.append(query.limit + 1)
            rows = connection.execute(
                f"SELECT {selection}, {bookmark} FROM {source} "
                f"WHERE {' AND '.join(predicates)} ORDER BY {key_sql} LIMIT ?",
                parameters,
            ).fetchall()
        finally:
            connection.rollback()
    next_cursor = None
    if len(rows) > query.limit:
        rows = rows[: query.limit]
        next_cursor = _encode_cursor(
            {"v": 2, "binding": binding, "generation": generation, "rowid": rows[-1][-1]}
        )
    return HistoryPage(tuple(row[:-1] for row in rows), generation, scanned_at, next_cursor)


def _bounded_text(name: str, value: str, maximum: int | None = None) -> None:
    if not isinstance(value, str):
        raise HistoryQueryError(f"{name} must be a string")
    if maximum is not None and len(value) > maximum:
        raise HistoryQueryError(f"{name} must be a string of at most {maximum} characters")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise HistoryQueryError(f"{name} must contain valid Unicode") from error


def _encode_cursor(payload: dict[str, Any]) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
            "utf-8"
        )
    ).decode("ascii")
    _bounded_text("cursor", encoded, 8192)
    return encoded


def _decode_cursor(encoded: str) -> dict[str, Any]:
    try:
        payload = json.loads(base64.b64decode(encoded, altchars=b"-_", validate=True))
        if (
            not isinstance(payload, dict)
            or set(payload) != {"v", "binding", "generation", "rowid"}
            or type(payload["v"]) is not int
            or payload["v"] != 2
            or not isinstance(payload["binding"], str)
            or not (payload["generation"] is None or isinstance(payload["generation"], str))
        ):
            raise ValueError
        if (
            type(payload["rowid"]) is not int
            or not 1 <= payload["rowid"] <= 2**63 - 1
            or _encode_cursor(payload) != encoded
        ):
            raise ValueError
        return payload
    except (ValueError, TypeError, OverflowError, RecursionError, binascii.Error) as error:
        raise HistoryQueryError("Malformed or mismatched history cursor") from error
