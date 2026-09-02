import csv
import hashlib
import io
import json
import math
import os
import re
import shutil
import unicodedata
from collections.abc import Callable, Mapping
from dataclasses import replace
from datetime import UTC, datetime
from itertools import count
from pathlib import Path
from typing import cast
from uuid import uuid4

from pydantic import ValidationError

from batchcraft.comfyui import (
    WorkflowPreparationError,
    validate_workflow_profile,
    workflow_profile_image_inputs,
    workflow_profile_parameters,
)
from batchcraft.domain import (
    BatchDefinition,
    CompilationError,
    CompilationWarning,
    CompilationWarningCode,
    CompiledJob,
    CompiledRunPlan,
    ImageBinding,
    ImageInputSlot,
    LinkedParameterRow,
    LinkedParameterSet,
    ParameterDecimalRange,
    ParameterRangeIntent,
    ParameterValuesIntent,
    ParameterValueType,
    PromptVersion,
    ResolvedImageInput,
    ResolvedParameter,
    ResolvedParameterSet,
    ResolvedVariable,
    SeedInput,
    VariableBinding,
    WorkflowParameter,
    compile_batch,
    materialize_parameter_bindings,
    validate_image_input_slot_key,
    validate_parameter_scalar,
)
from batchcraft.files._io import (
    canonical_json_bytes,
    ensure_directory,
    fsync_directory,
    is_safe_filesystem_key,
    read_json_object,
    sha256_file,
    utc_timestamp,
    write_bytes,
    write_json,
)
from batchcraft.files.assets import AssetStoreError, ProjectAssetStore
from batchcraft.files.models import (
    AssetRecord,
    BatchIdentity,
    PersistedImageInput,
    PersistedJob,
    ProjectIdentity,
    PublishedRun,
)
from batchcraft.files.project_owners import ProjectOwnerError, ProjectOwnerStore
from batchcraft.files.snapshots import (
    BatchSnapshotV6,
    SnapshotLinkedParameterSet,
    SnapshotParameterRangeBinding,
    SnapshotParameterValuesBinding,
)

RUN_FORMAT_VERSION = 2
MANIFEST_FORMAT_VERSION = 9
OWNER_FORMAT_VERSION = 1
RUN_NAME_MAX_LENGTH = 200
RUN_DESCRIPTION_MAX_LENGTH = 4000
RUN_SLUG_MAX_LENGTH = 80
_ID_CHARACTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
_RUN_FILESYSTEM_KEY = re.compile(r"[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*")
_RUN_SLUG_SEPARATOR = re.compile(r"[^a-z0-9]+")
_CSV_COLUMNS = (
    "job_ordinal",
    "job_id",
    "prompt_version_id",
    "prompt_version_name",
    "prompt_template",
    "resolved_prompt",
    "resolved_variables_json",
    "resolved_image_inputs_json",
    "resolved_parameters_json",
    "resolved_parameter_sets_json",
    "seed",
    "workflow_sha256",
    "workflow_profile_sha256",
)


class RunStoreError(ValueError):
    """A Run cannot be safely created or loaded from the filesystem."""


