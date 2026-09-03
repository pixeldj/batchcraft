import hashlib
import mimetypes
import os
import re
from enum import StrEnum
from pathlib import Path, PurePosixPath
from typing import cast
from uuid import uuid4

from batchcraft.comfyui import DownloadedArtifact, SubmissionDisposition
from batchcraft.files import PublishedRun
from batchcraft.files._io import (
    canonical_json_bytes,
    fsync_directory,
    read_json_object,
    write_bytes,
)
from batchcraft.files.formats import (
    EXECUTION_FORMAT,
    format_header,
    require_exact_keys,
    validate_format_record,
)
from batchcraft.files.formats import EXECUTION_FORMAT_VERSION as _EXECUTION_FORMAT_VERSION

from .models import (
    JobExecutionState,
    JobExecutionStatus,
    ResultRecord,
    RunExecutionState,
    RunExecutionStatus,
)

EXECUTION_FORMAT_VERSION = _EXECUTION_FORMAT_VERSION
EXECUTION_FILENAME = "execution.json"
DISCARDED_BEFORE_START = "discarded_before_start"
STOPPED_AFTER_CURRENT_JOB = "stopped_after_current_job"
USER_DETACHED_FROM_CURRENT_JOB = (
    "User detached from current Job while remote completion was unconfirmed."
)
_SAFE_EXTENSION = re.compile(r"\.[A-Za-z0-9]{1,10}")
_RUN_TRANSITIONS = {
    RunExecutionStatus.CREATED: {
        RunExecutionStatus.RUNNING,
        RunExecutionStatus.CANCELLED,
    },
    RunExecutionStatus.RUNNING: {
        RunExecutionStatus.SUCCEEDED,
        RunExecutionStatus.FAILED,
        RunExecutionStatus.BLOCKED,
        RunExecutionStatus.CANCELLED,
    },
    RunExecutionStatus.SUCCEEDED: set(),
    RunExecutionStatus.FAILED: set(),
    RunExecutionStatus.CANCELLED: set(),
    RunExecutionStatus.BLOCKED: {
        RunExecutionStatus.RUNNING,
        RunExecutionStatus.SUCCEEDED,
        RunExecutionStatus.FAILED,
    },
}
_JOB_TRANSITIONS = {
    JobExecutionStatus.PENDING: {
        JobExecutionStatus.PREPARING,
        JobExecutionStatus.CANCELLED,
    },
    JobExecutionStatus.PREPARING: {
        JobExecutionStatus.SUBMITTING,
        JobExecutionStatus.FAILED,
        JobExecutionStatus.CANCELLED,
    },
    JobExecutionStatus.SUBMITTING: {
        JobExecutionStatus.SUBMITTED,
        JobExecutionStatus.SUBMISSION_UNKNOWN,
        JobExecutionStatus.FAILED,
    },
    JobExecutionStatus.SUBMISSION_UNKNOWN: {
        JobExecutionStatus.SUBMITTED,
        JobExecutionStatus.FAILED,
    },
    JobExecutionStatus.SUBMITTED: {
        JobExecutionStatus.SUCCEEDED,
        JobExecutionStatus.FAILED,
    },
    JobExecutionStatus.SUCCEEDED: set(),
    JobExecutionStatus.FAILED: set(),
    JobExecutionStatus.CANCELLED: set(),
}


class ExecutionStateError(ValueError):
    """Mutable Run execution state or Result storage is invalid."""


