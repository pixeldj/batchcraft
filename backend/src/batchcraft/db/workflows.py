import hashlib
import json
import sqlite3
from collections.abc import Callable, Mapping
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import uuid4

from batchcraft.comfyui import validate_workflow, validate_workflow_profile
from batchcraft.comfyui.errors import WorkflowPreparationError
from batchcraft.db.connection import open_connection
from batchcraft.db.models import (
    WorkflowListRecord,
    WorkflowProfileListRecord,
    WorkflowProfileRecord,
    WorkflowProfileVersionRecord,
    WorkflowRecord,
    WorkflowVersionRecord,
)
from batchcraft.files._io import canonical_json_bytes


class WorkflowStoreError(ValueError):
    """A Workflow persistence operation failed."""


class WorkflowValidationError(WorkflowStoreError):
    """Workflow input is invalid."""


class WorkflowNotFoundError(WorkflowStoreError):
    """The requested Workflow does not exist."""


class WorkflowVersionNotFoundError(WorkflowStoreError):
    """The requested WorkflowVersion does not exist."""


class WorkflowProjectNotFoundError(WorkflowStoreError):
    """The Workflow's Project does not exist."""


class WorkflowConflictError(WorkflowStoreError):
    """A Workflow constraint conflicts with existing data."""


class WorkflowVersionConflictError(WorkflowConflictError):
    """A WorkflowVersion constraint conflicts with existing data."""


class WorkflowProfileStoreError(ValueError):
    """A Workflow Profile persistence operation failed."""


class WorkflowProfileValidationError(WorkflowProfileStoreError):
    """Workflow Profile input is invalid."""


class WorkflowProfileNotFoundError(WorkflowProfileStoreError):
    """The requested Workflow Profile does not exist."""


class WorkflowProfileVersionNotFoundError(WorkflowProfileStoreError):
    """The requested Workflow Profile version does not exist."""


class WorkflowProfileWorkflowNotFoundError(WorkflowProfileStoreError):
    """The Workflow Profile's parent Workflow does not exist."""


class WorkflowProfileWorkflowVersionNotFoundError(WorkflowProfileStoreError):
    """The target WorkflowVersion does not exist."""


class WorkflowProfileOwnershipError(WorkflowProfileStoreError):
    """The target WorkflowVersion does not belong to the Profile's Workflow."""


class WorkflowProfileConflictError(WorkflowProfileStoreError):
    """A Workflow Profile constraint conflicts with existing data."""


class WorkflowProfileVersionConflictError(WorkflowProfileConflictError):
    """A Workflow Profile version constraint conflicts with existing data."""