class RunFilesystemStore:
    def __init__(
        self,
        projects_path: Path,
        *,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.projects_path = projects_path
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._clock = clock or (lambda: datetime.now(UTC))

    def create_run(
        self,
        *,
        project: ProjectIdentity,
        batch: BatchIdentity,
        batch_snapshot: Mapping[str, object],
        plan: CompiledRunPlan,
        image_assets: Mapping[str, AssetRecord],
        workflow: Mapping[str, object],
        workflow_profile: Mapping[str, object],
        name: str | None = None,
        description: str | None = None,
    ) -> PublishedRun:
        self._validate_owner(project.id, project.filesystem_key, project.name, "Project")
        self._validate_owner(batch.id, batch.filesystem_key, batch.name, "Batch")
        self._validate_plan(plan)
        batch_snapshot_object = _parse_batch_snapshot(
            _canonical_json_object(batch_snapshot, "batch_snapshot")
        )
        project_path = self.projects_path / project.filesystem_key
        batch_path = project_path / "batches" / batch.filesystem_key
        try:
            ProjectOwnerStore(self.projects_path).publish(project)
        except ProjectOwnerError as error:
            raise RunStoreError(str(error)) from error
        ensure_directory(batch_path)
        self._ensure_owner_file(
            batch_path / "batch.json",
            "batch",
            batch.id,
            batch.filesystem_key,
            batch.name,
        )

        asset_store = ProjectAssetStore(project_path)
        assets_by_id = self._validate_image_assets(plan, image_assets, asset_store)
        run_name = _normalize_run_text(name, "Run name", RUN_NAME_MAX_LENGTH)
        run_description = _normalize_run_text(
            description, "Run description", RUN_DESCRIPTION_MAX_LENGTH
        )
        run_slug = slugify_run_name(run_name)
        run_id = self._new_id("Run")
        created_at = self._timestamp()
        run_number, reservation_path, final_path = self._reserve_run_number(batch_path, run_slug)
        filesystem_key = final_path.name
        staging_root = batch_path / ".staging"
        staging_path = staging_root / run_id
        staging_created = False

        try:
            ensure_directory(staging_root)
            staging_path.mkdir()
            staging_created = True
            fsync_directory(staging_root)
            outputs_path = staging_path / "outputs"
            ensure_directory(outputs_path)

            workflow_object = dict(workflow)
            workflow_profile_object = dict(workflow_profile)
            _validate_batch_snapshot_consistency(
                batch_snapshot_object,
                project=project,
                batch=batch,
                plan=plan,
                workflow=workflow_object,
                workflow_profile=workflow_profile_object,
            )
            workflow_bytes = canonical_json_bytes(workflow_object)
            workflow_profile_bytes = canonical_json_bytes(workflow_profile_object)
            workflow_sha256 = hashlib.sha256(workflow_bytes).hexdigest()
            workflow_profile_sha256 = hashlib.sha256(workflow_profile_bytes).hexdigest()
            write_bytes(staging_path / "workflow.json", workflow_bytes)
            write_bytes(staging_path / "workflow-profile.json", workflow_profile_bytes)

            persisted_jobs = tuple(
                PersistedJob(
                    job_id=self._new_id("Job"),
                    compiled_job=job,
                    image_inputs=tuple(
                        PersistedImageInput(
                            slot_key=item.slot_key,
                            slot_label=next(
                                slot.label
                                for slot in plan.image_input_slots
                                if slot.key == item.slot_key
                            ),
                            asset=(None if item.asset_id is None else assets_by_id[item.asset_id]),
                        )
                        for item in job.resolved_image_inputs
                    ),
                )
                for job in plan.jobs
            )
            run_metadata = _run_metadata(
                run_id=run_id,
                run_number=run_number,
                name=run_name,
                description=run_description,
                filesystem_key=filesystem_key,
                created_at=created_at,
                project=project,
                batch=batch,
                job_count=plan.job_count,
                workflow_sha256=workflow_sha256,
                workflow_profile_sha256=workflow_profile_sha256,
            )
            manifest = _manifest(
                run_metadata=run_metadata,
                batch_snapshot=batch_snapshot_object,
                plan=plan,
                jobs=persisted_jobs,
                workflow_sha256=workflow_sha256,
                workflow_profile_sha256=workflow_profile_sha256,
            )
            write_json(staging_path / "run.json", run_metadata)
            write_json(staging_path / "manifest.json", manifest)
            write_bytes(
                staging_path / "manifest.csv",
                _manifest_csv_bytes(
                    plan=plan,
                    jobs=persisted_jobs,
                    workflow_sha256=workflow_sha256,
                    workflow_profile_sha256=workflow_profile_sha256,
                ),
            )
            fsync_directory(outputs_path)
            fsync_directory(staging_path)

            staged_run = self._load_run(staging_path, project_path, validate_csv=True)
            if staged_run.compiled_plan != plan:
                raise RunStoreError("staged manifest does not reconstruct the compiled plan")
            if staged_run.batch_snapshot != batch_snapshot_object:
                raise RunStoreError("staged manifest does not match the supplied Batch snapshot")
            if staged_run.workflow != workflow_object:
                raise RunStoreError("staged workflow snapshot does not match the input workflow")
            if staged_run.workflow_profile != workflow_profile_object:
                raise RunStoreError(
                    "staged Workflow Profile snapshot does not match the input mapping"
                )

            try:
                self._publish(staging_path, final_path)
            except OSError:
                if staging_path.exists() or not final_path.is_dir():
                    raise
            return replace(staged_run, path=final_path)
        except (OSError, ValueError) as error:
            if isinstance(error, RunStoreError):
                raise
            raise RunStoreError(f"failed to create Run {run_id}: {error}") from error
        finally:
            if staging_created and staging_path.exists():
                shutil.rmtree(staging_path)
            if reservation_path.exists():
                reservation_path.rmdir()

    def load_run(self, run_path: Path) -> PublishedRun:
        try:
            project_path = run_path.parents[2]
        except IndexError as error:
            raise RunStoreError(
                f"Run path is not inside a Project Batch path: {run_path}"
            ) from error
        published_run = self._load_run(run_path, project_path, validate_csv=False)
        if run_path.name != published_run.filesystem_key:
            raise RunStoreError(
                f"Run directory name {run_path.name!r} does not match its recorded filesystem key"
            )
        if run_path.parent.name != published_run.batch.filesystem_key:
            raise RunStoreError("Run directory is not under its recorded Batch filesystem key")
        if project_path.name != published_run.project.filesystem_key:
            raise RunStoreError("Run directory is not under its recorded Project filesystem key")
        return published_run

    def read_run_id(self, run_path: Path) -> str:
        metadata_path = run_path / "run.json"
        if metadata_path.is_symlink() or not metadata_path.is_file():
            raise RunStoreError(f"Run identity metadata is missing or unsafe: {run_path}")
        try:
            run_data = read_json_object(metadata_path)
            if _integer(run_data, "format_version") != RUN_FORMAT_VERSION:
                raise RunStoreError("unsupported run.json format version")
            return _required_string(run_data, "run_id")
        except (OSError, ValueError) as error:
            if isinstance(error, RunStoreError):
                raise
            raise RunStoreError(f"invalid Run identity metadata in {run_path}: {error}") from error

    def _load_run(self, run_path: Path, project_path: Path, *, validate_csv: bool) -> PublishedRun:
        required_files = (
            "run.json",
            "manifest.json",
            "manifest.csv",
            "workflow.json",
            "workflow-profile.json",
        )
        missing = tuple(name for name in required_files if not (run_path / name).is_file())
        if missing:
            raise RunStoreError(f"Run is missing required files: {', '.join(missing)}")
        if not (run_path / "outputs").is_dir():
            raise RunStoreError("Run is missing its outputs directory")

        try:
            run_data = read_json_object(run_path / "run.json")
            manifest_data = read_json_object(run_path / "manifest.json")
            workflow = read_json_object(run_path / "workflow.json")
            workflow_profile = read_json_object(run_path / "workflow-profile.json")
            loaded = _parse_run(run_data, manifest_data, run_path)
        except ValueError as error:
            if isinstance(error, RunStoreError):
                raise
            raise RunStoreError(f"invalid Run artifacts in {run_path}: {error}") from error

        workflow_sha256 = sha256_file(run_path / "workflow.json")
        workflow_profile_sha256 = sha256_file(run_path / "workflow-profile.json")
        if workflow_sha256 != loaded.workflow_sha256:
            raise RunStoreError("workflow snapshot hash does not match Run provenance")
        if workflow_profile_sha256 != loaded.workflow_profile_sha256:
            raise RunStoreError("Workflow Profile snapshot hash does not match Run provenance")
        try:
            validate_workflow_profile(workflow, workflow_profile)
        except WorkflowPreparationError as error:
            raise RunStoreError(f"frozen workflow/Profile pair is invalid: {error}") from error
        _validate_batch_snapshot_consistency(
            loaded.batch_snapshot,
            project=loaded.project,
            batch=loaded.batch,
            plan=loaded.compiled_plan,
            workflow=workflow,
            workflow_profile=workflow_profile,
        )

        asset_store = ProjectAssetStore(project_path)
        validated_assets: dict[str, AssetRecord] = {}
        for job in loaded.jobs:
            for image_input in job.image_inputs:
                asset = image_input.asset
                if asset is None:
                    continue
                validated = validated_assets.get(asset.asset_id)
                if validated is not None:
                    if validated != asset:
                        raise RunStoreError(
                            f"Jobs reference inconsistent metadata for asset ID {asset.asset_id!r}"
                        )
                    continue
                try:
                    validated_assets[asset.asset_id] = asset_store.validate_record(asset)
                except AssetStoreError as error:
                    raise RunStoreError(
                        f"Job {job.compiled_job.ordinal} references an invalid Project asset: {error}"
                    ) from error

        if validate_csv:
            expected_csv = _manifest_csv_bytes(
                plan=loaded.compiled_plan,
                jobs=loaded.jobs,
                workflow_sha256=workflow_sha256,
                workflow_profile_sha256=workflow_profile_sha256,
            )
            if (run_path / "manifest.csv").read_bytes() != expected_csv:
                raise RunStoreError("staged manifest.csv does not match the canonical manifest")

        return PublishedRun(
            run_id=loaded.run_id,
            run_number=loaded.run_number,
            name=loaded.name,
            description=loaded.description,
            filesystem_key=loaded.filesystem_key,
            created_at=loaded.created_at,
            path=run_path,
            project=loaded.project,
            batch=loaded.batch,
            batch_snapshot=loaded.batch_snapshot,
            compiled_plan=loaded.compiled_plan,
            jobs=loaded.jobs,
            workflow=workflow,
            workflow_profile=workflow_profile,
            workflow_sha256=workflow_sha256,
            workflow_profile_sha256=workflow_profile_sha256,
        )

    def _validate_image_assets(
        self,
        plan: CompiledRunPlan,
        image_assets: Mapping[str, AssetRecord],
        asset_store: ProjectAssetStore,
    ) -> dict[str, AssetRecord]:
        assets_by_id: dict[str, AssetRecord] = {}
        for job in plan.jobs:
            for image_input in job.resolved_image_inputs:
                asset_id = image_input.asset_id
                if asset_id is None:
                    continue
                if asset_id in assets_by_id:
                    continue
                record = image_assets.get(asset_id)
                if record is None:
                    raise RunStoreError(f"compiled plan references unknown asset ID: {asset_id!r}")
                if record.asset_id != asset_id:
                    raise RunStoreError(
                        f"image asset mapping key {asset_id!r} does not match record ID "
                        f"{record.asset_id!r}"
                    )
                try:
                    assets_by_id[asset_id] = asset_store.validate_record(record)
                except AssetStoreError as error:
                    raise RunStoreError(f"invalid image asset {asset_id!r}: {error}") from error
        return assets_by_id

    def _reserve_run_number(self, batch_path: Path, slug: str) -> tuple[int, Path, Path]:
        allocations_path = batch_path / ".allocations"
        ensure_directory(allocations_path)
        for run_number in count(1):
            prefix = f"{run_number:03d}"
            final_path = batch_path / f"{prefix}-{slug}"
            reservation_path = allocations_path / prefix
            if _run_number_is_published(batch_path, prefix):
                continue
            try:
                reservation_path.mkdir()
                fsync_directory(allocations_path)
            except FileExistsError:
                continue
            if _run_number_is_published(batch_path, prefix):
                reservation_path.rmdir()
                continue
            return run_number, reservation_path, final_path
        raise AssertionError("unreachable")

    def _ensure_owner_file(
        self,
        path: Path,
        kind: str,
        owner_id: str,
        filesystem_key: str,
        name: str,
    ) -> None:
        payload = {
            "format_version": OWNER_FORMAT_VERSION,
            f"{kind}_id": owner_id,
            "filesystem_key": filesystem_key,
            "name": name,
        }
        temporary_path = path.parent / f".{path.name}.{uuid4()}.tmp"
        try:
            write_json(temporary_path, payload)
            try:
                os.link(temporary_path, path)
                fsync_directory(path.parent)
            except FileExistsError:
                pass
        finally:
            temporary_path.unlink(missing_ok=True)

        try:
            existing = read_json_object(path)
        except ValueError as error:
            raise RunStoreError(f"invalid {kind} identity file {path}: {error}") from error
        if _integer(existing, "format_version") != OWNER_FORMAT_VERSION:
            raise RunStoreError(f"unsupported {kind} identity format in {path}")
        if existing.get(f"{kind}_id") != owner_id:
            raise RunStoreError(
                f"{kind.capitalize()} filesystem key {filesystem_key!r} belongs to another ID"
            )
        if existing.get("filesystem_key") != filesystem_key:
            raise RunStoreError(f"{kind.capitalize()} identity file has a mismatched key")

    def _validate_owner(self, owner_id: str, key: str, name: str, kind: str) -> None:
        if not owner_id:
            raise RunStoreError(f"{kind} ID must not be empty")
        if not name:
            raise RunStoreError(f"{kind} display name must not be empty")
        if not is_safe_filesystem_key(key):
            raise RunStoreError(f"{kind} filesystem key is not path-safe: {key!r}")

    def _validate_plan(self, plan: CompiledRunPlan) -> None:
        if not plan.prompt_versions:
            raise RunStoreError("compiled plan must contain at least one PromptVersion")
        prompt_ids: set[str] = set()
        for prompt_version in plan.prompt_versions:
            if not prompt_version.id:
                raise RunStoreError("compiled plan PromptVersion ID must not be empty")
            if not prompt_version.name:
                raise RunStoreError(
                    f"compiled plan PromptVersion {prompt_version.id!r} name must not be empty"
                )
            if prompt_version.id in prompt_ids:
                raise RunStoreError(
                    f"compiled plan contains duplicate PromptVersion ID: {prompt_version.id!r}"
                )
            prompt_ids.add(prompt_version.id)
        slot_keys: set[str] = set()
        for slot in plan.image_input_slots:
            try:
                validate_image_input_slot_key(slot.key)
            except ValueError as error:
                raise RunStoreError(str(error)) from error
            if slot.key in slot_keys:
                raise RunStoreError(f"compiled plan contains duplicate image slot: {slot.key!r}")
            if not slot.label.strip() or not slot.node_id or not slot.input_name:
                raise RunStoreError(
                    f"compiled plan image slot {slot.key!r} has incomplete metadata"
                )
            slot_keys.add(slot.key)
        parameter_keys: set[str] = set()
        for parameter in plan.parameters:
            if parameter.key in parameter_keys:
                raise RunStoreError(
                    f"compiled plan contains duplicate parameter: {parameter.key!r}"
                )
            if not parameter.label.strip() or not parameter.node_id or not parameter.input_name:
                raise RunStoreError(
                    f"compiled plan parameter {parameter.key!r} has incomplete metadata"
                )
            parameter_keys.add(parameter.key)
        expected_ordinals = tuple(range(1, plan.job_count + 1))
        if tuple(job.ordinal for job in plan.jobs) != expected_ordinals:
            raise RunStoreError("compiled Job ordinals must be one-based and contiguous")
        for job in plan.jobs:
            if job.prompt_version_id not in prompt_ids:
                raise RunStoreError(
                    f"compiled Job {job.ordinal} references unknown PromptVersion ID: "
                    f"{job.prompt_version_id!r}"
                )
            if "{{" in job.resolved_prompt or "}}" in job.resolved_prompt:
                raise RunStoreError(
                    f"compiled Job {job.ordinal} contains an unresolved prompt placeholder"
                )
            variable_names = tuple(variable.name for variable in job.resolved_variables)
            if len(set(variable_names)) != len(variable_names):
                raise RunStoreError(
                    f"compiled Job {job.ordinal} contains duplicate resolved variables"
                )
            if tuple(item.slot_key for item in job.resolved_image_inputs) != tuple(
                slot.key for slot in plan.image_input_slots
            ):
                raise RunStoreError(
                    f"compiled Job {job.ordinal} image inputs do not match Profile slot order"
                )
            if any(
                item.asset_id is not None and not item.asset_id.strip()
                for item in job.resolved_image_inputs
            ):
                raise RunStoreError(f"compiled Job {job.ordinal} has a blank image asset ID")
            if tuple(item.parameter_key for item in job.resolved_parameters) != tuple(
                parameter.key for parameter in plan.parameters
            ):
                raise RunStoreError(
                    f"compiled Job {job.ordinal} parameters do not match Profile order"
                )
            set_keys = tuple(item.set_key for item in job.resolved_parameter_sets)
            if len(set(set_keys)) != len(set_keys):
                raise RunStoreError(
                    f"compiled Job {job.ordinal} contains duplicate resolved parameter sets"
                )

    def _new_id(self, kind: str) -> str:
        value = self._id_factory()
        if (
            not value
            or value in {".", ".."}
            or any(character not in _ID_CHARACTERS for character in value)
        ):
            raise RunStoreError(f"{kind} ID factory returned an unsafe value: {value!r}")
        return value

    def _timestamp(self) -> str:
        try:
            return utc_timestamp(self._clock)
        except ValueError as error:
            raise RunStoreError(str(error)) from error

    def _publish(self, staging_path: Path, final_path: Path) -> None:
        staging_path.rename(final_path)
        fsync_directory(final_path.parent)


def slugify_run_name(name: str | None) -> str:
    if name is None:
        return "run"
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = _RUN_SLUG_SEPARATOR.sub("-", ascii_name.lower()).strip("-")
    slug = slug[:RUN_SLUG_MAX_LENGTH].rstrip("-")
    return slug or "run"


def _normalize_run_text(value: str | None, label: str, max_length: int) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if len(normalized) > max_length:
        raise RunStoreError(f"{label} must contain at most {max_length} characters")
    return normalized


def _run_number_is_published(batch_path: Path, prefix: str) -> bool:
    return any(candidate.name.startswith(f"{prefix}-") for candidate in batch_path.iterdir())


def _validate_run_filesystem_key(filesystem_key: str, run_number: int) -> None:
    if (
        not _RUN_FILESYSTEM_KEY.fullmatch(filesystem_key)
        or not is_safe_filesystem_key(filesystem_key)
        or not filesystem_key.startswith(f"{run_number:03d}-")
    ):
        raise RunStoreError("Run filesystem key is invalid or does not match its Run number")


def _run_metadata(
    *,
    run_id: str,
    run_number: int,
    name: str | None,
    description: str | None,
    filesystem_key: str,
    created_at: str,
    project: ProjectIdentity,
    batch: BatchIdentity,
    job_count: int,
    workflow_sha256: str,
    workflow_profile_sha256: str,
) -> dict[str, object]:
    return {
        "format_version": RUN_FORMAT_VERSION,
        "run_id": run_id,
        "run_number": run_number,
        "name": name,
        "description": description,
        "filesystem_key": filesystem_key,
        "created_at": created_at,
        "status": "created",
        "project": _project_data(project),
        "batch": _batch_data(batch),
        "job_count": job_count,
        "workflow_sha256": workflow_sha256,
        "workflow_profile_sha256": workflow_profile_sha256,
    }


def _manifest(
    *,
    run_metadata: dict[str, object],
    batch_snapshot: dict[str, object],
    plan: CompiledRunPlan,
    jobs: tuple[PersistedJob, ...],
    workflow_sha256: str,
    workflow_profile_sha256: str,
) -> dict[str, object]:
    return {
        "format_version": MANIFEST_FORMAT_VERSION,
        "run": {
            "run_id": run_metadata["run_id"],
            "run_number": run_metadata["run_number"],
            "name": run_metadata["name"],
            "description": run_metadata["description"],
            "filesystem_key": run_metadata["filesystem_key"],
            "created_at": run_metadata["created_at"],
            "project": run_metadata["project"],
            "batch": run_metadata["batch"],
        },
        "batch_snapshot": batch_snapshot,
        "prompt_versions": [
            {
                "prompt_version_id": version.id,
                "prompt_version_name": version.name,
                "prompt_template": version.text,
            }
            for version in plan.prompt_versions
        ],
        "image_input_slots": [
            {
                "slot_key": slot.key,
                "slot_label": slot.label,
                "node_id": slot.node_id,
                "input_name": slot.input_name,
            }
            for slot in plan.image_input_slots
        ],
        "parameters": [
            {
                "parameter_key": parameter.key,
                "parameter_label": parameter.label,
                "node_id": parameter.node_id,
                "input_name": parameter.input_name,
                "value_type": parameter.value_type.value,
            }
            for parameter in plan.parameters
        ],
        "compiler_warnings": [
            {
                "code": warning.code.value,
                "message": warning.message,
                "placeholder": warning.placeholder,
            }
            for warning in plan.warnings
        ],
        "workflow_snapshot": {
            "path": "workflow.json",
            "sha256": workflow_sha256,
        },
        "workflow_profile_snapshot": {
            "path": "workflow-profile.json",
            "sha256": workflow_profile_sha256,
        },
        "jobs": [
            {
                "job_id": job.job_id,
                "ordinal": job.compiled_job.ordinal,
                "prompt_version_id": job.compiled_job.prompt_version_id,
                "resolved_prompt": job.compiled_job.resolved_prompt,
                "resolved_variables": [
                    {"name": variable.name, "value": variable.value}
                    for variable in job.compiled_job.resolved_variables
                ],
                "resolved_image_inputs": [
                    {
                        "slot_key": image_input.slot_key,
                        "slot_label": image_input.slot_label,
                        "asset": (
                            None if image_input.asset is None else _asset_data(image_input.asset)
                        ),
                    }
                    for image_input in job.image_inputs
                ],
                "resolved_parameters": [
                    {"parameter_key": item.parameter_key, "value": item.value}
                    for item in job.compiled_job.resolved_parameters
                ],
                "resolved_parameter_sets": [
                    {
                        "set_key": item.set_key,
                        "set_label": item.set_label,
                        "row_ordinal": item.row_ordinal,
                        "row_label": item.row_label,
                    }
                    for item in job.compiled_job.resolved_parameter_sets
                ],
                "seed": job.compiled_job.seed,
                "workflow_sha256": workflow_sha256,
                "workflow_profile_sha256": workflow_profile_sha256,
            }
            for job in jobs
        ],
    }


def _manifest_csv_bytes(
    *,
    plan: CompiledRunPlan,
    jobs: tuple[PersistedJob, ...],
    workflow_sha256: str,
    workflow_profile_sha256: str,
) -> bytes:
    prompt_versions = {version.id: version for version in plan.prompt_versions}
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=_CSV_COLUMNS, lineterminator="\n")
    writer.writeheader()
    for job in jobs:
        prompt_version = prompt_versions[job.compiled_job.prompt_version_id]
        writer.writerow(
            {
                "job_ordinal": job.compiled_job.ordinal,
                "job_id": job.job_id,
                "prompt_version_id": prompt_version.id,
                "prompt_version_name": prompt_version.name,
                "prompt_template": prompt_version.text,
                "resolved_prompt": job.compiled_job.resolved_prompt,
                "resolved_variables_json": canonical_json_bytes(
                    [
                        {"name": variable.name, "value": variable.value}
                        for variable in job.compiled_job.resolved_variables
                    ]
                )
                .decode()
                .rstrip("\n"),
                "resolved_image_inputs_json": canonical_json_bytes(
                    [
                        {
                            "slot_key": image_input.slot_key,
                            "slot_label": image_input.slot_label,
                            "asset": (
                                None
                                if image_input.asset is None
                                else _asset_data(image_input.asset)
                            ),
                        }
                        for image_input in job.image_inputs
                    ]
                )
                .decode()
                .rstrip("\n"),
                "resolved_parameters_json": canonical_json_bytes(
                    [
                        {"parameter_key": item.parameter_key, "value": item.value}
                        for item in job.compiled_job.resolved_parameters
                    ]
                )
                .decode()
                .rstrip("\n"),
                "resolved_parameter_sets_json": canonical_json_bytes(
                    [
                        {
                            "set_key": item.set_key,
                            "set_label": item.set_label,
                            "row_ordinal": item.row_ordinal,
                            "row_label": item.row_label,
                        }
                        for item in job.compiled_job.resolved_parameter_sets
                    ]
                )
                .decode()
                .rstrip("\n"),
                "seed": job.compiled_job.seed,
                "workflow_sha256": workflow_sha256,
                "workflow_profile_sha256": workflow_profile_sha256,
            }
        )
    return output.getvalue().encode()


