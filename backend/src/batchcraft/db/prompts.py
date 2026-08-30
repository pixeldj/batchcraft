import sqlite3
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from batchcraft.db.connection import open_connection
from batchcraft.db.models import PromptRecord, PromptVersionRecord


class PromptStoreError(ValueError):
    """A Prompt persistence operation failed."""


class PromptValidationError(PromptStoreError):
    """Prompt input is invalid."""


class PromptNotFoundError(PromptStoreError):
    """The requested Prompt does not exist."""


class PromptVersionNotFoundError(PromptStoreError):
    """The requested PromptVersion does not exist."""


class PromptProjectNotFoundError(PromptStoreError):
    """The Prompt's Project does not exist."""


class PromptConflictError(PromptStoreError):
    """A Prompt uniqueness constraint conflicts with an existing row."""


class PromptIdConflictError(PromptConflictError):
    """The Prompt ID already exists."""


class PromptNameConflictError(PromptConflictError):
    """The Prompt name already exists within its Project."""


class PromptVersionConflictError(PromptStoreError):
    """A PromptVersion uniqueness constraint conflicts with an existing row."""


class PromptVersionIdConflictError(PromptVersionConflictError):
    """The PromptVersion ID already exists."""


class PromptStore:
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
        project_id: str,
        name: str,
        text: str,
        *,
        description: str | None = None,
        note: str | None = None,
        prompt_id: str | None = None,
        version_id: str | None = None,
    ) -> tuple[PromptRecord, PromptVersionRecord]:
        prompt_id = prompt_id if prompt_id is not None else self._id_factory()
        version_id = version_id if version_id is not None else self._id_factory()
        _validate_nonempty(project_id, "Project ID")
        _validate_nonempty(prompt_id, "Prompt ID")
        _validate_nonempty(version_id, "PromptVersion ID")
        _validate_nonempty(name, "Prompt name")
        _validate_nonempty(text, "PromptVersion text")
        _validate_optional_text(description, "Prompt description")
        _validate_note(note)
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                timestamp = _timestamp(self._clock)
                if not _project_exists(connection, project_id):
                    raise PromptProjectNotFoundError(f"Project not found: {project_id}")
                conflict = _find_prompt_conflict(
                    connection,
                    project_id=project_id,
                    prompt_id=prompt_id,
                    name=name,
                )
                if conflict is not None:
                    raise conflict
                if _version_exists(connection, version_id):
                    raise PromptVersionIdConflictError(
                        f"PromptVersion ID already exists: {version_id}"
                    )
                connection.execute(
                    """
                    INSERT INTO prompt (
                        id, project_id, name, description, created_at, updated_at, archived_at
                    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (prompt_id, project_id, name, description, timestamp, timestamp),
                )
                connection.execute(
                    """
                    INSERT INTO prompt_version (
                        id, prompt_id, version_number, name_snapshot, text, note,
                        created_at, archived_at
                    ) VALUES (?, ?, 1, ?, ?, ?, ?, NULL)
                    """,
                    (version_id, prompt_id, name, text, note, timestamp),
                )
                connection.commit()
            except PromptStoreError:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise _create_conflict(
                    connection,
                    project_id=project_id,
                    prompt_id=prompt_id,
                    name=name,
                    version_id=version_id,
                    error=error,
                ) from error
            return _get_prompt(connection, prompt_id), _get_version(connection, version_id)

    def list(self, project_id: str, *, include_archived: bool = False) -> tuple[PromptRecord, ...]:
        _validate_nonempty(project_id, "Project ID")
        archived_filter = "" if include_archived else "AND archived_at IS NULL"
        with closing(open_connection(self.database_path)) as connection:
            if not _project_exists(connection, project_id):
                raise PromptProjectNotFoundError(f"Project not found: {project_id}")
            rows = connection.execute(
                f"""
                SELECT id, project_id, name, description, created_at, updated_at, archived_at
                FROM prompt
                WHERE project_id = ? {archived_filter}
                ORDER BY created_at, id
                """,
                (project_id,),
            ).fetchall()
        return tuple(_prompt_from_row(row) for row in rows)

    def get(self, prompt_id: str) -> PromptRecord:
        _validate_nonempty(prompt_id, "Prompt ID")
        with closing(open_connection(self.database_path)) as connection:
            return _get_prompt(connection, prompt_id)

    def update_metadata(
        self,
        prompt_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        update_description: bool | None = None,
    ) -> PromptRecord:
        _validate_nonempty(prompt_id, "Prompt ID")
        should_update_description = (
            description is not None if update_description is None else update_description
        )
        if name is not None:
            _validate_nonempty(name, "Prompt name")
        if should_update_description:
            _validate_optional_text(description, "Prompt description")
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                timestamp = _timestamp(self._clock)
                prompt = _get_prompt(connection, prompt_id)
                next_name = prompt.name if name is None else name
                next_description = description if should_update_description else prompt.description
                if (
                    connection.execute(
                        """
                    SELECT 1 FROM prompt
                    WHERE project_id = ? AND name = ? AND id != ?
                    """,
                        (prompt.project_id, next_name, prompt_id),
                    ).fetchone()
                    is not None
                ):
                    raise PromptNameConflictError(
                        f"Prompt name already exists in Project {prompt.project_id}: {next_name}"
                    )
                connection.execute(
                    "UPDATE prompt SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                    (next_name, next_description, timestamp, prompt_id),
                )
                connection.commit()
            except PromptStoreError:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise _prompt_update_conflict(
                    connection,
                    project_id=prompt.project_id,
                    prompt_id=prompt_id,
                    name=next_name,
                    error=error,
                ) from error
            return _get_prompt(connection, prompt_id)

    def archive(self, prompt_id: str) -> PromptRecord:
        _validate_nonempty(prompt_id, "Prompt ID")
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                timestamp = _timestamp(self._clock)
                cursor = connection.execute(
                    """
                    UPDATE prompt
                    SET archived_at = ?, updated_at = ?
                    WHERE id = ? AND archived_at IS NULL
                    """,
                    (timestamp, timestamp, prompt_id),
                )
                if cursor.rowcount == 0 and not _prompt_exists(connection, prompt_id):
                    raise PromptNotFoundError(f"Prompt not found: {prompt_id}")
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            return _get_prompt(connection, prompt_id)

    def list_versions(
        self, prompt_id: str, *, include_archived: bool = False
    ) -> tuple[PromptVersionRecord, ...]:
        _validate_nonempty(prompt_id, "Prompt ID")
        archived_filter = "" if include_archived else "AND archived_at IS NULL"
        with closing(open_connection(self.database_path)) as connection:
            if not _prompt_exists(connection, prompt_id):
                raise PromptNotFoundError(f"Prompt not found: {prompt_id}")
            rows = connection.execute(
                f"""
                SELECT id, prompt_id, version_number, name_snapshot, text, note,
                       created_at, archived_at
                FROM prompt_version
                WHERE prompt_id = ? {archived_filter}
                ORDER BY version_number
                """,
                (prompt_id,),
            ).fetchall()
        return tuple(_version_from_row(row) for row in rows)

    def get_version(self, version_id: str) -> PromptVersionRecord:
        _validate_nonempty(version_id, "PromptVersion ID")
        with closing(open_connection(self.database_path)) as connection:
            return _get_version(connection, version_id)

    def create_version(
        self,
        prompt_id: str,
        text: str,
        *,
        note: str | None = None,
        version_id: str | None = None,
    ) -> PromptVersionRecord:
        _validate_nonempty(prompt_id, "Prompt ID")
        _validate_nonempty(text, "PromptVersion text")
        _validate_note(note)
        version_id = version_id if version_id is not None else self._id_factory()
        _validate_nonempty(version_id, "PromptVersion ID")

        with closing(open_connection(self.database_path)) as connection:
            return self._create_version(
                connection,
                prompt_id=prompt_id,
                version_id=version_id,
                text=text,
                note=note,
            )

    def archive_version(self, version_id: str) -> PromptVersionRecord:
        _validate_nonempty(version_id, "PromptVersion ID")
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                timestamp = _timestamp(self._clock)
                cursor = connection.execute(
                    """
                    UPDATE prompt_version SET archived_at = ?
                    WHERE id = ? AND archived_at IS NULL
                    """,
                    (timestamp, version_id),
                )
                if cursor.rowcount == 0 and not _version_exists(connection, version_id):
                    raise PromptVersionNotFoundError(f"PromptVersion not found: {version_id}")
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            return _get_version(connection, version_id)

    def restore_version(
        self, version_id: str, *, new_version_id: str | None = None
    ) -> PromptVersionRecord:
        _validate_nonempty(version_id, "PromptVersion ID")
        new_version_id = new_version_id if new_version_id is not None else self._id_factory()
        _validate_nonempty(new_version_id, "PromptVersion ID")
        with closing(open_connection(self.database_path)) as connection:
            source = _get_version(connection, version_id)
            return self._create_version(
                connection,
                prompt_id=source.prompt_id,
                version_id=new_version_id,
                text=source.text,
                note=source.note,
            )

    def _create_version(
        self,
        connection: sqlite3.Connection,
        *,
        prompt_id: str,
        version_id: str,
        text: str,
        note: str | None,
    ) -> PromptVersionRecord:
        try:
            connection.execute("BEGIN IMMEDIATE")
            prompt = _get_prompt(connection, prompt_id)
            row = connection.execute(
                "SELECT COALESCE(MAX(version_number), 0) + 1 FROM prompt_version WHERE prompt_id = ?",
                (prompt_id,),
            ).fetchone()
            version_number = row[0] if row is not None else None
            if not isinstance(version_number, int) or version_number < 1:
                raise PromptStoreError(f"invalid next version number for Prompt: {prompt_id}")
            connection.execute(
                """
                INSERT INTO prompt_version (
                    id, prompt_id, version_number, name_snapshot, text, note,
                    created_at, archived_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    version_id,
                    prompt_id,
                    version_number,
                    prompt.name,
                    text,
                    note,
                    _timestamp(self._clock),
                ),
            )
            connection.commit()
        except PromptStoreError:
            connection.rollback()
            raise
        except sqlite3.IntegrityError as error:
            connection.rollback()
            if _version_exists(connection, version_id):
                raise PromptVersionIdConflictError(
                    f"PromptVersion ID already exists: {version_id}"
                ) from error
            if not _prompt_exists(connection, prompt_id):
                raise PromptNotFoundError(f"Prompt not found: {prompt_id}") from error
            raise PromptVersionConflictError(
                f"PromptVersion conflicts with an existing row: {error}"
            ) from error
        return _get_version(connection, version_id)


