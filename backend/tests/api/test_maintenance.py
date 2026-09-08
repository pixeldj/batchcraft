"""Maintenance tests use only disposable repositories; builds and process probes are fakes."""

import hashlib
import shutil
import signal
import socket
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path
from typing import Any

import pytest

from tools import maintenance as m
from tools import refresh_test, runtime, update_daily


def put(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


@pytest.fixture
def installed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, Path]:
    source, app, data = tmp_path / "source", tmp_path / "daily", tmp_path / "daily-data"
    source.mkdir()
    m.git(source, "init")
    put(
        source / ".gitignore",
        "/app.local.json\n/installation.local.json\n.venv/\nnode_modules/\ndist/\n__pycache__/\n*.sqlite3\n",
    )
    put(source / "backend/source.py", "old application\n")
    put(source / "frontend/source.ts", "old client\n")
    m.git(source, "add", ".")
    m.git(
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "old",
    )
    m.git(source, "tag", "v1.0.0")
    m.git(source, "worktree", "add", "--detach", str(app), "v1.0.0")
    bootstrap = {}
    for relative in m.BOOTSTRAP:
        put(app / relative, "bootstrap\n")
        bootstrap[relative] = hashlib.sha256((app / relative).read_bytes()).hexdigest()
        put(source / relative, "new tracked launcher\n")
    put(data / "projects/retained.txt", "immutable result")
    put(data / "batchcraft.sqlite3", "database")
    put(data / "batchcraft.sqlite3-wal", "wal")
    put(data / "batchcraft.sqlite3-shm", "shm")
    put(data / "logs/server.log", "full copy includes logs")
    m.write_metadata(
        app / "app.local.json",
        {"data_root": str(data), "comfyui_base_url": "http://gpu.invalid:8188", "lan_access": True},
    )
    m.write_metadata(
        app / "installation.local.json",
        {"application_commit": m.git(app, "rev-parse", "HEAD"), "bootstrap_sha256": bootstrap},
    )
    m.git(source, "add", ".")
    m.git(
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "new",
    )
    m.git(source, "tag", "v1.2")
    monkeypatch.setattr(m, "ROOT", source)
    monkeypatch.setattr(m, "stopped", lambda *roots: nullcontext())
    monkeypatch.setattr(m, "closed_data", lambda *roots: None)
    original_run = m.run

    def fake_run(command: list[str], cwd: Path) -> str:
        if command[0] in {"uv", "npm"}:
            return ""
        if command[1:3] == ["-m", "tools.install_app"]:
            target = Path(command[command.index("--app-path") + 1])
            target_data = Path(command[command.index("--data-root") + 1])
            revision = command[command.index("--revision") + 1]
            m.git(source, "worktree", "add", "--detach", str(target), revision)
            (target_data / "projects").mkdir(parents=True)
            m.write_metadata(
                target / "app.local.json",
                {
                    "data_root": str(target_data),
                    "comfyui_base_url": command[command.index("--comfyui-url") + 1],
                    "lan_access": False,
                },
            )
            m.write_metadata(
                target / "installation.local.json",
                {"application_commit": revision, "bootstrap_sha256": {}},
            )
            return ""
        return original_run(command, cwd)

    monkeypatch.setattr(m, "run", fake_run)
    original_subprocess_run = subprocess.run

    def fake_subprocess_run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if command[:3] == ["npm", "run", "build"]:
            assert "data_root" not in m.object_file(app / "app.local.json")
            assert kwargs["env"]["VITE_BATCHCRAFT_API_URL"] == "/"
            assert kwargs["env"]["VITE_BATCHCRAFT_INSTANCE"] == ""
            return subprocess.CompletedProcess(command, 0, "", "")
        return original_subprocess_run(command, **kwargs)

    monkeypatch.setattr(subprocess, "run", fake_subprocess_run)
    return source, app, data


def test_stable_tag_numeric_order_and_filter(installed: tuple[Path, Path, Path]) -> None:
    source, _, _ = installed
    for tag in (
        "v1.9",
        "v1.10.0",
        "v1.2.1",
        "v99.0rc1",
        "v100.0.0-dev",
        "latest",
        "v2",
        "v2.0.0.1",
    ):
        m.git(source, "tag", tag)
    assert m.stable_tags(source) == ["v1.0.0", "v1.2", "v1.2.1", "v1.9", "v1.10.0"]


