import asyncio
import hashlib
import json
import os
import re
import secrets
import stat
from collections.abc import Callable, Coroutine, Iterator, Mapping
from contextlib import suppress
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Literal, Protocol, cast
from uuid import UUID, uuid5

from batchcraft.comfyui import (
    ComfyUIError,
    ServerInfo,
    WorkflowPreparationValues,
    prepare_workflow,
)
from batchcraft.db import (
    HistoricalDiagnosticRecord,
    HistoricalProjectConflictError,
    HistoricalProjectionError,
    HistoricalProjectionStore,
    HistoricalRunRecord,
    ProjectNotFoundError,
    ProjectStore,
    PromptConflictError,
    PromptNotFoundError,
    PromptRecord,
    PromptStore,
    PromptVersionConflictError,
    PromptVersionNotFoundError,
    PromptVersionRecord,
    RunCancellationMode,
    RunCancellationRequestRecord,
    RunCancellationRequestStore,
    WorkflowConflictError,
    WorkflowNotFoundError,
    WorkflowProfileConflictError,
    WorkflowProfileNotFoundError,
    WorkflowProfileRecord,
    WorkflowProfileStore,
    WorkflowProfileVersionNotFoundError,
    WorkflowProfileVersionRecord,
    WorkflowRecord,
    WorkflowStore,
    WorkflowVersionNotFoundError,
    WorkflowVersionRecord,
)
from batchcraft.db import (
    RunCancellationStoreError as DatabaseRunCancellationStoreError,
)
from batchcraft.domain import BatchDefinition, CompiledRunPlan, SeedInput, compile_batch
from batchcraft.execution import (
    DISCARDED_BEFORE_START,
    USER_DETACHED_FROM_CURRENT_JOB,
    ExecutionClient,
    ExecutionConfig,
    ExecutionStateError,
    ExecutionStateStore,
    JobExecutionStatus,
    ResultRecord,
    RunCancellationControl,
    RunExecutionState,
    RunExecutionStatus,
    execute_run,
    initial_execution_state,
)
from batchcraft.files import (
    AssetRecord,
    AssetStoreError,
    BatchIdentity,
    BatchSnapshotV1,
    ProjectAssetStore,
    ProjectIdentity,
    PublishedRun,
    RunFilesystemStore,
    RunStoreError,
    is_safe_filesystem_key,
)
from batchcraft.files.history import (
    ProjectHistoryScan,
    ProjectHistoryScanError,
    ProjectHistoryScanner,
)
from batchcraft.files.snapshots import SnapshotPromptVersion, SnapshotWorkflowSelection

from .cancellation import ActiveRunCancellationControl
from .errors import (
    AssetDataError,
    AssetNotFoundError,
    AssetPublicationError,
    AssetUploadError,
    ExecutionNotEligibleError,
    HistoricalResourceImportConflictError,
    HistoricalResourceImportError,
    InvalidProjectKeyError,
    ProjectHistoryNotFoundError,
    ProjectImportConflictError,
    ProjectImportError,
    ResultNotFoundError,
    RunCancellationNotEligibleError,
    RunCancellationStoreError,
    RunCreationError,
    RunDataError,
    RunDiscardNotEligibleError,
    RunNotFoundError,
    RunPublicationError,
)
from .library import LibraryService
from .tasks import RunTaskRegistry

_RUN_DIRECTORY = re.compile(r"[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*")
_HISTORICAL_IMPORT_NAMESPACE = UUID("cf2d89da-87dc-4ce7-8bf5-c1da75fc690b")
_SEED_SPACE_SIZE = 2**53
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
        cancellation_control: RunCancellationControl,
    ) -> Coroutine[object, object, RunExecutionState]: ...


RandomSeedSource = Callable[[int], int]


@dataclass(frozen=True, slots=True)
class RunCreationInput:
    project: ProjectIdentity
    batch: BatchIdentity
    definition: BatchDefinition
    workflow: Mapping[str, object]
    workflow_profile: Mapping[str, object]
    batch_snapshot: Mapping[str, object]
    name: str | None = None
    description: str | None = None


@dataclass(frozen=True, slots=True)
class AssetImportInput:
    source: Path
    content_type: str


@dataclass(frozen=True, slots=True)
class ListedResult:
    record: ResultRecord
    integrity_status: Literal["verified", "missing", "corrupt"]


@dataclass(frozen=True, slots=True)
class ComfyUIStatus:
    reachable: bool
    version: str | None
    devices: tuple[str, ...]
    diagnostic: str | None


class RunCancellationState(StrEnum):
    STOP_REQUESTED = "stop_requested"
    STOPPING_AFTER_CURRENT_JOB = "stopping_after_current_job"
    DETACH_REQUESTED = "detach_requested"
    DETACHED = "detached"
    CANCELLED = "cancelled"
    FINISHED = "finished"


