import asyncio
import hashlib
import sys
from pathlib import Path
from typing import cast

import pytest
from api_client import LoopbackTestClient as TestClient

from batchcraft.comfyui import SubmissionDisposition
from tools.fake_comfyui import FakeComfyUIClient, sample_png
from tools.install_app import main as install_app
from tools.runtime import application, settings_for


@pytest.mark.parametrize(("mode", "port"), [("dev", 8001), ("test", 8002)])
def test_sandbox_ignores_live_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    port: int,
) -> None:
    monkeypatch.setenv("BATCHCRAFT_DATABASE_PATH", "/do-not-touch/live.sqlite3")
    monkeypatch.setenv("BATCHCRAFT_PROJECTS_ROOT", "/do-not-touch/projects")
    monkeypatch.setenv("BATCHCRAFT_COMFYUI_BASE_URL", "http://real-host:8188")
    monkeypatch.setenv("BATCHCRAFT_SERVER_HOST", "0.0.0.0")
    settings = settings_for(mode, tmp_path, "http://real-host:8188")
    assert settings.database_path == tmp_path / "batchcraft.sqlite3"
    assert settings.projects_root == tmp_path / "projects"
    assert settings.comfyui_base_url == "http://fake.invalid"
    assert settings.server_host == "127.0.0.1"
    assert settings.server_port == port
    with TestClient(application(mode, settings)) as http:
        status = http.get("/api/comfyui/status")
        assert status.status_code == 200
        assert "simulated" in status.text
        assert http.get("/api/projects").json() == {"projects": []}


def test_runtime_requires_absolute_data_paths() -> None:
    with pytest.raises(ValueError, match="absolute"):
        settings_for("dev", Path("relative"))


def test_everyday_lan_access_is_opt_in(tmp_path: Path) -> None:
    assert settings_for("app", tmp_path).server_host == "127.0.0.1"
    assert settings_for("app", tmp_path, lan_access=False).server_host == "127.0.0.1"
    settings = settings_for("app", tmp_path, lan_access=True)
    assert settings.server_host == "0.0.0.0"
    assert settings.server_port == 8000


@pytest.mark.parametrize("mode", ["dev", "test"])
def test_sandbox_cannot_enable_lan_access(tmp_path: Path, mode: str) -> None:
    with pytest.raises(ValueError, match="only available for the everyday app"):
        settings_for(mode, tmp_path, lan_access=True)


@pytest.mark.parametrize("value", ["true", 1, None])
def test_lan_access_requires_a_boolean(tmp_path: Path, value: object) -> None:
    with pytest.raises(ValueError, match="must be a boolean"):
        settings_for("app", tmp_path, lan_access=value)  # type: ignore[arg-type]


@pytest.mark.parametrize("mode", ["app", "test"])
def test_built_frontend_serving_preserves_api_routes(tmp_path: Path, mode: str) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<h1>Everyday frontend</h1>")
    app = application(mode, settings_for(mode, tmp_path / "data"), dist)
    with TestClient(app) as http:
        assert "Everyday frontend" in http.get("/").text
        assert http.get("/api/health").json()["status"] == "ok"
        assert http.get("/api/not-a-route").status_code == 404
        assert http.get("/app.local.json").status_code == 404
        assert http.get("/../batchcraft.sqlite3").status_code == 404
        if mode == "test":
            assert "simulated" in http.get("/api/comfyui/status").text


def test_app_requires_a_built_frontend(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Build"):
        application("app", settings_for("app", tmp_path), tmp_path / "missing")


def test_fake_execution_and_faults() -> None:
    async def verify() -> None:
        fake = FakeComfyUIClient()
        accepted = await fake.submit_prompt({}, client_id="client")
        assert accepted.disposition is SubmissionDisposition.ACCEPTED
        assert accepted.prompt_id is not None
        assert await fake.get_history(accepted.prompt_id) is None
        fake.ready_at[accepted.prompt_id] = 0
        history = await fake.get_history(accepted.prompt_id)
        assert history is not None
        artifact = await fake.download_artifact(history.artifacts[0])
        assert artifact.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert artifact.sha256 == hashlib.sha256(artifact.content).hexdigest()
        for marker, disposition in [
            ("reject", SubmissionDisposition.REJECTED),
            ("unknown", SubmissionDisposition.UNKNOWN),
        ]:
            result = await fake.submit_prompt({"text": f"[sandbox:{marker}]"}, client_id="c")
            assert result.disposition is disposition
        assert sample_png("same") == sample_png("same")
        assert sample_png("different") != sample_png("same")

    asyncio.run(verify())


@pytest.mark.parametrize("existing", ["app", "data"])
def test_install_refuses_existing_destinations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    existing: str,
) -> None:
    (tmp_path / existing).mkdir()
    marker = tmp_path / existing / "keep.txt"
    marker.write_text("untouched")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "install_app",
            "--app-path",
            str(tmp_path / "app"),
            "--data-root",
            str(tmp_path / "data"),
            "--comfyui-url",
            "http://comfy.invalid",
        ],
    )
    with pytest.raises(SystemExit) as error:
        install_app()
    assert error.value.code == 2
    assert marker.read_text() == "untouched"
    assert not (tmp_path / ("data" if existing == "app" else "app")).exists()


def test_installer_builds_without_an_inherited_instance_label(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = tmp_path / "app"
    builds: list[dict[str, str]] = []

    def run(command: list[str], **kwargs: object) -> None:
        if command[:3] == ["git", "worktree", "add"]:
            (app / "backend").mkdir(parents=True)
            (app / "frontend").mkdir()
        elif command == ["npm", "run", "build"]:
            builds.append(cast(dict[str, str], kwargs["env"]))

    monkeypatch.setenv("VITE_BATCHCRAFT_INSTANCE", "Development - simulated ComfyUI")
    monkeypatch.setattr("tools.install_app.subprocess.run", run)
    monkeypatch.setattr(
        "tools.install_app.subprocess.check_output", lambda *args, **kwargs: "a" * 40
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "install_app",
            "--app-path",
            str(app),
            "--data-root",
            str(tmp_path / "data"),
            "--comfyui-url",
            "http://comfy.invalid",
        ],
    )
    install_app()
    assert len(builds) == 1
    assert builds[0]["VITE_BATCHCRAFT_INSTANCE"] == ""
    assert builds[0]["VITE_BATCHCRAFT_API_URL"] == "/"
