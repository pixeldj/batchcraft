import csv
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from threading import Barrier

import pytest

from batchcraft.domain import (
    BatchDefinition,
    CompiledRunPlan,
    PromptVersion,
    ReferenceSelection,
    SeedInput,
    VariableBinding,
    VariableBindingMode,
    VariableList,
    compile_batch,
)
from batchcraft.files import (
    AssetRecord,
    BatchIdentity,
    ProjectAssetStore,
    ProjectIdentity,
    PublishedRun,
    RunFilesystemStore,
    RunStoreError,
)

FIXED_TIME = datetime(2026, 8, 27, 12, 30, tzinfo=UTC)
PROJECT = ProjectIdentity(id="project-id", filesystem_key="project_key", name="Portrait tests")
BATCH = BatchIdentity(id="batch-id", filesystem_key="batch_key", name="Prompt matrix")
WORKFLOW: dict[str, object] = {
    "104": {"class_type": "CLIPTextEncode", "inputs": {"text": "original"}},
    "114": {"class_type": "KSampler", "inputs": {"seed": 0}},
}
WORKFLOW_PROFILE: dict[str, object] = {
    "id": "workflow-profile-id",
    "name": "Portrait workflow",
    "mappings": {
        "prompt": {"node_id": "104", "input_name": "text", "value_type": "string"},
        "reference_image": {
            "node_id": "221",
            "input_name": "image",
            "value_type": "image",
        },
        "seed": {"node_id": "114", "input_name": "seed", "value_type": "integer"},
    },
}


class SequentialIds:
    def __init__(self, *values: str) -> None:
        self._values = iter(values)

    def __call__(self) -> str:
        return next(self._values)


class ObservingRunStore(RunFilesystemStore):
    saw_staging = False

    def _publish(self, staging_path: Path, final_path: Path) -> None:
        self.saw_staging = staging_path.parent.name == ".staging"
        assert not final_path.exists()
        assert {path.name for path in staging_path.iterdir()} == {
            "manifest.csv",
            "manifest.json",
            "outputs",
            "run.json",
            "workflow-profile.json",
            "workflow.json",
        }
        super()._publish(staging_path, final_path)


class FailingRunStore(RunFilesystemStore):
    saw_complete_staging = False

    def _publish(self, staging_path: Path, final_path: Path) -> None:
        self.saw_complete_staging = (staging_path / "manifest.json").is_file()
        assert not final_path.exists()
        raise OSError("simulated publication failure")


class BarrierRunStore(RunFilesystemStore):
    def __init__(self, projects_path: Path, barrier: Barrier) -> None:
        super().__init__(projects_path, clock=lambda: FIXED_TIME)
        self._barrier = barrier

    def _publish(self, staging_path: Path, final_path: Path) -> None:
        self._barrier.wait(timeout=5)
        super()._publish(staging_path, final_path)


class PostRenameFailureStore(RunFilesystemStore):
    def _publish(self, staging_path: Path, final_path: Path) -> None:
        staging_path.rename(final_path)
        raise OSError("simulated directory sync failure")


def _fixture_plan(asset_id: str, *, seeds: tuple[int, ...] = (9, 3)) -> CompiledRunPlan:
    animals = VariableList(id="animals", values=("cat", "dog"))
    unused = VariableList(id="unused", values=("value",))
    return compile_batch(
        BatchDefinition(
            prompt_version=PromptVersion(id="prompt-v3", text="Portrait of {{animal}}"),
            variable_bindings=(
                VariableBinding(
                    placeholder="animal",
                    variable_list=animals,
                    mode=VariableBindingMode.ALL,
                    selected_values=("dog", "cat"),
                ),
                VariableBinding(
                    placeholder="unused",
                    variable_list=unused,
                    mode=VariableBindingMode.FIXED,
                    fixed_value="value",
                ),
            ),
            references=(ReferenceSelection(asset_id=asset_id),),
            seeds=SeedInput.explicit(seeds),
        )
    )


def _asset_fixture(projects_path: Path) -> AssetRecord:
    source = projects_path.parent / "reference.png"
    source.write_bytes(b"reference bytes")
    return ProjectAssetStore(
        projects_path / PROJECT.filesystem_key,
        id_factory=lambda: "asset-id",
        clock=lambda: FIXED_TIME,
    ).import_file(source)


def _create(
    store: RunFilesystemStore,
    plan: CompiledRunPlan,
    asset: AssetRecord,
    *,
    project: ProjectIdentity = PROJECT,
    batch: BatchIdentity = BATCH,
) -> PublishedRun:
    return store.create_run(
        project=project,
        batch=batch,
        plan=plan,
        reference_assets={asset.asset_id: asset},
        workflow=WORKFLOW,
        workflow_profile=WORKFLOW_PROFILE,
    )