def _get_prompt(connection: sqlite3.Connection, prompt_id: str) -> PromptRecord:
    row = connection.execute(
        """
        SELECT id, project_id, name, description, created_at, updated_at, archived_at
        FROM prompt WHERE id = ?
        """,
        (prompt_id,),
    ).fetchone()
    if row is None:
        raise PromptNotFoundError(f"Prompt not found: {prompt_id}")
    return _prompt_from_row(row)


def _get_version(connection: sqlite3.Connection, version_id: str) -> PromptVersionRecord:
    row = connection.execute(
        """
        SELECT id, prompt_id, version_number, name_snapshot, text, note,
               created_at, archived_at
        FROM prompt_version WHERE id = ?
        """,
        (version_id,),
    ).fetchone()
    if row is None:
        raise PromptVersionNotFoundError(f"PromptVersion not found: {version_id}")
    return _version_from_row(row)


def _create_conflict(
    connection: sqlite3.Connection,
    *,
    project_id: str,
    prompt_id: str,
    name: str,
    version_id: str,
    error: sqlite3.IntegrityError,
) -> PromptStoreError:
    if not _project_exists(connection, project_id):
        return PromptProjectNotFoundError(f"Project not found: {project_id}")
    if _prompt_exists(connection, prompt_id):
        return PromptIdConflictError(f"Prompt ID already exists: {prompt_id}")
    if _version_exists(connection, version_id):
        return PromptVersionIdConflictError(f"PromptVersion ID already exists: {version_id}")
    return _prompt_conflict(
        connection,
        project_id=project_id,
        prompt_id=prompt_id,
        name=name,
        error=error,
    )


