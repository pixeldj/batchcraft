import hashlib
import json
import sqlite3
from collections.abc import Callable
from contextlib import closing
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import uuid4

from batchcraft.db.connection import open_connection
from batchcraft.db.models import (
    SavedBatchDefinition,
    SavedBatchDetailRecord,
    SavedBatchImageBinding,
    SavedBatchLinkedParameterRow,
    SavedBatchLinkedParameterSet,
    SavedBatchListRecord,
    SavedBatchPromptSelection,
    SavedBatchRecord,
    SavedBatchSeedIntent,
    SavedBatchSeedMode,
    SavedBatchVariableBinding,
    SavedBatchWorkflowProfileVersionSnapshot,
    SavedBatchWorkflowVersionSnapshot,
)
from batchcraft.domain import (
    BatchDefinition,
    LinkedParameterRow,
    LinkedParameterSet,
    ParameterDecimalRange,
    ParameterRangeIntent,
    ParameterValuesIntent,
    ParameterValueType,
    PromptVersion,
    SeedInput,
    WorkflowParameter,
    compile_batch,
    materialize_parameter_bindings,
    validate_image_input_slot_key,
    validate_parameter_alternatives,
    validate_parameter_scalar,
    validate_stable_key,
)
from batchcraft.files._io import canonical_json_bytes, is_safe_filesystem_key

MAX_SAFE_SEED = 2**53 - 1


class SavedBatchStoreError(ValueError):
    """A Saved Batch persistence operation failed."""


class SavedBatchValidationError(SavedBatchStoreError):
    """Saved Batch input is invalid."""


class SavedBatchNotFoundError(SavedBatchStoreError):
    """The requested Saved Batch does not exist."""


class SavedBatchConflictError(SavedBatchStoreError):
    """A Saved Batch revision or uniqueness constraint conflicts."""


class SavedBatchIntegrityError(SavedBatchStoreError):
    """A Saved Batch library selection is missing, detached, or incompatible."""