class ExecutionStateStore:
    def __init__(self, run_path: Path, *, producer_version: str | None = None) -> None:
        self.run_path = run_path
        self.state_path = run_path / EXECUTION_FILENAME
        self.outputs_path = run_path / "outputs"
        self._producer_version = producer_version

    def initialize(self, run: PublishedRun) -> RunExecutionState:
        if self.state_path.is_symlink():
            raise ExecutionStateError("execution state path must not be a symlink")
        if self.state_path.exists():
            return self.load(run)
        state = initial_execution_state(run)
        self._validate_against_run(run, state)
        self._atomic_replace(
            self.state_path,
            canonical_json_bytes(_state_data(state, self._producer_version)),
        )
        return state

    def load(self, run: PublishedRun) -> RunExecutionState:
        return self._load(run, verify_result_files=True)

    def read_for_query(self, run: PublishedRun) -> RunExecutionState:
        return self._load(run, verify_result_files=False)

    def _load(self, run: PublishedRun, *, verify_result_files: bool) -> RunExecutionState:
        if self.state_path.is_symlink() or not self.state_path.is_file():
            raise ExecutionStateError("execution state path must be a regular file")
        try:
            state = _parse_state(read_json_object(self.state_path))
        except (OSError, ValueError) as error:
            if isinstance(error, ExecutionStateError):
                raise
            raise ExecutionStateError(f"invalid execution state: {error}") from error
        self._validate_against_run(run, state, verify_result_files=verify_result_files)
        return state

    def save(self, run: PublishedRun, state: RunExecutionState) -> None:
        previous: RunExecutionState | None = None
        if self.state_path.is_symlink():
            raise ExecutionStateError("execution state path must not be a symlink")
        if self.state_path.exists():
            previous = self._load(run, verify_result_files=False)
        self._validate_against_run(run, state, verify_result_files=False)
        if previous is not None:
            _validate_transition(previous, state)
            _verify_new_result_files(self.run_path, previous, state)
        else:
            _verify_result_files(
                self.run_path,
                tuple(result for job in state.jobs for result in job.results),
            )
        self._atomic_replace(
            self.state_path,
            canonical_json_bytes(_state_data(state, self._producer_version)),
        )

    def validate_storage(self, run: PublishedRun) -> None:
        self._validate_against_run(
            run,
            initial_execution_state(run),
            verify_result_files=False,
        )

    def persist_result(
        self,
        *,
        job_id: str,
        job_ordinal: int,
        artifact_ordinal: int,
        downloaded: DownloadedArtifact,
    ) -> ResultRecord:
        if job_ordinal <= 0 or artifact_ordinal <= 0:
            raise ExecutionStateError("Result ordinals must be positive")
        digest = hashlib.sha256(downloaded.content).hexdigest()
        if digest != downloaded.sha256:
            raise ExecutionStateError(
                f"downloaded artifact {downloaded.remote.filename!r} has a mismatched SHA-256"
            )
        extension = safe_extension(downloaded.remote.filename, downloaded.content_type)
        local_name = f"{job_ordinal:06d}-{artifact_ordinal:02d}{extension}"
        self._validate_outputs_directory()
        local_path = self.outputs_path / local_name
        if local_path.parent != self.outputs_path:
            raise ExecutionStateError("Result path escaped the Run outputs directory")
        if local_path.exists():
            if local_path.is_symlink() or not local_path.is_file():
                raise ExecutionStateError(
                    f"existing Result path is not a regular file: {local_path}"
                )
            if local_path.read_bytes() != downloaded.content:
                raise ExecutionStateError(
                    f"existing Result {local_name} has different content and cannot be replaced"
                )
        else:
            self._atomic_replace(local_path, downloaded.content)
        return ResultRecord(
            job_id=job_id,
            job_ordinal=job_ordinal,
            artifact_ordinal=artifact_ordinal,
            producing_node_id=downloaded.remote.producing_node_id,
            output_name=downloaded.remote.output_name,
            remote_filename=downloaded.remote.filename,
            remote_subfolder=downloaded.remote.subfolder,
            remote_type=downloaded.remote.remote_type,
            local_path=local_path.relative_to(self.run_path).as_posix(),
            content_type=downloaded.content_type,
            byte_size=len(downloaded.content),
            sha256=digest,
        )

    def discard_unrecorded_result(self, result: ResultRecord) -> None:
        self._validate_outputs_directory()
        result_path = self.run_path / result.local_path
        if result_path.parent != self.outputs_path or result_path.is_symlink():
            raise ExecutionStateError("unrecorded Result path is unsafe")
        if not result_path.exists():
            return
        if (
            not result_path.is_file()
            or result_path.stat().st_size != result.byte_size
            or _sha256_file(result_path) != result.sha256
        ):
            raise ExecutionStateError(
                f"unrecorded Result changed before cleanup: {result.local_path}"
            )
        result_path.unlink()
        fsync_directory(self.outputs_path)

    def _validate_against_run(
        self,
        run: PublishedRun,
        state: RunExecutionState,
        *,
        verify_result_files: bool = True,
    ) -> None:
        if self.run_path != run.path:
            raise ExecutionStateError("execution state store path does not match the Run path")
        if state.run_id != run.run_id:
            raise ExecutionStateError("execution state Run ID does not match the published Run")
        expected_jobs = tuple((job.job_id, job.compiled_job.ordinal) for job in run.jobs)
        actual_jobs = tuple((job.job_id, job.ordinal) for job in state.jobs)
        if actual_jobs != expected_jobs:
            raise ExecutionStateError("execution state Jobs do not match the published Run")
        _validate_state(state)
        self._validate_outputs_directory()
        if verify_result_files:
            _verify_result_files(
                self.run_path,
                tuple(result for job in state.jobs for result in job.results),
            )

    def _validate_outputs_directory(self) -> None:
        if self.outputs_path.is_symlink() or not self.outputs_path.is_dir():
            raise ExecutionStateError("Run outputs path must be a real directory")
        if self.outputs_path.resolve().parent != self.run_path.resolve():
            raise ExecutionStateError("Run outputs directory escapes the Run path")

    def _atomic_replace(self, path: Path, content: bytes) -> None:
        if not path.parent.is_dir():
            raise ExecutionStateError(f"required directory is missing: {path.parent}")
        temporary_path = path.parent / f".{path.name}.{uuid4()}.tmp"
        try:
            write_bytes(temporary_path, content)
            os.replace(temporary_path, path)
            fsync_directory(path.parent)
        except OSError as error:
            raise ExecutionStateError(f"failed to persist {path.name}: {error}") from error
        finally:
            temporary_path.unlink(missing_ok=True)