class WorkflowStore:
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
        workflow: Mapping[str, object],
        *,
        description: str | None = None,
        note: str | None = None,
        workflow_id: str | None = None,
        version_id: str | None = None,
    ) -> tuple[WorkflowRecord, WorkflowVersionRecord]:
        workflow_id = workflow_id or self._id_factory()
        version_id = version_id or self._id_factory()
        _validate_library_fields(
            project_id=project_id,
            logical_id=workflow_id,
            version_id=version_id,
            name=name,
            description=description,
            note=note,
            label="Workflow",
            error_type=WorkflowValidationError,
        )
        canonical, digest = _canonical_workflow(workflow)
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                if not _exists(connection, "project", project_id):
                    raise WorkflowProjectNotFoundError(f"Project not found: {project_id}")
                _check_logical_conflict(
                    connection,
                    table="workflow",
                    project_id=project_id,
                    logical_id=workflow_id,
                    name=name,
                    label="Workflow",
                    error_type=WorkflowConflictError,
                )
                if _exists(connection, "workflow_version", version_id):
                    raise WorkflowVersionConflictError(
                        f"WorkflowVersion ID already exists: {version_id}"
                    )
                timestamp = _timestamp(self._clock, WorkflowValidationError)
                connection.execute(
                    """
                    INSERT INTO workflow
                        (id, project_id, name, description, created_at, updated_at, archived_at)
                    VALUES (?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (workflow_id, project_id, name, description, timestamp, timestamp),
                )
                connection.execute(
                    """
                    INSERT INTO workflow_version
                        (id, workflow_id, project_id, version_number, name_snapshot,
                         workflow_json, content_sha256, note, created_at, archived_at)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)
                    """,
                    (version_id, workflow_id, project_id, name, canonical, digest, note, timestamp),
                )
                connection.commit()
            except (WorkflowStoreError, sqlite3.IntegrityError) as error:
                connection.rollback()
                if isinstance(error, WorkflowStoreError):
                    raise
                raise WorkflowConflictError(
                    f"Workflow conflicts with existing data: {error}"
                ) from error
            return _get_workflow(connection, workflow_id), _get_workflow_version(
                connection, version_id
            )

    def list(
        self, project_id: str, *, include_archived: bool = False
    ) -> tuple[WorkflowListRecord, ...]:
        _nonempty(project_id, "Project ID", WorkflowValidationError)
        archived = "" if include_archived else "AND w.archived_at IS NULL"
        with closing(open_connection(self.database_path)) as connection:
            if not _exists(connection, "project", project_id):
                raise WorkflowProjectNotFoundError(f"Project not found: {project_id}")
            rows = connection.execute(
                f"""
                SELECT w.id, w.project_id, w.name, w.description, w.created_at, w.updated_at,
                       w.archived_at, v.id, v.workflow_id, v.project_id, v.version_number,
                       v.name_snapshot, v.workflow_json, v.content_sha256, v.note,
                       v.created_at, v.archived_at
                FROM workflow AS w
                LEFT JOIN workflow_version AS v
                  ON v.workflow_id = w.id AND v.archived_at IS NULL
                 AND v.version_number = (
                     SELECT MAX(c.version_number) FROM workflow_version AS c
                     WHERE c.workflow_id = w.id AND c.archived_at IS NULL
                 )
                WHERE w.project_id = ? {archived}
                ORDER BY w.created_at, w.id
                """,
                (project_id,),
            ).fetchall()
        return tuple(_workflow_list_from_row(row) for row in rows)

    def get(self, workflow_id: str) -> WorkflowRecord:
        _nonempty(workflow_id, "Workflow ID", WorkflowValidationError)
        with closing(open_connection(self.database_path)) as connection:
            return _get_workflow(connection, workflow_id)

    def update_metadata(
        self,
        workflow_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        update_description: bool = False,
    ) -> WorkflowRecord:
        return cast(
            WorkflowRecord,
            _update_metadata(
                self.database_path,
                table="workflow",
                logical_id=workflow_id,
                name=name,
                description=description,
                update_description=update_description,
                clock=self._clock,
                getter=_get_workflow,
                label="Workflow",
                validation_error=WorkflowValidationError,
                conflict_error=WorkflowConflictError,
            ),
        )

    def archive(self, workflow_id: str) -> WorkflowRecord:
        return cast(
            WorkflowRecord,
            _archive(
                self.database_path,
                table="workflow",
                row_id=workflow_id,
                clock=self._clock,
                getter=_get_workflow,
                label="Workflow",
                validation_error=WorkflowValidationError,
                not_found_error=WorkflowNotFoundError,
            ),
        )

    def list_versions(
        self, workflow_id: str, *, include_archived: bool = False
    ) -> tuple[WorkflowVersionRecord, ...]:
        _nonempty(workflow_id, "Workflow ID", WorkflowValidationError)
        archived = "" if include_archived else "AND archived_at IS NULL"
        with closing(open_connection(self.database_path)) as connection:
            if not _exists(connection, "workflow", workflow_id):
                raise WorkflowNotFoundError(f"Workflow not found: {workflow_id}")
            rows = connection.execute(
                f"""
                SELECT id, workflow_id, project_id, version_number, name_snapshot,
                       workflow_json, content_sha256, note, created_at, archived_at
                FROM workflow_version WHERE workflow_id = ? {archived}
                ORDER BY version_number
                """,
                (workflow_id,),
            ).fetchall()
        return tuple(_workflow_version_from_row(row) for row in rows)

    def get_version(self, version_id: str) -> WorkflowVersionRecord:
        _nonempty(version_id, "WorkflowVersion ID", WorkflowValidationError)
        with closing(open_connection(self.database_path)) as connection:
            return _get_workflow_version(connection, version_id)

    def create_version(
        self,
        workflow_id: str,
        workflow: Mapping[str, object],
        *,
        note: str | None = None,
        version_id: str | None = None,
    ) -> WorkflowVersionRecord:
        _nonempty(workflow_id, "Workflow ID", WorkflowValidationError)
        _optional_note(note, "WorkflowVersion", WorkflowValidationError)
        version_id = version_id or self._id_factory()
        _nonempty(version_id, "WorkflowVersion ID", WorkflowValidationError)
        canonical, digest = _canonical_workflow(workflow)
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                parent = _get_workflow(connection, workflow_id)
                version_number = _next_version(
                    connection, "workflow_version", "workflow_id", workflow_id
                )
                connection.execute(
                    """
                    INSERT INTO workflow_version
                        (id, workflow_id, project_id, version_number, name_snapshot,
                         workflow_json, content_sha256, note, created_at, archived_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (
                        version_id,
                        workflow_id,
                        parent.project_id,
                        version_number,
                        parent.name,
                        canonical,
                        digest,
                        note,
                        _timestamp(self._clock, WorkflowValidationError),
                    ),
                )
                connection.commit()
            except WorkflowStoreError:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise WorkflowVersionConflictError(
                    f"WorkflowVersion conflicts with existing data: {error}"
                ) from error
            return _get_workflow_version(connection, version_id)

    def archive_version(self, version_id: str) -> WorkflowVersionRecord:
        return cast(
            WorkflowVersionRecord,
            _archive(
                self.database_path,
                table="workflow_version",
                row_id=version_id,
                clock=self._clock,
                getter=_get_workflow_version,
                label="WorkflowVersion",
                validation_error=WorkflowValidationError,
                not_found_error=WorkflowVersionNotFoundError,
                update_updated_at=False,
            ),
        )


