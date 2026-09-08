"""Replace an owned test candidate with committed code and a full offline daily-data copy."""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from tools import maintenance as m


def refresh(daily_app: Path, test_root: Path, revision: str, *, yes: bool) -> None:
    source = m.canonical(m.ROOT)
    daily_app, test_root = m.canonical(daily_app), m.canonical(test_root)
    daily_data, url, lan = m.configuration(daily_app)
    common = m.common_dir(source)
    m.separate(daily_app, daily_data, source)
    m.separate(daily_data, common)
    for protected in (daily_app, daily_data, source, common):
        m.separate(test_root, protected)
    app, data = test_root / "app", test_root / "data"
    for path in (app, data):
        m.canonical(path)
    existing_candidate = False
    if test_root.exists():
        if not test_root.is_dir():
            raise ValueError("Test root must be a directory")
        children = {item.name for item in test_root.iterdir()}
        if children and children != {"app", "data"}:
            raise ValueError(
                "Existing test root must be empty or contain exactly the owned app and data folders"
            )
        existing_candidate = bool(children)
    if existing_candidate:
        if m.configuration(app)[0] != data:
            raise ValueError("Existing candidate configuration must name test-root/data")
        m.installation(app, common)
    commit = m.git(source, "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}")
    tracked = set(m.git(source, "ls-tree", "-r", "--name-only", "-z", commit).split("\0"))
    for relative in set(m.BOOTSTRAP) - tracked:
        # The existing installer bootstraps older tags from this checkout. Do not silently
        # promote an uncommitted launcher while claiming that dirty source is excluded.
        m.canonical(source / relative)
        if not m.git(source, "ls-tree", "HEAD", "--", relative) or m.git(
            source, "diff", "HEAD", "--", relative
        ):
            raise ValueError(f"Required installer bootstrap must match committed HEAD: {relative}")
    if m.git(source, "status", "--porcelain"):
        print("WARNING: source checkout is dirty; uncommitted application changes are excluded.")
    m.check_data_tree(daily_data)
    print(
        f"Copy ALL daily data: {daily_data}\nReplace TEST ONLY: {test_root}\nCode commit: {commit}"
    )
    print(
        f"ComfyUI host preserved: {url}; test candidate uses loopback (daily LAN setting: {lan})."
    )
    print("The old test candidate is disposable and will not survive an installation failure.")
    with m.stopped(daily_data, data):
        m.confirm(yes)
        m.closed_data(daily_data, data)
        if existing_candidate:
            # --force permits installer-owned ignored config/build outputs, never unknown code.
            m.installation(app, common)
            m.git(source, "worktree", "remove", "--force", str(app))
            shutil.rmtree(data)
        else:
            if test_root.exists() and any(test_root.iterdir()):
                raise ValueError("Test root is no longer empty; refusing to adopt unknown files")
            test_root.mkdir(parents=True, exist_ok=True)
        m.run(
            [
                sys.executable,
                "-m",
                "tools.install_app",
                "--app-path",
                str(app),
                "--data-root",
                str(data),
                "--comfyui-url",
                url,
                "--revision",
                commit,
            ],
            source / "backend",
        )
        # Installer has created only an empty data root and projects directory. No app has run.
        if set(data.iterdir()) != {data / "projects"} or any((data / "projects").iterdir()):
            raise ValueError("Installer data directory is not fresh; refusing to overlay data")
        m.closed_data(daily_data, data)
        m.check_data_tree(daily_data)
        shutil.copytree(daily_data, data, dirs_exist_ok=True)
        m.closed_data(daily_data, data)
    print(f"Test candidate ready: {app / 'app.command'}\nNo daily data was modified.")
    print("This candidate retains the LIVE ComfyUI host; starting Jobs can submit GPU work.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daily-app", type=Path, default=Path("~/ai/batchcraft-app"))
    parser.add_argument("--test-root", type=Path, default=Path("~/ai/batchcraft-test"))
    parser.add_argument(
        "--revision", default="HEAD", help="Committed source revision (default HEAD)"
    )
    parser.add_argument(
        "--yes", action="store_true", help="Explicitly approve disposable test replacement"
    )
    args = parser.parse_args()
    try:
        refresh(args.daily_app, args.test_root, args.revision, yes=args.yes)
    except (ValueError, OSError, subprocess.CalledProcessError, EOFError) as error:
        parser.exit(
            1, f"Test refresh stopped: {error}\nPartial test installations need manual review.\n"
        )


if __name__ == "__main__":
    main()