def safe_extension(remote_filename: str, content_type: str | None) -> str:
    basename = PurePosixPath(remote_filename.replace("\\", "/")).name
    suffix = PurePosixPath(basename).suffix
    if _SAFE_EXTENSION.fullmatch(suffix):
        return suffix.lower()
    if content_type:
        guessed = mimetypes.guess_extension(content_type.partition(";")[0].strip().lower()) or ""
        if _SAFE_EXTENSION.fullmatch(guessed):
            return guessed.lower()
    return ".bin"


def initial_execution_state(run: PublishedRun) -> RunExecutionState:
    return RunExecutionState(
        run_id=run.run_id,
        status=RunExecutionStatus.CREATED,
        started_at=None,
        completed_at=None,
        current_job_ordinal=None,
        error=None,
        diagnostics=(),
        jobs=tuple(
            JobExecutionState(
                job_id=job.job_id,
                ordinal=job.compiled_job.ordinal,
                status=JobExecutionStatus.PENDING,
                client_id=None,
                submission_disposition=None,
                submission_http_status=None,
                submission_response=None,
                prompt_id=None,
                started_at=None,
                completed_at=None,
                error=None,
                diagnostics=(),
                history_status=None,
                results=(),
            )
            for job in run.jobs
        ),
    )


def _validate_transition(previous: RunExecutionState, current: RunExecutionState) -> None:
    if current.run_id != previous.run_id:
        raise ExecutionStateError("execution state cannot change its Run ID")
    if (
        current.status != previous.status
        and current.status not in _RUN_TRANSITIONS[previous.status]
    ):
        raise ExecutionStateError(
            f"illegal Run state transition: {previous.status.value} -> {current.status.value}"
        )
    if (
        previous.status
        in {
            RunExecutionStatus.SUCCEEDED,
            RunExecutionStatus.FAILED,
            RunExecutionStatus.CANCELLED,
        }
        and current != previous
    ):
        raise ExecutionStateError("terminal Run execution state cannot be rewritten")
    if len(current.jobs) != len(previous.jobs):
        raise ExecutionStateError("execution state cannot change its Job count")
    for old_job, new_job in zip(previous.jobs, current.jobs, strict=True):
        if (new_job.job_id, new_job.ordinal) != (old_job.job_id, old_job.ordinal):
            raise ExecutionStateError("execution state cannot change Job identity")
        if (
            new_job.status != old_job.status
            and new_job.status not in _JOB_TRANSITIONS[old_job.status]
        ):
            raise ExecutionStateError(
                f"illegal Job state transition for ordinal {new_job.ordinal}: "
                f"{old_job.status.value} -> {new_job.status.value}"
            )
        if (
            old_job.status
            in {
                JobExecutionStatus.SUCCEEDED,
                JobExecutionStatus.FAILED,
                JobExecutionStatus.CANCELLED,
            }
            and new_job != old_job
        ):
            raise ExecutionStateError(
                f"terminal Job execution state cannot be rewritten for ordinal {new_job.ordinal}"
            )
        if old_job.prompt_id is not None and new_job.prompt_id != old_job.prompt_id:
            raise ExecutionStateError("execution state cannot change an accepted prompt ID")
        if old_job.submission_disposition is not None and (
            new_job.submission_disposition != old_job.submission_disposition
        ):
            reconciled_disposition = (
                old_job.status is JobExecutionStatus.SUBMISSION_UNKNOWN
                and old_job.submission_disposition is SubmissionDisposition.UNKNOWN
                and (
                    (
                        new_job.status is JobExecutionStatus.SUBMITTED
                        and new_job.submission_disposition is SubmissionDisposition.ACCEPTED
                    )
                    or (
                        new_job.status is JobExecutionStatus.FAILED
                        and new_job.submission_disposition is SubmissionDisposition.REJECTED
                    )
                )
            )
            if not reconciled_disposition:
                raise ExecutionStateError("execution state cannot change submission disposition")
        if new_job.results[: len(old_job.results)] != old_job.results:
            raise ExecutionStateError("execution state cannot rewrite persisted Results")


