"""Bounded historical choices, read with their generation in one SQL snapshot."""

from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from batchcraft.db.connection import open_connection
from batchcraft.db.history_query import HistoryQueryError, _bounded_text, require_provenance

ChoiceKind = Literal[
    "parameter",
    "prompt",
    "prompt_version",
    "workflow_version",
    "profile_version",
    "saved_batch",
    "batch",
    "image_slot",
    "asset",
]


@dataclass(frozen=True, slots=True)
class HistoryChoice:
    value: str
    label: str
    value_type: str | None = None
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class HistoryChoices:
    project_id: str
    generation: str | None
    items: tuple[HistoryChoice, ...]
    has_more: bool


def query_choices(
    database_path: Path, project_id: str, kind: ChoiceKind, q: str = "", limit: int = 30
) -> HistoryChoices:
    _bounded_text("q", q, 200)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise HistoryQueryError("Invalid choice limit")
    sources = {
        "parameter": "SELECT parameter_key value, parameter_label label, value_type, NULL revision FROM historical_parameter_value WHERE project_id = ?",
        "prompt": "SELECT p.prompt_id value, p.name label, NULL value_type, NULL revision FROM historical_prompt_snapshot p WHERE p.project_id = ? AND EXISTS (SELECT 1 FROM historical_job j WHERE j.project_id = p.project_id AND j.run_id = p.run_id AND j.prompt_version_id = p.prompt_version_id)",
        "prompt_version": "SELECT j.prompt_version_id value, coalesce(p.name, j.prompt_version_id) label, NULL value_type, p.version_number revision FROM historical_job j LEFT JOIN historical_prompt_snapshot p ON p.project_id = j.project_id AND p.run_id = j.run_id AND p.prompt_version_id = j.prompt_version_id WHERE j.project_id = ?",
        "batch": "SELECT batch_id value, batch_name label, NULL value_type, NULL revision FROM historical_run WHERE project_id = ?",
        "image_slot": "SELECT slot_key value, slot_label label, NULL value_type, NULL revision FROM historical_image_input WHERE project_id = ?",
        "asset": "SELECT asset_id value, original_filename label, NULL value_type, NULL revision FROM historical_asset WHERE project_id = ? UNION ALL SELECT u.asset_id value, coalesce(a.original_filename, u.asset_id) label, NULL value_type, NULL revision FROM historical_asset_use u LEFT JOIN historical_asset a ON a.project_id = u.project_id AND a.asset_id = u.asset_id WHERE u.project_id = ?",
    }
    for choice, prefix in (
        ("workflow_version", "workflow"),
        ("profile_version", "profile"),
        ("saved_batch", "saved_batch"),
    ):
        identity = f"{prefix}_id" if choice == "saved_batch" else f"{prefix}_version_id"
        revision = "NULL" if choice == "saved_batch" else f"{prefix}_version_number"
        sources[choice] = (
            f"SELECT {identity} value, coalesce({prefix}_name, {identity}) label, NULL value_type, {revision} revision FROM historical_run_provenance WHERE project_id = ?"
        )
    if kind not in sources:
        raise HistoryQueryError("Invalid choice kind")
    with closing(open_connection(database_path)) as connection:
        connection.create_function(
            "history_casefold", 1, lambda text: text.casefold(), deterministic=True
        )
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        try:
            state = connection.execute(
                "SELECT generation FROM historical_projection_state WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            generation = None if state is None else state[0]
            require_provenance(connection, project_id, generation)
            rows = connection.execute(
                "WITH candidates AS (" + sources[kind] + "), displayed AS ("
                "SELECT value, label || CASE WHEN revision IS NULL THEN '' ELSE ' v' || revision END display_label, value_type FROM candidates"
                "), matched AS (SELECT value, substr(display_label, 1, 256) label, value_type "
                "FROM displayed WHERE value IS NOT NULL AND (instr(history_casefold(display_label), history_casefold(?)) > 0 OR instr(history_casefold(value), history_casefold(?)) > 0)) "
                "SELECT value, min(label) label, value_type FROM matched GROUP BY value, value_type "
                "ORDER BY history_casefold(label), value, coalesce(value_type, '') LIMIT ?",
                (
                    *((project_id, project_id) if kind == "asset" else (project_id,)),
                    q,
                    q,
                    limit + 1,
                ),
            ).fetchall()
        finally:
            connection.rollback()
    return HistoryChoices(
        project_id,
        generation,
        tuple(
            HistoryChoice(
                value, label, value_type, (value + (f" ({value_type})" if value_type else ""))[:256]
            )
            for value, label, value_type in rows[:limit]
        ),
        len(rows) > limit,
    )
