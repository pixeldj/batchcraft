import json
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from batchcraft.db.connection import open_connection
from batchcraft.files.history import ProjectHistoryScan
from batchcraft.files.models import AssetRecord
from batchcraft.files.snapshots import BatchSnapshotV1


class HistoricalProjectionError(ValueError):
    """Historical projection persistence or identity is invalid."""


class HistoricalProjectConflictError(HistoricalProjectionError):
    """A durable Project identity conflicts with SQLite registration."""


@dataclass(frozen=True, slots=True)
class HistoricalRunRecord:
    run_id: str
    project_id: str
    batch_id: str
    batch_filesystem_key: str
    batch_name: str
    run_number: int
    filesystem_key: str
    name: str | None
    description: str | None
    created_at: str
    relative_path: str
    job_count: int
    execution_available: bool
    execution_status: str | None
    started_at: str | None
    completed_at: str | None
    integrity_status: str
    replayable: bool


@dataclass(frozen=True, slots=True)
class HistoricalDiagnosticRecord:
    position: int
    scope: str
    filesystem_key: str | None
    entity_id: str | None
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class HistoricalResultRecord:
    run_id: str
    job_id: str
    job_ordinal: int
    artifact_ordinal: int
    producing_node_id: str
    output_name: str
    remote_filename: str
    remote_subfolder: str
    remote_type: str
    local_path: str
    content_type: str | None
    byte_size: int
    sha256: str
    integrity_status: str


class HistoricalProjectionStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def replace_project(self, scan: ProjectHistoryScan, *, register: bool = True) -> None:
        """Atomically confirm ownership and replace; only explicit import may register."""
        try:
            with closing(open_connection(self.database_path)) as connection:
                try:
                    connection.execute("BEGIN IMMEDIATE")
                    self._create_or_confirm_project(connection, scan, register=register)
                    if (
                        scan.batches_root_missing
                        and connection.execute(
                            """
                        SELECT 1 FROM historical_batch WHERE project_id = ?
                        UNION ALL
                        SELECT 1 FROM historical_run WHERE project_id = ?
                        UNION ALL
                        SELECT 1 FROM historical_diagnostic
                        WHERE project_id = ? AND scope IN ('batch', 'run', 'execution', 'result')
                        LIMIT 1
                        """,
                            (scan.project.id, scan.project.id, scan.project.id),
                        ).fetchone()
                    ):
                        raise HistoricalProjectionError(
                            "Batches root is missing; prior history retained. Restore storage and reindex"
                        )
                    self._delete_project_projection(connection, scan.project.id)
                    self._insert_projection(connection, scan)
                    generation = uuid4().hex
                    connection.execute(
                        """
                        INSERT INTO historical_projection_state (project_id, generation, scanned_at)
                        VALUES (?, ?, ?)
                        ON CONFLICT (project_id) DO UPDATE SET
                            generation = excluded.generation, scanned_at = excluded.scanned_at
                        """,
                        (
                            scan.project.id,
                            generation,
                            datetime.now(UTC)
                            .isoformat(timespec="microseconds")
                            .replace("+00:00", "Z"),
                        ),
                    )
                    connection.execute(
                        "INSERT INTO historical_provenance_state VALUES (?, ?) "
                        "ON CONFLICT(project_id) DO UPDATE SET generation = excluded.generation",
                        (scan.project.id, generation),
                    )
                    connection.commit()
                except BaseException:
                    connection.rollback()
                    raise
        except HistoricalProjectionError:
            raise
        except sqlite3.Error as error:
            raise HistoricalProjectionError(
                f"Historical projection replacement failed: {error}"
            ) from error

    def list_runs(self, project_id: str) -> tuple[HistoricalRunRecord, ...]:
        with closing(open_connection(self.database_path)) as connection:
            rows = connection.execute(
                """
                SELECT run_id, project_id, batch_id, batch_filesystem_key, batch_name,
                       run_number, filesystem_key, name, description, created_at, relative_path,
                       job_count, execution_available, execution_status, started_at, completed_at,
                       integrity_status, replayable
                FROM historical_run
                WHERE project_id = ?
                ORDER BY created_at DESC, run_number DESC, run_id
                """,
                (project_id,),
            ).fetchall()
        return tuple(_run_from_row(row) for row in rows)

    def get_run(self, run_id: str) -> HistoricalRunRecord | None:
        with closing(open_connection(self.database_path)) as connection:
            row = connection.execute(
                """
                SELECT run_id, project_id, batch_id, batch_filesystem_key, batch_name,
                       run_number, filesystem_key, name, description, created_at, relative_path,
                       job_count, execution_available, execution_status, started_at, completed_at,
                       integrity_status, replayable
                FROM historical_run WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
        return None if row is None else _run_from_row(row)

    def list_results(self, run_id: str) -> tuple[HistoricalResultRecord, ...]:
        with closing(open_connection(self.database_path)) as connection:
            rows = connection.execute(
                """
                SELECT run_id, job_id, job_ordinal, artifact_ordinal, producing_node_id,
                       output_name, remote_filename, remote_subfolder, remote_type, local_path,
                       content_type, byte_size, sha256, integrity_status
                FROM historical_result WHERE run_id = ?
                ORDER BY job_ordinal, artifact_ordinal
                """,
                (run_id,),
            ).fetchall()
        return tuple(HistoricalResultRecord(*row) for row in rows)

    def list_diagnostics(self, project_id: str) -> tuple[HistoricalDiagnosticRecord, ...]:
        with closing(open_connection(self.database_path)) as connection:
            return self._diagnostics(connection, project_id)

    def _create_or_confirm_project(
        self, connection: sqlite3.Connection, scan: ProjectHistoryScan, *, register: bool
    ) -> None:
        by_id = connection.execute(
            "SELECT id, filesystem_key FROM project WHERE id = ?", (scan.project.id,)
        ).fetchone()
        by_key = connection.execute(
            "SELECT id, filesystem_key FROM project WHERE filesystem_key = ?",
            (scan.project.filesystem_key,),
        ).fetchone()
        if by_id is not None or by_key is not None:
            expected = (scan.project.id, scan.project.filesystem_key)
            if by_id != expected or by_key != expected:
                raise HistoricalProjectConflictError(
                    "Project owner ID or filesystem key conflicts with SQLite registration"
                )
            return
        if not register:
            raise HistoricalProjectConflictError(
                "Project is not registered; explicit import is required"
            )
        if connection.execute(
            "SELECT 1 FROM project WHERE name = ?", (scan.project.name,)
        ).fetchone():
            raise HistoricalProjectConflictError(
                "Project owner name conflicts with SQLite registration"
            )
        connection.execute(
            """
            INSERT INTO project (id, filesystem_key, name, description, created_at, updated_at, archived_at)
            VALUES (?, ?, ?, NULL, ?, ?, NULL)
            """,
            (
                scan.project.id,
                scan.project.filesystem_key,
                scan.project.name,
                _import_timestamp(scan),
                _import_timestamp(scan),
            ),
        )

    def _delete_project_projection(self, connection: sqlite3.Connection, project_id: str) -> None:
        for table in (
            "historical_parameter_value",
            "historical_prompt_snapshot",
            "historical_run_provenance",
            "historical_provenance_state",
            "historical_result",
            "historical_asset_use",
            "historical_image_input",
            "historical_resolved_parameter",
            "historical_job",
            "historical_run",
            "historical_batch",
            "historical_asset",
            "historical_diagnostic",
        ):
            connection.execute(f"DELETE FROM {table} WHERE project_id = ?", (project_id,))

    def _insert_projection(self, connection: sqlite3.Connection, scan: ProjectHistoryScan) -> None:
        connection.executemany(
            "INSERT INTO historical_batch VALUES (?, ?, ?, ?, 'verified')",
            ((scan.project.id, item.id, item.filesystem_key, item.name) for item in scan.batches),
        )
        assets: dict[str, tuple[object, ...]] = {
            item.record.asset_id: _asset_row(scan.project.id, item.record, item.integrity_status)
            for item in scan.assets
        }
        for scanned_run in scan.runs:
            for item in scanned_run.referenced_assets:
                previous = assets.get(item.record.asset_id)
                row = _asset_row(scan.project.id, item.record, item.integrity_status)
                if previous is not None and previous[:-1] != row[:-1]:
                    raise HistoricalProjectionError(
                        f"Asset ID has conflicting historical metadata: {item.record.asset_id}"
                    )
                if previous is None or previous[-1] == "verified":
                    assets[item.record.asset_id] = row
        connection.executemany(
            "INSERT INTO historical_asset VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", assets.values()
        )

        for scanned in scan.runs:
            run = scanned.run
            relative_path = run.path.relative_to(scan.project_path).as_posix()
            connection.execute(
                "INSERT INTO historical_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run.run_id,
                    scan.project.id,
                    run.batch.id,
                    run.batch.filesystem_key,
                    run.batch.name,
                    run.run_number,
                    run.filesystem_key,
                    run.name,
                    run.description,
                    run.created_at,
                    relative_path,
                    run.compiled_plan.job_count,
                    int(scanned.execution_available),
                    scanned.execution_status,
                    scanned.started_at,
                    scanned.completed_at,
                    scanned.integrity_status,
                    int(scanned.replayable),
                ),
            )
            labels = {item.key: item.label for item in run.compiled_plan.parameters}
            types = {item.key: item.value_type for item in run.compiled_plan.parameters}
            snapshot = BatchSnapshotV1.model_validate(run.batch_snapshot)
            selection = snapshot.workflow_selection
            saved = snapshot.source_saved_batch
            connection.execute(
                "INSERT INTO historical_run_provenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    scan.project.id,
                    run.run_id,
                    selection.workflow_version_id,
                    selection.workflow_name,
                    None
                    if selection.workflow_version_number is None
                    else str(selection.workflow_version_number),
                    selection.workflow_profile_version_id,
                    selection.workflow_profile_name,
                    None
                    if selection.workflow_profile_version_number is None
                    else str(selection.workflow_profile_version_number),
                    None if saved is None else saved.id,
                    snapshot.batch.name,
                    None if saved is None else str(saved.revision),
                ),
            )
            connection.executemany(
                "INSERT INTO historical_prompt_snapshot VALUES (?, ?, ?, ?, ?, ?)",
                (
                    (
                        scan.project.id,
                        run.run_id,
                        prompt.id,
                        prompt.prompt_id,
                        prompt.name,
                        None if prompt.version_number is None else str(prompt.version_number),
                    )
                    for prompt in snapshot.prompt_versions
                ),
            )
            for job in run.jobs:
                execution = scanned.job_execution.get(job.job_id)
                connection.execute(
                    "INSERT INTO historical_job VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        scan.project.id,
                        run.run_id,
                        job.job_id,
                        job.compiled_job.ordinal,
                        job.compiled_job.prompt_version_id,
                        job.compiled_job.resolved_prompt,
                        _json(
                            [
                                {"name": item.name, "value": item.value}
                                for item in job.compiled_job.resolved_variables
                            ]
                        ),
                        _json(
                            [
                                {
                                    "set_key": item.set_key,
                                    "set_label": item.set_label,
                                    "row_ordinal": item.row_ordinal,
                                    "row_label": item.row_label,
                                }
                                for item in job.compiled_job.resolved_parameter_sets
                            ]
                        ),
                        job.compiled_job.seed,
                        job.output_prefix,
                        None if execution is None else execution[0],
                        None if execution is None else execution[1],
                        None if execution is None else execution[2],
                        None if execution is None else execution[3],
                        None if execution is None else execution[4],
                        _json([] if execution is None else execution[5]),
                    ),
                )
                for position, parameter in enumerate(job.compiled_job.resolved_parameters, 1):
                    value_type = types[parameter.parameter_key]
                    value = parameter.value
                    connection.execute(
                        "INSERT INTO historical_parameter_value VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            scan.project.id,
                            run.run_id,
                            job.job_id,
                            parameter.parameter_key,
                            labels[parameter.parameter_key],
                            value_type,
                            int(value is None),
                            value if value_type == "string" else None,
                            value if value_type == "integer" else None,
                            value if value_type == "float" else None,
                            value if value_type == "boolean" else None,
                        ),
                    )
                    connection.execute(
                        "INSERT INTO historical_resolved_parameter VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            scan.project.id,
                            run.run_id,
                            job.job_id,
                            position,
                            parameter.parameter_key,
                            labels[parameter.parameter_key],
                            _json(parameter.value),
                        ),
                    )
                for position, image in enumerate(job.image_inputs, 1):
                    asset_id = None if image.asset is None else image.asset.asset_id
                    connection.execute(
                        "INSERT INTO historical_image_input VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            scan.project.id,
                            run.run_id,
                            job.job_id,
                            position,
                            image.slot_key,
                            image.slot_label,
                            asset_id,
                        ),
                    )
                    if asset_id is not None:
                        connection.execute(
                            "INSERT INTO historical_asset_use VALUES (?, ?, ?, ?, ?)",
                            (scan.project.id, asset_id, run.run_id, job.job_id, image.slot_key),
                        )
            connection.executemany(
                "INSERT INTO historical_result VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    (
                        scan.project.id,
                        run.run_id,
                        item.record.job_id,
                        item.record.job_ordinal,
                        item.record.artifact_ordinal,
                        item.record.producing_node_id,
                        item.record.output_name,
                        item.record.remote_filename,
                        item.record.remote_subfolder,
                        item.record.remote_type,
                        item.record.local_path,
                        item.record.content_type,
                        item.record.byte_size,
                        item.record.sha256,
                        item.integrity_status,
                    )
                    for item in scanned.results
                ),
            )
        connection.executemany(
            "INSERT INTO historical_diagnostic VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                (
                    scan.project.id,
                    position,
                    item.scope,
                    item.filesystem_key,
                    item.entity_id,
                    item.code,
                    item.message,
                )
                for position, item in enumerate(scan.diagnostics, 1)
            ),
        )

    def _diagnostics(
        self, connection: sqlite3.Connection, project_id: str
    ) -> tuple[HistoricalDiagnosticRecord, ...]:
        rows = connection.execute(
            "SELECT position, scope, filesystem_key, entity_id, code, message FROM historical_diagnostic WHERE project_id = ? ORDER BY position",
            (project_id,),
        ).fetchall()
        return tuple(HistoricalDiagnosticRecord(*row) for row in rows)


def _import_timestamp(scan: ProjectHistoryScan) -> str:
    return min((item.run.created_at for item in scan.runs), default="1970-01-01T00:00:00Z")


def _asset_row(project_id: str, asset: AssetRecord, status: str) -> tuple[object, ...]:
    return (
        project_id,
        asset.asset_id,
        asset.sha256,
        asset.original_filename,
        asset.mime_type,
        asset.byte_size,
        asset.stored_path,
        asset.created_at,
        status,
    )


def _json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _run_from_row(row: tuple[object, ...]) -> HistoricalRunRecord:
    return HistoricalRunRecord(
        run_id=str(row[0]),
        project_id=str(row[1]),
        batch_id=str(row[2]),
        batch_filesystem_key=str(row[3]),
        batch_name=str(row[4]),
        run_number=_row_int(row[5]),
        filesystem_key=str(row[6]),
        name=None if row[7] is None else str(row[7]),
        description=None if row[8] is None else str(row[8]),
        created_at=str(row[9]),
        relative_path=str(row[10]),
        job_count=_row_int(row[11]),
        execution_available=bool(row[12]),
        execution_status=None if row[13] is None else str(row[13]),
        started_at=None if row[14] is None else str(row[14]),
        completed_at=None if row[15] is None else str(row[15]),
        integrity_status=str(row[16]),
        replayable=bool(row[17]),
    )


def _row_int(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise HistoricalProjectionError("Historical projection contains a non-integer value")
    return value
