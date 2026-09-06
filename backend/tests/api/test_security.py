import asyncio
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import BinaryIO, cast

import pytest
from artifact_fixture import write_artifact_fixture
from fastapi.testclient import TestClient
from starlette.types import Message, Receive, Scope, Send

from batchcraft.api import Settings, create_app
from batchcraft.api.security import RequestSecurityMiddleware
from tools.fake_comfyui import FakeComfyUIClient, sample_png
from tools.runtime import settings_for


@pytest.mark.parametrize(
    ("content", "mime", "passive"),
    [
        (sample_png("security"), "image/png", True),
        (b"<html><script>alert(1)</script></html>", "text/html", False),
        (b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', "image/svg+xml", False),
        (b"<html>not PNG</html>", "image/png", False),
        (sample_png("security"), "text/html", False),
        (b"unknown", None, False),
        (b"\xff\xd8\xffimage", "image/jpeg", True),
        (b"GIF89aimage", "image/gif", True),
        (b"RIFF\x04\x00\x00\x00WEBP", "image/webp", True),
        (b"RIFFnot-webp", "image/webp", False),
    ],
)
def test_result_serving_preserves_bytes_and_metadata_but_distrusts_mime(
    tmp_path: Path, content: bytes, mime: str | None, passive: bool
) -> None:
    settings = settings_for("test", tmp_path)
    execution_path = write_artifact_fixture(settings.projects_root, [(content, mime, "png")])
    before = execution_path.read_bytes()
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url="http://localhost:8002") as http:
        response = http.get("/api/runs/run-id/results/1/1")
    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-type"] == (mime if passive else "application/octet-stream")
    assert response.headers["content-disposition"].startswith(
        "inline;" if passive else "attachment;"
    )
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == (
        "sandbox; default-src 'none'; frame-ancestors 'none'"
    )
    assert execution_path.read_bytes() == before


@pytest.mark.parametrize(
    "origin",
    ["https://evil.example", "null", "http://localhost:8002.evil", "http://localhost:8002/path"],
)
def test_hostile_origins_reject_all_mutation_shapes_without_side_effects(
    tmp_path: Path, origin: str
) -> None:
    settings = settings_for("test", tmp_path)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url="http://localhost:8002") as http:
        project = http.post("/api/projects", json={"name": "Safe", "filesystem_key": "safe"}).json()
        before = {
            p.relative_to(settings.projects_root): p.read_bytes()
            for p in settings.projects_root.rglob("*")
            if p.is_file()
        }
        headers = {"Origin": origin}
        assert (
            http.post(
                "/api/projects", json={"name": "Evil", "filesystem_key": "evil"}, headers=headers
            ).status_code
            == 403
        )
        assert (
            http.post(f"/api/projects/{project['id']}/archive", headers=headers).status_code == 403
        )
        assert (
            http.post(
                "/api/projects/safe/assets",
                files={"files": ("image.png", sample_png("upload"), "image/png")},
                headers=headers,
            ).status_code
            == 403
        )
        assert len(http.get("/api/projects").json()["projects"]) == 1
        assert http.get(f"/api/projects/{project['id']}").json()["archived_at"] is None
        assert before == {
            p.relative_to(settings.projects_root): p.read_bytes()
            for p in settings.projects_root.rglob("*")
            if p.is_file()
        }


@pytest.mark.parametrize(
    "host",
    [
        "evil.example",
        "localhost.evil",
        "127.0.0.1.evil",
        "0.0.0.0",
        "192.168.1.20",
        "testserver",
        "localhost:bad",
        "user@localhost",
    ],
)
@pytest.mark.parametrize("peer", [("127.0.0.1", 12345), ("testclient", 50000)])
def test_hostile_hosts_rejected_even_without_origin(
    tmp_path: Path, host: str, peer: tuple[str, int]
) -> None:
    settings = settings_for("dev", tmp_path)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url="http://localhost:8001", client=peer) as http:
        assert http.get("/api/health", headers={"Host": host}).status_code == 400
        assert (
            http.post(
                "/api/projects",
                json={"name": "Evil", "filesystem_key": "evil"},
                headers={"Host": host},
            ).status_code
            == 400
        )
        assert http.get("/api/projects").json() == {"projects": []}
        assert not settings.projects_root.exists()