def _prompt_conflict(
    connection: sqlite3.Connection,
    *,
    project_id: str,
    prompt_id: str,
    name: str,
    error: sqlite3.IntegrityError,
) -> PromptConflictError:
    conflict = _find_prompt_conflict(
        connection,
        project_id=project_id,
        prompt_id=prompt_id,
        name=name,
    )
    if conflict is not None:
        return conflict
    return PromptConflictError(f"Prompt conflicts with an existing row: {error}")


def _find_prompt_conflict(
    connection: sqlite3.Connection,
    *,
    project_id: str,
    prompt_id: str,
    name: str,
) -> PromptConflictError | None:
    if _prompt_exists(connection, prompt_id):
        return PromptIdConflictError(f"Prompt ID already exists: {prompt_id}")
    if (
        connection.execute(
            "SELECT 1 FROM prompt WHERE project_id = ? AND name = ?",
            (project_id, name),
        ).fetchone()
        is not None
    ):
        return PromptNameConflictError(
            f"Prompt name already exists in Project {project_id}: {name}"
        )
    return None


def _prompt_update_conflict(
    connection: sqlite3.Connection,
    *,
    project_id: str,
    prompt_id: str,
    name: str,
    error: sqlite3.IntegrityError,
) -> PromptConflictError:
    if (
        connection.execute(
            "SELECT 1 FROM prompt WHERE project_id = ? AND name = ? AND id != ?",
            (project_id, name, prompt_id),
        ).fetchone()
        is not None
    ):
        return PromptNameConflictError(
            f"Prompt name already exists in Project {project_id}: {name}"
        )
    return PromptConflictError(f"Prompt update conflicts with an existing row: {error}")