def _parse_run(
    run_data: dict[str, object], manifest_data: dict[str, object], run_path: Path
) -> PublishedRun:
    if _integer(run_data, "format_version") != RUN_FORMAT_VERSION:
        raise RunStoreError("unsupported run.json format version")
    if _integer(manifest_data, "format_version") != MANIFEST_FORMAT_VERSION:
        raise RunStoreError("unsupported manifest.json format version")

    batch_snapshot = _parse_batch_snapshot(_required_object(manifest_data, "batch_snapshot"))

    run_id = _required_string(run_data, "run_id")
    run_number = _positive_integer(run_data, "run_number")
    name = _optional_string(run_data, "name")
    description = _optional_string(run_data, "description")
    if _normalize_run_text(name, "Run name", RUN_NAME_MAX_LENGTH) != name:
        raise RunStoreError("Run name is not normalized")
    if (
        _normalize_run_text(description, "Run description", RUN_DESCRIPTION_MAX_LENGTH)
        != description
    ):
        raise RunStoreError("Run description is not normalized")
    filesystem_key = _required_string(run_data, "filesystem_key")
    _validate_run_filesystem_key(filesystem_key, run_number)
    created_at = _required_string(run_data, "created_at")
    _required_string(run_data, "status")
    project = _parse_project(_required_object(run_data, "project"))
    batch = _parse_batch(_required_object(run_data, "batch"))
    workflow_sha256 = _required_string(run_data, "workflow_sha256")
    workflow_profile_sha256 = _required_string(run_data, "workflow_profile_sha256")

    manifest_run = _required_object(manifest_data, "run")
    if _required_string(manifest_run, "run_id") != run_id:
        raise RunStoreError("Run ID differs between run.json and manifest.json")
    if _positive_integer(manifest_run, "run_number") != run_number:
        raise RunStoreError("Run number differs between run.json and manifest.json")
    if _optional_string(manifest_run, "name") != name:
        raise RunStoreError("Run name differs between run.json and manifest.json")
    if _optional_string(manifest_run, "description") != description:
        raise RunStoreError("Run description differs between run.json and manifest.json")
    if _required_string(manifest_run, "filesystem_key") != filesystem_key:
        raise RunStoreError("Run filesystem key differs between run.json and manifest.json")
    if _required_string(manifest_run, "created_at") != created_at:
        raise RunStoreError("creation timestamp differs between run.json and manifest.json")
    if _parse_project(_required_object(manifest_run, "project")) != project:
        raise RunStoreError("Project identity differs between run.json and manifest.json")
    if _parse_batch(_required_object(manifest_run, "batch")) != batch:
        raise RunStoreError("Batch identity differs between run.json and manifest.json")

    workflow_snapshot = _required_object(manifest_data, "workflow_snapshot")
    if _required_string(workflow_snapshot, "path") != "workflow.json":
        raise RunStoreError("manifest has an unsupported workflow snapshot path")
    if _required_string(workflow_snapshot, "sha256") != workflow_sha256:
        raise RunStoreError("workflow hash differs between run.json and manifest.json")
    profile_snapshot = _required_object(manifest_data, "workflow_profile_snapshot")
    if _required_string(profile_snapshot, "path") != "workflow-profile.json":
        raise RunStoreError("manifest has an unsupported Workflow Profile snapshot path")
    if _required_string(profile_snapshot, "sha256") != workflow_profile_sha256:
        raise RunStoreError("Workflow Profile hash differs between run.json and manifest.json")

    prompt_versions = tuple(
        _parse_prompt_version(_object_item(value, "PromptVersion"))
        for value in _required_array(manifest_data, "prompt_versions")
    )
    if not prompt_versions:
        raise RunStoreError("manifest must contain at least one PromptVersion")
    prompt_ids = tuple(version.id for version in prompt_versions)
    if len(set(prompt_ids)) != len(prompt_ids):
        raise RunStoreError("manifest contains duplicate PromptVersion IDs")
    known_prompt_ids = {version.id for version in prompt_versions}
    image_input_slots = tuple(
        _parse_image_input_slot(_object_item(value, "image input slot"))
        for value in _required_array(manifest_data, "image_input_slots")
    )
    parameters = tuple(
        _parse_parameter(_object_item(value, "workflow parameter"))
        for value in _required_array(manifest_data, "parameters")
    )
    warnings = tuple(
        _parse_warning(_object_item(value, "compiler warning"))
        for value in _required_array(manifest_data, "compiler_warnings")
    )
    persisted_jobs = tuple(
        _parse_job(
            _object_item(value, "Job"),
            workflow_sha256,
            workflow_profile_sha256,
        )
        for value in _required_array(manifest_data, "jobs")
    )
    compiled_plan = CompiledRunPlan(
        prompt_versions=prompt_versions,
        image_input_slots=image_input_slots,
        parameters=parameters,
        jobs=tuple(job.compiled_job for job in persisted_jobs),
        warnings=warnings,
    )
    expected_image_inputs = tuple((slot.key, slot.label) for slot in image_input_slots)
    expected_parameters = tuple(parameter.key for parameter in parameters)
    for persisted_job in persisted_jobs:
        actual_image_inputs = tuple(
            (image_input.slot_key, image_input.slot_label)
            for image_input in persisted_job.image_inputs
        )
        if actual_image_inputs != expected_image_inputs:
            raise RunStoreError(
                f"Job {persisted_job.compiled_job.ordinal} image input keys or labels do not match the frozen Profile"
            )
        if (
            tuple(item.parameter_key for item in persisted_job.compiled_job.resolved_parameters)
            != expected_parameters
        ):
            raise RunStoreError(
                f"Job {persisted_job.compiled_job.ordinal} parameter keys do not match the frozen Profile"
            )
        for definition, resolved in zip(
            parameters,
            persisted_job.compiled_job.resolved_parameters,
            strict=True,
        ):
            if not _parameter_value_matches(definition.value_type, resolved.value):
                raise RunStoreError(
                    f"Job {persisted_job.compiled_job.ordinal} parameter "
                    f"{definition.key!r} does not match its frozen type"
                )
    if _non_negative_integer(run_data, "job_count") != compiled_plan.job_count:
        raise RunStoreError("job_count does not match manifest Jobs")
    expected_ordinals = tuple(range(1, compiled_plan.job_count + 1))
    if tuple(job.ordinal for job in compiled_plan.jobs) != expected_ordinals:
        raise RunStoreError("manifest Job ordinals are not one-based and contiguous")
    job_ids = tuple(job.job_id for job in persisted_jobs)
    if len(set(job_ids)) != len(job_ids):
        raise RunStoreError("manifest contains duplicate Job IDs")
    for job in compiled_plan.jobs:
        if job.prompt_version_id not in known_prompt_ids:
            raise RunStoreError(
                f"Job {job.ordinal} references unknown PromptVersion ID: {job.prompt_version_id!r}"
            )

    return PublishedRun(
        run_id=run_id,
        run_number=run_number,
        name=name,
        description=description,
        filesystem_key=filesystem_key,
        created_at=created_at,
        path=run_path,
        project=project,
        batch=batch,
        batch_snapshot=batch_snapshot,
        compiled_plan=compiled_plan,
        jobs=persisted_jobs,
        workflow={},
        workflow_profile={},
        workflow_sha256=workflow_sha256,
        workflow_profile_sha256=workflow_profile_sha256,
    )


