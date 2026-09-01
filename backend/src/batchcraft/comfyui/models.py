from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum


class SubmissionDisposition(StrEnum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    UNKNOWN = "unknown"


class ExecutionStatus(StrEnum):
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class ServerInfo:
    data: dict[str, object]


@dataclass(frozen=True, slots=True)
class UploadedInput:
    name: str
    subfolder: str
    remote_type: str
    workflow_value: str


@dataclass(frozen=True, slots=True)
class PromptSubmission:
    disposition: SubmissionDisposition
    client_id: str
    prompt_id: str | None
    http_status: int | None
    response: dict[str, object] | None
    diagnostic: str | None


@dataclass(frozen=True, slots=True)
class ExecutionEvent:
    event_type: str
    prompt_id: str
    node_id: str | None
    data: dict[str, object]

    @property
    def is_terminal_advisory(self) -> bool:
        return self.event_type in {
            "execution_success",
            "execution_error",
            "execution_interrupted",
        } or (self.event_type == "executing" and self.node_id is None)


@dataclass(frozen=True, slots=True)
class RemoteOutputArtifact:
    producing_node_id: str
    output_name: str
    filename: str
    subfolder: str
    remote_type: str


@dataclass(frozen=True, slots=True)
class ExecutionOutcome:
    prompt_id: str
    status: ExecutionStatus
    artifacts: tuple[RemoteOutputArtifact, ...]
    status_data: dict[str, object]


@dataclass(frozen=True, slots=True)
class DownloadedArtifact:
    remote: RemoteOutputArtifact
    content: bytes
    content_type: str | None
    sha256: str


@dataclass(frozen=True, slots=True)
class WorkflowPreparationValues:
    prompt: str
    image_inputs: Mapping[str, str]
    seed: int
    output_prefix: str
