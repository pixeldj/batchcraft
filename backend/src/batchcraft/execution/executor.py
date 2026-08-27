import asyncio
import copy
import mimetypes
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import AbstractAsyncContextManager, suppress
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from batchcraft.comfyui import (
    DownloadedArtifact,
    ExecutionEvent,
    ExecutionOutcome,
    ExecutionStatus,
    PromptSubmission,
    RemoteOutputArtifact,
    SubmissionDisposition,
    UploadedInput,
    WorkflowPreparationValues,
    prepare_workflow,
)
from batchcraft.files import PersistedJob, ProjectAssetStore, PublishedRun

from .models import (
    ExecutionConfig,
    JobExecutionState,
    JobExecutionStatus,
    RunExecutionState,
    RunExecutionStatus,
)
from .state import ExecutionStateStore, safe_extension


class EventSource(Protocol):
    def events(self, prompt_id: str) -> AsyncIterator[ExecutionEvent]: ...


class ExecutionClient(Protocol):
    async def upload_input(
        self,
        *,
        filename: str,
        content: bytes,
        mime_type: str = "application/octet-stream",
        subfolder: str = "",
    ) -> UploadedInput: ...

    def open_event_stream(self, client_id: str) -> AbstractAsyncContextManager[EventSource]: ...

    async def submit_prompt(
        self, workflow: Mapping[str, object], *, client_id: str
    ) -> PromptSubmission: ...

    async def get_history(self, prompt_id: str) -> ExecutionOutcome | None: ...

    async def download_artifact(self, artifact: RemoteOutputArtifact) -> DownloadedArtifact: ...


WorkflowPreparer = Callable[
    [Mapping[str, object], Mapping[str, object], WorkflowPreparationValues],
    dict[str, object],
]


class RunExecutionError(RuntimeError):
    """A published Run cannot be safely executed by the v1 executor."""