def _parse_job(
    data: dict[str, object],
    workflow_sha256: str,
    workflow_profile_sha256: str,
) -> PersistedJob:
    if _required_string(data, "workflow_sha256") != workflow_sha256:
        raise RunStoreError("Job workflow hash differs from the Run workflow hash")
    if _required_string(data, "workflow_profile_sha256") != workflow_profile_sha256:
        raise RunStoreError("Job Workflow Profile hash differs from the Run mapping hash")
    variables = tuple(
        ResolvedVariable(
            name=_required_string(variable, "name"),
            value=_required_string(variable, "value", allow_empty=True),
        )
        for variable in (
            _object_item(value, "resolved variable")
            for value in _required_array(data, "resolved_variables")
        )
    )
    variable_names = tuple(variable.name for variable in variables)
    if len(set(variable_names)) != len(variable_names):
        raise RunStoreError("Job contains duplicate resolved variables")
    image_inputs = tuple(
        _parse_persisted_image_input(_object_item(value, "resolved image input"))
        for value in _required_array(data, "resolved_image_inputs")
    )
    resolved_parameters = tuple(
        _parse_resolved_parameter(_object_item(value, "resolved parameter"))
        for value in _required_array(data, "resolved_parameters")
    )
    resolved_parameter_sets = tuple(
        _parse_resolved_parameter_set(_object_item(value, "resolved parameter set"))
        for value in _required_array(data, "resolved_parameter_sets")
    )
    resolved_prompt = _required_string(data, "resolved_prompt", allow_empty=True)
    if "{{" in resolved_prompt or "}}" in resolved_prompt:
        raise RunStoreError("Job contains an unresolved prompt placeholder")
    compiled_job = CompiledJob(
        ordinal=_positive_integer(data, "ordinal"),
        prompt_version_id=_required_string(data, "prompt_version_id"),
        resolved_prompt=resolved_prompt,
        resolved_variables=variables,
        resolved_image_inputs=tuple(
            ResolvedImageInput(
                slot_key=image_input.slot_key,
                asset_id=(None if image_input.asset is None else image_input.asset.asset_id),
            )
            for image_input in image_inputs
        ),
        resolved_parameters=resolved_parameters,
        resolved_parameter_sets=resolved_parameter_sets,
        seed=_integer(data, "seed"),
    )
    return PersistedJob(
        job_id=_required_string(data, "job_id"),
        compiled_job=compiled_job,
        image_inputs=image_inputs,
    )