@pytest.mark.parametrize("path", ["relative", "/tmp/../data"])
def test_canonical_refuses_ambiguous_paths(path: str) -> None:
    with pytest.raises(ValueError, match="absolute path"):
        m.canonical(Path(path))


def test_symlink_and_overlap_refused(tmp_path: Path) -> None:
    (tmp_path / "link").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="Symlink"):
        m.canonical(tmp_path / "link" / "absent")
    with pytest.raises(ValueError, match="overlap"):
        m.separate(tmp_path, tmp_path / "child")


@pytest.mark.parametrize("kind", ["symlink", "fifo"])
def test_data_copy_refuses_links_and_special_files(tmp_path: Path, kind: str) -> None:
    import os

    if kind == "symlink":
        (tmp_path / "unsafe").symlink_to("missing")
    else:
        os.mkfifo(tmp_path / "unsafe")
    with pytest.raises(ValueError, match="special file"):
        m.check_data_tree(tmp_path)


def test_refresh_full_independent_copy_and_replacement(
    installed: tuple[Path, Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    source, app, data = installed
    put(source / "uncommitted.txt", "not promoted")
    root = source.parent / "new-parent/test"
    refresh_test.refresh(app, root, "HEAD", yes=True)
    assert "uncommitted application changes are excluded" in capsys.readouterr().out
    assert not (root / "app/uncommitted.txt").exists()
    assert m.configuration(root / "app") == (root / "data", "http://gpu.invalid:8188", False)
    for file in data.rglob("*"):
        if file.is_file():
            copied = root / "data" / file.relative_to(data)
            assert copied.read_bytes() == file.read_bytes()
            assert copied.stat().st_ino != file.stat().st_ino
    put(root / "data/test-only", "disposable")
    refresh_test.refresh(app, root, "HEAD", yes=True)
    assert not (root / "data/test-only").exists()
    assert (data / "batchcraft.sqlite3-wal").read_text() == "wal"
    assert m.git(source, "worktree", "list", "--porcelain").count(f"worktree {root / 'app'}\n") == 1


@pytest.mark.parametrize("protected", ["app", "data", "source", "common", "ancestor"])
def test_refresh_never_overlaps_protected_paths(
    installed: tuple[Path, Path, Path], protected: str
) -> None:
    source, app, data = installed
    root = {
        "app": app,
        "data": data,
        "source": source / "test",
        "common": m.common_dir(source),
        "ancestor": source.parent,
    }[protected]
    with pytest.raises(ValueError, match="overlap"):
        refresh_test.refresh(app, root, "HEAD", yes=True)
    assert (data / "batchcraft.sqlite3").read_text() == "database"


def test_unknown_test_root_is_not_adopted(installed: tuple[Path, Path, Path]) -> None:
    source, app, _ = installed
    root = source.parent / "test"
    put(root / "precious", "preserve")
    with pytest.raises(ValueError, match="exactly the owned"):
        refresh_test.refresh(app, root, "HEAD", yes=True)
    assert (root / "precious").read_text() == "preserve"


@pytest.mark.parametrize(
    "relative", ["backend/source.py", "unknown.txt", "unknown.sqlite3", "app.command"]
)
def test_dirty_daily_code_and_unknown_files_block_update(
    installed: tuple[Path, Path, Path], relative: str
) -> None:
    source, app, _ = installed
    put(app / relative, "unreviewed modification")
    with pytest.raises(ValueError):
        update_daily.update(app, source.parent / "backups", None, fetch=False, yes=True)
    assert not (source.parent / "backups").exists()
    assert m.git(app, "rev-parse", "HEAD") == m.git(source, "rev-parse", "v1.0.0")


def test_dirty_candidate_is_not_removed(installed: tuple[Path, Path, Path]) -> None:
    source, app, _ = installed
    root = source.parent / "test"
    refresh_test.refresh(app, root, "HEAD", yes=True)
    put(root / "app/backend/source.py", "preserve candidate changes")
    with pytest.raises(ValueError, match="Dirty installed"):
        refresh_test.refresh(app, root, "HEAD", yes=True)
    assert (root / "app/backend/source.py").read_text() == "preserve candidate changes"


def test_wrong_candidate_data_and_git_common_refused(installed: tuple[Path, Path, Path]) -> None:
    source, app, data = installed
    root = source.parent / "test"
    refresh_test.refresh(app, root, "HEAD", yes=True)
    with pytest.raises(ValueError, match="source repository"):
        m.installation(root / "app", source.parent / "other.git")
    m.write_metadata(
        root / "app/app.local.json",
        {"data_root": str(data), "comfyui_base_url": "http://gpu.invalid"},
    )
    with pytest.raises(ValueError, match="test-root/data"):
        refresh_test.refresh(app, root, "HEAD", yes=True)


def test_daily_backup_then_update_reconciles_bootstrap(installed: tuple[Path, Path, Path]) -> None:
    source, app, data = installed
    config = (app / "app.local.json").read_bytes()
    backups = source.parent / "backups"
    update_daily.update(app, backups, None, fetch=False, yes=True)
    (backup,) = backups.iterdir()
    assert (backup / "data/batchcraft.sqlite3-wal").read_text() == "wal"
    assert (backup / "data/logs/server.log").read_text() == "full copy includes logs"
    assert (backup / "bootstrap/app.command").read_text() == "bootstrap\n"
    assert (
        (backup / "app.local.json").read_bytes() == config == (app / "app.local.json").read_bytes()
    )
    assert (app / "app.command").read_text() == "new tracked launcher\n"
    assert m.object_file(app / "installation.local.json")["bootstrap_sha256"] == {}
    assert m.object_file(app / "installation.local.json")["release_tag"] == "v1.2"
    assert (app / "app.local.json").stat().st_mode & 0o777 == 0o600
    assert m.configuration(app) == (data, "http://gpu.invalid:8188", True)
    assert (data / "batchcraft.sqlite3").read_text() == "database"
    m.installation(app, m.common_dir(source))


def test_backup_failure_precedes_checkout(
    installed: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    source, app, _ = installed

    def fail(*args: Any, **kwargs: Any) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(shutil, "copytree", fail)
    with pytest.raises(OSError, match="disk full"):
        update_daily.update(app, source.parent / "backups", None, fetch=False, yes=True)
    assert m.git(app, "rev-parse", "HEAD") == m.git(source, "rev-parse", "v1.0.0")
    assert (app / "app.command").read_text() == "bootstrap\n"
    assert "data_root" in m.object_file(app / "app.local.json")


def test_fetch_failure_precedes_data_or_code_changes(installed: tuple[Path, Path, Path]) -> None:
    source, app, _ = installed
    with pytest.raises(subprocess.CalledProcessError):
        update_daily.update(app, source.parent / "backups", None, fetch=True, yes=True)
    assert not (source.parent / "backups").exists()
    assert m.git(app, "rev-parse", "HEAD") == m.git(source, "rev-parse", "v1.0.0")


def test_downgrade_and_unreleased_current_refused(installed: tuple[Path, Path, Path]) -> None:
    source, app, _ = installed
    update_daily.update(app, source.parent / "backups", None, fetch=False, yes=True)
    with pytest.raises(ValueError, match="Downgrades"):
        update_daily.update(app, source.parent / "backups", "v1.0.0", fetch=False, yes=True)
    m.git(source, "tag", "-d", "v1.2")
    with pytest.raises(ValueError, match="not a stable release"):
        update_daily.update(app, source.parent / "backups", None, fetch=False, yes=True)


@pytest.mark.parametrize("tag", ["HEAD", "v2.0.0-rc1", "--help", "missing"])
def test_explicit_nonstable_tag_refused(installed: tuple[Path, Path, Path], tag: str) -> None:
    source, app, _ = installed
    with pytest.raises(ValueError, match="stable tag"):
        update_daily.update(app, source.parent / "backups", tag, fetch=False, yes=True)


def test_confirmation_cancel_has_no_effect(
    installed: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    source, app, _ = installed
    monkeypatch.setattr("builtins.input", lambda _: "no")
    with pytest.raises(ValueError, match="Cancelled"):
        refresh_test.refresh(app, source.parent / "test", "HEAD", yes=False)
    with pytest.raises(ValueError, match="Cancelled"):
        update_daily.update(app, source.parent / "backups", None, fetch=False, yes=False)
    assert not (source.parent / "test").exists()
    assert not (source.parent / "backups").exists()


@pytest.mark.parametrize(
    "code,stdout,stderr", [(0, "PID open", ""), (1, "", "warning"), (2, "", "error")]
)
def test_lsof_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, code: int, stdout: str, stderr: str
) -> None:
    monkeypatch.setattr(shutil, "which", lambda _: "/fake/lsof")
    monkeypatch.setattr(
        subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a[0], code, stdout, stderr)
    )
    with pytest.raises(ValueError, match="inconclusive lsof"):
        m.closed_data(tmp_path)


def test_lsof_required_and_empty_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda _: None)
    with pytest.raises(ValueError, match="lsof is required"):
        m.closed_data(tmp_path)
    monkeypatch.setattr(shutil, "which", lambda _: "/fake/lsof")
    monkeypatch.setattr(
        subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a[0], 1, "", "")
    )
    m.closed_data(tmp_path)


