from dataclasses import dataclass
from enum import StrEnum

from batchcraft.comfyui import SubmissionDisposition


class RunExecutionStatus(StrEnum):
    CREATED = "created"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


class JobExecutionStatus(StrEnum):
    PENDING = "pending"
    PREPARING = "preparing"
    SUBMITTING = "submitting"
    SUBMISSION_UNKNOWN = "submission_unknown"
    SUBMITTED = "submitted"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True, slots=True)
class ResultRecord:
    job_id: str
    job_ordinal: int
    artifact_ordinal: int
    producing_node_id: str
    output_name: str
    remote_filename: str
    remote_subfolder: str
    remote_type: str
    local_path: str
    content_type: str | None
    byte_size: int
    sha256: str


@dataclass(frozen=True, slots=True)
class JobExecutionState:
    job_id: str
    ordinal: int
    status: JobExecutionStatus
    client_id: str | None
    submission_disposition: SubmissionDisposition | None
    submission_http_status: int | None
    submission_response: dict[str, object] | None
    prompt_id: str | None
    started_at: str | None
    completed_at: str | None
    error: str | None
    diagnostics: tuple[str, ...]
    history_status: dict[str, object] | None
    results: tuple[ResultRecord, ...]


@dataclass(frozen=True, slots=True)
class RunExecutionState:
    run_id: str
    status: RunExecutionStatus
    started_at: str | None
    completed_at: str | None
    current_job_ordinal: int | None
    error: str | None
    diagnostics: tuple[str, ...]
    jobs: tuple[JobExecutionState, ...]


@dataclass(frozen=True, slots=True)
class ExecutionConfig:
    websocket_timeout_seconds: float = 21600.0
    history_timeout_seconds: float = 21600.0
    history_poll_interval_seconds: float = 1.0

    def __post_init__(self) -> None:
        for name, value in (
            ("websocket_timeout_seconds", self.websocket_timeout_seconds),
            ("history_timeout_seconds", self.history_timeout_seconds),
            ("history_poll_interval_seconds", self.history_poll_interval_seconds),
        ):
            if value <= 0:
                raise ValueError(f"{name} must be positive")
