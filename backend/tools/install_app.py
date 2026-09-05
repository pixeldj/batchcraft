"""Provision a new everyday worktree without committing or moving existing data."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-path", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--comfyui-url", required=True)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument(
        "--lan-access", action="store_true", help="Expose port 8000 on trusted LANs"
    )
    args = parser.parse_args()
    app_path = args.app_path.expanduser().resolve()
    data_root = args.data_root.expanduser().resolve()
    if app_path.exists() or data_root.exists():
        parser.error("New app and data paths must not exist; existing data is never replaced")
    if app_path.is_relative_to(data_root) or data_root.is_relative_to(app_path):
        parser.error("App and data directories must be separate, not nested")
    if not app_path.parent.is_dir() or not data_root.parent.is_dir():
        parser.error("Create the parent directories first")
    parsed = urlsplit(args.comfyui_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        parser.error("--comfyui-url must be an HTTP base URL")
    revision = subprocess.check_output(
        ["git", "rev-parse", "--verify", f"{args.revision}^{{commit}}"],
        cwd=ROOT,
        text=True,
    ).strip()
    subprocess.run(
        ["git", "worktree", "add", "--detach", str(app_path), revision], cwd=ROOT, check=True
    )

    # Bootstrap only the launcher when installing a revision predating these tools.
    # Application source and dependencies still come exclusively from the chosen commit.
    bootstrap: dict[str, str] = {}
    for relative in ("app.command", "backend/tools/__init__.py", "backend/tools/runtime.py"):
        destination = app_path / relative
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, destination)
            bootstrap[relative] = hashlib.sha256(destination.read_bytes()).hexdigest()
    (app_path / "app.command").chmod(0o755)
    config = app_path / "app.local.json"
    with config.open("x") as file:
        json.dump(
            {
                "data_root": str(data_root),
                "comfyui_base_url": args.comfyui_url,
                "lan_access": args.lan_access,
            },
            file,
            indent=2,
        )
        file.write("\n")
    config.chmod(0o600)
    with (app_path / "installation.local.json").open("x") as file:
        json.dump({"application_commit": revision, "bootstrap_sha256": bootstrap}, file, indent=2)
        file.write("\n")
    data_root.mkdir()
    (data_root / "projects").mkdir()
    subprocess.run(["uv", "sync", "--frozen", "--no-dev"], cwd=app_path / "backend", check=True)
    subprocess.run(["npm", "ci"], cwd=app_path / "frontend", check=True)
    subprocess.run(
        ["npm", "run", "build"],
        cwd=app_path / "frontend",
        check=True,
        env={
            **os.environ,
            "VITE_BATCHCRAFT_API_URL": "/",
            "VITE_BATCHCRAFT_INSTANCE": "Everyday app",
        },
    )
    print(f"Installed application commit {revision}")
    print(f"Start: {app_path / 'app.command'}")
    print("Open: http://127.0.0.1:8000")
    print("No existing data was copied. No server was started and no GPU work was submitted.")


if __name__ == "__main__":
    main()