def _validate_state(state: RunExecutionState) -> None:
    if not state.run_id:
        raise ExecutionStateError("execution state Run ID must not be empty")
    expected_ordinals = tuple(range(1, len(state.jobs) + 1))
    if tuple(job.ordinal for job in state.jobs) != expected_ordinals:
        raise ExecutionStateError("execution state Job ordinals must be one-based and contiguous")
    for job in state.jobs:
        if not job.job_id:
            raise ExecutionStateError("execution state Job ID must not be empty")
        if job.status in {
            JobExecutionStatus.SUBMITTED,
            JobExecutionStatus.SUCCEEDED,
        } and (
            job.submission_disposition is not SubmissionDisposition.ACCEPTED or not job.prompt_id
        ):
            raise ExecutionStateError(
                f"Job {job.ordinal} requires an accepted submission and prompt ID"
            )
        if job.status is JobExecutionStatus.SUBMISSION_UNKNOWN and (
            job.submission_disposition is not SubmissionDisposition.UNKNOWN
            or job.prompt_id is not None
        ):
            raise ExecutionStateError(f"Job {job.ordinal} has invalid unknown-submission state")
        if job.status is JobExecutionStatus.CANCELLED and (
            job.completed_at is None
            or (job.client_id is None) != (job.started_at is None)
            or job.submission_disposition is not None
            or job.submission_http_status is not None
            or job.submission_response is not None
            or job.prompt_id is not None
            or job.error is not None
            or job.diagnostics
            or job.history_status is not None
            or job.results
        ):
            raise ExecutionStateError(f"Job {job.ordinal} has invalid cancelled state")
        if tuple(result.artifact_ordinal for result in job.results) != tuple(
            range(1, len(job.results) + 1)
        ):
            raise ExecutionStateError(f"Job {job.ordinal} Result ordinals are not contiguous")
        for result in job.results:
            if (result.job_id, result.job_ordinal) != (job.job_id, job.ordinal):
                raise ExecutionStateError("Result identity does not match its Job")
            relative_path = PurePosixPath(result.local_path)
            expected_name = re.compile(
                rf"{job.ordinal:06d}-{result.artifact_ordinal:02d}\.[A-Za-z0-9]{{1,10}}"
            )
            if (
                relative_path.is_absolute()
                or relative_path.parent != PurePosixPath("outputs")
                or not expected_name.fullmatch(relative_path.name)
            ):
                raise ExecutionStateError("Result local path does not match its ordinals")
            if len(result.sha256) != 64 or any(
                character not in "0123456789abcdef" for character in result.sha256
            ):
                raise ExecutionStateError("Result SHA-256 is invalid")
    if state.status is RunExecutionStatus.SUCCEEDED and (
        any(job.status is not JobExecutionStatus.SUCCEEDED for job in state.jobs)
        or state.completed_at is None
        or state.current_job_ordinal is not None
    ):
        raise ExecutionStateError("succeeded Run state requires every Job to succeed")
    if state.status is RunExecutionStatus.FAILED and not any(
        job.status is JobExecutionStatus.FAILED for job in state.jobs
    ):
        raise ExecutionStateError("failed Run state requires a failed Job")
    if state.status is RunExecutionStatus.BLOCKED:
        if state.diagnostics == (USER_DETACHED_FROM_CURRENT_JOB,):
            _validate_detached_blocked_state(state)
        elif not any(
            job.status in {JobExecutionStatus.SUBMISSION_UNKNOWN, JobExecutionStatus.SUBMITTED}
            for job in state.jobs
        ):
            raise ExecutionStateError("blocked Run state requires an unresolved Job")
    if state.status is RunExecutionStatus.CANCELLED:
        discarded_before_start = (
            state.started_at is None
            and state.completed_at is not None
            and state.current_job_ordinal is None
            and state.error is None
            and state.diagnostics == (DISCARDED_BEFORE_START,)
            and all(_is_pristine_pending_job(job) for job in state.jobs)
        )
        stopped_after_current = (
            state.started_at is not None
            and state.completed_at is not None
            and state.current_job_ordinal is None
            and state.error is None
            and state.diagnostics == (STOPPED_AFTER_CURRENT_JOB,)
            and _has_succeeded_prefix_cancelled_suffix(state.jobs, state.completed_at)
        )
        if not discarded_before_start and not stopped_after_current:
            raise ExecutionStateError("cancelled Run state has an invalid cancellation shape")


