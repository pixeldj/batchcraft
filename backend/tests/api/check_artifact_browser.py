"""Opt-in check: PYTHONPATH=. uv run python tests/api/check_artifact_browser.py.

Requires frontend/dist and the frontend's installed Playwright Chromium. Uses only
temporary fake-backed data and port 8002, refusing an occupied port.
"""

import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import BinaryIO, cast

import uvicorn
from artifact_fixture import artifact_png, write_artifact_fixture

from batchcraft.application import BatchcraftService
from batchcraft.execution import ResultRecord
from batchcraft.files import PublishedRun
from tools.runtime import application, settings_for


def main() -> None:
    root = Path(__file__).resolve().parents[3]
    with tempfile.TemporaryDirectory(prefix="batchcraft-security-browser-") as directory:
        settings = settings_for("test", Path(directory))
        script = (
            "localStorage.setItem('artifact-executed', 'yes');"
            "fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'},"
            "body:JSON.stringify({name:'Exploit',filesystem_key:'exploit'})});"
        )
        execution_path = write_artifact_fixture(
            settings.projects_root,
            [
                (f"<html><script>{script}</script></html>".encode(), "text/html", "html"),
                (
                    f'<svg xmlns="http://www.w3.org/2000/svg"><script>{script}</script></svg>'.encode(),
                    "image/svg+xml",
                    "svg",
                ),
                (artifact_png("browser.png"), "image/png", "png"),
                *[(artifact_png(f"burst-{index}.png"), "image/png", "png") for index in range(6)],
            ],
        )
        before = execution_path.read_bytes()
        app = application("test", settings, root / "frontend/dist")
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 8002))
            listener.listen(128)
            server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
            thread = threading.Thread(
                target=server.run, kwargs={"sockets": [listener]}, daemon=True
            )
            thread.start()
            try:
                deadline = time.monotonic() + 10
                while not server.started:
                    if not thread.is_alive() or time.monotonic() >= deadline:
                        raise RuntimeError("Temporary security test server did not start")
                    time.sleep(0.02)
                service = cast(BatchcraftService, app.state.service)
                get_result = service.get_result
                lock = threading.Lock()
                active = peak = completed = 0

                def delayed_result(
                    run: PublishedRun,
                    job_ordinal: int,
                    artifact_ordinal: int,
                    destination: BinaryIO,
                ) -> ResultRecord:
                    nonlocal active, peak, completed
                    if artifact_ordinal < 4:
                        return get_result(run, job_ordinal, artifact_ordinal, destination)
                    with lock:
                        active += 1
                        peak = max(peak, active)
                    try:
                        # Hold four leases long enough for a normal six-image burst to queue.
                        time.sleep(0.5)
                        result = get_result(run, job_ordinal, artifact_ordinal, destination)
                        with lock:
                            completed += 1
                        return result
                    finally:
                        with lock:
                            active -= 1

                service.get_result = delayed_result  # type: ignore[method-assign]
                subprocess.run(
                    ["node", str(Path(__file__).with_name("artifact_browser.mjs"))],
                    cwd=root / "frontend",
                    check=True,
                    timeout=60,
                )
                assert execution_path.read_bytes() == before
                assert peak == 4 and completed == 6 and active == 0
            finally:
                server.should_exit = True
                thread.join(timeout=10)
                if thread.is_alive():
                    raise RuntimeError("Temporary security test server did not stop")


if __name__ == "__main__":
    main()