def _parse_image_input_slot(data: dict[str, object]) -> ImageInputSlot:
    return ImageInputSlot(
        key=_required_string(data, "slot_key"),
        label=_required_string(data, "slot_label"),
        node_id=_required_string(data, "node_id"),
        input_name=_required_string(data, "input_name"),
    )


def _parse_parameter(data: dict[str, object]) -> WorkflowParameter:
    try:
        value_type = ParameterValueType(_required_string(data, "value_type"))
    except ValueError as error:
        raise RunStoreError("workflow parameter has unsupported value_type") from error
    return WorkflowParameter(
        key=_required_string(data, "parameter_key"),
        label=_required_string(data, "parameter_label"),
        node_id=_required_string(data, "node_id"),
        input_name=_required_string(data, "input_name"),
        value_type=value_type,
    )


def _parse_resolved_parameter(data: dict[str, object]) -> ResolvedParameter:
    if "value" not in data:
        raise RunStoreError("resolved parameter must define value")
    value = data["value"]
    try:
        scalar = None if value is None else validate_parameter_scalar(value)
    except ValueError as error:
        raise RunStoreError(f"invalid resolved parameter value: {error}") from error
    return ResolvedParameter(
        parameter_key=_required_string(data, "parameter_key"),
        value=scalar,
    )


