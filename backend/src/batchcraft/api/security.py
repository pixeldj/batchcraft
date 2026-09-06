"""Browser request defenses and passive Result serving. These are not authentication."""

import asyncio
import ipaddress
import tempfile
from contextlib import suppress
from functools import partial
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote, urlsplit

from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .artifacts import file_operation
from .config import Settings


def artifact_response(
    content: bytes,
    content_type: str | None,
    local_path: str,
    *,
    snapshot: BinaryIO,
    size: int,
) -> Response:
    from .artifacts import snapshot_response

    signatures = {
        "image/png": content.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": content.startswith(b"\xff\xd8\xff"),
        "image/gif": content.startswith((b"GIF87a", b"GIF89a")),
        "image/webp": (content.startswith(b"RIFF") and content[8:12] == b"WEBP"),
    }
    passive = signatures.get(content_type or "", False)
    disposition = "inline" if passive else "attachment"
    return snapshot_response(
        snapshot,
        size=size,
        media_type=content_type if passive else "application/octet-stream",
        headers={
            "Content-Disposition": (
                f"{disposition}; filename*=UTF-8''{quote(Path(local_path).name, safe='')}"
            ),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
        },
    )


def _origin(value: str) -> tuple[str, str, int] | None:
    """Accept an origin, not an arbitrary URL or a list of origins."""
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
            or any(character.isspace() for character in value)
            or any(ord(character) < 32 or ord(character) == 127 for character in value)
            or "?" in value
            or "#" in value
            or "\\" in value
            or value.endswith(":")
            or parsed.port == 0
        ):
            return None
        return (
            parsed.scheme,
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
        )
    except ValueError:
        return None


class RequestSecurityMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings
        self._inflight_bodies = 0
        self.frontend_origin = _origin(settings.frontend_origin)
        if self.frontend_origin is None:
            raise ValueError("frontend_origin must be an explicit HTTP(S) origin")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def reject(code: int, name: str, message: str) -> None:
            await JSONResponse(
                {"error": {"code": name, "message": message}},
                status_code=code,
                headers={"Retry-After": "1"} if code == 429 else None,
            )(scope, receive, send)

        hosts = [value.decode("latin-1") for key, value in scope["headers"] if key == b"host"]
        target = _origin(f"{scope['scheme']}://{hosts[0]}") if len(hosts) == 1 else None
        allowed = {"localhost", "127.0.0.1", "::1"}
        bind = self.settings.server_host
        if bind not in {"0.0.0.0", "::"}:
            allowed.add(bind.lower())
        elif target is not None:
            # A wildcard listener's socket destination identifies the actual local LAN IP.
            # Never resolve a supplied Host, or trust Forwarded/X-Forwarded-Host.
            try:
                address = ipaddress.ip_address(target[1])
                server = scope.get("server")
                if server and address == ipaddress.ip_address(server[0]):
                    allowed.add(target[1])
            except ValueError:
                pass
        if target is None or target[1] not in allowed:
            await reject(400, "invalid_host", "Host is not allowed for this instance")
            return
        origins = [value.decode("latin-1") for key, value in scope["headers"] if key == b"origin"]
        if scope["method"] not in {"GET", "HEAD", "OPTIONS"} and origins:
            origin = _origin(origins[0]) if len(origins) == 1 else None
            if origin is None or origin not in {target, self.frontend_origin}:
                await reject(403, "invalid_origin", "Origin is not allowed for mutations")
                return

        lengths = [value for key, value in scope["headers"] if key == b"content-length"]
        if lengths:
            if len(lengths) != 1 or not lengths[0].isdigit():
                await reject(400, "invalid_content_length", "Invalid Content-Length")
                return
            length = lengths[0].lstrip(b"0") or b"0"
            if (
                len(length) > len(str(self.settings.max_request_bytes))
                or int(length) > self.settings.max_request_bytes
            ):
                await reject(413, "request_too_large", "Request body exceeds the upload budget")
                return

        deadline = asyncio.get_running_loop().time() + self.settings.request_body_timeout_seconds
        first = asyncio.ensure_future(receive())
        leased = False
        body = None
        try:
            # Give receive one turn to report a genuinely empty body. Neither the method
            # nor Content-Length proves emptiness. Pending probes never queue for a slot.
            await asyncio.sleep(0)
            message = first.result() if first.done() else None
            if message is not None and message["type"] == "http.disconnect":
                return
            empty = (
                message is not None
                and not message.get("body", b"")
                and not message.get("more_body", False)
            )
            if not empty:
                if self._inflight_bodies >= self.settings.max_inflight_request_bodies:
                    await reject(429, "request_capacity_exceeded", "Request body capacity is full")
                    return
                self._inflight_bodies += 1
                leased = True
                # The outer finally closes this before releasing the admission lease.
                body = tempfile.SpooledTemporaryFile(max_size=1024 * 1024)  # noqa: SIM115
                size = 0
                admission = asyncio.timeout_at(deadline)
                try:
                    async with admission:
                        if message is None:
                            message = await first
                        while True:
                            if message["type"] == "http.disconnect":
                                return
                            chunk = message.get("body", b"")
                            size += len(chunk)
                            if size > self.settings.max_request_bytes:
                                break
                            await file_operation(partial(body.write, chunk))
                            if not message.get("more_body", False):
                                break
                            message = await receive()
                        await file_operation(partial(body.seek, 0))
                except TimeoutError:
                    if not admission.expired():
                        raise
                    await reject(408, "request_body_timeout", "Request body admission timed out")
                    return
                if size > self.settings.max_request_bytes:
                    await reject(413, "request_too_large", "Request body exceeds the upload budget")
                    return
            else:
                size = 0

            remaining = size
            completed = False

            async def replay() -> Message:
                nonlocal remaining, completed
                if completed:
                    return await receive()
                chunk = (
                    await file_operation(partial(body.read, 64 * 1024)) if body is not None else b""
                )
                remaining -= len(chunk)
                completed = remaining == 0
                return {"type": "http.request", "body": chunk, "more_body": remaining > 0}

            await self.app(scope, replay, send)
        finally:
            first.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await first
            try:
                if body is not None:
                    await file_operation(body.close)
            finally:
                if leased:
                    self._inflight_bodies -= 1