class WorkflowProfileStore:
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
        workflow_id: str,
        name: str,
        workflow_version_id: str,
        mappings: Mapping[str, object],
        *,
        description: str | None = None,
        note: str | None = None,
        profile_id: str | None = None,
        version_id: str | None = None,
    ) -> tuple[WorkflowProfileRecord, WorkflowProfileVersionRecord]:
        profile_id = profile_id or self._id_factory()
        version_id = version_id or self._id_factory()
        _validate_profile_library_fields(
            workflow_id=workflow_id,
            logical_id=profile_id,
            version_id=version_id,
            name=name,
            description=description,
            note=note,
            label="Workflow Profile",
            error_type=WorkflowProfileValidationError,
        )
        _nonempty(
            workflow_version_id,
            "WorkflowVersion ID",
            WorkflowProfileValidationError,
        )
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                parent_workflow = _profile_workflow(connection, workflow_id)
                target = _profile_target(connection, workflow_version_id, workflow_id)
                canonical, digest = _canonical_profile(profile_id, name, mappings, target.workflow)
                _check_logical_conflict(
                    connection,
                    table="workflow_profile",
                    project_id=workflow_id,
                    logical_id=profile_id,
                    name=name,
                    label="Workflow Profile",
                    error_type=WorkflowProfileConflictError,
                    scope_column="workflow_id",
                )
                if _exists(connection, "workflow_profile_version", version_id):
                    raise WorkflowProfileVersionConflictError(
                        f"Workflow Profile version ID already exists: {version_id}"
                    )
                timestamp = _timestamp(self._clock, WorkflowProfileValidationError)
                connection.execute(
                    """
                    INSERT INTO workflow_profile
                        (id, workflow_id, project_id, name, description, created_at,
                         updated_at, archived_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (
                        profile_id,
                        workflow_id,
                        parent_workflow.project_id,
                        name,
                        description,
                        timestamp,
                        timestamp,
                    ),
                )
                _insert_profile_version(
                    connection,
                    version_id=version_id,
                    profile_id=profile_id,
                    workflow_id=workflow_id,
                    project_id=parent_workflow.project_id,
                    workflow_version_id=workflow_version_id,
                    version_number=1,
                    name_snapshot=name,
                    canonical=canonical,
                    digest=digest,
                    note=note,
                    timestamp=timestamp,
                )
                connection.commit()
            except WorkflowProfileStoreError:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise WorkflowProfileConflictError(
                    f"Workflow Profile conflicts with existing data: {error}"
                ) from error
            return _get_profile(connection, profile_id), _get_profile_version(
                connection, version_id
            )

    def list(
        self,
        workflow_id: str,
        *,
        workflow_version_id: str | None = None,
        include_archived: bool = False,
    ) -> tuple[WorkflowProfileListRecord, ...]:
        _nonempty(workflow_id, "Workflow ID", WorkflowProfileValidationError)
        if workflow_version_id is not None:
            _nonempty(
                workflow_version_id,
                "WorkflowVersion ID",
                WorkflowProfileValidationError,
            )
        archived = "" if include_archived else "AND p.archived_at IS NULL"
        compatibility = "" if workflow_version_id is None else "AND v.workflow_version_id = ?"
        with closing(open_connection(self.database_path)) as connection:
            _profile_workflow(connection, workflow_id)
            if workflow_version_id is not None:
                _profile_target(connection, workflow_version_id, workflow_id)
            rows = connection.execute(
                f"""
                SELECT p.id, p.workflow_id, p.project_id, p.name, p.description, p.created_at,
                       p.updated_at, p.archived_at, v.id, v.workflow_profile_id, v.workflow_id,
                       v.project_id, v.workflow_version_id, v.version_number, v.name_snapshot,
                       v.profile_json, v.content_sha256, v.note, v.created_at, v.archived_at
                FROM workflow_profile AS p
                LEFT JOIN workflow_profile_version AS v
                  ON v.workflow_profile_id = p.id AND v.archived_at IS NULL {compatibility}
                 AND v.version_number = (
                     SELECT MAX(c.version_number) FROM workflow_profile_version AS c
                     WHERE c.workflow_profile_id = p.id AND c.archived_at IS NULL
                       {compatibility.replace("v.", "c.")}
                )
                WHERE p.workflow_id = ? {archived}
                ORDER BY p.created_at, p.id
                """,
                (workflow_id,)
                if workflow_version_id is None
                else (workflow_version_id, workflow_version_id, workflow_id),
            ).fetchall()
        return tuple(_profile_list_from_row(row) for row in rows)

    def get(self, profile_id: str) -> WorkflowProfileRecord:
        _nonempty(profile_id, "Workflow Profile ID", WorkflowProfileValidationError)
        with closing(open_connection(self.database_path)) as connection:
            return _get_profile(connection, profile_id)

    def update_metadata(
        self,
        profile_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        update_description: bool = False,
    ) -> WorkflowProfileRecord:
        return cast(
            WorkflowProfileRecord,
            _update_metadata(
                self.database_path,
                table="workflow_profile",
                logical_id=profile_id,
                name=name,
                description=description,
                update_description=update_description,
                clock=self._clock,
                getter=_get_profile,
                label="Workflow Profile",
                validation_error=WorkflowProfileValidationError,
                conflict_error=WorkflowProfileConflictError,
            ),
        )

    def archive(self, profile_id: str) -> WorkflowProfileRecord:
        return cast(
            WorkflowProfileRecord,
            _archive(
                self.database_path,
                table="workflow_profile",
                row_id=profile_id,
                clock=self._clock,
                getter=_get_profile,
                label="Workflow Profile",
                validation_error=WorkflowProfileValidationError,
                not_found_error=WorkflowProfileNotFoundError,
            ),
        )

    def list_versions(
        self, profile_id: str, *, include_archived: bool = False
    ) -> tuple[WorkflowProfileVersionRecord, ...]:
        _nonempty(profile_id, "Workflow Profile ID", WorkflowProfileValidationError)
        archived = "" if include_archived else "AND archived_at IS NULL"
        with closing(open_connection(self.database_path)) as connection:
            if not _exists(connection, "workflow_profile", profile_id):
                raise WorkflowProfileNotFoundError(f"Workflow Profile not found: {profile_id}")
            rows = connection.execute(
                f"""
                SELECT id, workflow_profile_id, workflow_id, project_id, workflow_version_id,
                       version_number, name_snapshot, profile_json, content_sha256,
                       note, created_at, archived_at
                FROM workflow_profile_version
                WHERE workflow_profile_id = ? {archived}
                ORDER BY version_number
                """,
                (profile_id,),
            ).fetchall()
        return tuple(_profile_version_from_row(row) for row in rows)

    def get_version(self, version_id: str) -> WorkflowProfileVersionRecord:
        _nonempty(
            version_id,
            "Workflow Profile version ID",
            WorkflowProfileValidationError,
        )
        with closing(open_connection(self.database_path)) as connection:
            return _get_profile_version(connection, version_id)

    def create_version(
        self,
        profile_id: str,
        workflow_version_id: str,
        mappings: Mapping[str, object],
        *,
        note: str | None = None,
        version_id: str | None = None,
    ) -> WorkflowProfileVersionRecord:
        _nonempty(profile_id, "Workflow Profile ID", WorkflowProfileValidationError)
        _nonempty(
            workflow_version_id,
            "WorkflowVersion ID",
            WorkflowProfileValidationError,
        )
        _optional_note(note, "Workflow Profile version", WorkflowProfileValidationError)
        version_id = version_id or self._id_factory()
        _nonempty(
            version_id,
            "Workflow Profile version ID",
            WorkflowProfileValidationError,
        )
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                profile = _get_profile(connection, profile_id)
                target = _profile_target(connection, workflow_version_id, profile.workflow_id)
                version_number = _next_version(
                    connection,
                    "workflow_profile_version",
                    "workflow_profile_id",
                    profile_id,
                )
                canonical, digest = _canonical_profile(
                    profile.id, profile.name, mappings, target.workflow
                )
                _insert_profile_version(
                    connection,
                    version_id=version_id,
                    profile_id=profile_id,
                    workflow_id=profile.workflow_id,
                    project_id=profile.project_id,
                    workflow_version_id=workflow_version_id,
                    version_number=version_number,
                    name_snapshot=profile.name,
                    canonical=canonical,
                    digest=digest,
                    note=note,
                    timestamp=_timestamp(self._clock, WorkflowProfileValidationError),
                )
                connection.commit()
            except WorkflowProfileStoreError:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise WorkflowProfileVersionConflictError(
                    f"Workflow Profile version conflicts with existing data: {error}"
                ) from error
            return _get_profile_version(connection, version_id)

    def archive_version(self, version_id: str) -> WorkflowProfileVersionRecord:
        return cast(
            WorkflowProfileVersionRecord,
            _archive(
                self.database_path,
                table="workflow_profile_version",
                row_id=version_id,
                clock=self._clock,
                getter=_get_profile_version,
                label="Workflow Profile version",
                validation_error=WorkflowProfileValidationError,
                not_found_error=WorkflowProfileVersionNotFoundError,
                update_updated_at=False,
            ),
        )


def _canonical_workflow(workflow: Mapping[str, object]) -> tuple[str, str]:
    try:
        validate_workflow(workflow)
        return _canonical(workflow)
    except (WorkflowPreparationError, ValueError) as error:
        raise WorkflowValidationError(str(error)) from error


def _canonical_profile(
    profile_id: str,
    name: str,
    mappings: Mapping[str, object],
    workflow: Mapping[str, object],
) -> tuple[str, str]:
    try:
        profile = {"id": profile_id, "name": name, "mappings": dict(mappings)}
        validate_workflow_profile(workflow, profile)
        return _canonical(profile)
    except (WorkflowPreparationError, ValueError) as error:
        raise WorkflowProfileValidationError(str(error)) from error


def _canonical(value: object) -> tuple[str, str]:
    content = canonical_json_bytes(value)
    return content.decode("ascii"), hashlib.sha256(content).hexdigest()


def _profile_target(
    connection: sqlite3.Connection, version_id: str, workflow_id: str
) -> WorkflowVersionRecord:
    try:
        target = _get_workflow_version(connection, version_id)
    except WorkflowVersionNotFoundError as error:
        raise WorkflowProfileWorkflowVersionNotFoundError(str(error)) from error
    if target.workflow_id != workflow_id:
        raise WorkflowProfileOwnershipError(
            f"WorkflowVersion {version_id} does not belong to Workflow {workflow_id}"
        )
    return target


def _profile_workflow(connection: sqlite3.Connection, workflow_id: str) -> WorkflowRecord:
    try:
        return _get_workflow(connection, workflow_id)
    except WorkflowNotFoundError as error:
        raise WorkflowProfileWorkflowNotFoundError(str(error)) from error


def _insert_profile_version(
    connection: sqlite3.Connection,
    *,
    version_id: str,
    profile_id: str,
    workflow_id: str,
    project_id: str,
    workflow_version_id: str,
    version_number: int,
    name_snapshot: str,
    canonical: str,
    digest: str,
    note: str | None,
    timestamp: str,
) -> None:
    connection.execute(
        """
        INSERT INTO workflow_profile_version
            (id, workflow_profile_id, workflow_id, project_id, workflow_version_id,
             version_number, name_snapshot, profile_json, content_sha256, note,
             created_at, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            version_id,
            profile_id,
            workflow_id,
            project_id,
            workflow_version_id,
            version_number,
            name_snapshot,
            canonical,
            digest,
            note,
            timestamp,
        ),
    )