def _parse_resolved_parameter_set(data: dict[str, object]) -> ResolvedParameterSet:
    return ResolvedParameterSet(
        set_key=_required_string(data, "set_key"),
        set_label=_required_string(data, "set_label"),
        row_ordinal=_positive_integer(data, "row_ordinal"),
        row_label=_optional_string(data, "row_label"),
    )


def _parameter_value_matches(value_type: ParameterValueType, value: object) -> bool:
    if value is None:
        return True
    if value_type is ParameterValueType.STRING:
        return isinstance(value, str)
    if value_type is ParameterValueType.INTEGER:
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
            and -(2**53 - 1) <= value <= 2**53 - 1
        )
    if value_type is ParameterValueType.FLOAT:
        return (
            isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        )
    return isinstance(value, bool)


def _parse_persisted_image_input(data: dict[str, object]) -> PersistedImageInput:
    if "asset" not in data:
        raise RunStoreError("resolved image input must define asset")
    raw_asset = data["asset"]
    return PersistedImageInput(
        slot_key=_required_string(data, "slot_key"),
        slot_label=_required_string(data, "slot_label"),
        asset=None if raw_asset is None else _parse_asset(_object_item(raw_asset, "asset")),
    )


def _parse_prompt_version(data: dict[str, object]) -> PromptVersion:
    return PromptVersion(
        id=_required_string(data, "prompt_version_id"),
        name=_required_string(data, "prompt_version_name"),
        text=_required_string(data, "prompt_template", allow_empty=True),
    )