@pytest.mark.parametrize(
    ("mode", "url", "origin"),
    [
        ("dev", "http://127.0.0.1:8001", "http://127.0.0.1:5174"),
        ("app", "http://127.0.0.1:8000", "http://127.0.0.1:8000"),
        ("app", "http://localhost:8000", "http://localhost:8000"),
        ("test", "http://localhost:8002", None),
    ],
)
def test_legitimate_browser_and_cli_mutations(
    tmp_path: Path, mode: str, url: str, origin: str | None
) -> None:
    settings = settings_for(mode, tmp_path)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url=url) as http:
        response = http.post(
            "/api/projects",
            json={"name": "Allowed", "filesystem_key": "allowed"},
            headers={} if origin is None else {"Origin": origin},
        )
        assert response.status_code == 201
        if mode == "dev":
            assert response.headers["access-control-allow-origin"] == origin


def test_receive_budget_and_lan_policy_before_parsing_and_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = replace(
        settings_for("app", tmp_path, lan_access=True), max_request_bytes=2 * 1024 * 1024
    )
    spools: list[BinaryIO] = []
    original = tempfile.SpooledTemporaryFile

    def tracked_spool(*args: object, **kwargs: object) -> BinaryIO:
        spool = original(*args, **kwargs)  # type: ignore[call-overload]
        spools.append(cast(BinaryIO, spool))
        return cast(BinaryIO, spool)

    monkeypatch.setattr("batchcraft.api.security.tempfile.SpooledTemporaryFile", tracked_spool)

    async def check(
        host: str,
        origin: str | None,
        chunks: list[bytes],
        expected: int,
        *,
        length: bytes | None = None,
        disconnect: bool = False,
    ) -> None:
        called = False
        messages: list[Message] = []
        received = 0
        headers = [
            (b"host", host.encode()),
            (b"content-type", b"multipart/form-data; boundary=test"),
        ]
        if origin is not None:
            headers.append((b"origin", origin.encode()))
        if length is not None:
            headers.append((b"content-length", length))
        scope: Scope = {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "headers": headers,
            "server": ("192.168.1.20", 8000),
            "client": ("192.168.1.30", 23456),
        }

        async def receive() -> Message:
            nonlocal received
            received += 1
            if disconnect and received == len(chunks):
                return {"type": "http.disconnect"}
            return {
                "type": "http.request",
                "body": chunks[received - 1],
                "more_body": received < len(chunks),
            }

        async def send(message: Message) -> None:
            messages.append(message)

        async def endpoint(scope: Scope, receive: Receive, send: Send) -> None:
            nonlocal called
            called = True
            body = b""
            while True:
                message = await receive()
                body += message["body"]
                if not message["more_body"]:
                    break
            assert body == b"".join(chunks)

        await RequestSecurityMiddleware(endpoint, settings)(scope, receive, send)
        assert called is (expected == 200)
        if expected not in {200, 499}:
            assert messages[0]["status"] == expected
        if expected in {400, 403} or length is not None:
            assert received == 0
        assert all(spool.closed for spool in spools)

    async def verify() -> None:
        await check("192.168.1.20:8000", "http://192.168.1.20:8000", [b"ok"], 200)
        await check("192.168.1.20:8000", None, [b"x" * 1024 * 1024] * 2, 200)
        await check("192.168.1.20:8000", None, [b"x" * (1024 * 1024 + 1)] * 2, 413)
        await check("192.168.1.20:8000", None, [b""], 413, length=b"2097153")
        await check(
            "192.168.1.20:8000", None, [b"x" * (1024 * 1024 + 1), b""], 499, disconnect=True
        )
        await check("192.168.1.21:8000", None, [b""], 400)
        await check("evil.example:8000", "http://evil.example:8000", [b""], 400)
        await check("192.168.1.20:8000", "null", [b""], 403)
        await check("192.168.1.20:8000", "http://192.168.1.20:9000", [b""], 403)

    asyncio.run(verify())