def _get_workflow(connection: sqlite3.Connection, workflow_id: str) -> WorkflowRecord:
    row = connection.execute(
        """
        SELECT id, project_id, name, description, created_at, updated_at, archived_at
        FROM workflow WHERE id = ?
        """,
        (workflow_id,),
    ).fetchone()
    if row is None:
        raise WorkflowNotFoundError(f"Workflow not found: {workflow_id}")
    return _workflow_from_row(row)


def _get_workflow_version(connection: sqlite3.Connection, version_id: str) -> WorkflowVersionRecord:
    row = connection.execute(
        """
        SELECT id, workflow_id, project_id, version_number, name_snapshot,
               workflow_json, content_sha256, note, created_at, archived_at
        FROM workflow_version WHERE id = ?
        """,
        (version_id,),
    ).fetchone()
    if row is None:
        raise WorkflowVersionNotFoundError(f"WorkflowVersion not found: {version_id}")
    return _workflow_version_from_row(row)


def _get_profile(connection: sqlite3.Connection, profile_id: str) -> WorkflowProfileRecord:
    row = connection.execute(
        """
        SELECT id, workflow_id, project_id, name, description, created_at, updated_at,
               archived_at
        FROM workflow_profile WHERE id = ?
        """,
        (profile_id,),
    ).fetchone()
    if row is None:
        raise WorkflowProfileNotFoundError(f"Workflow Profile not found: {profile_id}")
    return _profile_from_row(row)


