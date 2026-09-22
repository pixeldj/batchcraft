"""Shared API test clients and explicit temporary-storage settings."""

import copy
import hashlib
from collections.abc import AsyncIterator, Mapping
from contextlib import AbstractAsyncContextManager
from pathlib import Path
from typing import cast

from artifact_fixture import artifact_png

from batchcraft.api import Settings
from batchcraft.application import ApplicationComfyUIClient
from batchcraft.comfyui import (
    DownloadedArtifact,
    ExecutionEvent,
    ExecutionOutcome,
    ExecutionStatus,
    PromptSubmission,
    RemoteOutputArtifact,
    ServerInfo,
    SubmissionDisposition,
    UploadedInput,
)


class FakeEventSource:
    async def events(self, prompt_id: str) -> AsyncIterator[ExecutionEvent]:
        yield ExecutionEvent(
            event_type="execution_success",
            prompt_id=prompt_id,
            node_id=None,
            data={"prompt_id": prompt_id},
        )


class FakeEventContext(AbstractAsyncContextManager[FakeEventSource]):
    async def __aenter__(self) -> FakeEventSource:
        return FakeEventSource()

    async def __aexit__(self, *_args: object) -> None:
        return None


class FakeComfyUIClient:
    def __init__(
        self,
        *,
        status_error: Exception | None = None,
        submission_disposition: SubmissionDisposition = SubmissionDisposition.ACCEPTED,
        history_status: ExecutionStatus = ExecutionStatus.SUCCEEDED,
        upload_error: Exception | None = None,
        artifact_count: int = 0,
    ) -> None:
        self.status_error = status_error
        self.submission_disposition = submission_disposition
        self.history_status = history_status
        self.upload_error = upload_error
        self.artifact_count = artifact_count
        self.closed = False
        self.submission_count = 0
        self.submitted_workflows: list[dict[str, object]] = []

    async def get_server_info(self) -> ServerInfo:
        if self.status_error is not None:
            raise self.status_error
        return ServerInfo(
            data={
                "system": {"comfyui_version": "0.31.0"},
                "devices": [{"name": "Test GPU"}],
            }
        )

    async def upload_input(
        self,
        *,
        filename: str,
        content: bytes,
        mime_type: str = "application/octet-stream",
        subfolder: str = "",
    ) -> UploadedInput:
        if self.upload_error is not None:
            raise self.upload_error
        return UploadedInput(
            name=filename,
            subfolder=subfolder,
            remote_type="input",
            workflow_value=f"{subfolder}/{filename}",
        )

    def open_event_stream(self, client_id: str) -> AbstractAsyncContextManager[FakeEventSource]:
        return FakeEventContext()

    async def submit_prompt(
        self, workflow: Mapping[str, object], *, client_id: str
    ) -> PromptSubmission:
        self.submitted_workflows.append(copy.deepcopy(dict(workflow)))
        self.submission_count += 1
        prompt_id = (
            f"prompt-{self.submission_count}"
            if self.submission_disposition is SubmissionDisposition.ACCEPTED
            else None
        )
        return PromptSubmission(
            disposition=self.submission_disposition,
            client_id=client_id,
            prompt_id=prompt_id,
            http_status=200,
            response={"prompt_id": prompt_id} if prompt_id else None,
            diagnostic=(
                "submission outcome unknown"
                if self.submission_disposition is SubmissionDisposition.UNKNOWN
                else None
            ),
        )

    async def get_history(self, prompt_id: str) -> ExecutionOutcome | None:
        artifacts = tuple(
            RemoteOutputArtifact(
                producing_node_id=str(40 + ordinal),
                output_name="images",
                filename=f"{prompt_id}-{ordinal}.png",
                subfolder="batchcraft",
                remote_type="output",
            )
            for ordinal in range(1, self.artifact_count + 1)
        )
        return ExecutionOutcome(
            prompt_id=prompt_id,
            status=self.history_status,
            artifacts=artifacts,
            status_data={"completed": True, "status_str": self.history_status.value},
        )

    async def download_artifact(self, artifact: RemoteOutputArtifact) -> DownloadedArtifact:
        content = artifact_png(artifact.filename)
        return DownloadedArtifact(
            remote=artifact,
            content=content,
            content_type="image/png",
            sha256=hashlib.sha256(content).hexdigest(),
        )

    async def aclose(self) -> None:
        self.closed = True


class UnusedClient:
    async def aclose(self) -> None:
        return None


def _client(_settings: Settings) -> ApplicationComfyUIClient:
    return cast(ApplicationComfyUIClient, UnusedClient())


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        projects_root=tmp_path / "projects",
        comfyui_base_url="http://comfyui.test:8188",
        comfyui_timeout_seconds=1,
        websocket_timeout_seconds=1,
        history_timeout_seconds=1,
        history_poll_interval_seconds=0.01,
        frontend_origin="http://localhost:5173",
        server_host="127.0.0.1",
        server_port=8000,
        data_root=tmp_path,
        database_path=tmp_path / "batchcraft.sqlite3",
    )


def _history_settings(tmp_path: Path, *, database_name: str = "batchcraft.sqlite3") -> Settings:
    return Settings(
        projects_root=tmp_path / "projects",
        comfyui_base_url="http://unused",
        comfyui_timeout_seconds=1,
        websocket_timeout_seconds=1,
        history_timeout_seconds=1,
        history_poll_interval_seconds=0.01,
        frontend_origin="http://localhost:5173",
        server_host="127.0.0.1",
        server_port=8000,
        data_root=tmp_path / "data",
        database_path=tmp_path / "data" / database_name,
    )