def test_port_refusal_before_yield(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(m, "_lsof_clear", lambda *args: None)

    class BusySocket:
        def __enter__(self) -> "BusySocket":
            return self

        def __exit__(self, *args: Any) -> None:
            pass

        def bind(self, address: tuple[str, int]) -> None:
            assert address == ("0.0.0.0", 8000)
            raise OSError("busy")

    monkeypatch.setattr(socket, "socket", BusySocket)
    with pytest.raises(OSError, match="busy"), m.stopped():
        pytest.fail("Must not start maintenance")


def test_git_environment_cannot_redirect_operations(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_DIR", "/do/not/touch")
    monkeypatch.setenv("GIT_WORK_TREE", "/do/not/touch")
    assert "GIT_DIR" not in m.environment()
    assert "GIT_WORK_TREE" not in m.environment()


def test_build_failure_keeps_backup_and_does_not_claim_update(
    installed: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    source, app, data = installed
    original_run = m.run

    def fail_build(command: list[str], cwd: Path) -> str:
        if command[0] == "uv":
            raise subprocess.CalledProcessError(1, command)
        return original_run(command, cwd)

    monkeypatch.setattr(m, "run", fail_build)
    with pytest.raises(subprocess.CalledProcessError):
        update_daily.update(app, source.parent / "backups", None, fetch=False, yes=True)
    (backup,) = (source.parent / "backups").iterdir()
    assert (backup / "data/batchcraft.sqlite3").read_bytes() == (
        data / "batchcraft.sqlite3"
    ).read_bytes()
    assert m.object_file(app / "installation.local.json")["application_commit"] == m.git(
        source, "rev-parse", "v1.0.0"
    )
    assert m.git(app, "rev-parse", "HEAD") == m.git(source, "rev-parse", "v1.2")


def test_explicit_tag_caps_release_selection(installed: tuple[Path, Path, Path]) -> None:
    source, app, _ = installed
    m.git(source, "tag", "v1.0.1")
    update_daily.update(app, source.parent / "backups", "v1.0.1", fetch=False, yes=True)
    assert m.object_file(app / "installation.local.json")["release_tag"] == "v1.0.1"
    update_daily.update(app, source.parent / "backups", "v1.0.1", fetch=False, yes=True)
    assert len(list((source.parent / "backups").iterdir())) == 1


def test_backup_path_must_not_overlap_daily_data(installed: tuple[Path, Path, Path]) -> None:
    _, app, data = installed
    with pytest.raises(ValueError, match="overlap"):
        update_daily.update(app, data / "backup", None, fetch=False, yes=True)
    assert not (data / "backup").exists()


def test_manifest_commit_and_metadata_symlink_refused(installed: tuple[Path, Path, Path]) -> None:
    source, app, _ = installed
    metadata = m.object_file(app / "installation.local.json")
    m.write_metadata(app / "installation.local.json", {**metadata, "application_commit": "0" * 40})
    with pytest.raises(ValueError, match="does not match HEAD"):
        m.installation(app, m.common_dir(source))
    (app / "app.local.json").rename(app / "config.saved")
    (app / "app.local.json").symlink_to(app / "config.saved")
    with pytest.raises(ValueError, match="Symlink"):
        m.configuration(app)


def test_candidate_install_failure_leaves_daily_untouched(
    installed: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    source, app, data = installed
    original_run = m.run

    def fail_install(command: list[str], cwd: Path) -> str:
        if command[1:3] == ["-m", "tools.install_app"]:
            raise subprocess.CalledProcessError(1, command)
        return original_run(command, cwd)

    monkeypatch.setattr(m, "run", fail_install)
    with pytest.raises(subprocess.CalledProcessError):
        refresh_test.refresh(app, source.parent / "test", "HEAD", yes=True)
    assert (data / "batchcraft.sqlite3").read_text() == "database"
    assert (data / "batchcraft.sqlite3-wal").read_text() == "wal"
    assert m.git(app, "rev-parse", "HEAD") == m.git(source, "rev-parse", "v1.0.0")


def test_dirty_bootstrap_cannot_leak_into_old_candidate(installed: tuple[Path, Path, Path]) -> None:
    source, app, _ = installed
    put(source / "backend/tools/runtime.py", "uncommitted launcher")
    with pytest.raises(ValueError, match="bootstrap must match committed HEAD"):
        refresh_test.refresh(app, source.parent / "test", "v1.0.0", yes=True)
    assert not (source.parent / "test").exists()


def test_old_release_update_retains_verified_untracked_bootstrap(
    installed: tuple[Path, Path, Path],
) -> None:
    source, app, _ = installed
    old = m.git(source, "rev-parse", "v1.0.0")
    tree = m.git(source, "rev-parse", "v1.0.0^{tree}")
    commit = m.git(
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit-tree",
        tree,
        "-p",
        old,
        "-m",
        "release still needing bootstrap",
    )
    m.git(source, "tag", "v1.0.1", commit)
    before = m.object_file(app / "installation.local.json")["bootstrap_sha256"]
    update_daily.update(app, source.parent / "backups", "v1.0.1", fetch=False, yes=True)
    metadata = m.installation(app, m.common_dir(source))
    assert metadata["bootstrap_sha256"] == before
    assert metadata["application_commit"] == commit
    assert (app / "app.command").read_text() == "bootstrap\n"


def test_staged_changes_hidden_by_worktree_restore_are_not_discarded(
    installed: tuple[Path, Path, Path],
) -> None:
    source, app, _ = installed
    original = (app / "backend/source.py").read_text()
    put(app / "backend/source.py", "staged work")
    m.git(app, "add", "backend/source.py")
    put(app / "backend/source.py", original)
    assert not m.git(app, "diff", "HEAD", "--")
    with pytest.raises(ValueError, match="Dirty installed"):
        m.installation(app, m.common_dir(source))
    assert m.git(app, "show", ":backend/source.py") == "staged work"


@pytest.mark.parametrize(
    "failure", ["checkout", "unlink", "uv", "npm-ci", "build", "metadata-rename", "config-restore"]
)
def test_incomplete_daily_update_blocks_launch(
    installed: tuple[Path, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    failure: str,
) -> None:
    source, app, data = installed
    original_config = (app / "app.local.json").read_bytes()
    before = {
        path.relative_to(data): path.read_bytes() for path in data.rglob("*") if path.is_file()
    }
    original_run, original_unlink, original_replace = m.run, Path.unlink, Path.replace
    original_subprocess_run = subprocess.run

    def fail_run(command: list[str], cwd: Path) -> str:
        if (
            (failure == "checkout" and command[:2] == ["git", "checkout"])
            or (failure == "uv" and command[0] == "uv")
            or (failure == "npm-ci" and command == ["npm", "ci"])
        ):
            raise OSError("injected update failure")
        return original_run(command, cwd)

    def fail_unlink(path: Path, missing_ok: bool = False) -> None:
        if failure == "unlink" and path == app / "app.command":
            raise OSError("injected update failure")
        original_unlink(path, missing_ok=missing_ok)

    def fail_replace(path: Path, target: Any) -> Path:
        if (failure == "metadata-rename" and target == app / "installation.local.json") or (
            failure == "config-restore"
            and target == app / "app.local.json"
            and "data_root" in m.object_file(path)
        ):
            raise OSError("injected update failure")
        return original_replace(path, target)

    def fail_build(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if failure == "build" and command == ["npm", "run", "build"]:
            put(app / "frontend/dist/index.html", "partially replaced frontend")
            raise OSError("injected update failure")
        return original_subprocess_run(command, **kwargs)

    monkeypatch.setattr(m, "run", fail_run)
    monkeypatch.setattr(Path, "unlink", fail_unlink)
    monkeypatch.setattr(Path, "replace", fail_replace)
    monkeypatch.setattr(subprocess, "run", fail_build)
    with pytest.raises(OSError, match="injected update failure"):
        update_daily.update(app, source.parent / "backups", None, fetch=False, yes=True)
    (backup,) = (source.parent / "backups").iterdir()
    assert m.object_file(app / "app.local.json") == {
        "maintenance_incomplete": {"backup": str(backup)}
    }
    assert (app / "app.local.json").stat().st_mode & 0o777 == 0o600
    assert (backup / "app.local.json").read_bytes() == original_config
    assert m.configuration(backup) == (data, "http://gpu.invalid:8188", True)
    assert {
        path.relative_to(data): path.read_bytes() for path in data.rglob("*") if path.is_file()
    } == before
    assert {
        path.relative_to(backup / "data"): path.read_bytes()
        for path in (backup / "data").rglob("*")
        if path.is_file()
    } == before
    if failure == "build":
        assert (app / "frontend/dist/index.html").read_text() == "partially replaced frontend"
    output = capsys.readouterr().out
    assert "Launch is blocked" in output
    assert "BEFORE restoring the backed-up app.local.json" in output

    # Exercise the real launcher entry point, but make reaching application creation a failure.
    monkeypatch.setattr(runtime, "ROOT", app)
    monkeypatch.setattr(sys, "argv", ["runtime", "app"])
    monkeypatch.setattr(signal, "signal", lambda *args: None)
    monkeypatch.setattr(
        runtime, "application", lambda *args: pytest.fail("Application must not start")
    )
    with pytest.raises(ValueError, match="Expected data_root"):
        runtime.main()


@pytest.mark.parametrize("alias", ["v1.2.0", "v01.02.00"])
@pytest.mark.parametrize("same_commit", [True, False])
def test_equal_version_alias_requires_identical_commit(
    installed: tuple[Path, Path, Path],
    alias: str,
    same_commit: bool,
) -> None:
    source, app, _ = installed
    backups = source.parent / "backups"
    update_daily.update(app, backups, "v1.2", fetch=False, yes=True)
    m.git(source, "tag", alias, "v1.2" if same_commit else "v1.0.0")
    config = (app / "app.local.json").read_bytes()
    if same_commit:
        update_daily.update(app, backups, alias, fetch=False, yes=True)
    else:
        with pytest.raises(ValueError, match="Equal-version release aliases"):
            update_daily.update(app, backups, alias, fetch=False, yes=True)
    assert len(list(backups.iterdir())) == 1
    assert m.git(app, "rev-parse", "HEAD") == m.git(source, "rev-parse", "v1.2")
    assert (app / "app.local.json").read_bytes() == config


def test_empty_test_root_installs_without_removal(
    installed: tuple[Path, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, app, _ = installed
    root = source.parent / "test"
    root.mkdir()
    inode = root.stat().st_ino
    original_run = m.run

    def no_remove(command: list[str], cwd: Path) -> str:
        assert command[:3] != ["git", "worktree", "remove"]
        return original_run(command, cwd)

    monkeypatch.setattr(m, "run", no_remove)
    monkeypatch.setattr(shutil, "rmtree", lambda *args, **kwargs: pytest.fail("No deletion needed"))
    refresh_test.refresh(app, root, "HEAD", yes=True)
    assert root.stat().st_ino == inode
    assert m.configuration(root / "app")[0] == root / "data"