def _project_exists(connection: sqlite3.Connection, project_id: str) -> bool:
    return (
        connection.execute("SELECT 1 FROM project WHERE id = ?", (project_id,)).fetchone()
        is not None
    )


def _prompt_exists(connection: sqlite3.Connection, prompt_id: str) -> bool:
    return (
        connection.execute("SELECT 1 FROM prompt WHERE id = ?", (prompt_id,)).fetchone() is not None
    )


def _version_exists(connection: sqlite3.Connection, version_id: str) -> bool:
    return (
        connection.execute("SELECT 1 FROM prompt_version WHERE id = ?", (version_id,)).fetchone()
        is not None
    )


def _prompt_from_row(row: sqlite3.Row | tuple[object, ...]) -> PromptRecord:
    return PromptRecord(
        id=_db_string(row[0], "prompt.id"),
        project_id=_db_string(row[1], "prompt.project_id"),
        name=_db_string(row[2], "prompt.name"),
        description=_optional_db_string(row[3], "prompt.description"),
        created_at=_parse_datetime(row[4], "prompt.created_at"),
        updated_at=_parse_datetime(row[5], "prompt.updated_at"),
        archived_at=_parse_optional_datetime(row[6], "prompt.archived_at"),
    )


def _version_from_row(row: sqlite3.Row | tuple[object, ...]) -> PromptVersionRecord:
    version_number = row[2]
    if not isinstance(version_number, int) or version_number < 1:
        raise PromptStoreError("prompt_version.version_number must be a positive integer")
    note = row[5]
    if note is not None and not isinstance(note, str):
        raise PromptStoreError("prompt_version.note must be a string or null")
    return PromptVersionRecord(
        id=_db_string(row[0], "prompt_version.id"),
        prompt_id=_db_string(row[1], "prompt_version.prompt_id"),
        version_number=version_number,
        name_snapshot=_db_string(row[3], "prompt_version.name_snapshot"),
        text=_db_string(row[4], "prompt_version.text"),
        note=note,
        created_at=_parse_datetime(row[6], "prompt_version.created_at"),
        archived_at=_parse_optional_datetime(row[7], "prompt_version.archived_at"),
    )


def _validate_nonempty(value: str, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise PromptValidationError(f"{label} must be a nonempty string")


def _validate_note(note: str | None) -> None:
    if note is not None and not isinstance(note, str):
        raise PromptValidationError("PromptVersion note must be a string or null")
    if isinstance(note, str) and not note.strip():
        raise PromptValidationError("PromptVersion note must be nonempty when provided")


def _validate_optional_text(value: str | None, label: str) -> None:
    if value is not None and (not isinstance(value, str) or not value.strip()):
        raise PromptValidationError(f"{label} must be nonempty when provided")


def _timestamp(clock: Callable[[], datetime]) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise PromptValidationError("clock must return an aware datetime")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _parse_datetime(value: object, label: str) -> datetime:
    if not isinstance(value, str):
        raise PromptStoreError(f"{label} must be a timestamp string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PromptStoreError(f"{label} is not a valid timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PromptStoreError(f"{label} must include a UTC offset")
    return parsed.astimezone(UTC)


def _parse_optional_datetime(value: object, label: str) -> datetime | None:
    return None if value is None else _parse_datetime(value, label)


def _db_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise PromptStoreError(f"{label} must be a nonempty string")
    return value


def _optional_db_string(value: object, label: str) -> str | None:
    if value is None:
        return None
    return _db_string(value, label)
