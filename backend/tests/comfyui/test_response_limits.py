import asyncio
import gzip
from collections.abc import AsyncIterator

import httpx
import pytest
from websockets.asyncio.server import ServerConnection, serve

from batchcraft.comfyui import (
    ArtifactDownloadError,
    ComfyUIClient,
    ComfyUIConnectionError,
    ComfyUIProtocolError,
    ExecutionObservationError,
    HistoryError,
    RemoteOutputArtifact,
    SubmissionDisposition,
    UploadError,
)
from batchcraft.comfyui.events import parse_execution_event


class Body(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], failure: BaseException | None = None) -> None:
        self.chunks = chunks
        self.failure = failure
        self.closed = False
        self.reads = 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            self.reads += 1
            yield chunk
        if self.failure:
            raise self.failure

    async def aclose(self) -> None:
        self.closed = True


ARTIFACT = RemoteOutputArtifact("1", "images", "private.png", "private", "output")


async def invoke(client: ComfyUIClient, method: str) -> object:
    if method == "info":
        return await client.get_server_info()
    if method == "upload":
        return await client.upload_input(filename="input.png", content=b"input")
    if method == "history":
        return await client.get_history("prompt")
    return await client.download_artifact(ARTIFACT)


@pytest.mark.parametrize(
    "name",
    [
        "max_json_response_bytes",
        "max_artifact_bytes",
        "max_websocket_message_bytes",
    ],
)
@pytest.mark.parametrize("value", [0, -1, True, False, 1.5, "5", None])
def test_limits_are_strict_positive_integers(name: str, value: object) -> None:
    with pytest.raises(ValueError, match=name):
        ComfyUIClient("http://gpu", **{name: value})  # type: ignore[arg-type]


@pytest.mark.parametrize("length", [None, "2", "garbage", "-1", "9" * 5000])
@pytest.mark.parametrize("extra", [False, True])
def test_actual_byte_boundary_and_declared_early_rejection(length: str | None, extra: bool) -> None:
    async def scenario() -> None:
        body = Body([b"{", b"}"] + ([b" ", b"never read"] if extra else []))
        headers = {} if length is None else {"Content-Length": length}
        response = httpx.Response(200, headers=headers, stream=body)

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.headers["accept-encoding"] == "identity"
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = ComfyUIClient("http://gpu", http_client=http, max_json_response_bytes=2)
            if extra or length == "9" * 5000:
                with pytest.raises(ComfyUIConnectionError, match="byte limit"):
                    await client.get_server_info()
            else:
                assert (await client.get_server_info()).data == {}
        assert body.closed and response.is_closed
        assert body.reads == (0 if length == "9" * 5000 else 3 if extra else 2)

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "method,error",
    [
        ("info", ComfyUIConnectionError),
        ("upload", UploadError),
        ("history", HistoryError),
        ("artifact", ArtifactDownloadError),
    ],
)
@pytest.mark.parametrize("status", [200, 400, 500])
def test_all_operations_bound_success_and_error_bodies(
    method: str, error: type[Exception], status: int
) -> None:
    async def scenario() -> None:
        body = Body([b"1234", b"5", b"unread"])
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(status, stream=body))
        ) as http:
            client = ComfyUIClient(
                "http://gpu", http_client=http, max_json_response_bytes=4, max_artifact_bytes=4
            )
            with pytest.raises(error, match="byte limit"):
                await invoke(client, method)
        assert body.closed and body.reads == 2

    asyncio.run(scenario())


def test_artifact_exact_boundary_keeps_bytes_interface_and_distinct_error_cap() -> None:
    async def scenario() -> None:
        for status in (200, 404):
            body = Body([b"ab", b"cd"])
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda _, status=status, body=body: httpx.Response(status, stream=body)
                )
            ) as http:
                client = ComfyUIClient(
                    "http://gpu", http_client=http, max_json_response_bytes=2, max_artifact_bytes=4
                )
                if status == 200:
                    artifact = await client.download_artifact(ARTIFACT)
                    assert artifact.content == b"abcd"
                    assert isinstance(artifact.content, bytes)
                else:
                    with pytest.raises(ArtifactDownloadError, match="byte limit"):
                        await client.download_artifact(ARTIFACT)
            assert body.closed

    asyncio.run(scenario())


