"""Shared fail-closed checks for stopped, source-installed macOS instances."""

import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ("app.command", "backend/tools/__init__.py", "backend/tools/runtime.py")


def environment() -> dict[str, str]:
    # Do not let an inherited Git override redirect a destructive worktree operation.
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def run(command: list[str], cwd: Path) -> str:
    return subprocess.check_output(command, cwd=cwd, env=environment(), text=True).rstrip("\n")


def git(root: Path, *args: str) -> str:
    return run(["git", *args], root)


def canonical(path: Path) -> Path:
    path = path.expanduser()
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Use an absolute path without '..': {path}")
    for component in (*reversed(path.parents), path):
        if component.is_symlink():
            raise ValueError(f"Symlink path is not allowed: {component}")
    return path.resolve()


def separate(*paths: Path) -> None:
    for index, left in enumerate(paths):
        for right in paths[index + 1 :]:
            if left.is_relative_to(right) or right.is_relative_to(left):
                raise ValueError(f"Paths overlap: {left} and {right}")


def object_file(path: Path) -> dict[str, Any]:
    canonical(path)
    if not path.is_file() or path.stat().st_nlink != 1:
        raise ValueError(f"Expected an independent regular metadata file: {path}")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def configuration(app: Path) -> tuple[Path, str, bool]:
    config = object_file(app / "app.local.json")
    if not {"data_root", "comfyui_base_url"} <= config.keys() or config.keys() - {
        "data_root",
        "comfyui_base_url",
        "lan_access",
    }:
        raise ValueError(f"Unexpected app.local.json schema in {app}")
    data, url, lan = (
        config["data_root"],
        config["comfyui_base_url"],
        config.get("lan_access", False),
    )
    if not isinstance(data, str) or not isinstance(url, str) or not isinstance(lan, bool):
        raise ValueError("Invalid application configuration types")
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Invalid ComfyUI HTTP URL")
    data_root = canonical(Path(data))
    if not data_root.is_dir():
        raise ValueError(f"Missing data directory: {data_root}")
    return data_root, url, lan


def common_dir(app: Path) -> Path:
    return canonical(Path(git(app, "rev-parse", "--path-format=absolute", "--git-common-dir")))


def installation(app: Path, common: Path) -> dict[str, Any]:
    if not (app / ".git").is_file() or (app / ".git").is_symlink():
        raise ValueError(f"Expected an installed linked worktree: {app}")
    if (
        canonical(Path(git(app, "rev-parse", "--show-toplevel"))) != app
        or common_dir(app) != common
    ):
        raise ValueError(f"Worktree does not belong to the source repository: {app}")
    records = git(app, "worktree", "list", "--porcelain").split("\n\n")
    if not any(f"worktree {app}\n" in record + "\n" for record in records):
        raise ValueError(f"Worktree is not registered: {app}")
    if git(app, "rev-parse", "--abbrev-ref", "HEAD") != "HEAD":
        raise ValueError(f"Installed worktree must be detached: {app}")
    metadata = object_file(app / "installation.local.json")
    if metadata.get("application_commit") != git(app, "rev-parse", "HEAD"):
        raise ValueError(f"Installation commit does not match HEAD: {app}")
    bootstrap = metadata.get("bootstrap_sha256")
    if not isinstance(bootstrap, dict) or bootstrap.keys() - set(BOOTSTRAP):
        raise ValueError("Unknown bootstrap files in installation manifest")
    for relative, digest in bootstrap.items():
        path = canonical(app / relative)
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(f"Modified or missing bootstrap file: {path}")
        if git(app, "ls-files", "--", relative):
            raise ValueError(f"Bootstrap unexpectedly tracked: {relative}")
    if git(app, "diff", "HEAD", "--") or git(app, "diff", "--cached", "--"):
        raise ValueError(f"Dirty installed code; preserve/review it manually: {app}")
    untracked = git(app, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
    allowed = {*bootstrap, "app.local.json", "installation.local.json"}
    if unexpected := set(untracked) - allowed - {""}:
        raise ValueError(f"Unknown untracked installed files: {sorted(unexpected)}")
    ignored = git(app, "ls-files", "--others", "--ignored", "--exclude-standard", "-z").split("\0")
    for relative in ignored:
        if not relative or relative in allowed:
            continue
        path = Path(relative)
        if not (
            relative.startswith(("backend/.venv/", "frontend/node_modules/", "frontend/dist/"))
            or "__pycache__" in path.parts
        ):
            raise ValueError(f"Unknown ignored installed file: {relative}")
    for relative in (
        "backend",
        "frontend",
        "backend/.venv",
        "frontend/node_modules",
        "frontend/dist",
    ):
        canonical(app / relative)
    return metadata


def check_data_tree(root: Path) -> None:
    # copytree must never follow links to outside data or block on a FIFO/device.
    for directory, dirs, files in os.walk(root, onerror=_walk_error):
        for name in dirs + files:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError(f"Data contains a symlink or special file: {path}")


def _walk_error(error: OSError) -> None:
    raise error


def _lsof_clear(arguments: list[str], label: str) -> None:
    executable = shutil.which("lsof")
    if executable is None:
        raise ValueError("lsof is required; cannot establish that the instances are stopped")
    result = subprocess.run(
        [executable, "-nP", *arguments], capture_output=True, text=True, env=environment()
    )
    if result.returncode != 1 or result.stdout.strip() or result.stderr.strip():
        raise ValueError(
            f"Open files or inconclusive lsof check for {label}; stop all users of this data.\n"
            f"{result.stdout}{result.stderr}"
        )


def closed_data(*roots: Path) -> None:
    for root in roots:
        if root.exists():
            _lsof_clear(["+D", str(root)], str(root))


@contextmanager
def stopped(*roots: Path) -> Iterator[None]:
    # Reserve the application's fixed IPv4 port throughout maintenance, including builds.
    _lsof_clear(["-iTCP:8000"], "TCP port 8000 (IPv4 and IPv6)")
    with socket.socket() as listener:
        listener.bind(("0.0.0.0", 8000))
        listener.listen(1)
        closed_data(*roots)
        yield


def confirm(yes: bool) -> None:
    print("Finish active Runs first; local process checks cannot detect remote ComfyUI work.")
    print("Keep both instances stopped until this command finishes. No server will be started.")
    if not yes and input("Type YES to proceed: ") != "YES":
        raise ValueError("Cancelled; no installation or data changes made")


def stable_version(tag: str) -> tuple[int, int, int] | None:
    if re.fullmatch(r"v[0-9]+\.[0-9]+(?:\.[0-9]+)?", tag) is None:
        return None
    parts = [int(part) for part in tag[1:].split(".")]
    return parts[0], parts[1], parts[2] if len(parts) == 3 else 0


def stable_tags(root: Path) -> list[str]:
    return sorted(
        (tag for tag in git(root, "tag", "--list").splitlines() if stable_version(tag) is not None),
        key=lambda tag: (stable_version(tag), tag),
    )


def write_metadata(path: Path, value: dict[str, Any]) -> None:
    # Replace rather than truncate an installation's existing metadata.
    temporary = path.with_name(path.name + ".pending")
    with temporary.open("x") as file:
        json.dump(value, file, indent=2)
        file.write("\n")
    temporary.chmod(0o600)
    temporary.replace(path)