def _get_profile_version(
    connection: sqlite3.Connection, version_id: str
) -> WorkflowProfileVersionRecord:
    row = connection.execute(
        """
        SELECT id, workflow_profile_id, workflow_id, project_id, workflow_version_id,
               version_number, name_snapshot, profile_json, content_sha256,
               note, created_at, archived_at
        FROM workflow_profile_version WHERE id = ?
        """,
        (version_id,),
    ).fetchone()
    if row is None:
        raise WorkflowProfileVersionNotFoundError(
            f"Workflow Profile version not found: {version_id}"
        )
    return _profile_version_from_row(row)


def _workflow_from_row(row: sqlite3.Row | tuple[object, ...]) -> WorkflowRecord:
    return WorkflowRecord(
        id=_string(row[0], "workflow.id"),
        project_id=_string(row[1], "workflow.project_id"),
        name=_string(row[2], "workflow.name"),
        description=_optional_string(row[3], "workflow.description"),
        created_at=_datetime(row[4], "workflow.created_at"),
        updated_at=_datetime(row[5], "workflow.updated_at"),
        archived_at=_optional_datetime(row[6], "workflow.archived_at"),
    )


def _workflow_version_from_row(row: sqlite3.Row | tuple[object, ...]) -> WorkflowVersionRecord:
    workflow = _verified_json_object(
        row[5], row[6], "workflow_version.workflow_json", WorkflowStoreError
    )
    return WorkflowVersionRecord(
        id=_string(row[0], "workflow_version.id"),
        workflow_id=_string(row[1], "workflow_version.workflow_id"),
        project_id=_string(row[2], "workflow_version.project_id"),
        version_number=_positive_int(row[3], "workflow_version.version_number"),
        name_snapshot=_string(row[4], "workflow_version.name_snapshot"),
        workflow=workflow,
        content_sha256=_string(row[6], "workflow_version.content_sha256"),
        note=_optional_string(row[7], "workflow_version.note"),
        created_at=_datetime(row[8], "workflow_version.created_at"),
        archived_at=_optional_datetime(row[9], "workflow_version.archived_at"),
    )


