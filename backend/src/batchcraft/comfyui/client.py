import hashlib
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import PurePosixPath
from typing import cast
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

from batchcraft.comfyui.errors import (
    ArtifactDownloadError,
    ComfyUIConnectionError,
    ComfyUIProtocolError,
    ExecutionObservationError,
    HistoryError,
    UploadError,
)
from batchcraft.comfyui.events import correlated_execution_events
from batchcraft.comfyui.models import (
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


class ExecutionEventStream:
    def __init__(self, connection: ClientConnection) -> None:
        self._connection = connection

    async def events(self, prompt_id: str) -> AsyncIterator[ExecutionEvent]:
        try:
            async for event in correlated_execution_events(self._connection, prompt_id):
                yield event
            raise ExecutionObservationError("ComfyUI WebSocket closed while observing prompt")
        except WebSocketException as error:
            raise ExecutionObservationError(
                "ComfyUI WebSocket disconnected while observing prompt"
            ) from error


class _ResponseReadError(Exception):
    def __init__(self, diagnostic: str, status: int | None) -> None:
        super().__init__(diagnostic)
        self.status = status


class ComfyUIClient:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 30.0,
        max_json_response_bytes: int = 8 * 1024 * 1024,
        max_artifact_bytes: int = 256 * 1024 * 1024,
        max_websocket_message_bytes: int = 4 * 1024 * 1024,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        for name, value in (
            ("max_json_response_bytes", max_json_response_bytes),
            ("max_artifact_bytes", max_artifact_bytes),
            ("max_websocket_message_bytes", max_websocket_message_bytes),
        ):
            if type(value) is not int or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        self.max_json_response_bytes = max_json_response_bytes
        self.max_artifact_bytes = max_artifact_bytes
        self.max_websocket_message_bytes = max_websocket_message_bytes
        normalized_base_url = base_url.strip().rstrip("/")
        parsed = urlsplit(normalized_base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("ComfyUI base URL must be an absolute HTTP or HTTPS URL")
        if parsed.query or parsed.fragment:
            raise ValueError("ComfyUI base URL must not contain a query or fragment")
        try:
            port = parsed.port
        except ValueError as error:
            raise ValueError("ComfyUI base URL must contain a valid port") from error
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("ComfyUI base URL must contain a valid port")
        self.base_url = normalized_base_url
        self.timeout = timeout
        self._owns_http_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=timeout, trust_env=False)

    async def __aenter__(self) -> "ComfyUIClient":
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_http_client:
            await self._http.aclose()

    async def get_server_info(self) -> ServerInfo:
        try:
            response = await self._request("GET", "/system_stats")
        except _ResponseReadError as error:
            raise ComfyUIConnectionError(f"ComfyUI system information failed: {error}") from (
                error.__cause__ or error
            )
        if not response.is_success:
            raise ComfyUIConnectionError(
                f"ComfyUI system information failed with HTTP {response.status_code}"
            )
        return ServerInfo(data=_response_object(response, "system information"))

    async def upload_input(
        self,
        *,
        filename: str,
        content: bytes,
        mime_type: str = "application/octet-stream",
        subfolder: str = "",
    ) -> UploadedInput:
        if (
            not filename
            or filename != PurePosixPath(filename).name
            or "/" in filename
            or "\\" in filename
        ):
            raise UploadError("upload filename must be a non-empty basename")
        try:
            response = await self._request(
                "POST",
                "/upload/image",
                data={"type": "input", "subfolder": subfolder, "overwrite": "false"},
                files={"image": (filename, content, mime_type)},
            )
        except _ResponseReadError as error:
            raise UploadError(f"ComfyUI input upload failed: {error}") from (
                error.__cause__ or error
            )
        if not response.is_success:
            raise UploadError(f"ComfyUI input upload failed with HTTP {response.status_code}")
        body = _response_object(response, "input upload", error_type=UploadError)
        remote_name = _required_string(body, "name", "input upload", UploadError)
        remote_subfolder = _optional_string(body, "subfolder", "input upload", UploadError)
        remote_type = _optional_string(body, "type", "input upload", UploadError) or "input"
        normalized_subfolder = remote_subfolder.replace("\\", "/").strip("/")
        workflow_value = (
            f"{normalized_subfolder}/{remote_name}" if normalized_subfolder else remote_name
        )
        return UploadedInput(
            name=remote_name,
            subfolder=remote_subfolder,
            remote_type=remote_type,
            workflow_value=workflow_value,
        )

    async def submit_prompt(
        self,
        workflow: Mapping[str, object],
        *,
        client_id: str,
    ) -> PromptSubmission:
        try:
            response = await self._request(
                "POST",
                "/prompt",
                json={"prompt": dict(workflow), "client_id": client_id},
            )
        except _ResponseReadError as error:
            rejected = error.status is not None and 400 <= error.status < 500
            return PromptSubmission(
                disposition=(
                    SubmissionDisposition.REJECTED if rejected else SubmissionDisposition.UNKNOWN
                ),
                client_id=client_id,
                prompt_id=None,
                http_status=error.status,
                response=None,
                diagnostic=(
                    f"prompt submission rejected with HTTP {error.status}: {error}"
                    if rejected
                    else f"prompt submission {error}; outcome unknown; do not retry"
                ),
            )

        body, parse_error = _try_response_object(response)
        if 400 <= response.status_code < 500:
            return PromptSubmission(
                disposition=SubmissionDisposition.REJECTED,
                client_id=client_id,
                prompt_id=None,
                http_status=response.status_code,
                response=body,
                diagnostic=(
                    f"prompt submission rejected with HTTP {response.status_code}"
                    + (f": {parse_error}" if parse_error else "; check workflow in ComfyUI")
                ),
            )
        if not response.is_success:
            return PromptSubmission(
                disposition=SubmissionDisposition.UNKNOWN,
                client_id=client_id,
                prompt_id=None,
                http_status=response.status_code,
                response=body,
                diagnostic=(
                    f"prompt submission outcome unknown with HTTP {response.status_code}; "
                    "do not retry"
                ),
            )
        if body is None:
            return PromptSubmission(
                disposition=SubmissionDisposition.UNKNOWN,
                client_id=client_id,
                prompt_id=None,
                http_status=response.status_code,
                response=None,
                diagnostic=parse_error or "prompt submission returned no JSON object",
            )
        prompt_id = body.get("prompt_id")
        if not isinstance(prompt_id, str) or not prompt_id:
            return PromptSubmission(
                disposition=SubmissionDisposition.UNKNOWN,
                client_id=client_id,
                prompt_id=None,
                http_status=response.status_code,
                response=body,
                diagnostic="prompt submission succeeded without a valid prompt_id",
            )
        return PromptSubmission(
            disposition=SubmissionDisposition.ACCEPTED,
            client_id=client_id,
            prompt_id=prompt_id,
            http_status=response.status_code,
            response=body,
            diagnostic=None,
        )

    @asynccontextmanager
    async def open_event_stream(self, client_id: str) -> AsyncIterator[ExecutionEventStream]:
        try:
            connection = await connect(
                self.websocket_url(client_id),
                open_timeout=self.timeout,
                close_timeout=5,
                max_size=self.max_websocket_message_bytes,
                proxy=None,
            )
        except (OSError, TimeoutError, WebSocketException) as error:
            raise ExecutionObservationError("cannot open ComfyUI WebSocket event stream") from error
        try:
            yield ExecutionEventStream(connection)
        finally:
            await connection.close()

    async def get_history(self, prompt_id: str) -> ExecutionOutcome | None:
        try:
            response = await self._request("GET", f"/history/{prompt_id}")
        except _ResponseReadError as error:
            raise HistoryError(f"ComfyUI history lookup failed: {error}") from (
                error.__cause__ or error
            )
        if not response.is_success:
            raise HistoryError(f"ComfyUI history lookup failed with HTTP {response.status_code}")
        payload = _response_object(response, "history", error_type=HistoryError)
        entry_value = payload.get(prompt_id)
        if entry_value is None:
            return None
        entry = _as_object(entry_value, "history entry", HistoryError)
        status_data = _as_object(entry.get("status"), "history status", HistoryError)
        status = _history_status(status_data)
        artifacts = _history_artifacts(entry)
        return ExecutionOutcome(
            prompt_id=prompt_id,
            status=status,
            artifacts=artifacts,
            status_data=status_data,
        )

    async def download_artifact(self, artifact: RemoteOutputArtifact) -> DownloadedArtifact:
        try:
            response = await self._request(
                "GET",
                "/view",
                artifact=True,
                params={
                    "filename": artifact.filename,
                    "subfolder": artifact.subfolder,
                    "type": artifact.remote_type,
                },
            )
        except _ResponseReadError as error:
            raise ArtifactDownloadError(f"failed to download ComfyUI artifact: {error}") from (
                error.__cause__ or error
            )
        if not response.is_success:
            raise ArtifactDownloadError(
                f"failed to download ComfyUI artifact with HTTP {response.status_code}"
            )
        return DownloadedArtifact(
            remote=artifact,
            content=response.content,
            content_type=response.headers.get("content-type"),
            sha256=hashlib.sha256(response.content).hexdigest(),
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        artifact: bool = False,
        json: object = None,
        data: dict[str, str] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
        params: dict[str, str] | None = None,
    ) -> httpx.Response:
        status = None
        try:
            async with self._http.stream(
                method,
                self._url(path),
                json=json,
                data=data,
                files=files,
                params=params,
                headers={"Accept-Encoding": "identity"},
                follow_redirects=False,
            ) as response:
                status = response.status_code
                limit = (
                    self.max_artifact_bytes
                    if artifact and response.is_success
                    else self.max_json_response_bytes
                )
                if (
                    response.headers.get("content-encoding", "identity").strip().lower()
                    != "identity"
                ):
                    raise _ResponseReadError("unsupported response content encoding", status)
                length = response.headers.get("content-length", "")
                # Ignore malformed declarations; actual received bytes remain authoritative.
                if length.isascii() and length.isdecimal():
                    normalized = length.lstrip("0") or "0"
                    maximum = str(limit)
                    if len(normalized) > len(maximum) or (
                        len(normalized) == len(maximum) and normalized > maximum
                    ):
                        raise _ResponseReadError("response byte limit exceeded", status)
                content = bytearray()
                # MockTransport may supply an already buffered Response. Real HTTP remains raw
                # and streamed, so no HTTPX decompressor can amplify a received chunk.
                if response.is_stream_consumed:
                    if len(response.content) > limit:
                        raise _ResponseReadError("response byte limit exceeded", status)
                    return response
                async for chunk in response.aiter_raw():
                    if len(chunk) > limit - len(content):
                        raise _ResponseReadError("response byte limit exceeded", status)
                    content.extend(chunk)
                return httpx.Response(status, headers=response.headers, content=bytes(content))
        except httpx.RequestError as error:
            raise _ResponseReadError("transport failure", status) from error

    def websocket_url(self, client_id: str) -> str:
        parsed = urlsplit(self.base_url)
        return urlunsplit(
            (
                "wss" if parsed.scheme == "https" else "ws",
                parsed.netloc,
                f"{parsed.path.rstrip('/')}/ws",
                urlencode({"clientId": client_id}),
                "",
            )
        )

    def _url(self, path: str) -> str:
        return f"{self.base_url}/{path.lstrip('/')}"


def _history_status(status: Mapping[str, object]) -> ExecutionStatus:
    status_string = status.get("status_str")
    completed = status.get("completed")
    if not isinstance(completed, bool) or not isinstance(status_string, str):
        raise HistoryError(
            "ComfyUI history status must contain boolean 'completed' and string 'status_str' fields"
        )
    if status_string == "success":
        if not completed:
            raise HistoryError("ComfyUI history status is contradictory")
        return ExecutionStatus.SUCCEEDED
    if status_string in {"error", "failed", "interrupted"}:
        return ExecutionStatus.FAILED
    if completed:
        raise HistoryError("ComfyUI history has unknown terminal status")
    return ExecutionStatus.PENDING


def _history_artifacts(entry: Mapping[str, object]) -> tuple[RemoteOutputArtifact, ...]:
    outputs_value = entry.get("outputs", {})
    outputs = _as_object(outputs_value, "history outputs", HistoryError)
    artifacts: list[RemoteOutputArtifact] = []
    seen_descriptors: set[tuple[str, str, str, str, str]] = set()
    for node_id, node_output_value in outputs.items():
        node_output = _as_object(node_output_value, "output node", HistoryError)
        for output_name, output_value in node_output.items():
            values = output_value if isinstance(output_value, list) else [output_value]
            for descriptor_value in values:
                if not isinstance(descriptor_value, dict) or "filename" not in descriptor_value:
                    continue
                descriptor = _as_object(
                    descriptor_value,
                    "artifact descriptor",
                    HistoryError,
                )
                filename = _required_string(
                    descriptor,
                    "filename",
                    "artifact descriptor",
                    HistoryError,
                )
                subfolder = _optional_string(
                    descriptor,
                    "subfolder",
                    "artifact descriptor",
                    HistoryError,
                )
                remote_type = (
                    _optional_string(
                        descriptor,
                        "type",
                        "artifact descriptor",
                        HistoryError,
                    )
                    or "output"
                )
                descriptor_key = (node_id, output_name, filename, subfolder, remote_type)
                if descriptor_key in seen_descriptors:
                    continue
                seen_descriptors.add(descriptor_key)
                artifacts.append(
                    RemoteOutputArtifact(
                        producing_node_id=node_id,
                        output_name=output_name,
                        filename=filename,
                        subfolder=subfolder,
                        remote_type=remote_type,
                    )
                )
    return tuple(artifacts)


def _response_object(
    response: httpx.Response,
    context: str,
    *,
    error_type: type[ComfyUIProtocolError] | type[UploadError] | type[HistoryError] = (
        ComfyUIProtocolError
    ),
) -> dict[str, object]:
    body, error = _try_response_object(response)
    if body is None:
        raise error_type(f"ComfyUI {context} response is malformed: {error}")
    return body


def _try_response_object(response: httpx.Response) -> tuple[dict[str, object] | None, str | None]:
    try:
        value: object = response.json()
    except (ValueError, RecursionError):
        return None, "invalid JSON"
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        return None, f"expected a JSON object, got {type(value).__name__}"
    return cast(dict[str, object], value), None


def _as_object(
    value: object,
    context: str,
    error_type: type[HistoryError],
) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise error_type(f"ComfyUI {context} must be a JSON object")
    return cast(dict[str, object], value)


def _required_string(
    data: Mapping[str, object],
    name: str,
    context: str,
    error_type: type[UploadError] | type[HistoryError],
) -> str:
    value = data.get(name)
    if not isinstance(value, str) or not value:
        raise error_type(f"ComfyUI {context} has no valid {name!r}")
    return value


def _optional_string(
    data: Mapping[str, object],
    name: str,
    context: str,
    error_type: type[UploadError] | type[HistoryError],
) -> str:
    value = data.get(name, "")
    if not isinstance(value, str):
        raise error_type(f"ComfyUI {context} has invalid {name!r}")
    return value