def _parse_warning(data: dict[str, object]) -> CompilationWarning:
    code_value = _required_string(data, "code")
    try:
        code = CompilationWarningCode(code_value)
    except ValueError as error:
        raise RunStoreError(f"unsupported compiler warning code: {code_value!r}") from error
    return CompilationWarning(
        code=code,
        message=_required_string(data, "message"),
        placeholder=_required_string(data, "placeholder"),
    )


def _parse_project(data: dict[str, object]) -> ProjectIdentity:
    return ProjectIdentity(
        id=_required_string(data, "project_id"),
        filesystem_key=_required_string(data, "filesystem_key"),
        name=_required_string(data, "name"),
    )


def _parse_batch(data: dict[str, object]) -> BatchIdentity:
    return BatchIdentity(
        id=_required_string(data, "batch_id"),
        filesystem_key=_required_string(data, "filesystem_key"),
        name=_required_string(data, "name"),
    )


def _parse_asset(data: dict[str, object]) -> AssetRecord:
    return AssetRecord(
        asset_id=_required_string(data, "asset_id"),
        sha256=_required_string(data, "sha256"),
        original_filename=_required_string(data, "original_filename"),
        mime_type=_optional_string(data, "mime_type"),
        byte_size=_non_negative_integer(data, "byte_size"),
        stored_path=_required_string(data, "stored_path"),
        created_at=_required_string(data, "created_at"),
    )


def _project_data(project: ProjectIdentity) -> dict[str, object]:
    return {
        "project_id": project.id,
        "filesystem_key": project.filesystem_key,
        "name": project.name,
    }


def _batch_data(batch: BatchIdentity) -> dict[str, object]:
    return {
        "batch_id": batch.id,
        "filesystem_key": batch.filesystem_key,
        "name": batch.name,
    }


def _asset_data(asset: AssetRecord) -> dict[str, object]:
    return {
        "asset_id": asset.asset_id,
        "sha256": asset.sha256,
        "original_filename": asset.original_filename,
        "mime_type": asset.mime_type,
        "byte_size": asset.byte_size,
        "stored_path": asset.stored_path,
        "created_at": asset.created_at,
    }


def _canonical_json_object(value: Mapping[str, object], name: str) -> dict[str, object]:
    try:
        loaded: object = json.loads(canonical_json_bytes(dict(value)))
    except (TypeError, ValueError) as error:
        raise RunStoreError(f"{name} must be a JSON object: {error}") from error
    return _object_item(loaded, name)


def _parse_batch_snapshot(snapshot: dict[str, object]) -> dict[str, object]:
    try:
        parsed = BatchSnapshotV6.model_validate(snapshot)
    except ValidationError as error:
        raise RunStoreError(f"invalid Batch snapshot v6: {error}") from error
    canonical = cast(dict[str, object], parsed.model_dump(mode="json"))
    if canonical != snapshot:
        raise RunStoreError("invalid Batch snapshot v6: snapshot must use its complete shape")
    return canonical


