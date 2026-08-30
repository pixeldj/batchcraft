import hashlib
import os
import re
import stat
from collections.abc import Coroutine, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from batchcraft.comfyui import (
    ComfyUIError,
    ServerInfo,
    WorkflowPreparationValues,
    prepare_workflow,
)
from batchcraft.domain import BatchDefinition, CompiledRunPlan, compile_batch
from batchcraft.execution import (
    ExecutionClient,
    ExecutionConfig,
    ExecutionStateError,
    ExecutionStateStore,
    ResultRecord,
    RunExecutionState,
    execute_run,
    initial_execution_state,
)
from batchcraft.files import (
    AssetRecord,
    AssetStoreError,
    BatchIdentity,
    ProjectAssetStore,
    ProjectIdentity,
    PublishedRun,
    RunFilesystemStore,
    RunStoreError,
    is_safe_filesystem_key,
)

from .errors import (
    AssetDataError,
    AssetNotFoundError,
    AssetPublicationError,
    AssetUploadError,
    ExecutionNotEligibleError,
    InvalidProjectKeyError,
    ResultNotFoundError,
    RunCreationError,
    RunDataError,
    RunNotFoundError,
    RunPublicationError,
)
from .tasks import RunTaskRegistry

_RUN_DIRECTORY = re.compile(r"run-[0-9]+")
_IMAGE_MIME_TYPES = {
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


class ApplicationComfyUIClient(ExecutionClient, Protocol):
    async def get_server_info(self) -> ServerInfo: ...

    async def aclose(self) -> None: ...


class RunExecutor(Protocol):
    def __call__(
        self,
        *,
        run: PublishedRun,
        client: ExecutionClient,
        config: ExecutionConfig,
    ) -> Coroutine[object, object, RunExecutionState]: ...


@dataclass(frozen=True, slots=True)
class RunCreationInput:
    project: ProjectIdentity
    batch: BatchIdentity
    definition: BatchDefinition
    workflow: Mapping[str, object]
    workflow_profile: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class AssetImportInput:
    source: Path
    content_type: str


@dataclass(frozen=True, slots=True)
class ComfyUIStatus:
    reachable: bool
    version: str | None
    devices: tuple[str, ...]
    diagnostic: str | None


class BatchcraftService:
    def __init__(
        self,
        *,
        projects_root: Path,
        comfyui_client: ApplicationComfyUIClient,
        task_registry: RunTaskRegistry,
        execution_config: ExecutionConfig,
        run_store: RunFilesystemStore | None = None,
        executor: RunExecutor = execute_run,
    ) -> None:
        self.projects_root = projects_root
        self.comfyui_client = comfyui_client
        self.task_registry = task_registry
        self.execution_config = execution_config
        self.run_store = run_store or RunFilesystemStore(projects_root)
        self._executor = executor

    def preview_batch(self, definition: BatchDefinition) -> CompiledRunPlan:
        return compile_batch(definition)

    def list_project_assets(self, project_filesystem_key: str) -> tuple[AssetRecord, ...]:
        store = self._project_asset_store(project_filesystem_key)
        try:
            records = store.list_metadata()
        except (AssetStoreError, OSError, ValueError) as error:
            raise AssetDataError("Project asset data is invalid") from error
        return tuple(record for record in records if _is_supported_image_record(record))

    def import_project_assets(
        self,
        project_filesystem_key: str,
        uploads: tuple[AssetImportInput, ...],
    ) -> tuple[AssetRecord, ...]:
        if not uploads:
            raise AssetUploadError("At least one image file is required")
        store = self._project_asset_store(project_filesystem_key)
        for upload in uploads:
            _validate_image_file(upload.source, upload.content_type)

        imported: dict[str, AssetRecord] = {}
        try:
            for upload in uploads:
                record = store.import_file(upload.source)
                imported.setdefault(record.asset_id, record)
        except (AssetStoreError, OSError, ValueError) as error:
            if _has_os_error_cause(error) or isinstance(error, OSError):
                raise AssetPublicationError("Project assets could not be published") from error
            raise AssetDataError("Project asset data is invalid") from error
        return tuple(imported.values())

    def get_project_asset_content(
        self, project_filesystem_key: str, asset_id: str
    ) -> tuple[AssetRecord, bytes]:
        store = self._project_asset_store(project_filesystem_key)
        try:
            matches = [
                record
                for record in store.list_metadata()
                if record.asset_id == asset_id and _is_supported_image_record(record)
            ]
        except (AssetStoreError, OSError, ValueError) as error:
            raise AssetDataError("Project asset data is invalid") from error
        if not matches:
            raise AssetNotFoundError(f"Project asset {asset_id!r} was not found")
        if len(matches) > 1:
            raise AssetDataError(f"duplicate Project asset ID: {asset_id}")

        try:
            record = store.load(matches[0].sha256)
            content = _read_asset_content(store.project_path / record.stored_path, record)
            if not _has_image_signature(content, record.mime_type):
                raise AssetDataError("Project asset image signature is invalid")
        except (AssetStoreError, OSError, ValueError) as error:
            raise AssetDataError("Project asset data is invalid") from error
        return record, content

    def create_run(self, creation: RunCreationInput) -> PublishedRun:
        self._validate_creation_paths(
            creation.project.filesystem_key,
            creation.batch.filesystem_key,
        )
        plan = compile_batch(creation.definition)
        first_job = plan.jobs[0]
        prepare_workflow(
            creation.workflow,
            creation.workflow_profile,
            WorkflowPreparationValues(
                prompt=first_job.resolved_prompt,
                reference_image=(
                    "batchcraft-validation-reference.png"
                    if first_job.reference_asset_id is not None
                    else None
                ),
                seed=first_job.seed,
                output_prefix="batchcraft/validation",
            ),
        )
        assets = self._resolve_assets(creation.project.filesystem_key, plan)
        try:
            return self.run_store.create_run(
                project=creation.project,
                batch=creation.batch,
                plan=plan,
                reference_assets=assets,
                workflow=creation.workflow,
                workflow_profile=creation.workflow_profile,
            )
        except OSError as error:
            raise RunPublicationError("Run publication failed") from error
        except RunStoreError as error:
            if _has_os_error_cause(error):
                raise RunPublicationError("Run publication failed") from error
            raise RunCreationError(f"Run could not be published: {error}") from error
        except AssetStoreError as error:
            raise RunCreationError(f"Run could not be published: {error}") from error

    def get_run(self, run_id: str) -> PublishedRun:
        matches: list[Path] = []
        for candidate in self._run_candidates():
            try:
                candidate_run_id = self.run_store.read_run_id(candidate)
            except (RunStoreError, OSError, ValueError):
                continue
            if candidate_run_id == run_id:
                matches.append(candidate)
        if not matches:
            raise RunNotFoundError(f"Run {run_id!r} was not found")
        if len(matches) > 1:
            raise RunDataError(f"duplicate published Run ID: {run_id}")
        try:
            run = self.run_store.load_run(matches[0])
        except (AssetStoreError, RunStoreError, OSError, ValueError) as error:
            raise RunDataError(f"published Run data is invalid: {matches[0]}") from error
        if run.run_id != run_id:
            raise RunDataError(f"published Run identity changed during lookup: {matches[0]}")
        return run

    def get_execution_state(self, run: PublishedRun) -> RunExecutionState:
        store = ExecutionStateStore(run.path)
        if not store.state_path.exists():
            return initial_execution_state(run)
        try:
            return store.read_for_query(run)
        except ExecutionStateError as error:
            raise RunDataError(f"execution state is invalid for Run {run.run_id!r}") from error

    async def start_execution(self, run_id: str) -> PublishedRun:
        run = self.get_run(run_id)

        def create_execution() -> Coroutine[object, object, RunExecutionState]:
            state_store = ExecutionStateStore(run.path)
            if state_store.state_path.exists():
                state = self.get_execution_state(run)
                raise ExecutionNotEligibleError(
                    f"Run {run_id!r} is not eligible to start from {state.status.value!r} state"
                )
            try:
                state_store.validate_storage(run)
            except ExecutionStateError as error:
                raise ExecutionNotEligibleError(
                    f"Run {run_id!r} storage is not eligible for execution"
                ) from error
            return self._executor(
                run=run,
                client=self.comfyui_client,
                config=self.execution_config,
            )

        await self.task_registry.start(run_id, create_execution)
        return run

    def list_results(self, run: PublishedRun) -> tuple[ResultRecord, ...]:
        state = self.get_execution_state(run)
        return tuple(result for job in state.jobs for result in job.results)

    def get_result(
        self, run: PublishedRun, job_ordinal: int, artifact_ordinal: int
    ) -> tuple[ResultRecord, bytes]:
        for result in self.list_results(run):
            if (result.job_ordinal, result.artifact_ordinal) == (
                job_ordinal,
                artifact_ordinal,
            ):
                path = run.path / result.local_path
                if path.parent != run.path / "outputs":
                    raise RunDataError(f"recorded Result file is unsafe: {result.local_path}")
                return result, _read_result(path, result)
        raise ResultNotFoundError(
            f"Result {job_ordinal}/{artifact_ordinal} was not found for Run {run.run_id!r}"
        )

    async def get_comfyui_status(self) -> ComfyUIStatus:
        try:
            info = await self.comfyui_client.get_server_info()
        except ComfyUIError as error:
            return ComfyUIStatus(
                reachable=False,
                version=None,
                devices=(),
                diagnostic=str(error),
            )
        system = info.data.get("system")
        version = system.get("comfyui_version") if isinstance(system, dict) else None
        raw_devices = info.data.get("devices")
        devices = (
            tuple(_device_name(device) for device in raw_devices if isinstance(device, dict))
            if isinstance(raw_devices, list)
            else ()
        )
        return ComfyUIStatus(
            reachable=True,
            version=version if isinstance(version, str) else None,
            devices=devices,
            diagnostic=None,
        )

    def _resolve_assets(
        self, project_filesystem_key: str, plan: CompiledRunPlan
    ) -> dict[str, AssetRecord]:
        needed = {job.reference_asset_id for job in plan.jobs if job.reference_asset_id is not None}
        if not needed:
            return {}
        project_path = self.projects_root / project_filesystem_key
        store = ProjectAssetStore(project_path)
        found: dict[str, AssetRecord] = {}
        try:
            records = store.list_metadata()
        except AssetStoreError as error:
            raise RunCreationError("Project asset data is invalid") from error
        for record in records:
            if record.asset_id not in needed:
                continue
            try:
                found[record.asset_id] = store.load(record.sha256)
            except AssetStoreError as error:
                raise RunCreationError("Project asset data is invalid") from error
        missing = sorted(needed - found.keys())
        if missing:
            raise AssetNotFoundError(f"Project assets were not found: {', '.join(missing)}")
        return found

    def _validate_creation_paths(
        self, project_filesystem_key: str, batch_filesystem_key: str
    ) -> None:
        project_path = self.projects_root / project_filesystem_key
        batches_path = project_path / "batches"
        batch_path = batches_path / batch_filesystem_key
        for path in (project_path, batches_path, batch_path):
            if path.is_symlink() or not _is_within(path, self.projects_root):
                raise RunCreationError("Project or Batch filesystem path is unsafe")

    def _project_asset_store(self, project_filesystem_key: str) -> ProjectAssetStore:
        if not is_safe_filesystem_key(project_filesystem_key):
            raise InvalidProjectKeyError("Project filesystem key is not path-safe")
        project_path = self.projects_root / project_filesystem_key
        if project_path.is_symlink() or not _is_within(project_path, self.projects_root):
            raise InvalidProjectKeyError("Project filesystem path is unsafe")
        if project_path.exists() and not project_path.is_dir():
            raise AssetDataError("Project filesystem path is not a directory")
        return ProjectAssetStore(project_path)

    def _run_candidates(self) -> tuple[Path, ...]:
        if not self.projects_root.is_dir():
            return ()
        candidates: list[Path] = []
        for candidate in sorted(self.projects_root.glob("*/batches/*/run-*")):
            if not _RUN_DIRECTORY.fullmatch(candidate.name) or not candidate.is_dir():
                continue
            if candidate.is_symlink() or not _is_within(candidate, self.projects_root):
                raise RunDataError("published Run path is unsafe")
            candidates.append(candidate)
        return tuple(candidates)


def _is_within(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def _device_name(device: dict[object, object]) -> str:
    for key in ("name", "type"):
        value = device.get(key)
        if isinstance(value, str) and value:
            return value
    return "unknown"


def _has_os_error_cause(error: BaseException) -> bool:
    cause = error.__cause__
    while cause is not None:
        if isinstance(cause, OSError):
            return True
        cause = cause.__cause__
    return False


def _read_result(path: Path, result: ResultRecord) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise RunDataError(f"recorded Result is not a regular file: {result.local_path}")
            content = file.read()
    except OSError as error:
        raise RunDataError(f"recorded Result cannot be read: {result.local_path}") from error
    if len(content) != result.byte_size or hashlib.sha256(content).hexdigest() != result.sha256:
        raise RunDataError(f"recorded Result integrity check failed: {result.local_path}")
    return content


def _validate_image_file(source: Path, declared_content_type: str) -> None:
    expected_content_type = _IMAGE_MIME_TYPES.get(source.suffix.lower())
    if expected_content_type is None or declared_content_type != expected_content_type:
        raise AssetUploadError("Image type must be PNG, JPEG, or WebP and match its filename")
    try:
        with source.open("rb") as file:
            prefix = file.read(12)
    except OSError as error:
        raise AssetUploadError("Uploaded image could not be read") from error
    if not _has_image_signature(prefix, declared_content_type):
        raise AssetUploadError("Uploaded bytes do not match the declared image type")


def _has_image_signature(content: bytes, content_type: str | None) -> bool:
    return bool(
        content_type == "image/png"
        and content.startswith(b"\x89PNG\r\n\x1a\n")
        or content_type == "image/jpeg"
        and content.startswith(b"\xff\xd8\xff")
        or content_type == "image/webp"
        and len(content) >= 12
        and content[:4] == b"RIFF"
        and content[8:12] == b"WEBP"
    )


def _is_supported_image_record(record: AssetRecord) -> bool:
    return _IMAGE_MIME_TYPES.get(Path(record.original_filename).suffix.lower()) == record.mime_type


def _read_asset_content(path: Path, record: AssetRecord) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise AssetDataError(f"Project asset is not a regular file: {record.asset_id}")
            content = file.read()
    except OSError as error:
        raise AssetDataError(f"Project asset cannot be read: {record.asset_id}") from error
    if len(content) != record.byte_size or hashlib.sha256(content).hexdigest() != record.sha256:
        raise AssetDataError(f"Project asset integrity check failed: {record.asset_id}")
    return content