@dataclass(frozen=True, slots=True)
class RunCancellation:
    mode: RunCancellationMode
    requested_at: datetime | None
    state: RunCancellationState


@dataclass(frozen=True, slots=True)
class RunCancellationRequestResult(RunCancellation):
    run_id: str
    created: bool


class ResourceLinkStatus(StrEnum):
    LINKED = "linked"
    DETACHED = "detached"
    CONFLICT = "conflict"


@dataclass(frozen=True, slots=True)
class ResourceLink:
    historical_version_id: str | None
    status: ResourceLinkStatus
    linked_version_id: str | None = None
    linked_resource_id: str | None = None


@dataclass(frozen=True, slots=True)
class BatchReconstruction:
    run_id: str
    batch_snapshot: BatchSnapshotV1
    prompt_versions: tuple[ResourceLink, ...]
    workflow_version: ResourceLink
    workflow_profile_version: ResourceLink


class BatchcraftService:
    def __init__(
        self,
        *,
        projects_root: Path,
        comfyui_client: ApplicationComfyUIClient,
        task_registry: RunTaskRegistry,
        cancellation_store: RunCancellationRequestStore,
        execution_config: ExecutionConfig,
        run_store: RunFilesystemStore | None = None,
        history_store: HistoricalProjectionStore | None = None,
        executor: RunExecutor = execute_run,
        clock: Callable[[], datetime] | None = None,
        random_seed_source: RandomSeedSource = secrets.randbelow,
    ) -> None:
        self.projects_root = projects_root
        self.comfyui_client = comfyui_client
        self.task_registry = task_registry
        self.cancellation_store = cancellation_store
        self.execution_config = execution_config
        self.run_store = run_store or RunFilesystemStore(projects_root)
        self.history_store = history_store or HistoricalProjectionStore(
            cancellation_store.database_path
        )
        self.history_scanner = ProjectHistoryScanner(projects_root)
        self._executor = executor
        self._clock = clock or (lambda: datetime.now(UTC))
        self._random_seed_source = random_seed_source

    def preview_batch(
        self, creation: RunCreationInput
    ) -> tuple[CompiledRunPlan, dict[str, AssetRecord]]:
        plan = self._compile_and_validate(creation)
        return plan, self._resolve_assets(creation.project.filesystem_key, plan)

    def preview_random_batch(
        self,
        creation: RunCreationInput,
        random_seed_count: int,
    ) -> tuple[CompiledRunPlan, dict[str, AssetRecord]]:
        if random_seed_count < 1:
            raise RunCreationError("Random seed count must be positive")
        base_plan = compile_batch(
            creation.definition,
            max_jobs=_SEED_SPACE_SIZE // random_seed_count,
        )
        seeds = materialize_random_seeds(
            base_plan.job_count * random_seed_count,
            self._random_seed_source,
        )
        materialized = replace(
            creation,
            definition=replace(
                creation.definition,
                seeds=SeedInput.materialized_random(seeds, random_seed_count),
            ),
        )
        return self.preview_batch(materialized)

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
        plan = self._compile_and_validate(creation)

        assets = self._resolve_assets(creation.project.filesystem_key, plan)
        try:
            run = self.run_store.create_run(
                project=creation.project,
                batch=creation.batch,
                batch_snapshot=creation.batch_snapshot,
                plan=plan,
                image_assets=assets,
                workflow=creation.workflow,
                workflow_profile=creation.workflow_profile,
                name=creation.name,
                description=creation.description,
            )
            # The filesystem Run is authoritative; projection repair is available via reindex.
            with suppress(ProjectImportError):
                self.import_project(creation.project.filesystem_key)
            return run
        except OSError as error:
            raise RunPublicationError("Run publication failed") from error
        except RunStoreError as error:
            if _has_os_error_cause(error):
                raise RunPublicationError("Run publication failed") from error
            raise RunCreationError(f"Run could not be published: {error}") from error
        except AssetStoreError as error:
            raise RunCreationError(f"Run could not be published: {error}") from error

    def _compile_and_validate(self, creation: RunCreationInput) -> CompiledRunPlan:
        plan = compile_batch(creation.definition)
        first_job = plan.jobs[0]
        prepare_workflow(
            creation.workflow,
            creation.workflow_profile,
            WorkflowPreparationValues(
                prompt=first_job.resolved_prompt,
                image_inputs={
                    item.slot_key: "batchcraft-validation-image.png"
                    for item in first_job.resolved_image_inputs
                    if item.asset_id is not None
                },
                parameters={
                    item.parameter_key: item.value
                    for item in first_job.resolved_parameters
                    if item.value is not None
                },
                seed=first_job.seed,
                output_prefix="batchcraft/validation",
            ),
        )
        return plan

    def get_run(self, run_id: str) -> PublishedRun:
        return self._get_run(run_id, historical=False)

    def get_historical_run(self, run_id: str) -> PublishedRun:
        return self._get_run(run_id, historical=True)

    def get_batch_reconstruction(self, run_id: str) -> BatchReconstruction:
        run = self.get_historical_run(run_id)
        snapshot = BatchSnapshotV1.model_validate(run.batch_snapshot)
        database_path = self.cancellation_store.database_path
        project_context_matches = _registered_project_context_matches(
            ProjectStore(database_path),
            run.project.id,
            run.project.filesystem_key,
        )
        prompt_store = PromptStore(database_path)
        workflow_store = WorkflowStore(database_path)
        profile_store = WorkflowProfileStore(database_path)

        prompt_links = tuple(
            _classify_prompt_version(
                prompt_store,
                item,
                run.project.id,
                project_context_matches=project_context_matches,
            )
            for item in snapshot.prompt_versions
        )
        workflow_link = _classify_workflow_version(
            workflow_store,
            snapshot.workflow_selection,
            run.project.id,
            run.workflow_sha256,
            project_context_matches=project_context_matches,
        )
        profile_link = _classify_workflow_profile_version(
            profile_store,
            snapshot.workflow_selection,
            run.project.id,
            workflow_link.status,
            run.workflow_profile_sha256,
            project_context_matches=project_context_matches,
        )
        return BatchReconstruction(
            run_id=run.run_id,
            batch_snapshot=snapshot,
            prompt_versions=prompt_links,
            workflow_version=workflow_link,
            workflow_profile_version=profile_link,
        )

    def import_historical_prompt_copy(
        self,
        run_id: str,
        position: int,
        *,
        import_request_id: str,
        name: str,
        description: str | None,
        note: str | None,
        library: LibraryService,
    ) -> tuple[PromptRecord, PromptVersionRecord]:
        run, snapshot = self._historical_copy_source(run_id, library)
        if position < 0 or position >= len(snapshot.prompt_versions):
            raise HistoricalResourceImportError(
                f"Historical PromptVersion position {position} is outside the available range "
                f"0..{len(snapshot.prompt_versions) - 1}"
            )
        prompt = snapshot.prompt_versions[position]
        if not prompt.text.strip():
            raise HistoricalResourceImportError(
                f"Historical PromptVersion at position {position} has empty text and cannot be "
                "imported as a mutable Prompt"
            )
        prompt_id, version_id = _historical_import_ids(
            run.project.id,
            run.run_id,
            "prompt",
            import_request_id,
            position=position,
        )
        for candidate_name in _historical_import_names(prompt.name or name):
            try:
                return library.create_prompt(
                    run.project.id,
                    name=candidate_name,
                    description=description,
                    text=prompt.text,
                    note=note,
                    prompt_id=prompt_id,
                    version_id=version_id,
                )
            except (PromptConflictError, PromptVersionConflictError) as error:
                replay = _replay_historical_prompt_copy(
                    library,
                    prompt_id=prompt_id,
                    version_id=version_id,
                    project_id=run.project.id,
                    text=prompt.text,
                    error=error,
                )
                if replay is not None:
                    return replay
        raise HistoricalResourceImportConflictError(
            "No collision-safe Prompt name is available for historical import"
        )

    def import_historical_workflow_copy(
        self,
        run_id: str,
        *,
        import_request_id: str,
        name: str,
        description: str | None,
        note: str | None,
        library: LibraryService,
    ) -> tuple[WorkflowRecord, WorkflowVersionRecord]:
        run, snapshot = self._historical_copy_source(run_id, library)
        workflow_id, version_id = _historical_import_ids(
            run.project.id, run.run_id, "workflow", import_request_id
        )
        preferred_name = snapshot.workflow_selection.workflow_name or name
        for candidate_name in _historical_import_names(preferred_name):
            try:
                return library.create_workflow(
                    run.project.id,
                    name=candidate_name,
                    description=description,
                    workflow=run.workflow,
                    note=note,
                    workflow_id=workflow_id,
                    version_id=version_id,
                )
            except WorkflowConflictError as error:
                replay = _replay_historical_workflow_copy(
                    library,
                    workflow_id=workflow_id,
                    version_id=version_id,
                    project_id=run.project.id,
                    content_sha256=run.workflow_sha256,
                    error=error,
                )
                if replay is not None:
                    return replay
        raise HistoricalResourceImportConflictError(
            "No collision-safe Workflow name is available for historical import"
        )

    def import_historical_workflow_profile_copy(
        self,
        run_id: str,
        *,
        import_request_id: str,
        name: str,
        description: str | None,
        note: str | None,
        workflow_version_id: str,
        library: LibraryService,
    ) -> tuple[WorkflowProfileRecord, WorkflowProfileVersionRecord]:
        run, snapshot = self._historical_copy_source(run_id, library)
        try:
            target = library.get_workflow_version(workflow_version_id)
            target_workflow = library.get_workflow(target.workflow_id)
        except (WorkflowNotFoundError, WorkflowVersionNotFoundError) as error:
            raise HistoricalResourceImportError(
                "Target WorkflowVersion was not found in the historical Run Project"
            ) from error
        if target.archived_at is not None or target_workflow.archived_at is not None:
            raise HistoricalResourceImportError(
                "Target Workflow and WorkflowVersion must both be active"
            )
        if (
            target.project_id != run.project.id
            or target_workflow.project_id != run.project.id
            or target.content_sha256 != run.workflow_sha256
        ):
            raise HistoricalResourceImportError(
                "Target WorkflowVersion must belong to the historical Run Project and exactly "
                "match its frozen Workflow"
            )

        profile = run.workflow_profile
        profile_id, version_id = _historical_import_ids(
            run.project.id, run.run_id, "workflow-profile", import_request_id
        )
        mappings = cast(Mapping[str, object], profile["mappings"])
        image_inputs = cast(list[object], profile["image_inputs"])
        parameters = cast(list[object], profile["parameters"])
        preferred_name = snapshot.workflow_selection.workflow_profile_name or name
        for candidate_name in _historical_import_names(preferred_name):
            try:
                return library.create_workflow_profile(
                    target.workflow_id,
                    name=candidate_name,
                    description=description,
                    workflow_version_id=target.id,
                    mappings=mappings,
                    image_inputs=image_inputs,
                    parameters=parameters,
                    note=note,
                    profile_id=profile_id,
                    version_id=version_id,
                )
            except WorkflowProfileConflictError as error:
                replay = _replay_historical_workflow_profile_copy(
                    library,
                    profile_id=profile_id,
                    version_id=version_id,
                    project_id=run.project.id,
                    workflow_id=target.workflow_id,
                    workflow_version_id=target.id,
                    mappings=mappings,
                    image_inputs=image_inputs,
                    parameters=parameters,
                    error=error,
                )
                if replay is not None:
                    return replay
        raise HistoricalResourceImportConflictError(
            "No collision-safe Workflow Profile name is available for historical import"
        )

    def _historical_copy_source(
        self, run_id: str, library: LibraryService
    ) -> tuple[PublishedRun, BatchSnapshotV1]:
        run = self.get_historical_run(run_id)
        snapshot = BatchSnapshotV1.model_validate(run.batch_snapshot)
        library.require_project_ownership(run.project.id, run.project.filesystem_key)
        return run, snapshot

    def _get_run(self, run_id: str, *, historical: bool) -> PublishedRun:
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
            run = (
                self.run_store.load_historical_run(matches[0])
                if historical
                else self.run_store.load_run(matches[0])
            )
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

    def get_historical_execution_state(self, run: PublishedRun) -> RunExecutionState:
        store = ExecutionStateStore(run.path)
        if not store.state_path.exists():
            return initial_execution_state(run)
        try:
            return store.read_historical(run)
        except ExecutionStateError as error:
            raise RunDataError(f"execution state is invalid for Run {run.run_id!r}") from error

    def execution_task_active(self, run_id: str) -> bool:
        return self.task_registry.is_active(run_id)

    async def get_active_execution_run_id(self) -> str | None:
        return await self.task_registry.active_run_id()

    def get_run_cancellation(self, state: RunExecutionState) -> RunCancellation | None:
        intent = self._get_cancellation_intent(
            state.run_id, RunCancellationMode.DETACH
        ) or self._get_cancellation_intent(state.run_id, RunCancellationMode.AFTER_CURRENT_JOB)
        if intent is None and state.status is not RunExecutionStatus.CANCELLED:
            return None
        return _run_cancellation(state, intent)

    async def start_execution(self, run_id: str) -> PublishedRun:
        run = self.get_run(run_id)
        stop_intent, detach_intent = await asyncio.gather(
            asyncio.to_thread(
                self._get_cancellation_intent,
                run_id,
                RunCancellationMode.AFTER_CURRENT_JOB,
            ),
            asyncio.to_thread(
                self._get_cancellation_intent,
                run_id,
                RunCancellationMode.DETACH,
            ),
        )
        cancellation_control = ActiveRunCancellationControl(
            run_id,
            self.cancellation_store,
            requested=stop_intent is not None,
            detach_requested=detach_intent is not None,
        )

        def create_execution() -> Coroutine[object, object, RunExecutionState]:
            state_store = ExecutionStateStore(run.path)
            if detach_intent is not None:
                raise ExecutionNotEligibleError(
                    f"Run {run_id!r} has a durable local detach request"
                )
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
                cancellation_control=cancellation_control,
            )

        await self.task_registry.start(run_id, cancellation_control, create_execution)
        return run

    async def request_run_cancellation(
        self,
        run_id: str,
        mode: RunCancellationMode = RunCancellationMode.AFTER_CURRENT_JOB,
    ) -> RunCancellationRequestResult:
        run = self.get_run(run_id)
        state = self.get_execution_state(run)
        intent = await asyncio.to_thread(self._get_cancellation_intent, run_id, mode)
        if intent is not None:
            return _cancellation_request_result(state, intent, created=False)
        if mode is RunCancellationMode.DETACH and state.status in {
            RunExecutionStatus.SUCCEEDED,
            RunExecutionStatus.FAILED,
            RunExecutionStatus.BLOCKED,
            RunExecutionStatus.CANCELLED,
        }:
            return RunCancellationRequestResult(
                run_id=run_id,
                mode=mode,
                requested_at=None,
                created=False,
                state=(
                    RunCancellationState.CANCELLED
                    if state.status is RunExecutionStatus.CANCELLED
                    else RunCancellationState.FINISHED
                ),
            )
        if state.status is RunExecutionStatus.CANCELLED:
            return RunCancellationRequestResult(
                run_id=run_id,
                mode=RunCancellationMode.AFTER_CURRENT_JOB,
                requested_at=None,
                created=False,
                state=RunCancellationState.CANCELLED,
            )
        if state.status in {
            RunExecutionStatus.SUCCEEDED,
            RunExecutionStatus.FAILED,
            RunExecutionStatus.BLOCKED,
        }:
            raise RunCancellationNotEligibleError(
                f"Run {run_id!r} is not eligible for cancellation from {state.status.value!r} state"
            )

        try:
            requested = await self.task_registry.request_cancellation(run_id, mode)
        except DatabaseRunCancellationStoreError as error:
            raise RunCancellationStoreError(
                "Run cancellation request could not be stored"
            ) from error
        if requested is not None:
            record, created = requested
            return _cancellation_request_result(
                self.get_execution_state(run), record, created=created
            )

        # The execution may have reached a terminal state while this request was admitted.
        state = self.get_execution_state(run)
        intent = await asyncio.to_thread(self._get_cancellation_intent, run_id, mode)
        if intent is not None:
            return _cancellation_request_result(state, intent, created=False)
        if state.status is RunExecutionStatus.CANCELLED:
            return RunCancellationRequestResult(
                run_id=run_id,
                mode=RunCancellationMode.AFTER_CURRENT_JOB,
                requested_at=None,
                created=False,
                state=RunCancellationState.CANCELLED,
            )
        raise RunCancellationNotEligibleError(
            f"Run {run_id!r} does not have an active execution task"
        )

    async def discard_run(self, run_id: str) -> RunExecutionState:
        run = self.get_run(run_id)

        def discard() -> RunExecutionState:
            store = ExecutionStateStore(run.path)
            try:
                if store.state_path.exists():
                    state = store.read_for_query(run)
                else:
                    store.validate_storage(run)
                    state = initial_execution_state(run)

                if state.status is RunExecutionStatus.CANCELLED:
                    return state
                if state != initial_execution_state(run):
                    raise RunDiscardNotEligibleError(
                        f"Run {run_id!r} is not pristine and unstarted"
                    )

                cancelled = replace(
                    state,
                    status=RunExecutionStatus.CANCELLED,
                    completed_at=_timestamp(self._clock),
                    diagnostics=(DISCARDED_BEFORE_START,),
                )
                store.save(run, cancelled)
                return cancelled
            except ExecutionStateError as error:
                raise RunDataError(f"execution state is invalid for Run {run.run_id!r}") from error

        return await self.task_registry.discard(run_id, discard)

    def list_results(self, run: PublishedRun) -> tuple[ListedResult, ...]:
        state = self.get_historical_execution_state(run)
        listed: list[ListedResult] = []
        for job in state.jobs:
            for result in job.results:
                try:
                    _read_result(run.path / result.local_path, result)
                except RunDataError:
                    path = run.path / result.local_path
                    integrity: Literal["verified", "missing", "corrupt"] = (
                        "missing" if path.is_symlink() or not path.exists() else "corrupt"
                    )
                else:
                    integrity = "verified"
                listed.append(ListedResult(record=result, integrity_status=integrity))
        return tuple(listed)

    def _get_cancellation_intent(
        self,
        run_id: str,
        mode: RunCancellationMode,
    ) -> RunCancellationRequestRecord | None:
        try:
            return self.cancellation_store.get(run_id, mode)
        except DatabaseRunCancellationStoreError as error:
            raise RunCancellationStoreError("Run cancellation data could not be read") from error

    def get_result(
        self, run: PublishedRun, job_ordinal: int, artifact_ordinal: int
    ) -> tuple[ResultRecord, bytes]:
        state = self.get_execution_state(run)
        for result in (result for job in state.jobs for result in job.results):
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

    def import_project(self, filesystem_key: str) -> ProjectHistoryScan:
        try:
            scan = self.history_scanner.scan(filesystem_key)
            self.history_store.replace_project(scan)
            return scan
        except HistoricalProjectConflictError as error:
            raise ProjectImportConflictError(str(error)) from error
        except (ProjectHistoryScanError, HistoricalProjectionError, OSError, ValueError) as error:
            raise ProjectImportError(str(error)) from error

    def reindex_project(self, project_id: str) -> ProjectHistoryScan:
        return self.import_project(self._registered_project_key(project_id))

    def list_project_runs(self, project_id: str) -> tuple[HistoricalRunRecord, ...]:
        self._registered_project_key(project_id)
        return self.history_store.list_runs(project_id)

    def list_project_diagnostics(self, project_id: str) -> tuple[HistoricalDiagnosticRecord, ...]:
        self._registered_project_key(project_id)
        return self.history_store.list_diagnostics(project_id)

    def _registered_project_key(self, project_id: str) -> str:
        try:
            return ProjectStore(self.history_store.database_path).get(project_id).filesystem_key
        except ProjectNotFoundError as error:
            raise ProjectHistoryNotFoundError(f"Project {project_id!r} was not found") from error

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
        needed = {
            item.asset_id
            for job in plan.jobs
            for item in job.resolved_image_inputs
            if item.asset_id is not None
        }
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
        for candidate in sorted(self.projects_root.glob("*/batches/*/*-*")):
            if not _RUN_DIRECTORY.fullmatch(candidate.name) or not candidate.is_dir():
                continue
            if candidate.is_symlink() or not _is_within(candidate, self.projects_root):
                raise RunDataError("published Run path is unsafe")
            candidates.append(candidate)
        return tuple(candidates)