class SavedBatchStore:
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
        filesystem_key: str,
        definition: SavedBatchDefinition,
        *,
        batch_id: str | None = None,
    ) -> SavedBatchDetailRecord:
        batch_id = self._id_factory() if batch_id is None else batch_id
        definition = _normalize_parameter_bindings(definition)
        _validate_identity(project_id, batch_id, filesystem_key)
        _validate_definition(definition)
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                _require_project(connection, project_id)
                _validate_library_selections(connection, project_id, definition)
                timestamp = _timestamp(self._clock)
                workflow_version_id = (
                    None
                    if definition.selected_workflow_version is None
                    else definition.selected_workflow_version.id
                )
                profile_version_id = (
                    None
                    if definition.selected_workflow_profile_version is None
                    else definition.selected_workflow_profile_version.id
                )
                connection.execute(
                    """
                    INSERT INTO batch (
                        id, project_id, filesystem_key, name, description, revision,
                        seed_mode, seed_values_json, random_seed_count,
                        selected_workflow_version_id, selected_workflow_profile_id,
                        selected_workflow_profile_version_id, created_at, updated_at, archived_at
                    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (
                        batch_id,
                        project_id,
                        filesystem_key,
                        definition.name,
                        definition.description,
                        definition.seed_intent.mode.value,
                        _canonical_array(definition.seed_intent.values),
                        definition.seed_intent.random_seed_count,
                        workflow_version_id,
                        definition.selected_workflow_profile_id,
                        profile_version_id,
                        timestamp,
                        timestamp,
                    ),
                )
                _replace_children(connection, batch_id, definition)
                connection.commit()
            except SavedBatchStoreError:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise _translate_integrity_error(
                    connection, project_id, batch_id, filesystem_key, error
                ) from error
            return _get_detail(connection, batch_id)

    def list(
        self, project_id: str, *, include_archived: bool = False
    ) -> tuple[SavedBatchListRecord, ...]:
        _nonblank(project_id, "Project ID")
        archived = "" if include_archived else "AND archived_at IS NULL"
        with closing(open_connection(self.database_path)) as connection:
            _require_project(connection, project_id)
            rows = connection.execute(
                f"""
                SELECT {_ROOT_COLUMNS}
                FROM batch WHERE project_id = ? {archived}
                ORDER BY created_at, id
                """,
                (project_id,),
            ).fetchall()
        return tuple(_list_record(row) for row in rows)

    def get(self, batch_id: str) -> SavedBatchDetailRecord:
        _nonblank(batch_id, "Saved Batch ID")
        with closing(open_connection(self.database_path)) as connection:
            return _get_detail(connection, batch_id)

    def update(
        self,
        batch_id: str,
        definition: SavedBatchDefinition,
        *,
        expected_revision: int,
    ) -> SavedBatchDetailRecord:
        _nonblank(batch_id, "Saved Batch ID")
        definition = _normalize_parameter_bindings(definition)
        if (
            not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 1
        ):
            raise SavedBatchValidationError("expected revision must be a positive integer")
        _validate_definition(definition)
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                current = _get_root(connection, batch_id)
                if current.revision != expected_revision:
                    raise SavedBatchConflictError(
                        f"Saved Batch revision conflict: expected {expected_revision}, "
                        f"found {current.revision}"
                    )
                _validate_library_selections(connection, current.project_id, definition)
                workflow_version_id = (
                    None
                    if definition.selected_workflow_version is None
                    else definition.selected_workflow_version.id
                )
                profile_version_id = (
                    None
                    if definition.selected_workflow_profile_version is None
                    else definition.selected_workflow_profile_version.id
                )
                cursor = connection.execute(
                    """
                    UPDATE batch SET
                        name = ?, description = ?, revision = revision + 1,
                        seed_mode = ?, seed_values_json = ?, random_seed_count = ?,
                        selected_workflow_version_id = ?, selected_workflow_profile_id = ?,
                        selected_workflow_profile_version_id = ?, updated_at = ?
                    WHERE id = ? AND revision = ?
                    """,
                    (
                        definition.name,
                        definition.description,
                        definition.seed_intent.mode.value,
                        _canonical_array(definition.seed_intent.values),
                        definition.seed_intent.random_seed_count,
                        workflow_version_id,
                        definition.selected_workflow_profile_id,
                        profile_version_id,
                        _timestamp(self._clock),
                        batch_id,
                        expected_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    raise SavedBatchConflictError("Saved Batch changed during update")
                _replace_children(connection, batch_id, definition)
                connection.commit()
            except SavedBatchStoreError:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise SavedBatchIntegrityError(
                    f"Saved Batch update violates database integrity: {error}"
                ) from error
            return _get_detail(connection, batch_id)

    def archive(self, batch_id: str) -> SavedBatchDetailRecord:
        _nonblank(batch_id, "Saved Batch ID")
        with closing(open_connection(self.database_path)) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                timestamp = _timestamp(self._clock)
                cursor = connection.execute(
                    """
                    UPDATE batch SET archived_at = ?, updated_at = ?, revision = revision + 1
                    WHERE id = ? AND archived_at IS NULL
                    """,
                    (timestamp, timestamp, batch_id),
                )
                if cursor.rowcount == 0 and not _batch_exists(connection, batch_id):
                    raise SavedBatchNotFoundError(f"Saved Batch not found: {batch_id}")
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            return _get_detail(connection, batch_id)


_ROOT_COLUMNS = """
id, project_id, filesystem_key, name, description, revision,
seed_mode, seed_values_json, random_seed_count,
selected_workflow_version_id, selected_workflow_profile_id,
selected_workflow_profile_version_id, created_at, updated_at, archived_at
"""


def _validate_identity(project_id: str, batch_id: str, filesystem_key: str) -> None:
    _nonblank(project_id, "Project ID")
    _nonblank(batch_id, "Saved Batch ID")
    if not is_safe_filesystem_key(filesystem_key):
        raise SavedBatchValidationError(
            f"Saved Batch filesystem key is not path-safe: {filesystem_key!r}"
        )


def _validate_definition(definition: SavedBatchDefinition) -> None:
    if not isinstance(definition, SavedBatchDefinition):
        raise SavedBatchValidationError("definition must be a SavedBatchDefinition")
    _nonblank(definition.name, "Saved Batch name")
    if definition.description is not None:
        _nonblank(definition.description, "Saved Batch description")
    _validate_seed_intent(definition.seed_intent)
    for selection in definition.prompt_selections:
        if not isinstance(selection, SavedBatchPromptSelection):
            raise SavedBatchValidationError("prompt selections must be typed records")
        _nonblank(selection.prompt_version_id, "PromptVersion ID")
        _nonblank(selection.name_snapshot, "PromptVersion name snapshot")
        _nonblank(selection.text, "PromptVersion text")
    for binding in definition.variable_bindings:
        _validate_binding(binding)
    slot_keys: set[str] = set()
    for image_binding in definition.image_bindings:
        if not isinstance(image_binding, SavedBatchImageBinding):
            raise SavedBatchValidationError("image bindings must be typed records")
        try:
            validate_image_input_slot_key(image_binding.slot_key)
        except ValueError as error:
            raise SavedBatchValidationError(str(error)) from error
        if image_binding.slot_key in slot_keys:
            raise SavedBatchValidationError(f"duplicate image binding: {image_binding.slot_key!r}")
        slot_keys.add(image_binding.slot_key)
        if not image_binding.values:
            raise SavedBatchValidationError(
                "image binding values must contain at least one effective value"
            )
        if any(
            value is not None and (not isinstance(value, str) or not value.strip())
            for value in image_binding.values
        ):
            raise SavedBatchValidationError(
                "image binding values must be nonblank asset IDs or null"
            )
        if len(set(image_binding.values)) != len(image_binding.values):
            raise SavedBatchValidationError(
                "image binding values must not contain exact duplicates"
            )
        if None in image_binding.values and image_binding.values[0] is not None:
            raise SavedBatchValidationError("image binding values must place Base workflow first")
    parameter_keys: set[str] = set()
    for parameter_binding in definition.parameter_bindings:
        if not isinstance(parameter_binding, (ParameterValuesIntent, ParameterRangeIntent)):
            raise SavedBatchValidationError("parameter bindings must be typed records")
        try:
            validate_stable_key(parameter_binding.parameter_key)
        except ValueError as error:
            raise SavedBatchValidationError(f"workflow parameter {error}") from error
        if parameter_binding.parameter_key in parameter_keys:
            raise SavedBatchValidationError(
                f"duplicate parameter binding: {parameter_binding.parameter_key!r}"
            )
        parameter_keys.add(parameter_binding.parameter_key)
        if isinstance(parameter_binding, ParameterValuesIntent):
            try:
                validate_parameter_alternatives(parameter_binding.values)
            except ValueError as error:
                raise SavedBatchValidationError(str(error)) from error
        elif (
            not isinstance(parameter_binding.include_base, bool)
            or not isinstance(parameter_binding.range, ParameterDecimalRange)
            or not all(
                isinstance(value, str)
                for value in (
                    parameter_binding.range.start,
                    parameter_binding.range.end,
                    parameter_binding.range.step,
                )
            )
        ):
            raise SavedBatchValidationError("parameter range intent is malformed")
    set_keys: set[str] = set()
    linked_members: set[str] = set()
    for linked_set in definition.linked_parameter_sets:
        if not isinstance(linked_set, SavedBatchLinkedParameterSet):
            raise SavedBatchValidationError("linked parameter sets must be typed records")
        try:
            validate_stable_key(linked_set.set_key)
        except ValueError as error:
            raise SavedBatchValidationError(f"linked parameter set {error}") from error
        if linked_set.set_key in set_keys:
            raise SavedBatchValidationError(
                f"duplicate linked parameter set: {linked_set.set_key!r}"
            )
        set_keys.add(linked_set.set_key)
        _nonblank(linked_set.set_label, "Linked parameter set label")
        if len(linked_set.member_keys) < 2 or len(set(linked_set.member_keys)) != len(
            linked_set.member_keys
        ):
            raise SavedBatchValidationError(
                "linked parameter sets must contain at least two unique members"
            )
        if linked_members.intersection(linked_set.member_keys):
            raise SavedBatchValidationError("a parameter may belong to at most one linked set")
        linked_members.update(linked_set.member_keys)
        if not linked_set.rows:
            raise SavedBatchValidationError("linked parameter sets must contain at least one row")
        for row in linked_set.rows:
            if not isinstance(row, SavedBatchLinkedParameterRow):
                raise SavedBatchValidationError("linked parameter rows must be typed records")
            if row.label is not None:
                _nonblank(row.label, "Linked parameter row label")
            if len(row.values) != len(linked_set.member_keys):
                raise SavedBatchValidationError("linked parameter rows must define every member")
    if definition.selected_workflow_version is not None:
        _validate_workflow_snapshot(definition.selected_workflow_version)
    if definition.selected_workflow_profile_id is not None:
        _nonblank(definition.selected_workflow_profile_id, "Workflow Profile ID")
    profile_version = definition.selected_workflow_profile_version
    if profile_version is not None:
        _validate_profile_snapshot(profile_version)
        if definition.selected_workflow_profile_id != profile_version.workflow_profile_id:
            raise SavedBatchValidationError(
                "Workflow Profile version must identify the selected logical Profile"
            )


def _validate_seed_intent(seeds: SavedBatchSeedIntent) -> None:
    if not isinstance(seeds, SavedBatchSeedIntent) or not isinstance(
        seeds.mode, SavedBatchSeedMode
    ):
        raise SavedBatchValidationError("seed intent must use a supported mode")
    if any(
        not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > MAX_SAFE_SEED
        for value in seeds.values
    ):
        raise SavedBatchValidationError(
            f"seed values must be integers from 0 through {MAX_SAFE_SEED}"
        )
    if seeds.mode is SavedBatchSeedMode.FIXED and len(seeds.values) != 1:
        raise SavedBatchValidationError("fixed seed intent must contain exactly one value")
    if seeds.mode is SavedBatchSeedMode.EXPLICIT and not seeds.values:
        raise SavedBatchValidationError("explicit seed intent must contain at least one value")
    if seeds.mode is SavedBatchSeedMode.RANDOM:
        if seeds.values:
            raise SavedBatchValidationError("random seed intent cannot contain concrete values")
        if (
            not isinstance(seeds.random_seed_count, int)
            or isinstance(seeds.random_seed_count, bool)
            or seeds.random_seed_count < 1
            or seeds.random_seed_count > 100
        ):
            raise SavedBatchValidationError("random seed count must be from 1 through 100")
    elif seeds.random_seed_count is not None:
        raise SavedBatchValidationError("only random seed intent may define a random seed count")


def _validate_binding(binding: SavedBatchVariableBinding) -> None:
    if not isinstance(binding, SavedBatchVariableBinding):
        raise SavedBatchValidationError("variable bindings must be typed records")
    if not isinstance(binding.placeholder, str):
        raise SavedBatchValidationError("binding placeholder must be a string")
    if any(not isinstance(value, str) for value in binding.values):
        raise SavedBatchValidationError("binding values must be strings")
    if len(set(binding.values)) != len(binding.values):
        raise SavedBatchValidationError("binding values must not contain exact duplicates")


def _validate_workflow_snapshot(snapshot: SavedBatchWorkflowVersionSnapshot) -> None:
    if not isinstance(snapshot, SavedBatchWorkflowVersionSnapshot):
        raise SavedBatchValidationError("selected WorkflowVersion must be a typed snapshot")
    _nonblank(snapshot.id, "WorkflowVersion ID")
    _validate_digest(snapshot.content_sha256, "WorkflowVersion SHA-256")
    if not isinstance(snapshot.workflow, dict):
        raise SavedBatchValidationError("WorkflowVersion snapshot must be a JSON object")


def _validate_profile_snapshot(snapshot: SavedBatchWorkflowProfileVersionSnapshot) -> None:
    if not isinstance(snapshot, SavedBatchWorkflowProfileVersionSnapshot):
        raise SavedBatchValidationError(
            "selected Workflow Profile version must be a typed snapshot"
        )
    _nonblank(snapshot.id, "Workflow Profile version ID")
    _nonblank(snapshot.workflow_profile_id, "Workflow Profile ID")
    _nonblank(snapshot.workflow_version_id, "WorkflowVersion ID")
    _validate_digest(snapshot.content_sha256, "Workflow Profile version SHA-256")
    if not isinstance(snapshot.profile, dict):
        raise SavedBatchValidationError("Workflow Profile version snapshot must be a JSON object")


def _validate_digest(value: str, label: str) -> None:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(c not in "0123456789abcdef" for c in value)
    ):
        raise SavedBatchValidationError(f"{label} must be a lowercase SHA-256 digest")


def _validate_library_selections(
    connection: sqlite3.Connection, project_id: str, definition: SavedBatchDefinition
) -> None:
    for selection in definition.prompt_selections:
        row = connection.execute(
            """
            SELECT pv.name_snapshot, pv.text, p.project_id
            FROM prompt_version AS pv JOIN prompt AS p ON p.id = pv.prompt_id
            WHERE pv.id = ?
            """,
            (selection.prompt_version_id,),
        ).fetchone()
        if row is None:
            raise SavedBatchIntegrityError(
                f"PromptVersion not found: {selection.prompt_version_id}; detached snapshots cannot be saved"
            )
        if row[2] != project_id:
            raise SavedBatchIntegrityError(
                f"PromptVersion {selection.prompt_version_id} belongs to another Project"
            )
        if row[0] != selection.name_snapshot or row[1] != selection.text:
            raise SavedBatchIntegrityError(
                f"PromptVersion {selection.prompt_version_id} snapshot content does not match the library"
            )

    workflow = definition.selected_workflow_version
    workflow_row: tuple[object, ...] | None = None
    if workflow is not None:
        workflow_row = connection.execute(
            """
            SELECT workflow_id, project_id, workflow_json, content_sha256
            FROM workflow_version WHERE id = ?
            """,
            (workflow.id,),
        ).fetchone()
        if workflow_row is None:
            raise SavedBatchIntegrityError(
                f"WorkflowVersion not found: {workflow.id}; detached snapshots cannot be saved"
            )
        if workflow_row[1] != project_id:
            raise SavedBatchIntegrityError(
                f"WorkflowVersion {workflow.id} belongs to another Project"
            )
        _require_snapshot_match(
            workflow.workflow,
            workflow.content_sha256,
            workflow_row[2],
            workflow_row[3],
            f"WorkflowVersion {workflow.id}",
        )

    profile_id = definition.selected_workflow_profile_id
    profile_row: tuple[object, ...] | None = None
    if profile_id is not None:
        profile_row = connection.execute(
            "SELECT workflow_id, project_id FROM workflow_profile WHERE id = ?", (profile_id,)
        ).fetchone()
        if profile_row is None:
            raise SavedBatchIntegrityError(f"Workflow Profile not found: {profile_id}")
        if profile_row[1] != project_id:
            raise SavedBatchIntegrityError(
                f"Workflow Profile {profile_id} belongs to another Project"
            )

    profile_version = definition.selected_workflow_profile_version
    if profile_version is not None:
        row = connection.execute(
            """
            SELECT workflow_profile_id, workflow_id, project_id, workflow_version_id,
                   profile_json, content_sha256
            FROM workflow_profile_version WHERE id = ?
            """,
            (profile_version.id,),
        ).fetchone()
        if row is None:
            raise SavedBatchIntegrityError(
                f"Workflow Profile version not found: {profile_version.id}; "
                "detached snapshots cannot be saved"
            )
        if row[0] != profile_id or row[2] != project_id:
            raise SavedBatchIntegrityError(
                f"Workflow Profile version {profile_version.id} has incompatible ownership"
            )
        if row[3] != profile_version.workflow_version_id:
            raise SavedBatchIntegrityError(
                f"Workflow Profile version {profile_version.id} target identity does not match"
            )
        if workflow is None or row[3] != workflow.id:
            raise SavedBatchIntegrityError(
                f"Workflow Profile version {profile_version.id} is incompatible with the selected WorkflowVersion"
            )
        if (
            profile_row is None
            or workflow_row is None
            or profile_row[0] != workflow_row[0]
            or row[1] != workflow_row[0]
        ):
            raise SavedBatchIntegrityError(
                "selected Workflow and Workflow Profile are incompatible"
            )
        _require_snapshot_match(
            profile_version.profile,
            profile_version.content_sha256,
            row[4],
            row[5],
            f"Workflow Profile version {profile_version.id}",
        )
        raw_image_inputs = profile_version.profile.get("image_inputs")
        if not isinstance(raw_image_inputs, list):
            raise SavedBatchIntegrityError(
                "selected Workflow Profile version has invalid image inputs"
            )
        profile_slot_keys = tuple(
            _profile_image_input_key(value, index)
            for index, value in enumerate(raw_image_inputs, start=1)
        )
        binding_slot_keys = tuple(binding.slot_key for binding in definition.image_bindings)
        if binding_slot_keys != profile_slot_keys:
            raise SavedBatchIntegrityError(
                "Saved Batch image bindings must match the selected ProfileVersion slot order"
            )
        raw_parameters = profile_version.profile.get("parameters")
        if not isinstance(raw_parameters, list):
            raise SavedBatchIntegrityError(
                "selected Workflow Profile version has invalid parameters"
            )
        profile_parameter_keys = tuple(
            _profile_parameter_key(value, index)
            for index, value in enumerate(raw_parameters, start=1)
        )
        linked_members = {
            member
            for linked_set in definition.linked_parameter_sets
            for member in linked_set.member_keys
        }
        expected_independent_keys = tuple(
            key for key in profile_parameter_keys if key not in linked_members
        )
        if (
            tuple(binding.parameter_key for binding in definition.parameter_bindings)
            != expected_independent_keys
        ):
            raise SavedBatchIntegrityError(
                "Saved Batch independent parameter bindings must match unlinked Profile parameters in order"
            )
        try:
            parameters = tuple(
                _workflow_parameter(value, index) for index, value in enumerate(raw_parameters, 1)
            )
            bindings = materialize_parameter_bindings(parameters, definition.parameter_bindings)
            compile_batch(
                BatchDefinition(
                    prompt_versions=(PromptVersion("saved-batch-validation", "Validation", ""),),
                    variable_bindings=(),
                    image_input_slots=(),
                    image_bindings=(),
                    parameters=parameters,
                    parameter_bindings=bindings,
                    linked_parameter_sets=tuple(
                        LinkedParameterSet(
                            item.set_key,
                            item.set_label,
                            item.member_keys,
                            tuple(LinkedParameterRow(row.values, row.label) for row in item.rows),
                        )
                        for item in definition.linked_parameter_sets
                    ),
                    seeds=SeedInput.fixed(0),
                )
            )
        except ValueError as error:
            raise SavedBatchIntegrityError(str(error)) from error
    elif profile_row is not None and workflow_row is not None and profile_row[0] != workflow_row[0]:
        raise SavedBatchIntegrityError(
            "selected Workflow and logical Workflow Profile are incompatible"
        )
    elif definition.image_bindings:
        raise SavedBatchIntegrityError(
            "Saved Batch image bindings require an exact selected ProfileVersion"
        )
    elif definition.parameter_bindings or definition.linked_parameter_sets:
        raise SavedBatchIntegrityError(
            "Saved Batch parameter bindings require an exact selected ProfileVersion"
        )


def _profile_image_input_key(value: object, position: int) -> str:
    if not isinstance(value, dict):
        raise SavedBatchIntegrityError(
            f"selected Workflow Profile image input {position} is invalid"
        )
    try:
        return validate_image_input_slot_key(value.get("key"))
    except ValueError as error:
        raise SavedBatchIntegrityError(str(error)) from error


def _profile_parameter_key(value: object, position: int) -> str:
    if not isinstance(value, dict):
        raise SavedBatchIntegrityError(f"selected Workflow Profile parameter {position} is invalid")
    try:
        return validate_stable_key(value.get("key"))
    except ValueError as error:
        raise SavedBatchIntegrityError(f"workflow parameter {error}") from error


def _require_snapshot_match(
    supplied: dict[str, object],
    supplied_digest: str,
    stored_json: object,
    stored_digest: object,
    label: str,
) -> None:
    canonical = canonical_json_bytes(supplied).decode("ascii")
    digest = hashlib.sha256(canonical.encode("ascii")).hexdigest()
    if supplied_digest != digest:
        raise SavedBatchIntegrityError(f"{label} supplied SHA-256 does not match its content")
    if stored_json != canonical or stored_digest != supplied_digest:
        raise SavedBatchIntegrityError(f"{label} snapshot content does not match the library")


def _replace_children(
    connection: sqlite3.Connection, batch_id: str, definition: SavedBatchDefinition
) -> None:
    connection.execute("DELETE FROM batch_prompt_selection WHERE batch_id = ?", (batch_id,))
    connection.execute("DELETE FROM batch_variable_binding WHERE batch_id = ?", (batch_id,))
    connection.execute("DELETE FROM batch_image_binding WHERE batch_id = ?", (batch_id,))
    connection.execute("DELETE FROM batch_parameter_binding WHERE batch_id = ?", (batch_id,))
    connection.execute("DELETE FROM batch_linked_parameter_set WHERE batch_id = ?", (batch_id,))
    connection.executemany(
        """
        INSERT INTO batch_prompt_selection (batch_id, position, prompt_version_id)
        VALUES (?, ?, ?)
        """,
        (
            (batch_id, position, selection.prompt_version_id)
            for position, selection in enumerate(definition.prompt_selections, 1)
        ),
    )
    connection.executemany(
        """
        INSERT INTO batch_linked_parameter_set (batch_id, position, set_key, set_label)
        VALUES (?, ?, ?, ?)
        """,
        (
            (batch_id, position, item.set_key, item.set_label)
            for position, item in enumerate(definition.linked_parameter_sets, 1)
        ),
    )
    connection.executemany(
        """
        INSERT INTO batch_linked_parameter_set_member
            (batch_id, set_position, member_position, parameter_key)
        VALUES (?, ?, ?, ?)
        """,
        (
            (batch_id, set_position, member_position, member_key)
            for set_position, item in enumerate(definition.linked_parameter_sets, 1)
            for member_position, member_key in enumerate(item.member_keys, 1)
        ),
    )
    connection.executemany(
        """
        INSERT INTO batch_linked_parameter_set_row
            (batch_id, set_position, row_position, row_label)
        VALUES (?, ?, ?, ?)
        """,
        (
            (batch_id, set_position, row_position, row.label)
            for set_position, item in enumerate(definition.linked_parameter_sets, 1)
            for row_position, row in enumerate(item.rows, 1)
        ),
    )
    connection.executemany(
        """
        INSERT INTO batch_linked_parameter_set_value
            (batch_id, set_position, row_position, member_position, value_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            (batch_id, set_position, row_position, member_position, _canonical_scalar(value))
            for set_position, item in enumerate(definition.linked_parameter_sets, 1)
            for row_position, row in enumerate(item.rows, 1)
            for member_position, value in enumerate(row.values, 1)
        ),
    )
    connection.executemany(
        """
        INSERT INTO batch_parameter_binding
            (batch_id, position, parameter_key, mode, include_base,
             range_start, range_end, range_step)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                batch_id,
                position,
                binding.parameter_key,
                binding.mode,
                int(binding.include_base) if isinstance(binding, ParameterRangeIntent) else 0,
                binding.range.start if isinstance(binding, ParameterRangeIntent) else None,
                binding.range.end if isinstance(binding, ParameterRangeIntent) else None,
                binding.range.step if isinstance(binding, ParameterRangeIntent) else None,
            )
            for position, binding in enumerate(definition.parameter_bindings, 1)
        ),
    )
    connection.executemany(
        """
        INSERT INTO batch_parameter_binding_value
            (batch_id, binding_position, value_position, value_json)
        VALUES (?, ?, ?, ?)
        """,
        (
            (batch_id, binding_position, value_position, _canonical_scalar(value))
            for binding_position, binding in enumerate(definition.parameter_bindings, 1)
            if isinstance(binding, ParameterValuesIntent)
            for value_position, value in enumerate(binding.values, 1)
        ),
    )
    connection.executemany(
        """
        INSERT INTO batch_variable_binding (batch_id, position, placeholder, values_json)
        VALUES (?, ?, ?, ?)
        """,
        (
            (
                batch_id,
                position,
                binding.placeholder,
                _canonical_array(binding.values),
            )
            for position, binding in enumerate(definition.variable_bindings, 1)
        ),
    )
    connection.executemany(
        """
        INSERT INTO batch_image_binding (batch_id, position, slot_key)
        VALUES (?, ?, ?)
        """,
        (
            (batch_id, position, binding.slot_key)
            for position, binding in enumerate(definition.image_bindings, 1)
        ),
    )
    connection.executemany(
        """
        INSERT INTO batch_image_binding_value
            (batch_id, binding_position, value_position, asset_id)
        VALUES (?, ?, ?, ?)
        """,
        (
            (batch_id, binding_position, value_position, value)
            for binding_position, binding in enumerate(definition.image_bindings, 1)
            for value_position, value in enumerate(binding.values, 1)
        ),
    )


def _get_root(connection: sqlite3.Connection, batch_id: str) -> SavedBatchRecord:
    row = connection.execute(
        f"SELECT {_ROOT_COLUMNS} FROM batch WHERE id = ?", (batch_id,)
    ).fetchone()
    if row is None:
        raise SavedBatchNotFoundError(f"Saved Batch not found: {batch_id}")
    return _root_record(row)


def _get_detail(connection: sqlite3.Connection, batch_id: str) -> SavedBatchDetailRecord:
    root = _get_root(connection, batch_id)
    prompts = connection.execute(
        """
        SELECT s.prompt_version_id, pv.name_snapshot, pv.text,
               p.id, p.name, pv.version_number, p.archived_at, pv.archived_at
        FROM batch_prompt_selection AS s
        JOIN prompt_version AS pv ON pv.id = s.prompt_version_id
        JOIN prompt AS p ON p.id = pv.prompt_id
        WHERE s.batch_id = ? ORDER BY s.position
        """,
        (batch_id,),
    ).fetchall()
    bindings = connection.execute(
        """
        SELECT placeholder, values_json
        FROM batch_variable_binding WHERE batch_id = ? ORDER BY position
        """,
        (batch_id,),
    ).fetchall()
    image_rows = connection.execute(
        """
        SELECT b.position, b.slot_key, v.value_position, v.asset_id
        FROM batch_image_binding AS b
        LEFT JOIN batch_image_binding_value AS v
          ON v.batch_id = b.batch_id AND v.binding_position = b.position
        WHERE b.batch_id = ? ORDER BY b.position, v.value_position
        """,
        (batch_id,),
    ).fetchall()
    parameter_rows = connection.execute(
        """
        SELECT b.position, b.parameter_key, b.mode, b.include_base,
               b.range_start, b.range_end, b.range_step, v.value_position, v.value_json
        FROM batch_parameter_binding AS b
        LEFT JOIN batch_parameter_binding_value AS v
          ON v.batch_id = b.batch_id AND v.binding_position = b.position
        WHERE b.batch_id = ? ORDER BY b.position, v.value_position
        """,
        (batch_id,),
    ).fetchall()
    linked_set_rows = connection.execute(
        """
        SELECT s.position, s.set_key, s.set_label, m.member_position, m.parameter_key,
                r.row_position, r.row_label, v.value_json
        FROM batch_linked_parameter_set AS s
        LEFT JOIN batch_linked_parameter_set_member AS m
          ON m.batch_id = s.batch_id AND m.set_position = s.position
        LEFT JOIN batch_linked_parameter_set_row AS r
          ON r.batch_id = s.batch_id AND r.set_position = s.position
        LEFT JOIN batch_linked_parameter_set_value AS v
          ON v.batch_id = s.batch_id AND v.set_position = s.position
         AND v.row_position = r.row_position AND v.member_position = m.member_position
        WHERE s.batch_id = ?
        ORDER BY s.position, r.row_position, m.member_position
        """,
        (batch_id,),
    ).fetchall()
    workflow = _load_workflow_snapshot(connection, root.selected_workflow_version_id)
    profile_metadata = _load_profile_metadata(connection, root.selected_workflow_profile_id)
    profile = _load_profile_snapshot(connection, root.selected_workflow_profile_version_id)
    parameter_bindings = _parameter_bindings_from_rows(parameter_rows)
    linked_parameter_sets = _linked_parameter_sets_from_rows(linked_set_rows)
    _validate_persisted_parameter_bindings(profile, parameter_bindings, linked_parameter_sets)
    return SavedBatchDetailRecord(
        id=root.id,
        project_id=root.project_id,
        filesystem_key=root.filesystem_key,
        name=root.name,
        description=root.description,
        revision=root.revision,
        seed_mode=root.seed_mode,
        seed_values=root.seed_values,
        random_seed_count=root.random_seed_count,
        selected_workflow_version_id=root.selected_workflow_version_id,
        selected_workflow_profile_id=root.selected_workflow_profile_id,
        selected_workflow_profile_version_id=root.selected_workflow_profile_version_id,
        created_at=root.created_at,
        updated_at=root.updated_at,
        archived_at=root.archived_at,
        prompt_selections=tuple(
            SavedBatchPromptSelection(
                prompt_version_id=_string(row[0], "prompt_version_id"),
                name_snapshot=_string(row[1], "name_snapshot"),
                text=_string(row[2], "text"),
                prompt_id=_string(row[3], "prompt_id"),
                prompt_name=_string(row[4], "prompt_name"),
                version_number=_positive_int(row[5], "prompt version_number"),
                prompt_archived_at=_optional_datetime(row[6], "prompt archived_at"),
                version_archived_at=_optional_datetime(row[7], "prompt version archived_at"),
            )
            for row in prompts
        ),
        variable_bindings=tuple(_binding_from_row(row) for row in bindings),
        image_bindings=_image_bindings_from_rows(image_rows),
        parameter_bindings=parameter_bindings,
        linked_parameter_sets=linked_parameter_sets,
        selected_workflow_version=workflow,
        selected_workflow_profile_name=(None if profile_metadata is None else profile_metadata[0]),
        selected_workflow_profile_archived_at=(
            None if profile_metadata is None else profile_metadata[1]
        ),
        selected_workflow_profile_version=profile,
    )


def _load_workflow_snapshot(
    connection: sqlite3.Connection, version_id: str | None
) -> SavedBatchWorkflowVersionSnapshot | None:
    if version_id is None:
        return None
    row = connection.execute(
        """
        SELECT v.workflow_json, v.content_sha256, w.id, w.name, v.version_number,
               v.name_snapshot, w.archived_at, v.archived_at
        FROM workflow_version AS v JOIN workflow AS w ON w.id = v.workflow_id
        WHERE v.id = ?
        """,
        (version_id,),
    ).fetchone()
    if row is None:
        raise SavedBatchIntegrityError(f"selected WorkflowVersion is missing: {version_id}")
    return SavedBatchWorkflowVersionSnapshot(
        id=version_id,
        content_sha256=_string(row[1], "workflow content_sha256"),
        workflow=_json_object(row[0], "workflow_json"),
        workflow_id=_string(row[2], "workflow_id"),
        workflow_name=_string(row[3], "workflow_name"),
        version_number=_positive_int(row[4], "workflow version_number"),
        name_snapshot=_string(row[5], "workflow name_snapshot"),
        workflow_archived_at=_optional_datetime(row[6], "workflow archived_at"),
        version_archived_at=_optional_datetime(row[7], "workflow version archived_at"),
    )


def _load_profile_snapshot(
    connection: sqlite3.Connection, version_id: str | None
) -> SavedBatchWorkflowProfileVersionSnapshot | None:
    if version_id is None:
        return None
    row = connection.execute(
        """
        SELECT v.workflow_profile_id, v.workflow_version_id, v.profile_json,
               v.content_sha256, p.name, v.version_number, v.name_snapshot,
               p.archived_at, v.archived_at
        FROM workflow_profile_version AS v
        JOIN workflow_profile AS p ON p.id = v.workflow_profile_id
        WHERE v.id = ?
        """,
        (version_id,),
    ).fetchone()
    if row is None:
        raise SavedBatchIntegrityError(
            f"selected Workflow Profile version is missing: {version_id}"
        )
    return SavedBatchWorkflowProfileVersionSnapshot(
        id=version_id,
        workflow_profile_id=_string(row[0], "workflow_profile_id"),
        workflow_version_id=_string(row[1], "workflow_version_id"),
        content_sha256=_string(row[3], "profile content_sha256"),
        profile=_json_object(row[2], "profile_json"),
        workflow_profile_name=_string(row[4], "workflow_profile_name"),
        version_number=_positive_int(row[5], "profile version_number"),
        name_snapshot=_string(row[6], "profile name_snapshot"),
        workflow_profile_archived_at=_optional_datetime(row[7], "profile archived_at"),
        version_archived_at=_optional_datetime(row[8], "profile version archived_at"),
    )


def _load_profile_metadata(
    connection: sqlite3.Connection, profile_id: str | None
) -> tuple[str, datetime | None] | None:
    if profile_id is None:
        return None
    row = connection.execute(
        "SELECT name, archived_at FROM workflow_profile WHERE id = ?", (profile_id,)
    ).fetchone()
    if row is None:
        raise SavedBatchIntegrityError(f"selected Workflow Profile is missing: {profile_id}")
    return (
        _string(row[0], "workflow_profile.name"),
        _optional_datetime(row[1], "workflow_profile.archived_at"),
    )


def _root_record(row: sqlite3.Row | tuple[object, ...]) -> SavedBatchRecord:
    return SavedBatchRecord(
        id=_string(row[0], "batch.id"),
        project_id=_string(row[1], "batch.project_id"),
        filesystem_key=_string(row[2], "batch.filesystem_key"),
        name=_string(row[3], "batch.name"),
        description=_optional_string(row[4], "batch.description"),
        revision=_positive_int(row[5], "batch.revision"),
        seed_mode=_seed_mode(row[6]),
        seed_values=_seed_array(row[7]),
        random_seed_count=_optional_positive_int(row[8], "batch.random_seed_count"),
        selected_workflow_version_id=_optional_string(row[9], "selected_workflow_version_id"),
        selected_workflow_profile_id=_optional_string(row[10], "selected_workflow_profile_id"),
        selected_workflow_profile_version_id=_optional_string(
            row[11], "selected_workflow_profile_version_id"
        ),
        created_at=_datetime(row[12], "batch.created_at"),
        updated_at=_datetime(row[13], "batch.updated_at"),
        archived_at=_optional_datetime(row[14], "batch.archived_at"),
    )


def _list_record(row: sqlite3.Row | tuple[object, ...]) -> SavedBatchListRecord:
    root = _root_record(row)
    return SavedBatchListRecord(
        id=root.id,
        project_id=root.project_id,
        filesystem_key=root.filesystem_key,
        name=root.name,
        description=root.description,
        revision=root.revision,
        seed_mode=root.seed_mode,
        seed_values=root.seed_values,
        random_seed_count=root.random_seed_count,
        selected_workflow_version_id=root.selected_workflow_version_id,
        selected_workflow_profile_id=root.selected_workflow_profile_id,
        selected_workflow_profile_version_id=root.selected_workflow_profile_version_id,
        created_at=root.created_at,
        updated_at=root.updated_at,
        archived_at=root.archived_at,
    )


def _binding_from_row(row: sqlite3.Row | tuple[object, ...]) -> SavedBatchVariableBinding:
    values = _string_array(row[1], "binding.values_json")
    if len(set(values)) != len(values):
        raise SavedBatchStoreError("binding.values_json must not contain exact duplicates")
    return SavedBatchVariableBinding(
        placeholder=_plain_string(row[0], "binding.placeholder"),
        values=values,
    )


def _image_bindings_from_rows(
    rows: list[sqlite3.Row] | list[tuple[object, ...]],
) -> tuple[SavedBatchImageBinding, ...]:
    bindings: list[SavedBatchImageBinding] = []
    current_position: int | None = None
    current_key = ""
    values: list[str | None] = []
    expected_binding_position = 1
    expected_value_position = 1
    for row in rows:
        position = _positive_int(row[0], "image binding position")
        if current_position is not None and position != current_position:
            bindings.append(SavedBatchImageBinding(current_key, tuple(values)))
            values = []
            expected_binding_position += 1
            expected_value_position = 1
        if position != current_position:
            if position != expected_binding_position:
                raise SavedBatchStoreError(
                    "image binding positions must be one-based and contiguous"
                )
            current_position = position
            current_key = _string(row[1], "image binding slot_key")
        if row[2] is not None:
            value_position = _positive_int(row[2], "image binding value position")
            if value_position != expected_value_position:
                raise SavedBatchStoreError(
                    "image binding value positions must be one-based and contiguous"
                )
            values.append(None if row[3] is None else _string(row[3], "image binding asset_id"))
            expected_value_position += 1
    if current_position is not None:
        bindings.append(SavedBatchImageBinding(current_key, tuple(values)))
    if any(not binding.values for binding in bindings):
        raise SavedBatchStoreError("image binding values must contain at least one effective value")
    if any(len(set(binding.values)) != len(binding.values) for binding in bindings):
        raise SavedBatchStoreError("image binding values must not contain exact duplicates")
    if any(None in binding.values and binding.values[0] is not None for binding in bindings):
        raise SavedBatchStoreError("image binding values must place Base workflow first")
    return tuple(bindings)


def _parameter_bindings_from_rows(
    rows: list[sqlite3.Row] | list[tuple[object, ...]],
) -> tuple[ParameterValuesIntent | ParameterRangeIntent, ...]:
    bindings: list[ParameterValuesIntent | ParameterRangeIntent] = []
    current_position: int | None = None
    current_key = ""
    current_mode = ""
    current_include_base = False
    current_range: ParameterDecimalRange | None = None
    values: list[str | int | float | bool | None] = []
    expected_binding_position = 1
    expected_value_position = 1
    for row in rows:
        position = _positive_int(row[0], "parameter binding position")
        if current_position is not None and position != current_position:
            bindings.append(
                _persisted_parameter_intent(
                    current_key, current_mode, current_include_base, current_range, values
                )
            )
            values = []
            expected_binding_position += 1
            expected_value_position = 1
        if position != current_position:
            if position != expected_binding_position:
                raise SavedBatchStoreError(
                    "parameter binding positions must be one-based and contiguous"
                )
            current_position = position
            current_key = _string(row[1], "parameter binding parameter_key")
            current_mode = _string(row[2], "parameter binding mode")
            current_include_base = _database_bool(row[3], "parameter binding include_base")
            range_parts = row[4:7]
            if all(value is None for value in range_parts):
                current_range = None
            elif all(isinstance(value, str) for value in range_parts):
                current_range = ParameterDecimalRange(*range_parts)
            else:
                raise SavedBatchStoreError(
                    "persisted parameter range must be complete decimal text"
                )
        if row[7] is not None:
            value_position = _positive_int(row[7], "parameter binding value position")
            if value_position != expected_value_position:
                raise SavedBatchStoreError(
                    "parameter binding value positions must be one-based and contiguous"
                )
            value = _json(row[8], "parameter binding value_json")
            try:
                scalar = None if value is None else validate_parameter_scalar(value)
            except ValueError as error:
                raise SavedBatchStoreError(f"invalid persisted parameter value: {error}") from error
            values.append(scalar)
            expected_value_position += 1
    if current_position is not None:
        bindings.append(
            _persisted_parameter_intent(
                current_key, current_mode, current_include_base, current_range, values
            )
        )
    for binding in bindings:
        if isinstance(binding, ParameterValuesIntent):
            try:
                validate_parameter_alternatives(binding.values)
            except ValueError as error:
                raise SavedBatchStoreError(
                    f"invalid persisted parameter values: {error}"
                ) from error
    return tuple(bindings)


def _linked_parameter_sets_from_rows(
    rows: list[sqlite3.Row] | list[tuple[object, ...]],
) -> tuple[SavedBatchLinkedParameterSet, ...]:
    sets: list[SavedBatchLinkedParameterSet] = []
    set_positions = sorted({_positive_int(row[0], "linked set position") for row in rows})
    if set_positions != list(range(1, len(set_positions) + 1)):
        raise SavedBatchStoreError(
            "linked parameter set positions must be one-based and contiguous"
        )
    for set_position in set_positions:
        set_rows = [row for row in rows if row[0] == set_position]
        set_key = _string(set_rows[0][1], "linked set key")
        set_label = _string(set_rows[0][2], "linked set label")
        member_positions = sorted(
            {_positive_int(row[3], "linked set member position") for row in set_rows}
        )
        row_positions = sorted(
            {_positive_int(row[5], "linked set row position") for row in set_rows}
        )
        if (
            member_positions != list(range(1, len(member_positions) + 1))
            or len(member_positions) < 2
        ):
            raise SavedBatchStoreError(
                "linked parameter set member positions must be contiguous with at least two members"
            )
        if row_positions != list(range(1, len(row_positions) + 1)) or not row_positions:
            raise SavedBatchStoreError(
                "linked parameter set row positions must be one-based and contiguous"
            )
        member_keys = tuple(
            _string(
                next(row[4] for row in set_rows if row[3] == member_position),
                "linked set parameter key",
            )
            for member_position in member_positions
        )
        linked_rows: list[SavedBatchLinkedParameterRow] = []
        for row_position in row_positions:
            value_rows = [row for row in set_rows if row[5] == row_position]
            if len(value_rows) != len(member_positions):
                raise SavedBatchStoreError("linked parameter row must define every member")
            value_rows.sort(key=lambda row: cast(int, row[3]))
            values: list[str | int | float | bool | None] = []
            for value_row in value_rows:
                value = _json(value_row[7], "linked parameter value_json")
                try:
                    values.append(None if value is None else validate_parameter_scalar(value))
                except ValueError as error:
                    raise SavedBatchStoreError(
                        f"invalid persisted linked parameter value: {error}"
                    ) from error
            linked_rows.append(
                SavedBatchLinkedParameterRow(
                    tuple(values),
                    _optional_string(value_rows[0][6], "linked parameter row label"),
                )
            )
        sets.append(
            SavedBatchLinkedParameterSet(set_key, set_label, member_keys, tuple(linked_rows))
        )
    return tuple(sets)


def _validate_persisted_parameter_bindings(
    profile: SavedBatchWorkflowProfileVersionSnapshot | None,
    bindings: tuple[ParameterValuesIntent | ParameterRangeIntent, ...],
    linked_sets: tuple[SavedBatchLinkedParameterSet, ...],
) -> None:
    if profile is None:
        if bindings or linked_sets:
            raise SavedBatchStoreError(
                "persisted parameter bindings require a selected Workflow Profile version"
            )
        return
    raw_parameters = profile.profile.get("parameters")
    if not isinstance(raw_parameters, list):
        raise SavedBatchStoreError("selected Workflow Profile version has invalid parameters")
    try:
        parameters = tuple(
            _workflow_parameter(value, index) for index, value in enumerate(raw_parameters, 1)
        )
        materialized = materialize_parameter_bindings(parameters, bindings)
        compile_batch(
            BatchDefinition(
                prompt_versions=(PromptVersion("saved-batch-load", "Load", ""),),
                variable_bindings=(),
                image_input_slots=(),
                image_bindings=(),
                parameters=parameters,
                parameter_bindings=materialized,
                linked_parameter_sets=tuple(
                    LinkedParameterSet(
                        item.set_key,
                        item.set_label,
                        item.member_keys,
                        tuple(LinkedParameterRow(row.values, row.label) for row in item.rows),
                    )
                    for item in linked_sets
                ),
                seeds=SeedInput.fixed(0),
            )
        )
    except ValueError as error:
        raise SavedBatchStoreError(f"invalid persisted parameter intent: {error}") from error


def _normalize_parameter_bindings(definition: SavedBatchDefinition) -> SavedBatchDefinition:
    if not isinstance(definition, SavedBatchDefinition):
        return definition
    profile = definition.selected_workflow_profile_version
    if profile is None:
        return definition
    raw = profile.profile.get("parameters")
    if not isinstance(raw, list):
        return definition
    keys = tuple(_profile_parameter_key(value, index) for index, value in enumerate(raw, 1))
    by_key = {binding.parameter_key: binding for binding in definition.parameter_bindings}
    linked_keys = {
        member
        for linked_set in definition.linked_parameter_sets
        for member in linked_set.member_keys
    }
    independent_keys = tuple(key for key in keys if key not in linked_keys)
    if len(by_key) != len(definition.parameter_bindings) or set(by_key) != set(independent_keys):
        return definition
    return replace(definition, parameter_bindings=tuple(by_key[key] for key in independent_keys))


def _persisted_parameter_intent(
    key: str,
    mode: str,
    include_base: bool,
    decimal_range: ParameterDecimalRange | None,
    values: list[str | int | float | bool | None],
) -> ParameterValuesIntent | ParameterRangeIntent:
    if mode == "values":
        if include_base or decimal_range is not None:
            raise SavedBatchStoreError("persisted values parameter intent has range fields")
        return ParameterValuesIntent(key, tuple(values))
    if mode == "range":
        if decimal_range is None or values:
            raise SavedBatchStoreError("persisted range parameter intent has invalid value rows")
        return ParameterRangeIntent(key, include_base, decimal_range)
    raise SavedBatchStoreError(f"persisted parameter intent has unsupported mode: {mode!r}")


def _workflow_parameter(value: object, position: int) -> WorkflowParameter:
    key = _profile_parameter_key(value, position)
    assert isinstance(value, dict)
    raw_value_type = value.get("value_type")
    if not isinstance(raw_value_type, str):
        raise SavedBatchStoreError(f"selected Workflow Profile parameter {key!r} has invalid type")
    try:
        value_type = ParameterValueType(raw_value_type)
    except ValueError as error:
        raise SavedBatchStoreError(
            f"selected Workflow Profile parameter {key!r} has invalid type"
        ) from error
    label = _string(value.get("label"), f"Workflow Profile parameter {key!r} label")
    node_id = _string(value.get("node_id"), f"Workflow Profile parameter {key!r} node_id")
    input_name = _string(value.get("input_name"), f"Workflow Profile parameter {key!r} input_name")
    return WorkflowParameter(key, label, node_id, input_name, value_type)


def _database_bool(value: object, label: str) -> bool:
    if value not in (0, 1) or isinstance(value, bool):
        raise SavedBatchStoreError(f"{label} must be zero or one")
    return bool(value)


def _canonical_scalar(value: object) -> str:
    return canonical_json_bytes(value).decode("ascii")


def _translate_integrity_error(
    connection: sqlite3.Connection,
    project_id: str,
    batch_id: str,
    filesystem_key: str,
    error: sqlite3.IntegrityError,
) -> SavedBatchStoreError:
    if _batch_exists(connection, batch_id):
        return SavedBatchConflictError(f"Saved Batch ID already exists: {batch_id}")
    if connection.execute(
        "SELECT 1 FROM batch WHERE project_id = ? AND filesystem_key = ?",
        (project_id, filesystem_key),
    ).fetchone():
        return SavedBatchConflictError(
            f"Saved Batch filesystem key already exists: {filesystem_key}"
        )
    return SavedBatchIntegrityError(f"Saved Batch violates database integrity: {error}")


def _require_project(connection: sqlite3.Connection, project_id: str) -> None:
    if connection.execute("SELECT 1 FROM project WHERE id = ?", (project_id,)).fetchone() is None:
        raise SavedBatchIntegrityError(f"Project not found: {project_id}")


def _batch_exists(connection: sqlite3.Connection, batch_id: str) -> bool:
    return (
        connection.execute("SELECT 1 FROM batch WHERE id = ?", (batch_id,)).fetchone() is not None
    )


def _nonblank(value: object, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise SavedBatchValidationError(f"{label} must be a nonempty string")


def _timestamp(clock: Callable[[], datetime]) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise SavedBatchValidationError("clock must return an aware datetime")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _canonical_array(values: tuple[object, ...]) -> str:
    return canonical_json_bytes(values).decode("ascii")


def _json(value: object, label: str) -> object:
    if not isinstance(value, str):
        raise SavedBatchStoreError(f"{label} must be JSON text")
    try:
        parsed: object = json.loads(value)
    except json.JSONDecodeError as error:
        raise SavedBatchStoreError(f"{label} is invalid JSON") from error
    if canonical_json_bytes(parsed).decode("ascii") != value:
        raise SavedBatchStoreError(f"{label} is not canonical JSON")
    return parsed


def _json_object(value: object, label: str) -> dict[str, object]:
    parsed = _json(value, label)
    if not isinstance(parsed, dict) or not all(isinstance(key, str) for key in parsed):
        raise SavedBatchStoreError(f"{label} must contain an object")
    return cast(dict[str, object], parsed)


def _string_array(value: object, label: str) -> tuple[str, ...]:
    parsed = _json(value, label)
    if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
        raise SavedBatchStoreError(f"{label} must contain a string array")
    return tuple(cast(list[str], parsed))


def _seed_array(value: object) -> tuple[int, ...]:
    parsed = _json(value, "batch.seed_values_json")
    if not isinstance(parsed, list) or any(
        not isinstance(item, int) or isinstance(item, bool) or item < 0 or item > MAX_SAFE_SEED
        for item in parsed
    ):
        raise SavedBatchStoreError("batch.seed_values_json must contain valid seed integers")
    return tuple(cast(list[int], parsed))


def _seed_mode(value: object) -> SavedBatchSeedMode:
    try:
        return SavedBatchSeedMode(_string(value, "batch.seed_mode"))
    except ValueError as error:
        raise SavedBatchStoreError("batch.seed_mode is unsupported") from error


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise SavedBatchStoreError(f"{label} must be a nonempty string")
    return value


def _plain_string(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise SavedBatchStoreError(f"{label} must be a string")
    return value


def _optional_string(value: object, label: str) -> str | None:
    return None if value is None else _string(value, label)


def _positive_int(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise SavedBatchStoreError(f"{label} must be a positive integer")
    return value


def _optional_positive_int(value: object, label: str) -> int | None:
    return None if value is None else _positive_int(value, label)


def _datetime(value: object, label: str) -> datetime:
    if not isinstance(value, str):
        raise SavedBatchStoreError(f"{label} must be a timestamp string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise SavedBatchStoreError(f"{label} is not a valid timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise SavedBatchStoreError(f"{label} must include a UTC offset")
    return parsed.astimezone(UTC)


def _optional_datetime(value: object, label: str) -> datetime | None:
    return None if value is None else _datetime(value, label)
