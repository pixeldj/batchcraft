"""Bounded SQL-only diagnostic browsing of one committed projection."""

import hashlib
import json
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from batchcraft.db.connection import open_connection
from batchcraft.db.history_query import (
    HistoryGenerationChangedError,
    HistoryPage,
    HistoryQuery,
    HistoryQueryError,
    _bounded_text,
    _decode_cursor,
    _encode_cursor,
)
from batchcraft.diagnostics import HISTORY_MESSAGES


@dataclass(frozen=True, slots=True)
class HistoryDiagnosticItem:
    ordinal: int
    scope: str
    entity_id: str | None
    name_excerpt: str | None
    display_truncated: bool
    code: str
    message: str


def query_diagnostics(
    database_path: Path, project_id: str, limit: int = 25, cursor: str | None = None
) -> HistoryPage[HistoryDiagnosticItem]:
    HistoryQuery(limit=limit, cursor=cursor)
    _bounded_text("project_id", project_id)
    bookmark = None if cursor is None else _decode_cursor(cursor)
    with closing(open_connection(database_path)) as connection:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        try:
            state = connection.execute(
                "SELECT generation, scanned_at FROM historical_projection_state WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            generation, scanned_at = (None, None) if state is None else state
            binding = hashlib.sha256(
                json.dumps(
                    [
                        project_id,
                        "diagnostics",
                        generation if bookmark is None else bookmark["generation"],
                    ],
                    ensure_ascii=True,
                    separators=(",", ":"),
                ).encode("ascii")
            ).hexdigest()
            after = 0
            if bookmark is not None:
                if bookmark["binding"] != binding:
                    raise HistoryQueryError("Mismatched diagnostic cursor")
                if bookmark["generation"] != generation:
                    raise HistoryGenerationChangedError("History changed; restart without a cursor")
                after = bookmark["rowid"]
                if (
                    connection.execute(
                        "SELECT 1 FROM historical_diagnostic WHERE project_id = ? AND position = ?",
                        (project_id, after),
                    ).fetchone()
                    is None
                ):
                    raise HistoryQueryError("Missing diagnostic bookmark")
            rows = connection.execute(
                """SELECT d.position, substr(d.scope, 1, 257), d.entity_id,
                    substr(coalesce(CASE CASE WHEN d.scope = 'execution' THEN 'run' ELSE d.scope END
                        WHEN 'run' THEN (SELECT name FROM historical_run r
                            WHERE r.project_id = d.project_id AND r.run_id = d.entity_id)
                        WHEN 'batch' THEN (SELECT name FROM historical_batch b
                            WHERE b.project_id = d.project_id AND b.batch_id = d.entity_id)
                        WHEN 'asset' THEN (SELECT original_filename FROM historical_asset a
                            WHERE a.project_id = d.project_id AND a.asset_id = d.entity_id)
                    END, CASE WHEN d.filesystem_key NOT IN ('.', '..')
                        AND instr(d.filesystem_key, '/') = 0
                        AND instr(d.filesystem_key, char(92)) = 0
                        AND instr(d.filesystem_key, ':') = 0
                        AND d.filesystem_key NOT GLOB '*[^a-zA-Z0-9_. -]*'
                        THEN d.filesystem_key END), 1, 257), substr(d.code, 1, 257)
                    FROM historical_diagnostic d
                    WHERE d.project_id = ? AND d.position > ? ORDER BY d.position LIMIT ?""",
                (project_id, after, limit + 1),
            ).fetchall()
        finally:
            connection.rollback()
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = _encode_cursor(
            {"v": 2, "binding": binding, "generation": generation, "rowid": rows[-1][0]}
        )
    return HistoryPage(
        tuple(
            HistoryDiagnosticItem(
                ordinal=ordinal,
                scope=scope
                if scope in ("project", "batch", "run", "asset", "execution", "result")
                else "project",
                entity_id=entity_id,
                name_excerpt=None if name is None else name[:256],
                display_truncated=len(name or "") > 256,
                code=code if code in HISTORY_MESSAGES else "historical_data_invalid",
                message=HISTORY_MESSAGES.get(code, "Historical data could not be validated")[:512],
            )
            for ordinal, scope, entity_id, name, code in rows
        ),
        generation,
        scanned_at,
        next_cursor,
    )