def test_total_multipart_budget_rejects_before_any_asset_is_imported(tmp_path: Path) -> None:
    settings = replace(settings_for("test", tmp_path), max_request_bytes=1024)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url="http://localhost:8002") as http:
        response = http.post(
            "/api/projects/safe/assets",
            headers={"Origin": settings.frontend_origin},
            files=[
                ("files", ("one.png", b"\x89PNG\r\n\x1a\n" + b"x" * 500, "image/png")),
                ("files", ("two.png", b"\x89PNG\r\n\x1a\n" + b"y" * 500, "image/png")),
            ],
        )
        assert response.status_code == 413
        assert response.headers["access-control-allow-origin"] == settings.frontend_origin
        assert response.json()["error"]["code"] == "request_too_large"
        assert not settings.projects_root.exists()


def test_request_budget_configuration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BATCHCRAFT_MAX_REQUEST_BYTES", "1234")
    assert Settings.from_env().max_request_bytes == 1234
    # Runtime instances deliberately do not inherit environment overrides.
    assert settings_for("test", tmp_path).max_request_bytes == 64 * 1024 * 1024
    for value in ["0", "-1", "invalid"]:
        monkeypatch.setenv("BATCHCRAFT_MAX_REQUEST_BYTES", value)
        with pytest.raises(ValueError):
            Settings.from_env()


@pytest.mark.parametrize(
    "headers",
    [
        [("Host", "localhost:8002"), ("Host", "evil.example")],
        [("Origin", "http://localhost:8002"), ("Origin", "https://evil.example")],
        [("Origin", "http://localhost:8002 https://evil.example")],
    ],
)
def test_ambiguous_security_headers_fail_closed(
    tmp_path: Path, headers: list[tuple[str, str]]
) -> None:
    settings = settings_for("test", tmp_path)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url="http://localhost:8002") as http:
        response = http.post(
            "/api/projects", json={"name": "Evil", "filesystem_key": "evil"}, headers=headers
        )
        assert response.status_code in {400, 403}
        assert http.get("/api/projects").json() == {"projects": []}


@pytest.mark.parametrize(
    ("url", "host", "origin", "expected"),
    [
        ("http://localhost", "LOCALHOST:80", "http://localhost", 201),
        ("https://localhost", "LOCALHOST:443", "https://localhost", 201),
        ("https://localhost", "localhost", "http://localhost", 403),
        ("http://localhost", "localhost", "https://localhost", 403),
        ("http://localhost", "localhost", "http://localhost:8000", 403),
        ("http://localhost", "localhost", "\x00http://localhost", 403),
        ("http://localhost", "localhost?", "http://localhost", 400),
        ("http://localhost", "localhost#", "http://localhost", 400),
        ("http://localhost", "localhost", "http://localhost?", 403),
        ("http://localhost", "localhost", "http://localhost#", 403),
        ("http://localhost", "evil.example", "http://localhost", 400),
    ],
)
def test_origin_normalization_preserves_scheme_port_and_host_policy(
    tmp_path: Path, url: str, host: str, origin: str, expected: int
) -> None:
    settings = settings_for("test", tmp_path)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app, base_url=url) as http:
        response = http.post(
            "/api/projects",
            json={"name": "Normalization", "filesystem_key": "normalization"},
            headers={
                "Host": host,
                "Origin": origin,
                "X-Forwarded-Host": "localhost",
                "X-Forwarded-Proto": origin.split(":", 1)[0],
            },
        )
        assert response.status_code == expected
        assert len(http.get("/api/projects").json()["projects"]) == (1 if expected == 201 else 0)
