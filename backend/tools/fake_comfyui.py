"""Network-free ComfyUI boundary for interactive development and browser tests."""

import asyncio
import hashlib
import struct
import time
import zlib
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from uuid import uuid4

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


class FakeComfyUIClient:
    def __init__(self) -> None:
        self.ready_at: dict[str, float] = {}

    async def get_server_info(self) -> ServerInfo:
        return ServerInfo(
            {
                "system": {"comfyui_version": "sandbox (simulated)"},
                "devices": [{"name": "Fake ComfyUI - no GPU or network"}],
            }
        )

    async def aclose(self) -> None:
        pass

    async def upload_input(
        self,
        *,
        filename: str,
        content: bytes,
        mime_type: str = "application/octet-stream",
        subfolder: str = "",
    ) -> UploadedInput:
        return UploadedInput(filename, subfolder, "input", f"{subfolder}/{filename}".lstrip("/"))

    @asynccontextmanager
    async def open_event_stream(self, client_id: str) -> AsyncIterator["FakeComfyUIClient"]:
        yield self

    async def events(self, prompt_id: str) -> AsyncIterator[ExecutionEvent]:
        await asyncio.sleep(max(0, self.ready_at[prompt_id] - time.monotonic()))
        yield ExecutionEvent("execution_success", prompt_id, None, {"simulated": True})

    async def submit_prompt(
        self,
        workflow: Mapping[str, object],
        *,
        client_id: str,
    ) -> PromptSubmission:
        text = str(workflow)
        if "[sandbox:reject]" in text:
            return PromptSubmission(
                SubmissionDisposition.REJECTED,
                client_id,
                None,
                400,
                None,
                "Simulated ComfyUI rejection requested by [sandbox:reject]",
            )
        if "[sandbox:unknown]" in text:
            return PromptSubmission(
                SubmissionDisposition.UNKNOWN,
                client_id,
                None,
                None,
                None,
                "Simulated ambiguous submission requested by [sandbox:unknown]",
            )
        prompt_id = str(uuid4())
        self.ready_at[prompt_id] = time.monotonic() + (30 if "[sandbox:slow]" in text else 1.5)
        return PromptSubmission(
            SubmissionDisposition.ACCEPTED,
            client_id,
            prompt_id,
            200,
            {"prompt_id": prompt_id, "simulated": True},
            None,
        )

    async def get_history(self, prompt_id: str) -> ExecutionOutcome | None:
        if time.monotonic() < self.ready_at[prompt_id]:
            return None
        return ExecutionOutcome(
            prompt_id,
            ExecutionStatus.SUCCEEDED,
            (RemoteOutputArtifact("3", "images", f"sandbox-{prompt_id}.png", "", "output"),),
            {"status_str": "success", "completed": True, "simulated": True},
        )

    async def download_artifact(self, artifact: RemoteOutputArtifact) -> DownloadedArtifact:
        content = sample_png(artifact.filename)
        return DownloadedArtifact(
            artifact, content, "image/png", hashlib.sha256(content).hexdigest()
        )


def sample_png(label: str = "sandbox") -> bytes:
    """Render a recognizable synthetic landscape without an image-library dependency."""
    width, height = 384, 256
    tint = hashlib.sha256(label.encode()).digest()[0]
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            if (x - 290) ** 2 + (y - 65) ** 2 < 28**2:
                color = (250, 212, 143)
            elif y > 175 - abs(x - 150) // 3:
                color = (30 + tint // 8, 66 + y // 6, 86 + x // 12)
            else:
                color = (100 + y // 3, 92 + tint // 4, 155 + y // 4)
            rows.extend(color)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(rows)))
        + chunk(b"IEND", b"")
    )