def _workflow_list_from_row(row: sqlite3.Row | tuple[object, ...]) -> WorkflowListRecord:
    logical = _workflow_from_row(tuple(row[index] for index in range(7)))
    latest = (
        None
        if row[7] is None
        else _workflow_version_from_row(tuple(row[index] for index in range(7, 17)))
    )
    return WorkflowListRecord(
        id=logical.id,
        project_id=logical.project_id,
        name=logical.name,
        description=logical.description,
        created_at=logical.created_at,
        updated_at=logical.updated_at,
        archived_at=logical.archived_at,
        latest_active_version=latest,
    )


def _profile_from_row(row: sqlite3.Row | tuple[object, ...]) -> WorkflowProfileRecord:
    return WorkflowProfileRecord(
        id=_string(row[0], "workflow_profile.id"),
        workflow_id=_string(row[1], "workflow_profile.workflow_id"),
        project_id=_string(row[2], "workflow_profile.project_id"),
        name=_string(row[3], "workflow_profile.name"),
        description=_optional_string(row[4], "workflow_profile.description"),
        created_at=_datetime(row[5], "workflow_profile.created_at"),
        updated_at=_datetime(row[6], "workflow_profile.updated_at"),
        archived_at=_optional_datetime(row[7], "workflow_profile.archived_at"),
    )