def _is_pristine_pending_job(job: JobExecutionState) -> bool:
    return job == JobExecutionState(
        job_id=job.job_id,
        ordinal=job.ordinal,
        status=JobExecutionStatus.PENDING,
        client_id=None,
        submission_disposition=None,
        submission_http_status=None,
        submission_response=None,
        prompt_id=None,
        started_at=None,
        completed_at=None,
        error=None,
        diagnostics=(),
        history_status=None,
        results=(),
    )


def _validate_detached_blocked_state(state: RunExecutionState) -> None:
    if (
        state.started_at is None
        or state.completed_at is not None
        or state.current_job_ordinal is None
        or state.error != USER_DETACHED_FROM_CURRENT_JOB
    ):
        raise ExecutionStateError("detached blocked Run has invalid metadata")
    current_index = state.current_job_ordinal - 1
    if current_index < 0 or current_index >= len(state.jobs):
        raise ExecutionStateError("detached blocked Run has invalid current Job ordinal")
    current = state.jobs[current_index]
    if current.status not in {
        JobExecutionStatus.PREPARING,
        JobExecutionStatus.SUBMISSION_UNKNOWN,
        JobExecutionStatus.SUBMITTED,
    }:
        raise ExecutionStateError("detached blocked Run requires an unresolved current Job")
    if not all(job.status is JobExecutionStatus.SUCCEEDED for job in state.jobs[:current_index]):
        raise ExecutionStateError("detached blocked Run requires a succeeded Job prefix")
    if not all(_is_pristine_pending_job(job) for job in state.jobs[current_index + 1 :]):
        raise ExecutionStateError("detached blocked Run requires a pending Job suffix")


def _has_succeeded_prefix_cancelled_suffix(
    jobs: tuple[JobExecutionState, ...],
    completed_at: str,
) -> bool:
    first_cancelled = next(
        (index for index, job in enumerate(jobs) if job.status is JobExecutionStatus.CANCELLED),
        None,
    )
    if first_cancelled is None:
        return False
    cancelled_jobs = jobs[first_cancelled:]
    return all(
        job.status is JobExecutionStatus.SUCCEEDED for job in jobs[:first_cancelled]
    ) and all(
        job.status is JobExecutionStatus.CANCELLED
        and job.completed_at == completed_at
        and (index == 0 or job.client_id is None)
        for index, job in enumerate(cancelled_jobs)
    )


