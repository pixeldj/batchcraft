"""Update a stopped daily installation to a stable Git tag, after a full offline backup."""

import argparse
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from tools import maintenance as m


def update(daily_app: Path, backup_root: Path, tag: str | None, *, fetch: bool, yes: bool) -> None:
    source, app, backups = m.canonical(m.ROOT), m.canonical(daily_app), m.canonical(backup_root)
    data, _, _ = m.configuration(app)
    common = m.common_dir(source)
    m.separate(source, app, data, backups)
    for path in (app, data, backups):
        m.separate(path, common)
    metadata = m.installation(app, common)
    # Fetch is opt-in, never forced, and uses the configured source origin, not a guessed URL.
    if fetch:
        origin = m.git(source, "remote", "get-url", "origin")
        print(f"Fetching tags from configured origin: {origin}")
        m.git(source, "fetch", "origin", "--tags", "--no-force", "--atomic")
    tags = m.stable_tags(source)
    if not tags or (tag is not None and tag not in tags):
        raise ValueError(
            "Choose an existing stable tag: vMAJOR.MINOR[.PATCH]; rc/dev tags are refused"
        )
    target = tag if tag is not None else tags[-1]
    current = [
        name
        for name in tags
        if m.git(source, "rev-parse", f"refs/tags/{name}^{{commit}}")
        == metadata["application_commit"]
    ]
    if not current:
        raise ValueError("Installed commit is not a stable release; manual backup/review required")
    current_tag = metadata.get("release_tag", current[-1])
    if current_tag not in current:
        raise ValueError(
            "Recorded installed release tag no longer matches HEAD; review tags manually"
        )
    target_version, current_version = m.stable_version(target), m.stable_version(current_tag)
    assert target_version is not None and current_version is not None
    if target_version < current_version:
        raise ValueError("Downgrades are refused; older code may not support the current database")
    commit = m.git(source, "rev-parse", "--verify", f"refs/tags/{target}^{{commit}}")
    if commit == metadata["application_commit"]:
        print(f"Already installed: {target} ({commit}); no changes made.")
        return
    if target_version == current_version:
        raise ValueError(
            "Equal-version release aliases point to different commits; review tags manually"
        )
    tracked = set(m.git(source, "ls-tree", "-r", "--name-only", "-z", commit).split("\0"))
    if {"app.local.json", "installation.local.json"} & tracked:
        raise ValueError("Release unexpectedly tracks local installation metadata")
    bootstrap = metadata["bootstrap_sha256"]
    collisions = set(bootstrap) & tracked
    m.check_data_tree(data)
    backup = backups / datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
    print(f"Daily update: {current_tag} -> {target}\nCommit: {commit}\nFULL backup: {backup}")
    with m.stopped(data):
        m.confirm(yes)
        m.closed_data(data)
        m.installation(app, common)
        backup.mkdir(parents=True, mode=0o700)
        # Copy sidecars, logs, Projects and all other data, never only the SQLite main file.
        shutil.copytree(data, backup / "data")
        shutil.copy2(app / "app.local.json", backup / "app.local.json")
        shutil.copy2(app / "installation.local.json", backup / "installation.local.json")
        for relative in bootstrap:
            destination = backup / "bootstrap" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(app / relative, destination)
        m.write_metadata(
            backup / "backup.json",
            {
                "application_commit": metadata["application_commit"],
                "current_tag": current_tag,
                "target_tag": target,
                "target_commit": commit,
                "data_root": str(data),
                "app_path": str(app),
                "git_common_dir": str(common),
            },
        )
        m.closed_data(data)
        # Only hash-verified bootstrap copies can be removed to allow newly tracked launchers.
        m.installation(app, common)
        original_config = m.object_file(backup / "app.local.json")
        # Old and current launchers reject this schema before constructing the application.
        # Leave it in place on any failure, including a partially written frontend build.
        m.write_metadata(
            app / "app.local.json", {"maintenance_incomplete": {"backup": str(backup)}}
        )
        try:
            for relative in collisions:
                (app / relative).unlink()
            m.git(app, "checkout", "--detach", commit)
            m.run(["uv", "sync", "--frozen", "--no-dev"], app / "backend")
            m.run(["npm", "ci"], app / "frontend")
            subprocess.run(
                ["npm", "run", "build"],
                cwd=app / "frontend",
                check=True,
                env={
                    **m.environment(),
                    "VITE_BATCHCRAFT_API_URL": "/",
                    "VITE_BATCHCRAFT_INSTANCE": "",
                },
            )
            m.write_metadata(
                app / "installation.local.json",
                {
                    **metadata,
                    "application_commit": commit,
                    "release_tag": target,
                    "bootstrap_sha256": {
                        key: value for key, value in bootstrap.items() if key not in collisions
                    },
                },
            )
            m.write_metadata(app / "app.local.json", original_config)
        except BaseException:
            print(
                f"Update incomplete. Launch is blocked by {app / 'app.local.json'}. "
                f"Full backup: {backup}."
            )
            print(
                "Manually review and restore consistent code, dependencies, and frontend build "
                "BEFORE restoring the backed-up app.local.json."
            )
            print("No automatic rollback: restoring code alone may be unsafe after migrations.")
            raise
    print(
        f"Updated to {target} ({commit}). Backup: {backup}\nStart manually: {app / 'app.command'}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daily-app", type=Path, default=Path("~/ai/batchcraft-app"))
    parser.add_argument("--backup-root", type=Path, default=Path("~/ai/batchcraft-backups"))
    parser.add_argument(
        "--tag", help="Stable local release tag; default is highest numeric stable tag"
    )
    parser.add_argument(
        "--fetch", action="store_true", help="First fetch origin tags without force; failure aborts"
    )
    parser.add_argument("--yes", action="store_true", help="Explicitly approve backup and update")
    args = parser.parse_args()
    try:
        update(args.daily_app, args.backup_root, args.tag, fetch=args.fetch, yes=args.yes)
    except (ValueError, OSError, subprocess.CalledProcessError, EOFError) as error:
        parser.exit(
            1,
            f"Daily update stopped: {error}\nNo server started; inspect any partial backup/build.\n",
        )


if __name__ == "__main__":
    main()
