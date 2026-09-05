import hashlib
import json
import shutil
from dataclasses import replace
from pathlib import Path

import pytest

from batchcraft.db import (
    HistoricalProjectConflictError,
    HistoricalProjectionStore,
    ProjectStore,
    apply_migrations,
    open_connection,
)
from batchcraft.domain import ParameterValueType, ResolvedParameter, WorkflowParameter
from batchcraft.execution import ExecutionStateError, ExecutionStateStore
from batchcraft.files import RunFilesystemStore, RunStoreError
from batchcraft.files.history import ProjectHistoryScanError, ProjectHistoryScanner

FIXTURE = Path(__file__).parent.parent / "fixtures" / "v1_project" / "project_key"


def _copy_fixture(tmp_path: Path) -> tuple[Path, Path]:
    projects = tmp_path / "projects"
    projects.mkdir()
    project = projects / "project_key"
    shutil.copytree(FIXTURE, project)
    # Git does not preserve the fixture's empty outputs directory.
    (project / "batches" / "batch_key" / "001-run" / "outputs").mkdir(exist_ok=True)
    return projects, project


def _inventory(path: Path) -> dict[str, tuple[int, str]]:
    return {
        item.relative_to(path).as_posix(): (
            item.stat().st_size,
            hashlib.sha256(item.read_bytes()).hexdigest(),
        )
        for item in sorted(path.rglob("*"))
        if item.is_file() and not item.is_symlink()
    }


def _database(tmp_path: Path) -> Path:
    path = tmp_path / "batchcraft.sqlite3"
    connection = open_connection(path)
    try:
        apply_migrations(connection)
    finally:
        connection.close()
    return path


def _add_result(project: Path, *, content: bytes | None) -> Path:
    run = project / "batches" / "batch_key" / "001-run"
    execution_path = run / "execution.json"
    execution = json.loads(execution_path.read_text())
    expected = b"result-bytes"
    result_path = run / "outputs" / "000001-01.png"
    if content is not None:
        result_path.write_bytes(content)
    execution["jobs"][0]["results"] = [
        {
            "job_id": "job-1",
            "job_ordinal": 1,
            "artifact_ordinal": 1,
            "producing_node_id": "301",
            "output_name": "images",
            "remote_filename": "result.png",
            "remote_subfolder": "",
            "remote_type": "output",
            "local_path": "outputs/000001-01.png",
            "content_type": "image/png",
            "byte_size": len(expected),
            "sha256": hashlib.sha256(expected).hexdigest(),
        }
    ]
    execution_path.write_text(json.dumps(execution, sort_keys=True, separators=(",", ":")) + "\n")
    return result_path


def test_scanner_reads_v1_history_without_changing_bytes_and_missing_execution_is_unavailable(
    tmp_path: Path,
) -> None:
    projects, project = _copy_fixture(tmp_path)
    (project / "batches" / "batch_key" / "001-run" / "execution.json").unlink()
    before = _inventory(project)

    scan = ProjectHistoryScanner(projects).scan("project_key")

    assert scan.project.id == "project-id"
    assert [item.id for item in scan.batches] == ["batch-id"]
    assert [item.run.run_id for item in scan.runs] == ["run-id"]
    assert scan.runs[0].execution_available is False
    assert scan.runs[0].execution_status is None
    assert _inventory(project) == before


@pytest.mark.parametrize(
    ("content", "expected"),
    ((None, "missing"), (b"wrong-result", "corrupt"), (b"result-bytes", "verified")),
)
def test_scanner_preserves_result_metadata_and_classifies_bytes(
    tmp_path: Path, content: bytes | None, expected: str
) -> None:
    projects, project = _copy_fixture(tmp_path)
    _add_result(project, content=content)

    scan = ProjectHistoryScanner(projects).scan("project_key")

    assert len(scan.runs[0].results) == 1
    assert scan.runs[0].results[0].record.remote_filename == "result.png"
    assert scan.runs[0].results[0].integrity_status == expected
    assert scan.runs[0].integrity_status == ("verified" if expected == "verified" else "degraded")
    if expected != "verified":
        strict_run = RunFilesystemStore(projects).load_run(scan.runs[0].run.path)
        with pytest.raises(ExecutionStateError, match="recorded Result"):
            ExecutionStateStore(strict_run.path).load(strict_run)