def _state_data(state: RunExecutionState, producer_version: str | None = None) -> dict[str, object]:
    return {
        **format_header(EXECUTION_FORMAT, producer_version),
        "run_id": state.run_id,
        "status": state.status.value,
        "started_at": state.started_at,
        "completed_at": state.completed_at,
        "current_job_ordinal": state.current_job_ordinal,
        "error": state.error,
        "diagnostics": list(state.diagnostics),
        "jobs": [_job_data(job) for job in state.jobs],
    }


def _job_data(job: JobExecutionState) -> dict[str, object]:
    return {
        "job_id": job.job_id,
        "ordinal": job.ordinal,
        "status": job.status.value,
        "client_id": job.client_id,
        "submission_disposition": (
            job.submission_disposition.value if job.submission_disposition else None
        ),
        "submission_http_status": job.submission_http_status,
        "submission_response": job.submission_response,
        "prompt_id": job.prompt_id,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "error": job.error,
        "diagnostics": list(job.diagnostics),
        "history_status": job.history_status,
        "results": [_result_data(result) for result in job.results],
    }


def _result_data(result: ResultRecord) -> dict[str, object]:
    return {
        "job_id": result.job_id,
        "job_ordinal": result.job_ordinal,
        "artifact_ordinal": result.artifact_ordinal,
        "producing_node_id": result.producing_node_id,
        "output_name": result.output_name,
        "remote_filename": result.remote_filename,
        "remote_subfolder": result.remote_subfolder,
        "remote_type": result.remote_type,
        "local_path": result.local_path,
        "content_type": result.content_type,
        "byte_size": result.byte_size,
        "sha256": result.sha256,
    }


def _parse_state(data: dict[str, object]) -> RunExecutionState:
    try:
        validate_format_record(
            data,
            EXECUTION_FORMAT,
            {
                "run_id",
                "status",
                "started_at",
                "completed_at",
                "current_job_ordinal",
                "error",
                "diagnostics",
                "jobs",
            },
        )
    except ValueError as error:
        raise ExecutionStateError(f"invalid execution state format: {error}") from error
    state = RunExecutionState(
        run_id=_required_string(data, "run_id"),
        status=_enum_value(RunExecutionStatus, data, "status"),
        started_at=_optional_string(data, "started_at"),
        completed_at=_optional_string(data, "completed_at"),
        current_job_ordinal=_optional_integer(data, "current_job_ordinal"),
        error=_optional_string(data, "error"),
        diagnostics=_string_tuple(data, "diagnostics"),
        jobs=tuple(_parse_job(_object(value, "Job")) for value in _array(data, "jobs")),
    )
    _validate_state(state)
    return state


def _parse_job(data: dict[str, object]) -> JobExecutionState:
    _require_shape(
        data,
        {
            "job_id",
            "ordinal",
            "status",
            "client_id",
            "submission_disposition",
            "submission_http_status",
            "submission_response",
            "prompt_id",
            "started_at",
            "completed_at",
            "error",
            "diagnostics",
            "history_status",
            "results",
        },
        "execution Job",
    )
    disposition_value = data.get("submission_disposition")
    disposition = (
        None
        if disposition_value is None
        else _enum_raw(SubmissionDisposition, disposition_value, "submission_disposition")
    )
    return JobExecutionState(
        job_id=_required_string(data, "job_id"),
        ordinal=_required_integer(data, "ordinal"),
        status=_enum_value(JobExecutionStatus, data, "status"),
        client_id=_optional_string(data, "client_id"),
        submission_disposition=disposition,
        submission_http_status=_optional_integer(data, "submission_http_status"),
        submission_response=_optional_object(data, "submission_response"),
        prompt_id=_optional_string(data, "prompt_id"),
        started_at=_optional_string(data, "started_at"),
        completed_at=_optional_string(data, "completed_at"),
        error=_optional_string(data, "error"),
        diagnostics=_string_tuple(data, "diagnostics"),
        history_status=_optional_object(data, "history_status"),
        results=tuple(_parse_result(_object(value, "Result")) for value in _array(data, "results")),
    )