@pytest.mark.parametrize("status", [200, 400, 503])
@pytest.mark.parametrize(
    "failure", ["limit", "timeout", "disconnect", "integer", "recursion", "encoding"]
)
def test_submission_preserves_header_classification_without_retry(
    status: int, failure: str
) -> None:
    async def scenario() -> None:
        payload = b'{"prompt_id":"valid-prefix"}'
        error = None
        headers = {}
        limit = 8192
        if failure == "limit":
            limit = len(payload)
            chunks = [payload, b" ", b"unread"]
        elif failure in {"timeout", "disconnect"}:
            error = (httpx.ReadTimeout if failure == "timeout" else httpx.ReadError)("secret/path")
            chunks = [payload]
        elif failure == "integer":
            chunks = [b'{"number":' + b"9" * 5000 + b"}"]
        elif failure == "recursion":
            chunks = [b"[" * 100000 + b"]" * 100000]
            limit = 256 * 1024
        else:
            headers = {"Content-Encoding": "gzip", "Content-Length": "1048576"}
            chunks = [gzip.compress(b"x" * (2 * 1024 * 1024))]
        body = Body(chunks, error)
        attempts = 0

        def handler(_: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            return httpx.Response(status, headers=headers, stream=body)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = ComfyUIClient("http://gpu", http_client=http, max_json_response_bytes=limit)
            result = await client.submit_prompt({}, client_id="client")
        assert result.disposition is (
            SubmissionDisposition.REJECTED if status == 400 else SubmissionDisposition.UNKNOWN
        )
        assert result.http_status == status
        assert result.prompt_id is None and result.response is None
        assert "secret" not in (result.diagnostic or "")
        assert "valid-prefix" not in (result.diagnostic or "")
        assert attempts == 1 and body.closed
        if failure == "encoding":
            assert body.reads == 0

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "method,error",
    [
        ("info", ComfyUIProtocolError),
        ("upload", UploadError),
        ("history", HistoryError),
    ],
)
@pytest.mark.parametrize(
    "payload",
    [b'{"n":' + b"9" * 5000 + b"}", b"[" * 100000 + b"]" * 100000],
    ids=["integer", "recursion"],
)
def test_json_parser_limits_are_typed(method: str, error: type[Exception], payload: bytes) -> None:
    async def scenario() -> None:
        body = Body([payload])
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=body))
        ) as http:
            with pytest.raises(error, match="invalid JSON"):
                await invoke(ComfyUIClient("http://gpu", http_client=http), method)
        assert body.closed

    asyncio.run(scenario())


@pytest.mark.parametrize("method", ["info", "upload", "history", "artifact", "submit"])
def test_cancellation_closes_response_and_propagates(method: str) -> None:
    async def scenario() -> None:
        started = asyncio.Event()

        class WaitingBody(Body):
            async def __aiter__(self) -> AsyncIterator[bytes]:
                yield b"{"
                started.set()
                await asyncio.Event().wait()

        body = WaitingBody([])
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(400, stream=body))
        ) as http:
            client = ComfyUIClient("http://gpu", http_client=http)
            task = asyncio.create_task(
                client.submit_prompt({}, client_id="client")
                if method == "submit"
                else invoke(client, method)
            )
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert body.closed

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "payload",
    ['{"n":' + "9" * 5000 + "}", "[" * 100000 + "]" * 100000],
    ids=["integer", "recursion"],
)
def test_websocket_parser_limits_are_typed(payload: str) -> None:
    with pytest.raises(ExecutionObservationError, match="invalid JSON"):
        parse_execution_event(payload, "prompt")


def test_defaults_and_websocket_cap_are_forwarded(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        class Connection:
            closed = False

            async def close(self) -> None:
                self.closed = True

        connection = Connection()
        received = {}

        async def connect(url: str, **kwargs: object) -> Connection:
            received.update(kwargs)
            return connection

        monkeypatch.setattr("batchcraft.comfyui.client.connect", connect)
        async with ComfyUIClient("http://gpu") as client:
            assert client.max_json_response_bytes == 8 * 1024 * 1024
            assert client.max_artifact_bytes == 256 * 1024 * 1024
            assert client.max_websocket_message_bytes == 4 * 1024 * 1024
            async with client.open_event_stream("client"):
                assert received["max_size"] == 4 * 1024 * 1024
        async with (
            ComfyUIClient("http://gpu", max_websocket_message_bytes=17) as client,
            client.open_event_stream("client"),
        ):
            assert received["max_size"] == 17
        assert connection.closed

    asyncio.run(scenario())


@pytest.mark.parametrize("binary", [False, True])
def test_oversized_websocket_message_closes_advisory_stream(binary: bool) -> None:
    async def scenario() -> None:
        closed = asyncio.Event()

        async def handler(connection: ServerConnection) -> None:
            await connection.send(b"x" * 65 if binary else "x" * 65)
            await connection.wait_closed()
            assert connection.close_code == 1009
            closed.set()

        async with serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with ComfyUIClient(
                f"http://127.0.0.1:{port}", max_websocket_message_bytes=64
            ) as client:
                async with client.open_event_stream("client") as stream:
                    with pytest.raises(ExecutionObservationError, match="disconnected"):
                        async for _ in stream.events("prompt"):
                            pytest.fail("oversized messages must not produce events")
                await asyncio.wait_for(closed.wait(), timeout=2)

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "method,error",
    [
        ("info", ComfyUIConnectionError),
        ("upload", UploadError),
        ("history", HistoryError),
        ("artifact", ArtifactDownloadError),
    ],
)
@pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "identity, gzip"])
def test_compression_is_rejected_before_read_or_decode(
    method: str, error: type[Exception], encoding: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        body = Body([gzip.compress(b"x" * (2 * 1024 * 1024))])

        def no_decode(*args: object, **kwargs: object) -> object:
            pytest.fail("compressed response must not be decoded")

        monkeypatch.setattr(httpx.Response, "_get_content_decoder", no_decode)
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    stream=body,
                    headers={
                        "Content-Encoding": encoding,
                        "Content-Length": "1048576",
                    },
                )
            )
        ) as http:
            with pytest.raises(error, match="content encoding"):
                await invoke(ComfyUIClient("http://gpu", http_client=http), method)
        assert body.closed and body.reads == 0

    asyncio.run(scenario())