def _is_within(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def materialize_random_seeds(
    count: int,
    random_seed_source: RandomSeedSource = secrets.randbelow,
) -> tuple[int, ...]:
    if count < 0:
        raise RunCreationError("Random seed assignment count must not be negative")
    if count > _SEED_SPACE_SIZE:
        raise RunCreationError("Random Job count exceeds the available seed space")

    seeds: list[int] = []
    used: set[int] = set()
    while len(seeds) < count:
        seed = random_seed_source(_SEED_SPACE_SIZE)
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < _SEED_SPACE_SIZE:
            raise RunCreationError(
                "Random seed source returned a value outside the allowed seed range"
            )
        if seed in used:
            continue
        used.add(seed)
        seeds.append(seed)
    return tuple(seeds)


def _historical_import_ids(
    project_id: str,
    run_id: str,
    resource_kind: str,
    import_request_id: str,
    *,
    position: int | None = None,
) -> tuple[str, str]:
    if not import_request_id.strip():
        raise HistoricalResourceImportError("Import request ID must be a nonempty string")
    parts: list[str | int] = [project_id, run_id, resource_kind]
    if position is not None:
        parts.append(position)
    parts.append(import_request_id)
    scope = json.dumps(parts, ensure_ascii=True, separators=(",", ":"))
    return (
        str(uuid5(_HISTORICAL_IMPORT_NAMESPACE, f"{scope}:logical")),
        str(uuid5(_HISTORICAL_IMPORT_NAMESPACE, f"{scope}:version")),
    )


def _historical_import_names(preferred_name: str) -> Iterator[str]:
    yield preferred_name
    yield f"{preferred_name} (imported)"
    for suffix in range(2, 10_001):
        yield f"{preferred_name} (imported {suffix})"


def _replay_historical_prompt_copy(
    library: LibraryService,
    *,
    prompt_id: str,
    version_id: str,
    project_id: str,
    text: str,
    error: Exception,
) -> tuple[PromptRecord, PromptVersionRecord] | None:
    try:
        prompt = library.get_prompt(prompt_id)
    except PromptNotFoundError:
        prompt = None
    try:
        version = library.get_prompt_version(version_id)
    except PromptVersionNotFoundError:
        version = None
    if prompt is None and version is None:
        return None
    if not (
        prompt is not None
        and version is not None
        and prompt.project_id == project_id
        and prompt.archived_at is None
        and version.prompt_id == prompt.id
        and version.version_number == 1
        and version.archived_at is None
        and version.text == text
    ):
        raise _historical_import_collision("Prompt") from error
    return prompt, version


def _replay_historical_workflow_copy(
    library: LibraryService,
    *,
    workflow_id: str,
    version_id: str,
    project_id: str,
    content_sha256: str,
    error: Exception,
) -> tuple[WorkflowRecord, WorkflowVersionRecord] | None:
    try:
        workflow = library.get_workflow(workflow_id)
    except WorkflowNotFoundError:
        workflow = None
    try:
        version = library.get_workflow_version(version_id)
    except WorkflowVersionNotFoundError:
        version = None
    if workflow is None and version is None:
        return None
    if not (
        workflow is not None
        and version is not None
        and workflow.project_id == project_id
        and workflow.archived_at is None
        and version.workflow_id == workflow.id
        and version.project_id == project_id
        and version.version_number == 1
        and version.archived_at is None
        and version.content_sha256 == content_sha256
    ):
        raise _historical_import_collision("Workflow") from error
    return workflow, version


def _replay_historical_workflow_profile_copy(
    library: LibraryService,
    *,
    profile_id: str,
    version_id: str,
    project_id: str,
    workflow_id: str,
    workflow_version_id: str,
    mappings: Mapping[str, object],
    image_inputs: list[object],
    parameters: list[object],
    error: Exception,
) -> tuple[WorkflowProfileRecord, WorkflowProfileVersionRecord] | None:
    try:
        profile = library.get_workflow_profile(profile_id)
    except WorkflowProfileNotFoundError:
        profile = None
    try:
        version = library.get_workflow_profile_version(version_id)
    except WorkflowProfileVersionNotFoundError:
        version = None
    if profile is None and version is None:
        return None
    stored = {} if version is None else version.profile
    source_payload = {
        "mappings": dict(mappings),
        "image_inputs": image_inputs,
        "parameters": parameters,
    }
    stored_payload = {key: stored.get(key) for key in source_payload}
    if not (
        profile is not None
        and version is not None
        and profile.project_id == project_id
        and profile.workflow_id == workflow_id
        and profile.archived_at is None
        and version.workflow_profile_id == profile.id
        and version.workflow_id == workflow_id
        and version.project_id == project_id
        and version.workflow_version_id == workflow_version_id
        and version.version_number == 1
        and version.archived_at is None
        and set(stored) == {"id", "name", *source_payload}
        and stored.get("id") == profile.id
        and _canonical_sha256(stored_payload) == _canonical_sha256(source_payload)
    ):
        raise _historical_import_collision("Workflow Profile") from error
    return profile, version


def _canonical_sha256(value: object) -> str:
    serialized = json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(f"{serialized}\n".encode()).hexdigest()


def _historical_import_collision(resource_label: str) -> HistoricalResourceImportConflictError:
    return HistoricalResourceImportConflictError(
        f"Historical {resource_label} import request IDs are occupied by incoherent library records"
    )


def _classify_prompt_version(
    store: PromptStore,
    snapshot: SnapshotPromptVersion,
    project_id: str,
    *,
    project_context_matches: bool,
) -> ResourceLink:
    prompt = snapshot
    version_id = prompt.id
    try:
        version = store.get_version(version_id)
    except PromptVersionNotFoundError:
        return ResourceLink(version_id, ResourceLinkStatus.DETACHED)
    try:
        parent = store.get(version.prompt_id)
    except PromptNotFoundError:
        return ResourceLink(version_id, ResourceLinkStatus.CONFLICT)
    if version.archived_at is not None or parent.archived_at is not None:
        return ResourceLink(version_id, ResourceLinkStatus.DETACHED)
    matches = (
        version.name_snapshot == prompt.name
        and version.text == prompt.text
        and project_context_matches
        and parent.project_id == project_id
        and (prompt.prompt_id is None or version.prompt_id == prompt.prompt_id)
        and (prompt.version_number is None or version.version_number == prompt.version_number)
    )
    if not matches:
        return ResourceLink(version_id, ResourceLinkStatus.CONFLICT)
    return ResourceLink(
        historical_version_id=version_id,
        status=ResourceLinkStatus.LINKED,
        linked_version_id=version.id,
        linked_resource_id=version.prompt_id,
    )


def _classify_workflow_version(
    store: WorkflowStore,
    selection: SnapshotWorkflowSelection,
    project_id: str,
    frozen_content_sha256: str,
    *,
    project_context_matches: bool,
) -> ResourceLink:
    version_id = selection.workflow_version_id
    if version_id is None:
        return ResourceLink(None, ResourceLinkStatus.DETACHED)
    try:
        version = store.get_version(version_id)
    except WorkflowVersionNotFoundError:
        return ResourceLink(version_id, ResourceLinkStatus.DETACHED)
    try:
        parent = store.get(version.workflow_id)
    except WorkflowNotFoundError:
        return ResourceLink(version_id, ResourceLinkStatus.CONFLICT)
    if version.archived_at is not None or parent.archived_at is not None:
        return ResourceLink(version_id, ResourceLinkStatus.DETACHED)
    matches = (
        version.content_sha256 == frozen_content_sha256
        and project_context_matches
        and version.project_id == project_id
        and parent.project_id == project_id
        and (selection.workflow_id is None or version.workflow_id == selection.workflow_id)
        and (
            selection.workflow_version_number is None
            or version.version_number == selection.workflow_version_number
        )
    )
    if not matches:
        return ResourceLink(version_id, ResourceLinkStatus.CONFLICT)
    return ResourceLink(
        historical_version_id=version_id,
        status=ResourceLinkStatus.LINKED,
        linked_version_id=version.id,
        linked_resource_id=version.workflow_id,
    )


def _classify_workflow_profile_version(
    store: WorkflowProfileStore,
    selection: SnapshotWorkflowSelection,
    project_id: str,
    workflow_status: ResourceLinkStatus,
    frozen_content_sha256: str,
    *,
    project_context_matches: bool,
) -> ResourceLink:
    version_id = selection.workflow_profile_version_id
    if version_id is None:
        return ResourceLink(None, ResourceLinkStatus.DETACHED)
    try:
        version = store.get_version(version_id)
    except WorkflowProfileVersionNotFoundError:
        return ResourceLink(version_id, ResourceLinkStatus.DETACHED)
    try:
        parent = store.get(version.workflow_profile_id)
    except WorkflowProfileNotFoundError:
        return ResourceLink(version_id, ResourceLinkStatus.CONFLICT)
    if version.archived_at is not None or parent.archived_at is not None:
        return ResourceLink(version_id, ResourceLinkStatus.DETACHED)
    matches = (
        version.content_sha256 == frozen_content_sha256
        and project_context_matches
        and version.project_id == project_id
        and parent.project_id == project_id
        and parent.workflow_id == version.workflow_id
        and (
            selection.workflow_profile_id is None
            or version.workflow_profile_id == selection.workflow_profile_id
        )
        and (selection.workflow_id is None or version.workflow_id == selection.workflow_id)
        and (
            selection.workflow_version_id is None
            or version.workflow_version_id == selection.workflow_version_id
        )
        and (
            selection.workflow_profile_version_number is None
            or version.version_number == selection.workflow_profile_version_number
        )
    )
    if not matches:
        status = ResourceLinkStatus.CONFLICT
    elif workflow_status is ResourceLinkStatus.LINKED:
        status = ResourceLinkStatus.LINKED
    elif workflow_status is ResourceLinkStatus.CONFLICT:
        status = ResourceLinkStatus.CONFLICT
    else:
        status = ResourceLinkStatus.DETACHED
    if status is not ResourceLinkStatus.LINKED:
        return ResourceLink(version_id, status)
    return ResourceLink(
        historical_version_id=version_id,
        status=status,
        linked_version_id=version.id,
        linked_resource_id=version.workflow_profile_id,
    )


def _registered_project_context_matches(
    store: ProjectStore,
    project_id: str,
    filesystem_key: str,
) -> bool:
    try:
        project = store.get(project_id)
    except ProjectNotFoundError:
        return False
    return project.filesystem_key == filesystem_key


def _cancellation_request_result(
    state: RunExecutionState,
    intent: RunCancellationRequestRecord,
    *,
    created: bool,
) -> RunCancellationRequestResult:
    cancellation = _run_cancellation(state, intent)
    return RunCancellationRequestResult(
        run_id=state.run_id,
        mode=cancellation.mode,
        requested_at=cancellation.requested_at,
        created=created,
        state=cancellation.state,
    )


def _run_cancellation(
    state: RunExecutionState,
    intent: RunCancellationRequestRecord | None,
) -> RunCancellation:
    mode = RunCancellationMode.AFTER_CURRENT_JOB if intent is None else intent.mode
    if state.status is RunExecutionStatus.CANCELLED:
        cancellation_state = RunCancellationState.CANCELLED
    elif (
        mode is RunCancellationMode.DETACH
        and state.status is RunExecutionStatus.BLOCKED
        and state.diagnostics == (USER_DETACHED_FROM_CURRENT_JOB,)
    ):
        cancellation_state = RunCancellationState.DETACHED
    elif state.status in {
        RunExecutionStatus.SUCCEEDED,
        RunExecutionStatus.FAILED,
        RunExecutionStatus.BLOCKED,
    }:
        cancellation_state = RunCancellationState.FINISHED
    elif mode is RunCancellationMode.DETACH:
        cancellation_state = RunCancellationState.DETACH_REQUESTED
    elif state.status is RunExecutionStatus.RUNNING and any(
        job.ordinal == state.current_job_ordinal
        and job.status
        in {
            JobExecutionStatus.SUBMITTING,
            JobExecutionStatus.SUBMISSION_UNKNOWN,
            JobExecutionStatus.SUBMITTED,
        }
        for job in state.jobs
    ):
        cancellation_state = RunCancellationState.STOPPING_AFTER_CURRENT_JOB
    else:
        cancellation_state = RunCancellationState.STOP_REQUESTED
    return RunCancellation(
        mode=mode,
        requested_at=None if intent is None else intent.requested_at,
        state=cancellation_state,
    )


def _timestamp(clock: Callable[[], datetime]) -> str:
    value = clock()
    if value.tzinfo is None:
        raise ValueError("application clock must return a timezone-aware datetime")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


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