def test_run_creation_persists_identity_plan_snapshots_and_manifests(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    ids = SequentialIds("run-id", "job-1", "job-2", "job-3", "job-4")
    store = ObservingRunStore(projects_path, id_factory=ids, clock=lambda: FIXED_TIME)

    published = _create(store, plan, asset)

    expected_path = projects_path / "project_key" / "batches" / "batch_key" / "run-001"
    assert published.path == expected_path
    assert published.run_id == "run-id"
    assert published.run_number == 1
    assert published.created_at == "2026-08-27T12:30:00Z"
    assert store.saw_staging
    assert expected_path.is_dir()
    assert (expected_path / "outputs").is_dir()
    assert [job.job_id for job in published.jobs] == ["job-1", "job-2", "job-3", "job-4"]
    assert [job.compiled_job.ordinal for job in published.jobs] == [1, 2, 3, 4]
    assert published.compiled_plan == plan
    assert published.workflow == WORKFLOW
    assert published.workflow_profile == WORKFLOW_PROFILE

    run_data = json.loads((expected_path / "run.json").read_text())
    assert run_data["run_id"] == "run-id"
    assert run_data["run_number"] == 1
    assert run_data["status"] == "created"
    assert run_data["job_count"] == 4

    manifest_path = expected_path / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    assert (
        manifest_bytes
        == (
            json.dumps(
                manifest,
                allow_nan=False,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n"
        ).encode()
    )
    assert manifest["prompt_version"] == {
        "prompt_version_id": "prompt-v3",
        "prompt_template": "Portrait of {{animal}}",
    }
    assert [job["ordinal"] for job in manifest["jobs"]] == [1, 2, 3, 4]
    assert [job["resolved_prompt"] for job in manifest["jobs"]] == [
        "Portrait of dog",
        "Portrait of dog",
        "Portrait of cat",
        "Portrait of cat",
    ]
    assert [job["seed"] for job in manifest["jobs"]] == [9, 3, 9, 3]
    assert all(job["reference_asset"]["asset_id"] == asset.asset_id for job in manifest["jobs"])
    assert all(job["reference_asset"]["sha256"] == asset.sha256 for job in manifest["jobs"])

    with (expected_path / "manifest.csv").open(newline="") as file:
        rows = list(csv.DictReader(file))
    assert [row["job_id"] for row in rows] == ["job-1", "job-2", "job-3", "job-4"]
    assert [row["job_ordinal"] for row in rows] == ["1", "2", "3", "4"]
    assert all(row["reference_sha256"] == asset.sha256 for row in rows)
    assert json.loads(rows[0]["resolved_variables_json"]) == [{"name": "animal", "value": "dog"}]


def test_published_run_reconstructs_without_sqlite(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    created = _create(
        RunFilesystemStore(
            projects_path,
            id_factory=SequentialIds("run-id", "job-1", "job-2", "job-3", "job-4"),
            clock=lambda: FIXED_TIME,
        ),
        plan,
        asset,
    )

    loaded = RunFilesystemStore(projects_path).load_run(created.path)

    assert loaded.compiled_plan == plan
    assert loaded.jobs == created.jobs
    assert loaded.workflow == WORKFLOW
    assert loaded.workflow_profile == WORKFLOW_PROFILE
    assert loaded.workflow_sha256 == created.workflow_sha256
    assert loaded.workflow_profile_sha256 == created.workflow_profile_sha256
    assert loaded.jobs[0].reference_asset == asset


def test_run_load_validates_a_repeated_asset_only_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id, seeds=tuple(range(50)))
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        plan,
        asset,
    )
    original_validate = ProjectAssetStore.validate_record
    validation_count = 0

    def count_validation(store: ProjectAssetStore, record: AssetRecord) -> AssetRecord:
        nonlocal validation_count
        validation_count += 1
        return original_validate(store, record)

    monkeypatch.setattr(ProjectAssetStore, "validate_record", count_validation)

    loaded = RunFilesystemStore(projects_path).load_run(created.path)

    assert loaded.compiled_plan == plan
    assert loaded.compiled_plan.job_count == 100
    assert validation_count == 1


def test_run_load_rejects_inconsistent_metadata_for_repeated_asset(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        plan,
        asset,
    )
    manifest_path = created.path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["jobs"][1]["reference_asset"]["original_filename"] = "inconsistent.png"
    manifest_path.write_text(
        json.dumps(
            manifest,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    )

    with pytest.raises(RunStoreError, match="inconsistent metadata for asset ID"):
        RunFilesystemStore(projects_path).load_run(created.path)


def test_failed_creation_cleans_staging_without_partial_final_run(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    store = FailingRunStore(
        projects_path,
        id_factory=SequentialIds("run-id", "job-1", "job-2", "job-3", "job-4"),
        clock=lambda: FIXED_TIME,
    )

    with pytest.raises(RunStoreError, match="simulated publication failure"):
        _create(store, plan, asset)

    batch_path = projects_path / "project_key" / "batches" / "batch_key"
    assert store.saw_complete_staging
    assert not (batch_path / "run-001").exists()
    assert tuple((batch_path / ".staging").iterdir()) == ()
    assert tuple((batch_path / ".allocations").iterdir()) == ()


def test_post_rename_error_returns_the_complete_published_run(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    store = PostRenameFailureStore(
        projects_path,
        id_factory=SequentialIds("run-id", "job-1", "job-2", "job-3", "job-4"),
        clock=lambda: FIXED_TIME,
    )

    published = _create(store, plan, asset)

    assert published.path.name == "run-001"
    assert published.path.is_dir()
    assert store.load_run(published.path).compiled_plan == plan


def test_existing_colliding_staging_directory_is_not_removed(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    staging_path = (
        projects_path / "project_key" / "batches" / "batch_key" / ".staging" / "shared-id"
    )
    staging_path.mkdir(parents=True)
    sentinel = staging_path / "owned-by-other-creator"
    sentinel.write_text("keep")
    store = RunFilesystemStore(
        projects_path,
        id_factory=SequentialIds("shared-id"),
        clock=lambda: FIXED_TIME,
    )

    with pytest.raises(RunStoreError, match="File exists"):
        _create(store, plan, asset)

    assert sentinel.read_text() == "keep"


def test_unsafe_run_id_is_rejected_before_staging(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    store = RunFilesystemStore(
        projects_path,
        id_factory=SequentialIds("../escape"),
        clock=lambda: FIXED_TIME,
    )

    with pytest.raises(RunStoreError, match="unsafe value"):
        _create(store, plan, asset)

    assert not (tmp_path / "escape").exists()


def test_multiple_runs_allocate_distinct_identity_and_preserve_display_name_history(
    tmp_path: Path,
) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    store = RunFilesystemStore(
        projects_path,
        id_factory=SequentialIds(
            "run-1",
            "run-1-job-1",
            "run-1-job-2",
            "run-1-job-3",
            "run-1-job-4",
            "run-2",
            "run-2-job-1",
            "run-2-job-2",
            "run-2-job-3",
            "run-2-job-4",
        ),
        clock=lambda: FIXED_TIME,
    )

    first = _create(store, plan, asset)
    renamed_project = ProjectIdentity(
        id=PROJECT.id,
        filesystem_key=PROJECT.filesystem_key,
        name="Renamed Project",
    )
    renamed_batch = BatchIdentity(
        id=BATCH.id,
        filesystem_key=BATCH.filesystem_key,
        name="Renamed Batch",
    )
    second = _create(
        store,
        plan,
        asset,
        project=renamed_project,
        batch=renamed_batch,
    )

    assert first.run_id != second.run_id
    assert (first.run_number, second.run_number) == (1, 2)
    assert (first.path.name, second.path.name) == ("run-001", "run-002")
    assert first.path.parent == second.path.parent
    assert first.path.is_dir()
    assert store.load_run(first.path).project.name == "Portrait tests"
    assert store.load_run(first.path).batch.name == "Prompt matrix"
    assert store.load_run(second.path).project.name == "Renamed Project"
    assert store.load_run(second.path).batch.name == "Renamed Batch"


def test_concurrent_run_creation_is_collision_safe(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    store = BarrierRunStore(projects_path, Barrier(2))

    def create() -> PublishedRun:
        return _create(store, plan, asset)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = (executor.submit(create), executor.submit(create))
        runs = tuple(future.result(timeout=10) for future in futures)

    assert {run.run_number for run in runs} == {1, 2}
    assert len({run.run_id for run in runs}) == 2
    assert len({run.path for run in runs}) == 2
    assert all(run.path.is_dir() for run in runs)
    assert all(run.compiled_plan == plan for run in runs)


def test_loading_uses_canonical_json_when_secondary_csv_is_reformatted(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    created = _create(
        RunFilesystemStore(
            projects_path,
            id_factory=SequentialIds("run-id", "job-1", "job-2", "job-3", "job-4"),
            clock=lambda: FIXED_TIME,
        ),
        plan,
        asset,
    )
    csv_path = created.path / "manifest.csv"
    csv_path.write_text(csv_path.read_text().replace("\n", "\r\n"))

    loaded = RunFilesystemStore(projects_path).load_run(created.path)

    assert loaded.compiled_plan == plan


def test_run_creation_rejects_unresolved_compiled_jobs(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    invalid_job = replace(plan.jobs[0], resolved_prompt="Still {{animal}}")
    invalid_plan = replace(plan, jobs=(invalid_job, *plan.jobs[1:]))

    with pytest.raises(RunStoreError, match="unresolved prompt placeholder"):
        _create(RunFilesystemStore(projects_path), invalid_plan, asset)


def test_create_run_requires_matching_stored_asset_record(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = _fixture_plan(asset.asset_id)
    mismatched = AssetRecord(
        asset_id=asset.asset_id,
        sha256=asset.sha256,
        original_filename="changed.png",
        mime_type=asset.mime_type,
        byte_size=asset.byte_size,
        stored_path=asset.stored_path,
        created_at=asset.created_at,
    )

    with pytest.raises(RunStoreError, match="does not match stored metadata"):
        _create(RunFilesystemStore(projects_path), plan, mismatched)
