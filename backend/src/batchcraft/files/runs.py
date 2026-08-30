import csv
import hashlib
import io
import os
import shutil
from collections.abc import Callable, Mapping
from dataclasses import replace
from datetime import UTC, datetime
from itertools import count
from pathlib import Path
from typing import cast
from uuid import uuid4

from batchcraft.domain import (
    CompilationWarning,
    CompilationWarningCode,
    CompiledJob,
    CompiledRunPlan,
    PromptVersion,
    ResolvedVariable,
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
    PersistedJob,
    ProjectIdentity,
    PublishedRun,
)
from batchcraft.files.project_owners import ProjectOwnerError, ProjectOwnerStore

RUN_FORMAT_VERSION = 1
MANIFEST_FORMAT_VERSION = 3
OWNER_FORMAT_VERSION = 1
_ID_CHARACTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
_CSV_COLUMNS = (
    "job_ordinal",
    "job_id",
    "prompt_version_id",
    "prompt_version_name",
    "prompt_template",
    "resolved_prompt",
    "resolved_variables_json",
    "reference_asset_id",
    "reference_original_filename",
    "reference_sha256",
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
        plan: CompiledRunPlan,
        reference_assets: Mapping[str, AssetRecord],
        workflow: Mapping[str, object],
        workflow_profile: Mapping[str, object],
    ) -> PublishedRun:
        self._validate_owner(project.id, project.filesystem_key, project.name, "Project")
        self._validate_owner(batch.id, batch.filesystem_key, batch.name, "Batch")
        self._validate_plan(plan)
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
        assets_by_id = self._validate_reference_assets(plan, reference_assets, asset_store)
        run_id = self._new_id("Run")
        created_at = self._timestamp()
        run_number, reservation_path, final_path = self._reserve_run_number(batch_path)
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
                    reference_asset=(
                        assets_by_id[job.reference_asset_id]
                        if job.reference_asset_id is not None
                        else None
                    ),
                )
                for job in plan.jobs
            )
            run_metadata = _run_metadata(
                run_id=run_id,
                run_number=run_number,
                created_at=created_at,
                project=project,
                batch=batch,
                job_count=plan.job_count,
                workflow_sha256=workflow_sha256,
                workflow_profile_sha256=workflow_profile_sha256,
            )
            manifest = _manifest(
                run_metadata=run_metadata,
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
        expected_name = f"run-{published_run.run_number:03d}"
        if run_path.name != expected_name:
            raise RunStoreError(
                f"Run directory name {run_path.name!r} does not match Run number "
                f"{published_run.run_number}"
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
            if run_data.get("format_version") != RUN_FORMAT_VERSION:
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

        asset_store = ProjectAssetStore(project_path)
        validated_assets: dict[str, AssetRecord] = {}
        for job in loaded.jobs:
            asset = job.reference_asset
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
            created_at=loaded.created_at,
            path=run_path,
            project=loaded.project,
            batch=loaded.batch,
            compiled_plan=loaded.compiled_plan,
            jobs=loaded.jobs,
            workflow=workflow,
            workflow_profile=workflow_profile,
            workflow_sha256=workflow_sha256,
            workflow_profile_sha256=workflow_profile_sha256,
        )

    def _validate_reference_assets(
        self,
        plan: CompiledRunPlan,
        reference_assets: Mapping[str, AssetRecord],
        asset_store: ProjectAssetStore,
    ) -> dict[str, AssetRecord]:
        assets_by_id: dict[str, AssetRecord] = {}
        for job in plan.jobs:
            asset_id = job.reference_asset_id
            if asset_id is None:
                continue
            if asset_id in assets_by_id:
                continue
            record = reference_assets.get(asset_id)
            if record is None:
                raise RunStoreError(f"compiled plan references unknown asset ID: {asset_id!r}")
            if record.asset_id != asset_id:
                raise RunStoreError(
                    f"reference asset mapping key {asset_id!r} does not match record ID "
                    f"{record.asset_id!r}"
                )
            try:
                assets_by_id[asset_id] = asset_store.validate_record(record)
            except AssetStoreError as error:
                raise RunStoreError(f"invalid reference asset {asset_id!r}: {error}") from error
        return assets_by_id

    def _reserve_run_number(self, batch_path: Path) -> tuple[int, Path, Path]:
        allocations_path = batch_path / ".allocations"
        ensure_directory(allocations_path)
        for run_number in count(1):
            name = f"run-{run_number:03d}"
            final_path = batch_path / name
            reservation_path = allocations_path / name
            if final_path.exists():
                continue
            try:
                reservation_path.mkdir()
                fsync_directory(allocations_path)
            except FileExistsError:
                continue
            if final_path.exists():
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
        if existing.get("format_version") != OWNER_FORMAT_VERSION:
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
            if job.reference_asset_id == "":
                raise RunStoreError(f"compiled Job {job.ordinal} has an empty reference asset ID")

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


def _run_metadata(
    *,
    run_id: str,
    run_number: int,
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
            "created_at": run_metadata["created_at"],
            "project": run_metadata["project"],
            "batch": run_metadata["batch"],
        },
        "prompt_versions": [
            {
                "prompt_version_id": version.id,
                "prompt_version_name": version.name,
                "prompt_template": version.text,
            }
            for version in plan.prompt_versions
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
                "reference_asset": (
                    _asset_data(job.reference_asset) if job.reference_asset is not None else None
                ),
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
                "reference_asset_id": (
                    job.reference_asset.asset_id if job.reference_asset is not None else ""
                ),
                "reference_original_filename": (
                    job.reference_asset.original_filename if job.reference_asset is not None else ""
                ),
                "reference_sha256": (
                    job.reference_asset.sha256 if job.reference_asset is not None else ""
                ),
                "seed": job.compiled_job.seed,
                "workflow_sha256": workflow_sha256,
                "workflow_profile_sha256": workflow_profile_sha256,
            }
        )
    return output.getvalue().encode()