async def execute_run(
    *,
    run: PublishedRun,
    client: ExecutionClient,
    config: ExecutionConfig | None = None,
    state_store: ExecutionStateStore | None = None,
    workflow_preparer: WorkflowPreparer = prepare_workflow,
    clock: Callable[[], datetime] | None = None,
    id_factory: Callable[[], str] | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> RunExecutionState:
    settings = config or ExecutionConfig()
    store = state_store or ExecutionStateStore(run.path)
    current_time = clock or (lambda: datetime.now(UTC))
    new_id = id_factory or (lambda: str(uuid4()))
    immutable_files = _immutable_file_bytes(run.path)
    original_plan = copy.deepcopy(run.compiled_plan)
    original_workflow = copy.deepcopy(run.workflow)
    original_profile = copy.deepcopy(run.workflow_profile)

    try:
        state = store.initialize(run)
        if state.status is not RunExecutionStatus.CREATED or any(
            job.status is not JobExecutionStatus.PENDING for job in state.jobs
        ):
            raise RunExecutionError(
                "automatic execution recovery is not implemented; existing state must be "
                "reconciled explicitly"
            )
        state = replace(
            state,
            status=RunExecutionStatus.RUNNING,
            started_at=_timestamp(current_time),
        )
        store.save(run, state)

        persisted_jobs = tuple(sorted(run.jobs, key=lambda job: job.compiled_job.ordinal))
        for persisted_job in persisted_jobs:
            ordinal = persisted_job.compiled_job.ordinal
            state = replace(state, current_job_ordinal=ordinal)
            store.save(run, state)
            state = await _execute_job(
                run=run,
                persisted_job=persisted_job,
                state=state,
                client=client,
                store=store,
                config=settings,
                workflow_preparer=workflow_preparer,
                clock=current_time,
                id_factory=new_id,
                sleep=sleep,
                monotonic=monotonic,
            )
            job_state = state.jobs[ordinal - 1]
            if job_state.status is JobExecutionStatus.SUCCEEDED:
                continue
            if job_state.status in {
                JobExecutionStatus.SUBMISSION_UNKNOWN,
                JobExecutionStatus.SUBMITTED,
            }:
                state = replace(
                    state,
                    status=RunExecutionStatus.BLOCKED,
                    error=job_state.error,
                    diagnostics=job_state.diagnostics,
                )
            else:
                state = replace(
                    state,
                    status=RunExecutionStatus.FAILED,
                    completed_at=_timestamp(current_time),
                    error=job_state.error,
                    diagnostics=job_state.diagnostics,
                )
            store.save(run, state)
            return state

        state = replace(
            state,
            status=RunExecutionStatus.SUCCEEDED,
            completed_at=_timestamp(current_time),
            current_job_ordinal=None,
        )
        store.save(run, state)
        return state
    finally:
        if _immutable_file_bytes(run.path) != immutable_files:
            raise RunExecutionError("Run execution changed immutable provenance files")
        if run.compiled_plan != original_plan:
            raise RunExecutionError("Run execution changed the CompiledRunPlan")
        if run.workflow != original_workflow or run.workflow_profile != original_profile:
            raise RunExecutionError("Run execution changed an in-memory workflow snapshot")


async def _execute_job(
    *,
    run: PublishedRun,
    persisted_job: PersistedJob,
    state: RunExecutionState,
    client: ExecutionClient,
    store: ExecutionStateStore,
    config: ExecutionConfig,
    workflow_preparer: WorkflowPreparer,
    clock: Callable[[], datetime],
    id_factory: Callable[[], str],
    sleep: Callable[[float], Awaitable[None]],
    monotonic: Callable[[], float],
) -> RunExecutionState:
    ordinal = persisted_job.compiled_job.ordinal
    job_state = state.jobs[ordinal - 1]
    client_id = id_factory()
    preparing = replace(
        job_state,
        status=JobExecutionStatus.PREPARING,
        client_id=client_id,
        started_at=_timestamp(clock),
    )
    state = _persist_job(run, store, state, preparing)

    try:
        asset = ProjectAssetStore(run.path.parents[2]).validate_record(
            persisted_job.reference_asset
        )
        asset_path = run.path.parents[2] / asset.stored_path
        content = asset_path.read_bytes()
        reference_filename = f"reference{safe_extension(asset.original_filename, asset.mime_type)}"
        uploaded = await client.upload_input(
            filename=reference_filename,
            content=content,
            mime_type=asset.mime_type
            or mimetypes.guess_type(reference_filename)[0]
            or "application/octet-stream",
            subfolder=f"batchcraft/{run.run_id}/{persisted_job.job_id}/input",
        )
        prepared = workflow_preparer(
            run.workflow,
            run.workflow_profile,
            WorkflowPreparationValues(
                prompt=persisted_job.compiled_job.resolved_prompt,
                reference_image=uploaded.workflow_value,
                seed=persisted_job.compiled_job.seed,
                output_prefix=f"batchcraft/{run.run_id}/{persisted_job.job_id}/result",
            ),
        )
    except Exception as error:
        return _fail_job(run, store, state, ordinal, error, clock)

    reconciling = False
    try:
        async with client.open_event_stream(client_id) as event_source:
            submitting = replace(
                state.jobs[ordinal - 1],
                status=JobExecutionStatus.SUBMITTING,
            )
            state = _persist_job(run, store, state, submitting)
            try:
                submission = await client.submit_prompt(prepared, client_id=client_id)
            except Exception as error:
                unknown = replace(
                    state.jobs[ordinal - 1],
                    status=JobExecutionStatus.SUBMISSION_UNKNOWN,
                    submission_disposition=SubmissionDisposition.UNKNOWN,
                    error=f"prompt submission raised {type(error).__name__}: {error}",
                    diagnostics=(str(error),),
                )
                return _persist_job(run, store, state, unknown)

            state = _persist_submission(run, store, state, ordinal, submission, clock)
            current = state.jobs[ordinal - 1]
            if current.status is not JobExecutionStatus.SUBMITTED:
                return state
            observation = asyncio.create_task(
                _observe_events(
                    event_source,
                    current.prompt_id or "",
                    config.websocket_timeout_seconds,
                )
            )
            reconciliation = asyncio.create_task(
                _reconcile_and_ingest(
                    run=run,
                    persisted_job=persisted_job,
                    state=state,
                    client=client,
                    store=store,
                    config=config,
                    clock=clock,
                    sleep=sleep,
                    monotonic=monotonic,
                )
            )
            reconciling = True
            observation_diagnostic = None
            try:
                state = await reconciliation
            finally:
                observation.cancel()
                with suppress(asyncio.CancelledError):
                    observation_diagnostic = await observation
            if observation_diagnostic is not None and state.jobs[ordinal - 1].status in {
                JobExecutionStatus.SUBMITTED,
                JobExecutionStatus.SUBMISSION_UNKNOWN,
            }:
                state = _add_job_diagnostic(
                    run,
                    store,
                    state,
                    ordinal,
                    observation_diagnostic,
                )
            return state
    except Exception as error:
        current = state.jobs[ordinal - 1]
        if current.status is JobExecutionStatus.PREPARING:
            return _fail_job(run, store, state, ordinal, error, clock)
        if current.status is JobExecutionStatus.SUBMITTING:
            unknown = replace(
                current,
                status=JobExecutionStatus.SUBMISSION_UNKNOWN,
                submission_disposition=SubmissionDisposition.UNKNOWN,
                error=f"submission stream failed: {type(error).__name__}: {error}",
                diagnostics=(*current.diagnostics, str(error)),
            )
            return _persist_job(run, store, state, unknown)
        if current.status is JobExecutionStatus.SUBMITTED:
            if reconciling:
                raise
            state = _add_job_diagnostic(
                run,
                store,
                state,
                ordinal,
                f"WebSocket stream failed after acceptance: {type(error).__name__}: {error}",
            )
        else:
            return state

    return state


async def _observe_events(
    event_source: EventSource,
    prompt_id: str,
    timeout_seconds: float,
) -> str | None:
    try:
        async with asyncio.timeout(timeout_seconds):
            async for event in event_source.events(prompt_id):
                if event.is_terminal_advisory:
                    break
    except Exception as error:
        return f"WebSocket observation failed: {type(error).__name__}: {error}"
    return None


def _persist_submission(
    run: PublishedRun,
    store: ExecutionStateStore,
    state: RunExecutionState,
    ordinal: int,
    submission: PromptSubmission,
    clock: Callable[[], datetime],
) -> RunExecutionState:
    current = state.jobs[ordinal - 1]
    if submission.disposition is SubmissionDisposition.ACCEPTED:
        if not submission.prompt_id:
            raise RunExecutionError("accepted prompt submission has no prompt ID")
        updated = replace(
            current,
            status=JobExecutionStatus.SUBMITTED,
            submission_disposition=submission.disposition,
            submission_http_status=submission.http_status,
            submission_response=submission.response,
            prompt_id=submission.prompt_id,
            diagnostics=(submission.diagnostic,) if submission.diagnostic else (),
        )
    elif submission.disposition is SubmissionDisposition.UNKNOWN:
        updated = replace(
            current,
            status=JobExecutionStatus.SUBMISSION_UNKNOWN,
            submission_disposition=submission.disposition,
            submission_http_status=submission.http_status,
            submission_response=submission.response,
            error=submission.diagnostic or "prompt submission outcome is unknown",
            diagnostics=(submission.diagnostic,) if submission.diagnostic else (),
        )
    else:
        updated = replace(
            current,
            status=JobExecutionStatus.FAILED,
            submission_disposition=submission.disposition,
            submission_http_status=submission.http_status,
            submission_response=submission.response,
            completed_at=_timestamp(clock),
            error=submission.diagnostic or "prompt submission was rejected",
            diagnostics=(submission.diagnostic,) if submission.diagnostic else (),
        )
    return _persist_job(run, store, state, updated)


async def _reconcile_and_ingest(
    *,
    run: PublishedRun,
    persisted_job: PersistedJob,
    state: RunExecutionState,
    client: ExecutionClient,
    store: ExecutionStateStore,
    config: ExecutionConfig,
    clock: Callable[[], datetime],
    sleep: Callable[[float], Awaitable[None]],
    monotonic: Callable[[], float],
) -> RunExecutionState:
    ordinal = persisted_job.compiled_job.ordinal
    prompt_id = state.jobs[ordinal - 1].prompt_id
    if not prompt_id:
        raise RunExecutionError(f"submitted Job {ordinal} has no prompt ID")
    deadline = monotonic() + config.history_timeout_seconds
    outcome: ExecutionOutcome | None = None
    while True:
        remaining = deadline - monotonic()
        if remaining <= 0:
            return _history_timeout(run, store, state, ordinal, config)
        try:
            async with asyncio.timeout(remaining):
                candidate = await client.get_history(prompt_id)
        except TimeoutError:
            return _history_timeout(run, store, state, ordinal, config)
        except Exception as error:
            state = _add_job_diagnostic(
                run,
                store,
                state,
                ordinal,
                f"history lookup failed: {type(error).__name__}: {error}",
            )
        else:
            if candidate is not None and candidate.status is not ExecutionStatus.PENDING:
                outcome = candidate
                break
        remaining = deadline - monotonic()
        if remaining <= 0:
            return _history_timeout(run, store, state, ordinal, config)
        await sleep(min(config.history_poll_interval_seconds, remaining))

    current = state.jobs[ordinal - 1]
    state = _persist_job(run, store, state, replace(current, history_status=outcome.status_data))
    if outcome.status is ExecutionStatus.FAILED:
        return _fail_job(
            run,
            store,
            state,
            ordinal,
            RuntimeError(f"ComfyUI execution failed: {outcome.status_data}"),
            clock,
        )

    for artifact_ordinal, artifact in enumerate(outcome.artifacts, start=1):
        result = None
        try:
            downloaded = await client.download_artifact(artifact)
            result = store.persist_result(
                job_id=persisted_job.job_id,
                job_ordinal=ordinal,
                artifact_ordinal=artifact_ordinal,
                downloaded=downloaded,
            )
            current = state.jobs[ordinal - 1]
            state = _persist_job(
                run,
                store,
                state,
                replace(current, results=(*current.results, result)),
            )
        except Exception as error:
            if result is not None:
                try:
                    persisted_state = store.load(run)
                    persisted_job_state = persisted_state.jobs[ordinal - 1]
                    if result in persisted_job_state.results:
                        state = persisted_state
                    else:
                        store.discard_unrecorded_result(result)
                except Exception as cleanup_error:
                    error = RunExecutionError(
                        f"{error}; could not reconcile unrecorded Result: {cleanup_error}"
                    )
            return _fail_job(run, store, state, ordinal, error, clock)

    succeeded = replace(
        state.jobs[ordinal - 1],
        status=JobExecutionStatus.SUCCEEDED,
        completed_at=_timestamp(clock),
        error=None,
    )
    return _persist_job(run, store, state, succeeded)


def _history_timeout(
    run: PublishedRun,
    store: ExecutionStateStore,
    state: RunExecutionState,
    ordinal: int,
    config: ExecutionConfig,
) -> RunExecutionState:
    return _add_job_diagnostic(
        run,
        store,
        state,
        ordinal,
        f"history did not reach terminal state within {config.history_timeout_seconds} seconds",
        error="history reconciliation timed out",
    )


def _persist_job(
    run: PublishedRun,
    store: ExecutionStateStore,
    state: RunExecutionState,
    job: JobExecutionState,
) -> RunExecutionState:
    jobs = list(state.jobs)
    jobs[job.ordinal - 1] = job
    updated = replace(state, jobs=tuple(jobs))
    store.save(run, updated)
    return updated


def _fail_job(
    run: PublishedRun,
    store: ExecutionStateStore,
    state: RunExecutionState,
    ordinal: int,
    error: Exception,
    clock: Callable[[], datetime],
) -> RunExecutionState:
    current = state.jobs[ordinal - 1]
    diagnostic = f"{type(error).__name__}: {error}"
    failed = replace(
        current,
        status=JobExecutionStatus.FAILED,
        completed_at=_timestamp(clock),
        error=diagnostic,
        diagnostics=(*current.diagnostics, diagnostic),
    )
    return _persist_job(run, store, state, failed)


def _add_job_diagnostic(
    run: PublishedRun,
    store: ExecutionStateStore,
    state: RunExecutionState,
    ordinal: int,
    diagnostic: str,
    *,
    error: str | None = None,
) -> RunExecutionState:
    current = state.jobs[ordinal - 1]
    diagnostics = (
        current.diagnostics
        if diagnostic in current.diagnostics
        else (*current.diagnostics, diagnostic)
    )
    return _persist_job(
        run,
        store,
        state,
        replace(current, diagnostics=diagnostics, error=error or current.error),
    )


def _timestamp(clock: Callable[[], datetime]) -> str:
    value = clock()
    if value.tzinfo is None:
        raise RunExecutionError("execution clock must return a timezone-aware datetime")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _immutable_file_bytes(run_path: Path) -> tuple[bytes, bytes, bytes, bytes, bytes]:
    try:
        return (
            (run_path / "run.json").read_bytes(),
            (run_path / "manifest.json").read_bytes(),
            (run_path / "manifest.csv").read_bytes(),
            (run_path / "workflow.json").read_bytes(),
            (run_path / "workflow-profile.json").read_bytes(),
        )
    except OSError as error:
        raise RunExecutionError(f"cannot read immutable Run provenance: {error}") from error