def test_scanner_degrades_missing_referenced_asset_but_keeps_run(tmp_path: Path) -> None:
    projects, project = _copy_fixture(tmp_path)
    content = next((project / "assets" / "sha256").glob("*/*/content"))
    content.unlink()

    scan = ProjectHistoryScanner(projects).scan("project_key")

    assert [item.run.run_id for item in scan.runs] == ["run-id"]
    assert scan.runs[0].integrity_status == "degraded"
    assert scan.runs[0].replayable is False
    assert scan.runs[0].referenced_assets[0].integrity_status == "missing"
    with pytest.raises(RunStoreError, match="invalid Project asset"):
        RunFilesystemStore(projects).load_run(scan.runs[0].run.path)


def test_historical_readers_preserve_execution_metadata_without_outputs(tmp_path: Path) -> None:
    projects, project = _copy_fixture(tmp_path)
    _add_result(project, content=b"result-bytes")
    run_path = project / "batches" / "batch_key" / "001-run"
    shutil.rmtree(run_path / "outputs")

    run = RunFilesystemStore(projects).load_historical_run(run_path)
    state = ExecutionStateStore(run_path).read_historical(run)

    assert state.run_id == "run-id"
    assert state.jobs[0].results[0].remote_filename == "result.png"
    with pytest.raises(RunStoreError, match="outputs directory"):
        RunFilesystemStore(projects).load_run(run_path)
    with pytest.raises(ExecutionStateError, match="outputs path"):
        ExecutionStateStore(run_path).read_for_query(run)


def test_scanner_isolates_one_bad_or_unsupported_run(tmp_path: Path) -> None:
    projects, project = _copy_fixture(tmp_path)
    healthy = project / "batches" / "batch_key" / "001-run"
    bad = healthy.parent / "002-bad"
    shutil.copytree(healthy, bad)
    manifest_path = bad / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["format_version"] = 2
    manifest_path.write_text(json.dumps(manifest))

    scan = ProjectHistoryScanner(projects).scan("project_key")

    assert [item.run.run_id for item in scan.runs] == ["run-id"]
    assert any(
        item.code == "invalid_run" and "unsupported" in item.message for item in scan.diagnostics
    )


def test_scanner_isolates_malformed_batch_and_symlinked_run(tmp_path: Path) -> None:
    projects, project = _copy_fixture(tmp_path)
    bad_batch = project / "batches" / "bad_batch"
    bad_batch.mkdir()
    (bad_batch / "batch.json").write_text("{}")
    outside = tmp_path / "outside-run"
    outside.mkdir()
    (project / "batches" / "batch_key" / "002-linked").symlink_to(outside, target_is_directory=True)

    scan = ProjectHistoryScanner(projects).scan("project_key")

    assert [item.run.run_id for item in scan.runs] == ["run-id"]
    assert {item.code for item in scan.diagnostics} >= {
        "invalid_batch_owner",
        "unsafe_run_path",
    }


def test_scanner_rejects_both_duplicate_run_id_candidates(tmp_path: Path) -> None:
    projects, project = _copy_fixture(tmp_path)
    original = project / "batches" / "batch_key" / "001-run"
    duplicate = original.parent / "002-copy"
    shutil.copytree(original, duplicate)
    for name in ("run.json", "manifest.json"):
        path = duplicate / name
        data = json.loads(path.read_text())
        target = data if name == "run.json" else data["run"]
        target["run_number"] = 2
        target["filesystem_key"] = "002-copy"
        path.write_text(json.dumps(data, sort_keys=True, separators=(",", ":")) + "\n")

    scan = ProjectHistoryScanner(projects).scan("project_key")

    assert scan.runs == ()
    assert [item.code for item in scan.diagnostics].count("duplicate_run_id") == 2