def _parse_run(
    run_data: dict[str, object], manifest_data: dict[str, object], run_path: Path
) -> PublishedRun:
    if run_data.get("format_version") != RUN_FORMAT_VERSION:
        raise RunStoreError("unsupported run.json format version")
    manifest_version = manifest_data.get("format_version")
    if manifest_version not in {1, 2, MANIFEST_FORMAT_VERSION}:
        raise RunStoreError("unsupported manifest.json format version")

    run_id = _required_string(run_data, "run_id")
    run_number = _positive_integer(run_data, "run_number")
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

    prompt_versions: tuple[PromptVersion, ...]
    if manifest_version == 1:
        prompt_version_data = _required_object(manifest_data, "prompt_version")
        legacy_prompt_id = _required_string(prompt_version_data, "prompt_version_id")
        prompt_versions = (
            PromptVersion(
                id=legacy_prompt_id,
                name=legacy_prompt_id,
                text=_required_string(prompt_version_data, "prompt_template", allow_empty=True),
            ),
        )
    else:
        prompt_versions = tuple(
            _parse_prompt_version(_object_item(value, "PromptVersion"))
            for value in _required_array(manifest_data, "prompt_versions")
        )
        if not prompt_versions:
            raise RunStoreError("manifest must contain at least one PromptVersion")
        prompt_ids = tuple(version.id for version in prompt_versions)
        if len(set(prompt_ids)) != len(prompt_ids):
            raise RunStoreError("manifest contains duplicate PromptVersion IDs")
        legacy_prompt_id = None
    known_prompt_ids = {version.id for version in prompt_versions}
    warnings = tuple(
        _parse_warning(_object_item(value, "compiler warning"))
        for value in _required_array(manifest_data, "compiler_warnings")
    )
    persisted_jobs = tuple(
        _parse_job(
            _object_item(value, "Job"),
            workflow_sha256,
            workflow_profile_sha256,
            manifest_version=manifest_version,
            legacy_prompt_id=legacy_prompt_id,
        )
        for value in _required_array(manifest_data, "jobs")
    )
    compiled_plan = CompiledRunPlan(
        prompt_versions=prompt_versions,
        jobs=tuple(job.compiled_job for job in persisted_jobs),
        warnings=warnings,
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
        created_at=created_at,
        path=run_path,
        project=project,
        batch=batch,
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
    *,
    manifest_version: object,
    legacy_prompt_id: str | None,
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
    asset: AssetRecord | None
    if manifest_version in {1, 2}:
        asset = _parse_asset(_required_object(data, "reference_asset"))
    else:
        if "reference_asset" not in data:
            raise RunStoreError("Job must define reference_asset")
        reference_asset = data["reference_asset"]
        asset = (
            None
            if reference_asset is None
            else _parse_asset(_object_item(reference_asset, "reference_asset"))
        )
    resolved_prompt = _required_string(data, "resolved_prompt", allow_empty=True)
    if "{{" in resolved_prompt or "}}" in resolved_prompt:
        raise RunStoreError("Job contains an unresolved prompt placeholder")
    compiled_job = CompiledJob(
        ordinal=_positive_integer(data, "ordinal"),
        prompt_version_id=(
            legacy_prompt_id
            if legacy_prompt_id is not None
            else _required_string(data, "prompt_version_id")
        ),
        resolved_prompt=resolved_prompt,
        resolved_variables=variables,
        reference_asset_id=asset.asset_id if asset is not None else None,
        seed=_integer(data, "seed"),
    )
    return PersistedJob(
        job_id=_required_string(data, "job_id"),
        compiled_job=compiled_job,
        reference_asset=asset,
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