def _validate_batch_snapshot_consistency(
    snapshot: dict[str, object],
    *,
    project: ProjectIdentity,
    batch: BatchIdentity,
    plan: CompiledRunPlan,
    workflow: dict[str, object],
    workflow_profile: dict[str, object],
) -> None:
    parsed = BatchSnapshotV6.model_validate(snapshot)
    if (
        parsed.project.id,
        parsed.project.filesystem_key,
        parsed.project.name,
    ) != (project.id, project.filesystem_key, project.name):
        raise RunStoreError("Batch snapshot Project identity does not match the Run")
    if (
        parsed.batch.id,
        parsed.batch.filesystem_key,
        parsed.batch.name,
    ) != (batch.id, batch.filesystem_key, batch.name):
        raise RunStoreError("Batch snapshot identity does not match the Run")
    selection = parsed.workflow_selection
    if selection.workflow != workflow or selection.workflow_profile != workflow_profile:
        raise RunStoreError("Batch snapshot Workflow selection does not match the Run snapshots")

    seed_intent = parsed.seed_intent
    if seed_intent.mode == "random":
        random_count = seed_intent.random_seed_count
        if random_count is None or len(plan.jobs) < random_count:
            raise RunStoreError(
                "Batch snapshot Random seed intent does not match the compiled plan"
            )
        seeds = SeedInput.explicit(tuple(job.seed for job in plan.jobs[:random_count]))
    elif seed_intent.mode == "fixed":
        seeds = SeedInput.fixed(seed_intent.values[0])
    else:
        seeds = SeedInput.explicit(tuple(seed_intent.values))

    try:
        snapshot_plan = compile_batch(
            BatchDefinition(
                prompt_versions=tuple(
                    PromptVersion(id=item.id, name=item.name, text=item.text)
                    for item in parsed.prompt_versions
                ),
                variable_bindings=tuple(
                    VariableBinding(placeholder=item.placeholder, values=tuple(item.values))
                    for item in parsed.variable_bindings
                ),
                image_input_slots=tuple(
                    ImageInputSlot(key=key, label=label, node_id=node_id, input_name=input_name)
                    for key, label, node_id, input_name in _profile_image_inputs(workflow_profile)
                ),
                image_bindings=tuple(
                    ImageBinding(slot_key=item.slot_key, values=tuple(item.values))
                    for item in parsed.image_bindings
                ),
                parameters=_profile_parameters(workflow_profile),
                parameter_bindings=materialize_parameter_bindings(
                    _profile_parameters(workflow_profile),
                    tuple(_snapshot_parameter_intent(item) for item in parsed.parameter_bindings),
                ),
                linked_parameter_sets=tuple(
                    _snapshot_linked_parameter_set(item) for item in parsed.linked_parameter_sets
                ),
                seeds=seeds,
            ),
            max_jobs=plan.job_count,
        )
    except (CompilationError, ValueError) as error:
        raise RunStoreError(f"Batch snapshot does not compile: {error}") from error
    if not _compiled_plans_match_exactly(snapshot_plan, plan):
        raise RunStoreError("Batch snapshot does not reconstruct the compiled Run plan")


def _compiled_plans_match_exactly(left: CompiledRunPlan, right: CompiledRunPlan) -> bool:
    if left != right:
        return False
    left_values = tuple(
        tuple(canonical_json_bytes(parameter.value) for parameter in job.resolved_parameters)
        for job in left.jobs
    )
    right_values = tuple(
        tuple(canonical_json_bytes(parameter.value) for parameter in job.resolved_parameters)
        for job in right.jobs
    )
    return left_values == right_values


def _snapshot_linked_parameter_set(item: SnapshotLinkedParameterSet) -> LinkedParameterSet:
    return LinkedParameterSet(
        key=item.set_key,
        label=item.set_label,
        member_keys=tuple(item.members),
        rows=tuple(
            LinkedParameterRow(
                values=tuple(row.values[key] for key in item.members),
                label=row.row_label,
            )
            for row in item.rows
        ),
    )


def _profile_image_inputs(
    profile: dict[str, object],
) -> tuple[tuple[str, str, str, str], ...]:
    try:
        return workflow_profile_image_inputs(profile)
    except WorkflowPreparationError as error:
        raise RunStoreError(f"invalid Workflow Profile image inputs: {error}") from error


def _profile_parameters(profile: dict[str, object]) -> tuple[WorkflowParameter, ...]:
    try:
        return workflow_profile_parameters(profile)
    except WorkflowPreparationError as error:
        raise RunStoreError(f"invalid Workflow Profile parameters: {error}") from error


def _snapshot_parameter_intent(
    binding: SnapshotParameterValuesBinding | SnapshotParameterRangeBinding,
) -> ParameterValuesIntent | ParameterRangeIntent:
    if isinstance(binding, SnapshotParameterValuesBinding):
        return ParameterValuesIntent(binding.parameter_key, tuple(binding.values))
    return ParameterRangeIntent(
        binding.parameter_key,
        binding.include_base,
        ParameterDecimalRange(binding.range.start, binding.range.end, binding.range.step),
    )


def _required_object(data: dict[str, object], name: str) -> dict[str, object]:
    return _object_item(data.get(name), name)


def _object_item(value: object, name: str) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise RunStoreError(f"{name} must be a JSON object")
    return cast(dict[str, object], value)


def _required_array(data: dict[str, object], name: str) -> list[object]:
    value = data.get(name)
    if not isinstance(value, list):
        raise RunStoreError(f"{name} must be a JSON array")
    return cast(list[object], value)


def _required_string(data: dict[str, object], name: str, *, allow_empty: bool = False) -> str:
    value = data.get(name)
    if not isinstance(value, str) or (not allow_empty and not value):
        qualifier = "a string" if allow_empty else "a non-empty string"
        raise RunStoreError(f"{name} must be {qualifier}")
    return value


def _optional_string(data: dict[str, object], name: str) -> str | None:
    value = data.get(name)
    if value is not None and not isinstance(value, str):
        raise RunStoreError(f"{name} must be a string or null")
    return value


def _integer(data: dict[str, object], name: str) -> int:
    value = data.get(name)
    if not isinstance(value, int) or isinstance(value, bool):
        raise RunStoreError(f"{name} must be an integer")
    return value


def _positive_integer(data: dict[str, object], name: str) -> int:
    value = _integer(data, name)
    if value <= 0:
        raise RunStoreError(f"{name} must be positive")
    return value


def _non_negative_integer(data: dict[str, object], name: str) -> int:
    value = _integer(data, name)
    if value < 0:
        raise RunStoreError(f"{name} must be non-negative")
    return value
