import asyncio
import hashlib
import json

import httpx
import pytest

from batchcraft.comfyui import (
    ArtifactDownloadError,
    ComfyUIClient,
    ExecutionStatus,
    HistoryError,
    RemoteOutputArtifact,
    SubmissionDisposition,
    UploadError,
)


def _response(status: int, payload: object) -> httpx.Response:
    return httpx.Response(status, json=payload)


def test_server_info_and_websocket_url_use_explicit_base_url() -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/comfy/system_stats"
            return _response(200, {"system": {"comfyui_version": "0.31.0"}, "devices": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = ComfyUIClient("https://gpu.example/comfy", http_client=http)
            info = await client.get_server_info()
            assert info.data["system"] == {"comfyui_version": "0.31.0"}
            assert client.websocket_url("client 1") == (
                "wss://gpu.example/comfy/ws?clientId=client+1"
            )

    asyncio.run(scenario())


def test_base_url_ignores_surrounding_whitespace() -> None:
    async def scenario() -> None:
        async with ComfyUIClient("  http://gpu:8188/comfy/  ") as client:
            assert client.base_url == "http://gpu:8188/comfy"
            assert client.websocket_url("client-1") == ("ws://gpu:8188/comfy/ws?clientId=client-1")

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "base_url",
    [
        "gpu:8188",
        "ftp://gpu:8188",
        "http://gpu:8188?token=secret",
        "http://gpu:8188#ws",
        "http://gpu:not-a-port",
    ],
)
def test_invalid_base_url_is_rejected(base_url: str) -> None:
    with pytest.raises(ValueError, match="base URL"):
        ComfyUIClient(base_url)


def test_upload_response_is_parsed_for_workflow_use() -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/upload/image"
            assert b'name="image"' in request.content
            assert b"reference.png" in request.content
            return _response(
                200,
                {"name": "reference.png", "subfolder": "batchcraft\\run-1", "type": "input"},
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            uploaded = await ComfyUIClient("http://gpu:8188", http_client=http).upload_input(
                filename="reference.png",
                content=b"png bytes",
                mime_type="image/png",
                subfolder="batchcraft/run-1",
            )
            assert uploaded.name == "reference.png"
            assert uploaded.subfolder == "batchcraft\\run-1"
            assert uploaded.remote_type == "input"
            assert uploaded.workflow_value == "batchcraft/run-1/reference.png"

    asyncio.run(scenario())


def test_successful_submission_captures_prompt_id() -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert body == {"prompt": {"1": {"inputs": {}}}, "client_id": "client-id"}
            return _response(200, {"prompt_id": "prompt-id", "number": 4})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            submission = await ComfyUIClient("http://gpu:8188", http_client=http).submit_prompt(
                {"1": {"inputs": {}}}, client_id="client-id"
            )
            assert submission.disposition is SubmissionDisposition.ACCEPTED
            assert submission.prompt_id == "prompt-id"
            assert submission.http_status == 200
            assert submission.diagnostic is None

    asyncio.run(scenario())


def test_client_error_is_a_definite_submission_rejection() -> None:
    async def scenario() -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return _response(400, {"error": "prompt outputs failed validation"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            submission = await ComfyUIClient("http://gpu:8188", http_client=http).submit_prompt(
                {}, client_id="client-id"
            )
            assert submission.disposition is SubmissionDisposition.REJECTED
            assert submission.prompt_id is None
            assert submission.response == {"error": "prompt outputs failed validation"}

    asyncio.run(scenario())


def test_malformed_client_error_is_still_a_definite_submission_rejection() -> None:
    async def scenario() -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, content=b"not-json")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            submission = await ComfyUIClient("http://gpu:8188", http_client=http).submit_prompt(
                {}, client_id="client-id"
            )
            assert submission.disposition is SubmissionDisposition.REJECTED
            assert submission.response is None
            assert "invalid JSON" in (submission.diagnostic or "")

    asyncio.run(scenario())


def test_ambiguous_submission_is_returned_once_without_retry() -> None:
    async def scenario() -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            raise httpx.ReadTimeout("response was lost", request=request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            submission = await ComfyUIClient("http://gpu:8188", http_client=http).submit_prompt(
                {}, client_id="client-id"
            )
            assert submission.disposition is SubmissionDisposition.UNKNOWN
            assert submission.prompt_id is None
            assert submission.http_status is None
            assert "transport failure" in (submission.diagnostic or "")
            assert attempts == 1

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("status", "body"),
    [(200, b"not-json"), (200, b"[]"), (503, b'{"error":"busy"}')],
)
def test_malformed_or_server_error_submission_is_ambiguous(status: int, body: bytes) -> None:
    async def scenario() -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(status, content=body)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            submission = await ComfyUIClient("http://gpu:8188", http_client=http).submit_prompt(
                {}, client_id="client-id"
            )
            assert submission.disposition is SubmissionDisposition.UNKNOWN
            assert submission.prompt_id is None

    asyncio.run(scenario())


def test_history_reconciliation_deduplicates_repeated_descriptor_in_same_output() -> None:
    async def scenario() -> None:
        history = {
            "prompt-id": {
                "status": {"completed": True, "status_str": "success"},
                "outputs": {
                    "41": {
                        "images": [
                            {"filename": "one.png", "subfolder": "folder\\one", "type": "output"},
                            {"filename": "two.png", "subfolder": "folder\\one", "type": "output"},
                            {"filename": "one.png", "subfolder": "folder\\one", "type": "output"},
                        ]
                    },
                    "52": {
                        "animated": [
                            {"filename": "three.webp", "subfolder": "other", "type": "temp"}
                        ]
                    },
                },
            }
        }

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/history/prompt-id"
            return _response(200, history)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            outcome = await ComfyUIClient("http://gpu:8188", http_client=http).get_history(
                "prompt-id"
            )
            assert outcome is not None
            assert outcome.status is ExecutionStatus.SUCCEEDED
            assert [(item.producing_node_id, item.output_name) for item in outcome.artifacts] == [
                ("41", "images"),
                ("41", "images"),
                ("52", "animated"),
            ]
            assert [item.filename for item in outcome.artifacts] == [
                "one.png",
                "two.png",
                "three.webp",
            ]
            assert outcome.artifacts[0].subfolder == "folder\\one"
            assert outcome.artifacts[2].remote_type == "temp"

    asyncio.run(scenario())


def test_history_reconciliation_preserves_identical_remote_file_from_different_nodes() -> None:
    async def scenario() -> None:
        descriptor = {"filename": "shared.png", "subfolder": "folder", "type": "output"}
        history = {
            "prompt-id": {
                "status": {"completed": True, "status_str": "success"},
                "outputs": {
                    "41": {"images": [descriptor]},
                    "52": {"images": [descriptor]},
                },
            }
        }

        def handler(_request: httpx.Request) -> httpx.Response:
            return _response(200, history)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            outcome = await ComfyUIClient("http://gpu:8188", http_client=http).get_history(
                "prompt-id"
            )
            assert outcome is not None
            assert [(item.producing_node_id, item.output_name) for item in outcome.artifacts] == [
                ("41", "images"),
                ("52", "images"),
            ]
            assert [item.filename for item in outcome.artifacts] == ["shared.png", "shared.png"]

    asyncio.run(scenario())


def test_missing_history_entry_is_not_yet_reconciled() -> None:
    async def scenario() -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return _response(200, {})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            outcome = await ComfyUIClient("http://gpu:8188", http_client=http).get_history(
                "prompt-id"
            )
            assert outcome is None

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "status",
    [
        {"completed": True},
        {"completed": False, "status_str": "success"},
        {"completed": True, "status_str": "future-status"},
        {"completed": "yes", "status_str": "success"},
    ],
)
def test_malformed_history_status_is_rejected(status: dict[str, object]) -> None:
    async def scenario() -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return _response(200, {"prompt-id": {"status": status, "outputs": {}}})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            with pytest.raises(HistoryError):
                await ComfyUIClient("http://gpu:8188", http_client=http).get_history("prompt-id")

    asyncio.run(scenario())


def test_failed_history_reconciliation_preserves_status() -> None:
    async def scenario() -> None:
        status = {
            "completed": False,
            "status_str": "error",
            "messages": [["execution_error", {"exception_message": "CUDA error"}]],
        }

        def handler(_request: httpx.Request) -> httpx.Response:
            return _response(200, {"prompt-id": {"status": status, "outputs": {}}})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            outcome = await ComfyUIClient("http://gpu:8188", http_client=http).get_history(
                "prompt-id"
            )
            assert outcome is not None
            assert outcome.status is ExecutionStatus.FAILED
            assert outcome.status_data == status
            assert outcome.artifacts == ()

    asyncio.run(scenario())


def test_artifact_download_preserves_remote_descriptor() -> None:
    async def scenario() -> None:
        artifact = RemoteOutputArtifact(
            producing_node_id="41",
            output_name="images",
            filename="result.png",
            subfolder="Windows\\style",
            remote_type="output",
        )

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/view"
            assert request.url.params["filename"] == "result.png"
            assert request.url.params["subfolder"] == "Windows\\style"
            assert request.url.params["type"] == "output"
            return httpx.Response(
                200, content=b"artifact bytes", headers={"content-type": "image/png"}
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            downloaded = await ComfyUIClient("http://gpu:8188", http_client=http).download_artifact(
                artifact
            )
            assert downloaded.remote == artifact
            assert downloaded.content == b"artifact bytes"
            assert downloaded.content_type == "image/png"
            assert downloaded.sha256 == hashlib.sha256(b"artifact bytes").hexdigest()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("method", "expected_error"),
    [("upload", UploadError), ("history", HistoryError), ("download", ArtifactDownloadError)],
)
def test_malformed_and_failed_protocol_responses_are_actionable(
    method: str, expected_error: type[Exception]
) -> None:
    async def scenario() -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            if method == "download":
                return httpx.Response(404, text="missing")
            return httpx.Response(200, json=[])

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = ComfyUIClient("http://gpu:8188", http_client=http)
            with pytest.raises(expected_error):
                if method == "upload":
                    await client.upload_input(filename="input.png", content=b"bytes")
                elif method == "history":
                    await client.get_history("prompt-id")
                else:
                    await client.download_artifact(
                        RemoteOutputArtifact("41", "images", "missing.png", "", "output")
                    )

    asyncio.run(scenario())


def test_invalid_utf8_submission_response_is_ambiguous() -> None:
    async def scenario() -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b'\xff{"prompt_id":"maybe"}')

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            submission = await ComfyUIClient("http://gpu:8188", http_client=http).submit_prompt(
                {}, client_id="client-id"
            )
            assert submission.disposition is SubmissionDisposition.UNKNOWN
            assert "invalid JSON" in (submission.diagnostic or "")

    asyncio.run(scenario())