def _profile_version_from_row(
    row: sqlite3.Row | tuple[object, ...],
) -> WorkflowProfileVersionRecord:
    return WorkflowProfileVersionRecord(
        id=_string(row[0], "workflow_profile_version.id"),
        workflow_profile_id=_string(row[1], "workflow_profile_version.workflow_profile_id"),
        workflow_id=_string(row[2], "workflow_profile_version.workflow_id"),
        project_id=_string(row[3], "workflow_profile_version.project_id"),
        workflow_version_id=_string(row[4], "workflow_profile_version.workflow_version_id"),
        version_number=_positive_int(row[5], "workflow_profile_version.version_number"),
        name_snapshot=_string(row[6], "workflow_profile_version.name_snapshot"),
        profile=_verified_json_object(
            row[7],
            row[8],
            "workflow_profile_version.profile_json",
            WorkflowProfileStoreError,
        ),
        content_sha256=_string(row[8], "workflow_profile_version.content_sha256"),
        note=_optional_string(row[9], "workflow_profile_version.note"),
        created_at=_datetime(row[10], "workflow_profile_version.created_at"),
        archived_at=_optional_datetime(row[11], "workflow_profile_version.archived_at"),
    )


def _profile_list_from_row(row: sqlite3.Row | tuple[object, ...]) -> WorkflowProfileListRecord:
    logical = _profile_from_row(tuple(row[index] for index in range(8)))
    latest = (
        None
        if row[8] is None
        else _profile_version_from_row(tuple(row[index] for index in range(8, 20)))
    )
    return WorkflowProfileListRecord(
        id=logical.id,
        workflow_id=logical.workflow_id,
        project_id=logical.project_id,
        name=logical.name,
        description=logical.description,
        created_at=logical.created_at,
        updated_at=logical.updated_at,
        archived_at=logical.archived_at,
        latest_compatible_version=latest,
    )


def _update_metadata(
    database_path: Path,
    *,
    table: str,
    logical_id: str,
    name: str | None,
    description: str | None,
    update_description: bool,
    clock: Callable[[], datetime],
    getter: Callable[[sqlite3.Connection, str], object],
    label: str,
    validation_error: type[ValueError],
    conflict_error: type[ValueError],
) -> object:
    _nonempty(logical_id, f"{label} ID", validation_error)
    if name is not None:
        _nonempty(name, f"{label} name", validation_error)
    if update_description:
        _optional_text(description, f"{label} description", validation_error)
    with closing(open_connection(database_path)) as connection:
        try:
            connection.execute("BEGIN IMMEDIATE")
            current = getter(connection, logical_id)
            logical = cast(WorkflowRecord | WorkflowProfileRecord, current)
            current_name = logical.name
            current_description = logical.description
            connection.execute(
                f"UPDATE {table} SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                (
                    current_name if name is None else name,
                    description if update_description else current_description,
                    _timestamp(clock, validation_error),
                    logical_id,
                ),
            )
            connection.commit()
        except sqlite3.IntegrityError as error:
            connection.rollback()
            raise conflict_error(
                f"{label} metadata conflicts with existing data: {error}"
            ) from error
        except BaseException:
            connection.rollback()
            raise
        return getter(connection, logical_id)


def _archive(
    database_path: Path,
    *,
    table: str,
    row_id: str,
    clock: Callable[[], datetime],
    getter: Callable[[sqlite3.Connection, str], object],
    label: str,
    validation_error: type[ValueError],
    not_found_error: type[ValueError],
    update_updated_at: bool = True,
) -> object:
    _nonempty(row_id, f"{label} ID", validation_error)
    with closing(open_connection(database_path)) as connection:
        try:
            connection.execute("BEGIN IMMEDIATE")
            timestamp = _timestamp(clock, validation_error)
            assignment = (
                "archived_at = ?, updated_at = ?" if update_updated_at else "archived_at = ?"
            )
            params = (timestamp, timestamp, row_id) if update_updated_at else (timestamp, row_id)
            cursor = connection.execute(
                f"UPDATE {table} SET {assignment} WHERE id = ? AND archived_at IS NULL", params
            )
            if cursor.rowcount == 0 and not _exists(connection, table, row_id):
                raise not_found_error(f"{label} not found: {row_id}")
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        return getter(connection, row_id)


