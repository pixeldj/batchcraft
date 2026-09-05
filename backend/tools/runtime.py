"""Run isolated local instances. Invoke from backend with python -m tools.runtime."""

import argparse
import json
import os
import signal
import socket
import subprocess
import tempfile
from contextlib import ExitStack
from pathlib import Path
from types import FrameType
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI
from starlette.staticfiles import StaticFiles

from batchcraft.api import Settings, create_app

ROOT = Path(__file__).resolve().parents[2]


def settings_for(
    mode: str,
    data_root: Path,
    comfyui_url: str = "http://fake.invalid",
    *,
    lan_access: bool = False,
) -> Settings:
    """Never inherit database, filesystem, or remote-host overrides from the shell."""
    if not data_root.is_absolute():
        raise ValueError("The data root must be an absolute path")
    if not isinstance(lan_access, bool):
        raise ValueError("lan_access must be a boolean")
    if lan_access and mode != "app":
        raise ValueError("LAN access is only available for the everyday app")
    port = {"app": 8000, "dev": 8001, "test": 8002}[mode]
    origin = {
        "app": "http://127.0.0.1:8000",
        "dev": "http://127.0.0.1:5174",
        "test": "http://127.0.0.1:5175",
    }[mode]
    return Settings(
        data_root=data_root,
        database_path=data_root / "batchcraft.sqlite3",
        projects_root=data_root / "projects",
        comfyui_base_url=comfyui_url if mode == "app" else "http://fake.invalid",
        comfyui_timeout_seconds=30,
        websocket_timeout_seconds=21600,
        history_timeout_seconds=21600,
        history_poll_interval_seconds=1 if mode == "app" else 0.1,
        frontend_origin=origin,
        server_host="0.0.0.0" if lan_access else "127.0.0.1",
        server_port=port,
    )


def application(mode: str, settings: Settings, frontend_dist: Path | None = None) -> FastAPI:
    if (mode == "app" or frontend_dist is not None) and (
        frontend_dist is None or not (frontend_dist / "index.html").is_file()
    ):
        raise ValueError("Build the everyday frontend before starting the app")
    if mode == "app":
        app = create_app(settings)
    else:
        from tools.fake_comfyui import FakeComfyUIClient

        app = create_app(settings, client_factory=lambda _settings: FakeComfyUIClient())
    if frontend_dist is not None:
        app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("app", "dev", "test"))
    parser.add_argument(
        "--built-frontend", action="store_true", help="Test same-origin built frontend"
    )
    args = parser.parse_args()
    mode = args.mode
    if args.built_frontend and mode != "test":
        parser.error("--built-frontend is only available in test mode")
    # Uvicorn restores and re-raises SIGTERM after shutdown. Unwind our owned resources too.
    signal.signal(signal.SIGTERM, terminate)
    lan_access = False
    with ExitStack() as stack:
        if mode == "app":
            config_path = ROOT / "app.local.json"
            config = json.loads(config_path.read_text())
            required = {"data_root", "comfyui_base_url"}
            if not required <= set(config) or set(config) - required - {"lan_access"}:
                raise ValueError(
                    f"Expected data_root, comfyui_base_url, and optional lan_access in {config_path}"
                )
            lan_access = config.get("lan_access", False)
            data_root = Path(config["data_root"]).expanduser()
            url = config["comfyui_base_url"]
            parsed = urlsplit(url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise ValueError("Configure a valid ComfyUI HTTP base URL in app.local.json")
        elif mode == "test":
            data_root = Path(
                stack.enter_context(tempfile.TemporaryDirectory(prefix="batchcraft-e2e-"))
            )
            url = "http://fake.invalid"
        else:
            data_root = ROOT / ".local" / "dev-data"
            if not data_root.resolve().is_relative_to(ROOT):
                raise ValueError("Development data must stay inside this checkout")
            url = "http://fake.invalid"

        settings = settings_for(mode, data_root, url, lan_access=lan_access)
        frontend_dist = ROOT / "frontend" / "dist" if mode == "app" or args.built_frontend else None
        app = application(mode, settings, frontend_dist)
        # Claim the API port before starting Vite or initializing any data.
        listener = stack.enter_context(socket.socket())
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((settings.server_host, settings.server_port))
        listener.listen(128)
        browser_url = "http://localhost:8002" if args.built_frontend else settings.frontend_origin
        print(f"batchcraft {mode}: {browser_url}", flush=True)
        if lan_access:
            print(
                "LAN: http://<this-Mac-LAN-IP>:8000 (all IPv4 interfaces, no authentication; "
                "trusted networks only)",
                flush=True,
            )
        print(f"Data: {data_root}", flush=True)
        print(
            f"ComfyUI: {'LIVE' if mode == 'app' else 'SIMULATED - no network or GPU'}", flush=True
        )
        if mode == "dev":
            with socket.socket() as frontend_port:
                frontend_port.bind(("127.0.0.1", 5174))
            environment = {
                **os.environ,
                "VITE_BATCHCRAFT_API_URL": "http://127.0.0.1:8001",
                "VITE_BATCHCRAFT_INSTANCE": "Development - simulated ComfyUI",
            }
            frontend = subprocess.Popen(
                [
                    "node",
                    "node_modules/vite/bin/vite.js",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "5174",
                    "--strictPort",
                ],
                cwd=ROOT / "frontend",
                env=environment,
            )
            stack.callback(stop_frontend, frontend)
        uvicorn.run(app, fd=listener.fileno())


def terminate(signum: int, frame: FrameType | None) -> None:
    raise SystemExit(0)


def stop_frontend(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == "__main__":
    main()