def _parse_result(data: dict[str, object]) -> ResultRecord:
    _require_shape(
        data,
        {
            "job_id",
            "job_ordinal",
            "artifact_ordinal",
            "producing_node_id",
            "output_name",
            "remote_filename",
            "remote_subfolder",
            "remote_type",
            "local_path",
            "content_type",
            "byte_size",
            "sha256",
        },
        "execution Result",
    )
    return ResultRecord(
        job_id=_required_string(data, "job_id"),
        job_ordinal=_required_integer(data, "job_ordinal"),
        artifact_ordinal=_required_integer(data, "artifact_ordinal"),
        producing_node_id=_required_string(data, "producing_node_id"),
        output_name=_required_string(data, "output_name"),
        remote_filename=_required_string(data, "remote_filename"),
        remote_subfolder=_required_string(data, "remote_subfolder", allow_empty=True),
        remote_type=_required_string(data, "remote_type"),
        local_path=_required_string(data, "local_path"),
        content_type=_optional_string(data, "content_type"),
        byte_size=_non_negative_integer(data, "byte_size"),
        sha256=_required_string(data, "sha256"),
    )


def _enum_value[T: StrEnum](enum_type: type[T], data: dict[str, object], name: str) -> T:
    return _enum_raw(enum_type, data.get(name), name)


def _enum_raw[T: StrEnum](enum_type: type[T], value: object, name: str) -> T:
    if not isinstance(value, str):
        raise ExecutionStateError(f"{name} must be a string")
    try:
        return enum_type(value)
    except ValueError as error:
        raise ExecutionStateError(f"unsupported {name}: {value!r}") from error


def _object(value: object, name: str) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ExecutionStateError(f"{name} must be a JSON object")
    return cast(dict[str, object], value)


def _require_shape(data: dict[str, object], keys: set[str], description: str) -> None:
    try:
        require_exact_keys(data, keys, description)
    except ValueError as error:
        raise ExecutionStateError(str(error)) from error


def _optional_object(data: dict[str, object], name: str) -> dict[str, object] | None:
    value = data.get(name)
    return None if value is None else _object(value, name)


def _array(data: dict[str, object], name: str) -> list[object]:
    value = data.get(name)
    if not isinstance(value, list):
        raise ExecutionStateError(f"{name} must be a JSON array")
    return cast(list[object], value)


def _string_tuple(data: dict[str, object], name: str) -> tuple[str, ...]:
    values = _array(data, name)
    if not all(isinstance(value, str) for value in values):
        raise ExecutionStateError(f"{name} must contain only strings")
    return tuple(cast(list[str], values))


def _required_string(data: dict[str, object], name: str, *, allow_empty: bool = False) -> str:
    value = data.get(name)
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ExecutionStateError(f"{name} must be a string")
    return value


def _optional_string(data: dict[str, object], name: str) -> str | None:
    value = data.get(name)
    if value is not None and not isinstance(value, str):
        raise ExecutionStateError(f"{name} must be a string or null")
    return value


def _required_integer(data: dict[str, object], name: str) -> int:
    value = data.get(name)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ExecutionStateError(f"{name} must be a positive integer")
    return value


def _optional_integer(data: dict[str, object], name: str) -> int | None:
    value = data.get(name)
    if value is not None and (not isinstance(value, int) or isinstance(value, bool)):
        raise ExecutionStateError(f"{name} must be an integer or null")
    return value


def _non_negative_integer(data: dict[str, object], name: str) -> int:
    value = data.get(name)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ExecutionStateError(f"{name} must be a non-negative integer")
    return value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_new_result_files(
    run_path: Path,
    previous: RunExecutionState,
    current: RunExecutionState,
) -> None:
    _verify_result_files(
        run_path,
        tuple(
            result
            for old_job, new_job in zip(previous.jobs, current.jobs, strict=True)
            for result in new_job.results[len(old_job.results) :]
        ),
    )


def _verify_result_files(run_path: Path, results: tuple[ResultRecord, ...]) -> None:
    for result in results:
        result_path = run_path / result.local_path
        if result_path.is_symlink() or not result_path.is_file():
            raise ExecutionStateError(f"recorded Result is missing: {result.local_path}")
        if result_path.stat().st_size != result.byte_size:
            raise ExecutionStateError(f"recorded Result size does not match: {result.local_path}")
        if _sha256_file(result_path) != result.sha256:
            raise ExecutionStateError(
                f"recorded Result SHA-256 does not match: {result.local_path}"
            )