def _validate_library_fields(
    *,
    project_id: str,
    logical_id: str,
    version_id: str,
    name: str,
    description: str | None,
    note: str | None,
    label: str,
    error_type: type[ValueError],
) -> None:
    _nonempty(project_id, "Project ID", error_type)
    _nonempty(logical_id, f"{label} ID", error_type)
    _nonempty(version_id, f"{label} version ID", error_type)
    _nonempty(name, f"{label} name", error_type)
    _optional_text(description, f"{label} description", error_type)
    _optional_note(note, f"{label} version", error_type)


def _validate_profile_library_fields(
    *,
    workflow_id: str,
    logical_id: str,
    version_id: str,
    name: str,
    description: str | None,
    note: str | None,
    label: str,
    error_type: type[ValueError],
) -> None:
    _nonempty(workflow_id, "Workflow ID", error_type)
    _nonempty(logical_id, f"{label} ID", error_type)
    _nonempty(version_id, f"{label} version ID", error_type)
    _nonempty(name, f"{label} name", error_type)
    _optional_text(description, f"{label} description", error_type)
    _optional_note(note, f"{label} version", error_type)


def _check_logical_conflict(
    connection: sqlite3.Connection,
    *,
    table: str,
    project_id: str,
    logical_id: str,
    name: str,
    label: str,
    error_type: type[ValueError],
    scope_column: str = "project_id",
) -> None:
    if _exists(connection, table, logical_id):
        raise error_type(f"{label} ID already exists: {logical_id}")
    if connection.execute(
        f"SELECT 1 FROM {table} WHERE {scope_column} = ? AND name = ?", (project_id, name)
    ).fetchone():
        raise error_type(f"{label} name already exists in Project {project_id}: {name}")


def _next_version(
    connection: sqlite3.Connection, table: str, parent_column: str, parent_id: str
) -> int:
    row = connection.execute(
        f"SELECT COALESCE(MAX(version_number), 0) + 1 FROM {table} WHERE {parent_column} = ?",
        (parent_id,),
    ).fetchone()
    value = None if row is None else row[0]
    if not isinstance(value, int) or value < 1:
        raise ValueError("invalid next version number")
    return value


def _exists(connection: sqlite3.Connection, table: str, row_id: str) -> bool:
    return (
        connection.execute(f"SELECT 1 FROM {table} WHERE id = ?", (row_id,)).fetchone() is not None
    )


def _nonempty(value: object, label: str, error_type: type[ValueError]) -> None:
    if not isinstance(value, str) or not value.strip():
        raise error_type(f"{label} must be a nonempty string")


def _optional_text(value: object, label: str, error_type: type[ValueError]) -> None:
    if value is not None and (not isinstance(value, str) or not value.strip()):
        raise error_type(f"{label} must be nonempty when provided")


def _optional_note(value: object, label: str, error_type: type[ValueError]) -> None:
    _optional_text(value, f"{label} note", error_type)


def _timestamp(clock: Callable[[], datetime], error_type: type[ValueError]) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise error_type("clock must return an aware datetime")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _datetime(value: object, label: str) -> datetime:
    if not isinstance(value, str):
        raise WorkflowStoreError(f"{label} must be a timestamp string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise WorkflowStoreError(f"{label} is not a valid timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise WorkflowStoreError(f"{label} must include a UTC offset")
    return parsed.astimezone(UTC)


def _optional_datetime(value: object, label: str) -> datetime | None:
    return None if value is None else _datetime(value, label)


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise WorkflowStoreError(f"{label} must be a nonempty string")
    return value


def _optional_string(value: object, label: str) -> str | None:
    return None if value is None else _string(value, label)


def _positive_int(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise WorkflowStoreError(f"{label} must be a positive integer")
    return value


def _json_object(value: object, label: str, error_type: type[ValueError]) -> dict[str, object]:
    if not isinstance(value, str):
        raise error_type(f"{label} must be JSON text")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise error_type(f"{label} is invalid JSON") from error
    if not isinstance(parsed, dict) or not all(isinstance(key, str) for key in parsed):
        raise error_type(f"{label} must contain an object")
    return cast(dict[str, object], parsed)


def _verified_json_object(
    value: object,
    digest: object,
    label: str,
    error_type: type[ValueError],
) -> dict[str, object]:
    parsed = _json_object(value, label, error_type)
    expected_digest = _string(digest, f"{label} SHA-256")
    canonical, actual_digest = _canonical(parsed)
    if value != canonical:
        raise error_type(f"{label} is not canonical JSON")
    if actual_digest != expected_digest:
        raise error_type(f"{label} SHA-256 does not match its content")
    return parsed
