import sqlite3
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from batchcraft.db.connection import open_connection
from batchcraft.db.models import ProjectRecord


class ProjectStoreError(ValueError):
    """A Project persistence operation failed."""


class ProjectValidationError(ProjectStoreError):
    """Project input is invalid."""


class ProjectNotFoundError(ProjectStoreError):
    """The requested Project does not exist."""


class ProjectConflictError(ProjectStoreError):
    """A Project uniqueness constraint conflicts with an existing row."""


class ProjectIdConflictError(ProjectConflictError):
    """The Project ID already exists."""


class ProjectNameConflictError(ProjectConflictError):
    """The Project name already exists."""


class ProjectFilesystemKeyConflictError(ProjectConflictError):
    """The Project filesystem key already exists."""


class ProjectStore:
    def __init__(
        self,
        database_path: Path,
        *,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.database_path = database_path
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._clock = clock or (lambda: datetime.now(UTC))

    def create(
        self,
        name: str,
        filesystem_key: str,
        *,
        description: str | None = None,
        project_id: str | None = None,
    ) -> ProjectRecord:
        project_id = project_id if project_id is not None else self._id_factory()
        _validate_nonempty(project_id, "Project ID")
        _validate_nonempty(name, "Project name")
        _validate_nonempty(filesystem_key, "Project filesystem key")
        _validate_optional_text(description, "Project description")
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                timestamp = _serialize_datetime(_utc_now(self._clock))
                conflict = _find_project_conflict(
                    connection,
                    project_id=project_id,
                    name=name,
                    filesystem_key=filesystem_key,
                )
                if conflict is not None:
                    raise conflict
                connection.execute(
                    """
                    INSERT INTO project (
                        id, name, filesystem_key, description, created_at, updated_at, archived_at
                    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (project_id, name, filesystem_key, description, timestamp, timestamp),
                )
                connection.commit()
            except ProjectStoreError:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise _project_conflict(
                    connection,
                    project_id=project_id,
                    name=name,
                    filesystem_key=filesystem_key,
                    error=error,
                ) from error
            return _get_project(connection, project_id)

    def list(self, *, include_archived: bool = False) -> tuple[ProjectRecord, ...]:
        where = "" if include_archived else "WHERE archived_at IS NULL"
        with closing(open_connection(self.database_path)) as connection:
            rows = connection.execute(
                f"""
                SELECT id, name, filesystem_key, description, created_at, updated_at, archived_at
                FROM project
                {where}
                ORDER BY created_at, id
                """
            ).fetchall()
        return tuple(_project_from_row(row) for row in rows)

    def get(self, project_id: str) -> ProjectRecord:
        _validate_nonempty(project_id, "Project ID")
        with closing(open_connection(self.database_path)) as connection:
            return _get_project(connection, project_id)

    def update_metadata(
        self,
        project_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        update_description: bool | None = None,
    ) -> ProjectRecord:
        _validate_nonempty(project_id, "Project ID")
        should_update_description = (
            description is not None if update_description is None else update_description
        )
        if name is not None:
            _validate_nonempty(name, "Project name")
        if should_update_description:
            _validate_optional_text(description, "Project description")
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                timestamp = _serialize_datetime(_utc_now(self._clock))
                current = _get_project(connection, project_id)
                next_name = current.name if name is None else name
                next_description = description if should_update_description else current.description
                if (
                    connection.execute(
                        "SELECT 1 FROM project WHERE name = ? AND id != ?",
                        (next_name, project_id),
                    ).fetchone()
                    is not None
                ):
                    raise ProjectNameConflictError(f"Project name already exists: {next_name}")
                connection.execute(
                    "UPDATE project SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                    (next_name, next_description, timestamp, project_id),
                )
                connection.commit()
            except ProjectStoreError:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise _project_update_conflict(
                    connection,
                    project_id=project_id,
                    name=next_name,
                    error=error,
                ) from error
            return _get_project(connection, project_id)

    def archive(self, project_id: str) -> ProjectRecord:
        _validate_nonempty(project_id, "Project ID")

        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                timestamp = _serialize_datetime(_utc_now(self._clock))
                cursor = connection.execute(
                    """
                    UPDATE project
                    SET archived_at = ?, updated_at = ?
                    WHERE id = ? AND archived_at IS NULL
                    """,
                    (timestamp, timestamp, project_id),
                )
                if cursor.rowcount == 0 and not _project_exists(connection, project_id):
                    raise ProjectNotFoundError(f"Project not found: {project_id}")
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            return _get_project(connection, project_id)


def _get_project(connection: sqlite3.Connection, project_id: str) -> ProjectRecord:
    row = connection.execute(
        """
        SELECT id, name, filesystem_key, description, created_at, updated_at, archived_at
        FROM project
        WHERE id = ?
        """,
        (project_id,),
    ).fetchone()
    if row is None:
        raise ProjectNotFoundError(f"Project not found: {project_id}")
    return _project_from_row(row)


def _project_exists(connection: sqlite3.Connection, project_id: str) -> bool:
    return (
        connection.execute("SELECT 1 FROM project WHERE id = ?", (project_id,)).fetchone()
        is not None
    )


def _project_conflict(
    connection: sqlite3.Connection,
    *,
    project_id: str,
    name: str,
    filesystem_key: str | None,
    error: sqlite3.IntegrityError,
) -> ProjectConflictError:
    conflict = _find_project_conflict(
        connection,
        project_id=project_id,
        name=name,
        filesystem_key=filesystem_key,
    )
    if conflict is not None:
        return conflict
    return ProjectConflictError(f"Project conflicts with an existing row: {error}")


def _find_project_conflict(
    connection: sqlite3.Connection,
    *,
    project_id: str,
    name: str,
    filesystem_key: str | None,
) -> ProjectConflictError | None:
    if _project_exists(connection, project_id):
        return ProjectIdConflictError(f"Project ID already exists: {project_id}")
    if connection.execute("SELECT 1 FROM project WHERE name = ?", (name,)).fetchone() is not None:
        return ProjectNameConflictError(f"Project name already exists: {name}")
    if (
        filesystem_key is not None
        and connection.execute(
            "SELECT 1 FROM project WHERE filesystem_key = ?", (filesystem_key,)
        ).fetchone()
        is not None
    ):
        return ProjectFilesystemKeyConflictError(
            f"Project filesystem key already exists: {filesystem_key}"
        )
    return None


def _project_update_conflict(
    connection: sqlite3.Connection,
    *,
    project_id: str,
    name: str,
    error: sqlite3.IntegrityError,
) -> ProjectConflictError:
    if (
        connection.execute(
            "SELECT 1 FROM project WHERE name = ? AND id != ?", (name, project_id)
        ).fetchone()
        is not None
    ):
        return ProjectNameConflictError(f"Project name already exists: {name}")
    return ProjectConflictError(f"Project update conflicts with an existing row: {error}")


def _project_from_row(row: sqlite3.Row | tuple[object, ...]) -> ProjectRecord:
    return ProjectRecord(
        id=_required_db_string(row[0], "project.id"),
        name=_required_db_string(row[1], "project.name"),
        filesystem_key=_required_db_string(row[2], "project.filesystem_key"),
        description=_optional_db_string(row[3], "project.description"),
        created_at=_parse_datetime(row[4], "project.created_at"),
        updated_at=_parse_datetime(row[5], "project.updated_at"),
        archived_at=_parse_optional_datetime(row[6], "project.archived_at"),
    )


def _validate_nonempty(value: str, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ProjectValidationError(f"{label} must be a nonempty string")


def _validate_optional_text(value: str | None, label: str) -> None:
    if value is not None and (not isinstance(value, str) or not value.strip()):
        raise ProjectValidationError(f"{label} must be nonempty when provided")


def _utc_now(clock: Callable[[], datetime]) -> datetime:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ProjectValidationError("clock must return an aware datetime")
    return value.astimezone(UTC)


def _serialize_datetime(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _parse_datetime(value: object, label: str) -> datetime:
    if not isinstance(value, str):
        raise ProjectStoreError(f"{label} must be a timestamp string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProjectStoreError(f"{label} is not a valid timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ProjectStoreError(f"{label} must include a UTC offset")
    return parsed.astimezone(UTC)


def _parse_optional_datetime(value: object, label: str) -> datetime | None:
    return None if value is None else _parse_datetime(value, label)


def _required_db_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ProjectStoreError(f"{label} must be a nonempty string")
    return value


def _optional_db_string(value: object, label: str) -> str | None:
    if value is None:
        return None
    return _required_db_string(value, label)