def test_scanner_rejects_project_symlink_and_wrong_owner(tmp_path: Path) -> None:
    projects, project = _copy_fixture(tmp_path)
    outside = tmp_path / "outside"
    project.rename(outside)
    project.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ProjectHistoryScanError, match="immediate, non-symlink"):
        ProjectHistoryScanner(projects).scan("project_key")

    project.unlink()
    outside.rename(project)
    owner_path = project / "project.json"
    owner = json.loads(owner_path.read_text())
    owner["filesystem_key"] = "wrong_key"
    owner_path.write_text(json.dumps(owner))
    with pytest.raises(ProjectHistoryScanError, match="owner identity"):
        ProjectHistoryScanner(projects).scan("project_key")


def test_projection_replace_is_idempotent_rebuildable_and_conflicts_are_atomic(
    tmp_path: Path,
) -> None:
    projects, project = _copy_fixture(tmp_path)
    database = _database(tmp_path)
    store = HistoricalProjectionStore(database)
    _add_result(project, content=b"result-bytes")
    scan = ProjectHistoryScanner(projects).scan("project_key")
    scanned_run = scan.runs[0]
    parameter = WorkflowParameter(
        key="cfg",
        label="CFG",
        node_id="114",
        input_name="cfg",
        value_type=ParameterValueType.FLOAT,
    )
    persisted_jobs = tuple(
        replace(
            job,
            compiled_job=replace(
                job.compiled_job,
                resolved_parameters=(ResolvedParameter("cfg", 7.0),),
            ),
        )
        for job in scanned_run.run.jobs
    )
    changed_run = replace(
        scanned_run.run,
        jobs=persisted_jobs,
        compiled_plan=replace(
            scanned_run.run.compiled_plan,
            parameters=(parameter,),
            jobs=tuple(item.compiled_job for item in persisted_jobs),
        ),
    )
    scan = replace(scan, runs=(replace(scanned_run, run=changed_run),))
    before = _inventory(project)

    store.replace_project(scan)
    store.replace_project(scan)
    assert [item.run_id for item in store.list_runs("project-id")] == ["run-id"]
    connection = open_connection(database)
    try:
        assert connection.execute(
            "SELECT count(*) FROM historical_resolved_parameter"
        ).fetchone() == (4,)
        assert connection.execute("SELECT count(*) FROM historical_image_input").fetchone() == (4,)
        assert connection.execute("SELECT count(*) FROM historical_asset_use").fetchone() == (4,)
        assert connection.execute("SELECT count(*) FROM historical_result").fetchone() == (1,)
        connection.execute("DELETE FROM historical_job")
        connection.commit()
    finally:
        connection.close()
    store.replace_project(scan)
    connection = open_connection(database)
    try:
        assert connection.execute("SELECT count(*) FROM historical_job").fetchone() == (4,)
    finally:
        connection.close()
    assert _inventory(project) == before

    shutil.rmtree(project / "batches" / "batch_key" / "001-run")
    store.replace_project(ProjectHistoryScanner(projects).scan("project_key"))
    assert store.list_runs("project-id") == ()

    conflict_database = tmp_path / "conflict.sqlite3"
    connection = open_connection(conflict_database)
    try:
        apply_migrations(connection)
    finally:
        connection.close()
    ProjectStore(conflict_database).create("Other", "other_key", project_id="project-id")
    with pytest.raises(HistoricalProjectConflictError):
        HistoricalProjectionStore(conflict_database).replace_project(scan)
    assert HistoricalProjectionStore(conflict_database).list_runs("project-id") == ()
