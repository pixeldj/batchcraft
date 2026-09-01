import csv
import hashlib
import json
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from threading import Barrier

import pytest

from batchcraft.domain import (
    BatchDefinition,
    CompiledRunPlan,
    ImageBinding,
    ImageInputSlot,
    ParameterBinding,
    ParameterValueType,
    PromptVersion,
    SeedInput,
    VariableBinding,
    WorkflowParameter,
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
from batchcraft.files._io import canonical_json_bytes

FIXED_TIME = datetime(2026, 8, 27, 12, 30, tzinfo=UTC)
PROJECT = ProjectIdentity(id="project-id", filesystem_key="project_key", name="Portrait tests")
BATCH = BatchIdentity(id="batch-id", filesystem_key="batch_key", name="Prompt matrix")
WORKFLOW: dict[str, object] = {
    "104": {"class_type": "CLIPTextEncode", "inputs": {"text": "original"}},
    "114": {"class_type": "KSampler", "inputs": {"seed": 0}},
    "221": {"class_type": "LoadImage", "inputs": {"image": "original.png"}},
    "301": {"class_type": "SaveImage", "inputs": {"filename_prefix": "original"}},
}
WORKFLOW_PROFILE: dict[str, object] = {
    "id": "workflow-profile-id",
    "name": "Portrait workflow",
    "mappings": {
        "prompt": {"node_id": "104", "input_name": "text", "value_type": "string"},
        "seed": {"node_id": "114", "input_name": "seed", "value_type": "integer"},
        "output_prefix": {
            "node_id": "301",
            "input_name": "filename_prefix",
            "value_type": "string",
        },
    },
    "image_inputs": [
        {"key": "reference", "label": "Reference", "node_id": "221", "input_name": "image"}
    ],
    "parameters": [],
}
BATCH_SNAPSHOT: dict[str, object] = {
    "snapshot_version": 4,
    "project": {
        "id": PROJECT.id,
        "filesystem_key": PROJECT.filesystem_key,
        "name": PROJECT.name,
    },
    "source_saved_batch": None,
    "batch": {
        "id": BATCH.id,
        "filesystem_key": BATCH.filesystem_key,
        "name": BATCH.name,
        "description": None,
    },
    "prompt_versions": [
        {
            "id": "prompt-v3",
            "prompt_id": None,
            "version_number": None,
            "name": "Portrait prompt",
            "text": "Portrait of {{animal}}",
        }
    ],
    "variable_bindings": [
        {"placeholder": "animal", "values": ["dog", "cat"]},
        {"placeholder": "unused", "values": ["value"]},
    ],
    "image_bindings": [{"slot_key": "reference", "values": ["asset-id"]}],
    "parameter_bindings": [],
    "seed_intent": {
        "mode": "explicit",
        "values": [9, 3],
        "random_seed_count": None,
    },
    "workflow_selection": {
        "workflow_id": None,
        "workflow_version_id": None,
        "workflow_name": None,
        "workflow_version_number": None,
        "workflow_profile_id": None,
        "workflow_profile_version_id": None,
        "workflow_profile_name": None,
        "workflow_profile_version_number": None,
        "workflow": WORKFLOW,
        "workflow_profile": WORKFLOW_PROFILE,
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


def _fixture_plan(asset_id: str | None, *, seeds: tuple[int, ...] = (9, 3)) -> CompiledRunPlan:
    return compile_batch(
        BatchDefinition(
            prompt_versions=(
                PromptVersion(
                    id="prompt-v3", name="Portrait prompt", text="Portrait of {{animal}}"
                ),
            ),
            variable_bindings=(
                VariableBinding(
                    placeholder="animal",
                    values=("dog", "cat"),
                ),
                VariableBinding(
                    placeholder="unused",
                    values=("value",),
                ),
            ),
            image_input_slots=(ImageInputSlot("reference", "Reference", "221", "image"),),
            image_bindings=(ImageBinding("reference", (asset_id,)),),
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
    asset: AssetRecord | None,
    *,
    project: ProjectIdentity = PROJECT,
    batch: BatchIdentity = BATCH,
    batch_snapshot: Mapping[str, object] | None = None,
    workflow: Mapping[str, object] = WORKFLOW,
    workflow_profile: Mapping[str, object] = WORKFLOW_PROFILE,
) -> PublishedRun:
    return store.create_run(
        project=project,
        batch=batch,
        batch_snapshot=(
            batch_snapshot
            if batch_snapshot is not None
            else {
                **BATCH_SNAPSHOT,
                "project": {
                    "id": project.id,
                    "filesystem_key": project.filesystem_key,
                    "name": project.name,
                },
                "batch": {
                    "id": batch.id,
                    "filesystem_key": batch.filesystem_key,
                    "name": batch.name,
                    "description": None,
                },
                "image_bindings": [
                    {
                        "slot_key": "reference",
                        "values": [None if asset is None else asset.asset_id],
                    }
                ],
            }
        ),
        plan=plan,
        image_assets={} if asset is None else {asset.asset_id: asset},
        workflow=workflow,
        workflow_profile=workflow_profile,
    )


def _rewrite_frozen_workflow_pair(
    run: PublishedRun,
    workflow: dict[str, object],
    profile: dict[str, object],
) -> None:
    workflow_bytes = canonical_json_bytes(workflow)
    profile_bytes = canonical_json_bytes(profile)
    workflow_sha256 = hashlib.sha256(workflow_bytes).hexdigest()
    profile_sha256 = hashlib.sha256(profile_bytes).hexdigest()
    (run.path / "workflow.json").write_bytes(workflow_bytes)
    (run.path / "workflow-profile.json").write_bytes(profile_bytes)

    run_data = json.loads((run.path / "run.json").read_text())
    run_data["workflow_sha256"] = workflow_sha256
    run_data["workflow_profile_sha256"] = profile_sha256
    (run.path / "run.json").write_bytes(canonical_json_bytes(run_data))

    manifest = json.loads((run.path / "manifest.json").read_text())
    manifest["workflow_snapshot"]["sha256"] = workflow_sha256
    manifest["workflow_profile_snapshot"]["sha256"] = profile_sha256
    selection = manifest["batch_snapshot"]["workflow_selection"]
    selection["workflow"] = workflow
    selection["workflow_profile"] = profile
    for job in manifest["jobs"]:
        job["workflow_sha256"] = workflow_sha256
        job["workflow_profile_sha256"] = profile_sha256
    (run.path / "manifest.json").write_bytes(canonical_json_bytes(manifest))


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
    assert published.batch_snapshot == BATCH_SNAPSHOT
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
    assert manifest["format_version"] == 7
    assert manifest["batch_snapshot"] == BATCH_SNAPSHOT
    assert manifest["prompt_versions"] == [
        {
            "prompt_version_id": "prompt-v3",
            "prompt_version_name": "Portrait prompt",
            "prompt_template": "Portrait of {{animal}}",
        }
    ]
    assert [job["ordinal"] for job in manifest["jobs"]] == [1, 2, 3, 4]
    assert {job["prompt_version_id"] for job in manifest["jobs"]} == {"prompt-v3"}
    assert [job["resolved_prompt"] for job in manifest["jobs"]] == [
        "Portrait of dog",
        "Portrait of dog",
        "Portrait of cat",
        "Portrait of cat",
    ]
    assert [job["seed"] for job in manifest["jobs"]] == [9, 3, 9, 3]
    assert all(
        job["resolved_image_inputs"][0]["asset"]["asset_id"] == asset.asset_id
        for job in manifest["jobs"]
    )
    assert all(
        job["resolved_image_inputs"][0]["asset"]["sha256"] == asset.sha256
        for job in manifest["jobs"]
    )

    with (expected_path / "manifest.csv").open(newline="") as file:
        rows = list(csv.DictReader(file))
    assert [row["job_id"] for row in rows] == ["job-1", "job-2", "job-3", "job-4"]
    assert [row["job_ordinal"] for row in rows] == ["1", "2", "3", "4"]
    assert all(row["prompt_version_name"] == "Portrait prompt" for row in rows)
    assert all(
        json.loads(row["resolved_image_inputs_json"])[0]["asset"]["sha256"] == asset.sha256
        for row in rows
    )
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
    assert loaded.batch_snapshot == BATCH_SNAPSHOT
    assert loaded.jobs == created.jobs
    assert loaded.workflow == WORKFLOW
    assert loaded.workflow_profile == WORKFLOW_PROFILE
    assert loaded.workflow_sha256 == created.workflow_sha256
    assert loaded.workflow_profile_sha256 == created.workflow_profile_sha256
    assert loaded.jobs[0].image_inputs[0].asset == asset


def test_manifest_v7_round_trips_ordered_prompt_versions_and_job_associations(
    tmp_path: Path,
) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = compile_batch(
        BatchDefinition(
            prompt_versions=(
                PromptVersion(id="first", name="First", text="First {{animal}}"),
                PromptVersion(id="second", name="Second", text="Second"),
            ),
            variable_bindings=(
                VariableBinding(
                    placeholder="animal",
                    values=("dog", "cat"),
                ),
            ),
            image_input_slots=(ImageInputSlot("reference", "Reference", "221", "image"),),
            image_bindings=(ImageBinding("reference", (asset.asset_id,)),),
            seeds=SeedInput.fixed(7),
        )
    )
    batch_snapshot = {
        **BATCH_SNAPSHOT,
        "prompt_versions": [
            {
                "id": "first",
                "prompt_id": None,
                "version_number": None,
                "name": "First",
                "text": "First {{animal}}",
            },
            {
                "id": "second",
                "prompt_id": None,
                "version_number": None,
                "name": "Second",
                "text": "Second",
            },
        ],
        "variable_bindings": [{"placeholder": "animal", "values": ["dog", "cat"]}],
        "seed_intent": {
            "mode": "fixed",
            "values": [7],
            "random_seed_count": None,
        },
    }
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        plan,
        asset,
        batch_snapshot=batch_snapshot,
    )

    loaded = RunFilesystemStore(projects_path).load_run(created.path)

    assert loaded.compiled_plan == plan
    assert loaded.batch_snapshot == batch_snapshot
    assert [version.id for version in loaded.compiled_plan.prompt_versions] == ["first", "second"]
    assert [job.prompt_version_id for job in loaded.compiled_plan.jobs] == [
        "first",
        "first",
        "second",
    ]


def test_manifest_v7_freezes_parameter_definitions_values_and_csv(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    workflow = json.loads(json.dumps(WORKFLOW))
    workflow["114"]["inputs"]["steps"] = 20
    profile = json.loads(json.dumps(WORKFLOW_PROFILE))
    profile["parameters"] = [
        {
            "key": "steps",
            "label": "Steps",
            "node_id": "114",
            "input_name": "steps",
            "value_type": "integer",
        }
    ]
    parameter = WorkflowParameter("steps", "Steps", "114", "steps", ParameterValueType.INTEGER)
    plan = compile_batch(
        BatchDefinition(
            prompt_versions=(PromptVersion("prompt-v3", "Portrait prompt", "Portrait"),),
            variable_bindings=(),
            image_input_slots=(ImageInputSlot("reference", "Reference", "221", "image"),),
            image_bindings=(ImageBinding("reference", (None,)),),
            seeds=SeedInput.fixed(9),
            parameters=(parameter,),
            parameter_bindings=(ParameterBinding("steps", (-5,)),),
        )
    )
    workflow_selection = BATCH_SNAPSHOT["workflow_selection"]
    assert isinstance(workflow_selection, dict)
    snapshot = {
        **BATCH_SNAPSHOT,
        "prompt_versions": [
            {
                "id": "prompt-v3",
                "prompt_id": None,
                "version_number": None,
                "name": "Portrait prompt",
                "text": "Portrait",
            }
        ],
        "variable_bindings": [],
        "image_bindings": [{"slot_key": "reference", "values": [None]}],
        "parameter_bindings": [{"parameter_key": "steps", "values": [-5]}],
        "seed_intent": {"mode": "fixed", "values": [9], "random_seed_count": None},
        "workflow_selection": {
            **workflow_selection,
            "workflow": workflow,
            "workflow_profile": profile,
        },
    }
    created = _create(
        RunFilesystemStore(
            projects_path,
            id_factory=SequentialIds("run-id", "job-1"),
            clock=lambda: FIXED_TIME,
        ),
        plan,
        None,
        batch_snapshot=snapshot,
        workflow=workflow,
        workflow_profile=profile,
    )

    manifest = json.loads((created.path / "manifest.json").read_text())
    with (created.path / "manifest.csv").open(newline="") as file:
        row = next(csv.DictReader(file))

    assert manifest["parameters"][0]["parameter_key"] == "steps"
    assert manifest["jobs"][0]["resolved_parameters"] == [{"parameter_key": "steps", "value": -5}]
    assert json.loads(row["resolved_parameters_json"]) == [{"parameter_key": "steps", "value": -5}]
    assert RunFilesystemStore(projects_path).load_run(created.path).compiled_plan == plan

    corrupted_workflow = json.loads(json.dumps(workflow))
    corrupted_workflow["114"]["inputs"]["steps"] = "twenty"
    _rewrite_frozen_workflow_pair(created, corrupted_workflow, profile)
    with pytest.raises(RunStoreError, match="base value must be integer"):
        RunFilesystemStore(projects_path).load_run(created.path)


@pytest.mark.parametrize(
    "corruption",
    ("duplicate_prompt", "unknown_job_prompt", "missing_prompt_versions", "missing_job_prompt"),
)
def test_manifest_v7_rejects_invalid_prompt_provenance(tmp_path: Path, corruption: str) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        _fixture_plan(asset.asset_id),
        asset,
    )
    manifest_path = created.path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if corruption == "duplicate_prompt":
        manifest["prompt_versions"].append(dict(manifest["prompt_versions"][0]))
    elif corruption == "unknown_job_prompt":
        manifest["jobs"][0]["prompt_version_id"] = "unknown"
    elif corruption == "missing_prompt_versions":
        manifest.pop("prompt_versions")
    else:
        manifest["jobs"][0].pop("prompt_version_id")
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n")

    with pytest.raises(
        RunStoreError,
        match="duplicate PromptVersion|unknown PromptVersion|prompt_versions|prompt_version_id",
    ):
        RunFilesystemStore(projects_path).load_run(created.path)


@pytest.mark.parametrize("manifest_version", (1, 2, 3, 4, 5))
def test_manifest_v1_through_v5_are_rejected(tmp_path: Path, manifest_version: int) -> None:
    projects_path = tmp_path / "projects"
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        _fixture_plan(None),
        None,
    )
    manifest_path = created.path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["format_version"] = manifest_version
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n")

    with pytest.raises(RunStoreError, match="unsupported manifest.json format version"):
        RunFilesystemStore(projects_path).load_run(created.path)


@pytest.mark.parametrize(
    ("seed_mode", "concrete_seeds", "seed_intent"),
    (
        (
            "fixed",
            (41,),
            {"mode": "fixed", "values": [41], "random_seed_count": None},
        ),
        (
            "explicit",
            (51, 52),
            {"mode": "explicit", "values": [51, 52], "random_seed_count": None},
        ),
        (
            "random",
            (9001, 9002),
            {"mode": "random", "values": [], "random_seed_count": 2},
        ),
    ),
)
def test_manifest_v7_preserves_seed_intent_separately_from_concrete_job_seeds(
    tmp_path: Path,
    seed_mode: str,
    concrete_seeds: tuple[int, ...],
    seed_intent: dict[str, object],
) -> None:
    projects_path = tmp_path / seed_mode
    plan = _fixture_plan(None, seeds=concrete_seeds)
    batch_snapshot = {
        **BATCH_SNAPSHOT,
        "image_bindings": [{"slot_key": "reference", "values": [None]}],
        "seed_intent": seed_intent,
    }

    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        plan,
        None,
        batch_snapshot=batch_snapshot,
    )
    loaded = RunFilesystemStore(projects_path).load_run(created.path)
    manifest = json.loads((created.path / "manifest.json").read_text())

    assert loaded.batch_snapshot == batch_snapshot
    assert manifest["batch_snapshot"]["seed_intent"] == seed_intent
    assert [job.compiled_job.seed for job in loaded.jobs] == list(concrete_seeds) * 2
    assert [job["seed"] for job in manifest["jobs"]] == list(concrete_seeds) * 2


def test_manifest_v7_snapshot_has_no_input_or_output_aliases(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    seed_values = [17, 18]
    batch_snapshot: dict[str, object] = {
        **BATCH_SNAPSHOT,
        "image_bindings": [{"slot_key": "reference", "values": [None]}],
        "seed_intent": {
            "mode": "explicit",
            "values": seed_values,
            "random_seed_count": None,
        },
    }
    expected_snapshot = json.loads(json.dumps(batch_snapshot))
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        _fixture_plan(None, seeds=(17, 18)),
        None,
        batch_snapshot=batch_snapshot,
    )

    seed_values.append(19)
    assert created.batch_snapshot == expected_snapshot
    created.batch_snapshot["changed_after_publication"] = True

    loaded = RunFilesystemStore(projects_path).load_run(created.path)

    assert loaded.batch_snapshot == expected_snapshot


def test_manifest_v7_round_trips_null_image_inputs(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    plan = _fixture_plan(None)
    created = _create(
        RunFilesystemStore(
            projects_path,
            id_factory=SequentialIds("run-id", "job-1", "job-2", "job-3", "job-4"),
            clock=lambda: FIXED_TIME,
        ),
        plan,
        None,
        batch_snapshot={
            **BATCH_SNAPSHOT,
            "image_bindings": [{"slot_key": "reference", "values": [None]}],
            "seed_intent": {
                "mode": "random",
                "values": [],
                "random_seed_count": 2,
            },
        },
    )

    manifest = json.loads((created.path / "manifest.json").read_text())
    with (created.path / "manifest.csv").open(newline="") as file:
        rows = list(csv.DictReader(file))
    loaded = RunFilesystemStore(projects_path).load_run(created.path)

    assert manifest["format_version"] == 7
    assert manifest["batch_snapshot"]["image_bindings"] == [
        {"slot_key": "reference", "values": [None]}
    ]
    assert all(job["resolved_image_inputs"][0]["asset"] is None for job in manifest["jobs"])
    assert all(json.loads(row["resolved_image_inputs_json"])[0]["asset"] is None for row in rows)
    assert loaded.compiled_plan == plan
    assert all(job.image_inputs[0].asset is None for job in loaded.jobs)


def test_manifest_v7_preserves_batch_alternatives_and_concrete_job_choices(
    tmp_path: Path,
) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    plan = compile_batch(
        BatchDefinition(
            prompt_versions=(PromptVersion("prompt-v3", "Portrait prompt", "Portrait"),),
            variable_bindings=(),
            image_input_slots=(ImageInputSlot("reference", "Reference", "221", "image"),),
            image_bindings=(ImageBinding("reference", (None, asset.asset_id)),),
            seeds=SeedInput.explicit((9, 3)),
        )
    )
    snapshot = {
        **BATCH_SNAPSHOT,
        "prompt_versions": [
            {
                "id": "prompt-v3",
                "prompt_id": None,
                "version_number": None,
                "name": "Portrait prompt",
                "text": "Portrait",
            }
        ],
        "variable_bindings": [],
        "image_bindings": [{"slot_key": "reference", "values": [None, asset.asset_id]}],
    }
    created = _create(
        RunFilesystemStore(
            projects_path,
            id_factory=SequentialIds("run-id", "job-1", "job-2", "job-3", "job-4"),
            clock=lambda: FIXED_TIME,
        ),
        plan,
        asset,
        batch_snapshot=snapshot,
    )

    manifest = json.loads((created.path / "manifest.json").read_text())
    loaded = RunFilesystemStore(projects_path).load_run(created.path)

    assert manifest["format_version"] == 7
    assert manifest["batch_snapshot"]["snapshot_version"] == 4
    assert manifest["batch_snapshot"]["image_bindings"] == snapshot["image_bindings"]
    assert [job["resolved_image_inputs"][0]["asset"] is None for job in manifest["jobs"]] == [
        True,
        True,
        False,
        False,
    ]
    assert loaded.compiled_plan == plan
    assert [job.compiled_job.resolved_image_inputs[0].asset_id for job in loaded.jobs] == [
        None,
        None,
        asset.asset_id,
        asset.asset_id,
    ]


def test_manifest_v7_rejects_missing_resolved_image_inputs(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        _fixture_plan(None),
        None,
    )
    manifest_path = created.path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["jobs"][0].pop("resolved_image_inputs")
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n")

    with pytest.raises(RunStoreError, match="resolved_image_inputs must be a JSON array"):
        RunFilesystemStore(projects_path).load_run(created.path)


@pytest.mark.parametrize(
    ("field", "value"),
    (("slot_key", "other"), ("slot_label", "Other")),
)
def test_manifest_v7_rejects_job_image_input_that_differs_from_frozen_profile(
    tmp_path: Path,
    field: str,
    value: str,
) -> None:
    projects_path = tmp_path / "projects"
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        _fixture_plan(None),
        None,
    )
    manifest_path = created.path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["jobs"][0]["resolved_image_inputs"][0][field] = value
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n")

    with pytest.raises(RunStoreError, match="keys or labels do not match the frozen Profile"):
        RunFilesystemStore(projects_path).load_run(created.path)


@pytest.mark.parametrize(
    "corruption",
    (
        "missing",
        "array",
        "version_one",
        "incomplete",
        "old_binding_field",
        "duplicate_values",
    ),
)
def test_manifest_v7_rejects_missing_or_malformed_batch_snapshot(
    tmp_path: Path, corruption: str
) -> None:
    projects_path = tmp_path / "projects"
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        _fixture_plan(None),
        None,
    )
    manifest_path = created.path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if corruption == "missing":
        manifest.pop("batch_snapshot")
    elif corruption == "array":
        manifest["batch_snapshot"] = []
    elif corruption == "version_one":
        manifest["batch_snapshot"]["snapshot_version"] = 1
    elif corruption == "incomplete":
        manifest["batch_snapshot"].pop("workflow_selection")
    elif corruption == "old_binding_field":
        manifest["batch_snapshot"]["variable_bindings"][0]["mode"] = "all"
    else:
        manifest["batch_snapshot"]["variable_bindings"][0]["values"] = ["dog", "dog"]
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n")

    with pytest.raises(RunStoreError, match="batch_snapshot must|invalid Batch snapshot v4"):
        RunFilesystemStore(projects_path).load_run(created.path)


@pytest.mark.parametrize(
    "corruption",
    ("project", "batch", "prompt", "binding", "images", "seed", "expansion", "workflow"),
)
def test_manifest_v7_rejects_batch_snapshot_that_contradicts_frozen_run(
    tmp_path: Path, corruption: str
) -> None:
    projects_path = tmp_path / "projects"
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        _fixture_plan(None),
        None,
    )
    manifest_path = created.path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    snapshot = manifest["batch_snapshot"]
    if corruption == "project":
        snapshot["project"]["id"] = "other-project"
    elif corruption == "batch":
        snapshot["batch"]["name"] = "Other Batch"
    elif corruption == "prompt":
        snapshot["prompt_versions"][0]["text"] = "Changed {{animal}}"
    elif corruption == "binding":
        snapshot["variable_bindings"][0]["values"] = ["dog"]
    elif corruption == "images":
        snapshot["image_bindings"] = [{"slot_key": "reference", "values": ["other-asset"]}]
    elif corruption == "seed":
        snapshot["seed_intent"]["values"] = [3, 9]
    elif corruption == "expansion":
        snapshot["variable_bindings"][0]["values"] = [f"value-{index}" for index in range(100)]
    else:
        snapshot["workflow_selection"]["workflow"] = {"changed": True}
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n")

    with pytest.raises(RunStoreError, match="Batch snapshot"):
        RunFilesystemStore(projects_path).load_run(created.path)


@pytest.mark.parametrize("corruption", ("version_one", "incomplete", "old_binding_field"))
def test_create_run_rejects_malformed_snapshot_v4(tmp_path: Path, corruption: str) -> None:
    batch_snapshot = json.loads(
        json.dumps(
            {**BATCH_SNAPSHOT, "image_bindings": [{"slot_key": "reference", "values": [None]}]}
        )
    )
    if corruption == "version_one":
        batch_snapshot["snapshot_version"] = 1
    elif corruption == "incomplete":
        batch_snapshot.pop("workflow_selection")
    else:
        batch_snapshot["variable_bindings"][0]["fixed_value"] = "dog"

    with pytest.raises(RunStoreError, match="invalid Batch snapshot v4"):
        _create(
            RunFilesystemStore(tmp_path / "projects"),
            _fixture_plan(None),
            None,
            batch_snapshot=batch_snapshot,
        )


@pytest.mark.parametrize(
    ("artifact", "invalid_version"),
    (
        ("run", True),
        ("run", 1.0),
        ("manifest", True),
        ("manifest", 6.0),
        ("snapshot", True),
        ("snapshot", 3.0),
    ),
)
def test_run_load_rejects_non_integer_format_versions(
    tmp_path: Path, artifact: str, invalid_version: object
) -> None:
    projects_path = tmp_path / "projects"
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        _fixture_plan(None),
        None,
    )
    path = created.path / ("run.json" if artifact == "run" else "manifest.json")
    data = json.loads(path.read_text())
    if artifact == "snapshot":
        data["batch_snapshot"]["snapshot_version"] = invalid_version
    else:
        data["format_version"] = invalid_version
    path.write_text(json.dumps(data, separators=(",", ":"), sort_keys=True) + "\n")

    with pytest.raises(RunStoreError):
        RunFilesystemStore(projects_path).load_run(created.path)


@pytest.mark.parametrize("invalid_version", (True, 1.0))
def test_run_creation_rejects_non_integer_batch_owner_version(
    tmp_path: Path, invalid_version: object
) -> None:
    projects_path = tmp_path / "projects"
    store = RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME)
    created = _create(store, _fixture_plan(None), None)
    owner_path = created.path.parent / "batch.json"
    owner = json.loads(owner_path.read_text())
    owner["format_version"] = invalid_version
    owner_path.write_text(json.dumps(owner))

    with pytest.raises(RunStoreError, match="format_version must be an integer"):
        _create(store, _fixture_plan(None), None)


def test_manifest_load_rejects_unknown_format_version(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    asset = _asset_fixture(projects_path)
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        _fixture_plan(asset.asset_id),
        asset,
    )
    manifest_path = created.path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["format_version"] = 8
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n")

    with pytest.raises(RunStoreError, match="unsupported manifest.json format version"):
        RunFilesystemStore(projects_path).load_run(created.path)


@pytest.mark.parametrize(
    ("corruption", "message"),
    (
        ("missing_parameter_target", "references missing input"),
        ("connected_parameter_target", "parameter 'steps'.*connected input"),
        ("parameter_target_collision", "maps multiple inputs"),
        ("wrong_parameter_base_type", "base value must be integer"),
    ),
)
def test_run_load_rejects_semantically_invalid_frozen_workflow_profile_pair(
    tmp_path: Path, corruption: str, message: str
) -> None:
    projects_path = tmp_path / "projects"
    workflow = json.loads(json.dumps(WORKFLOW))
    workflow["114"]["inputs"]["steps"] = 20
    profile = json.loads(json.dumps(WORKFLOW_PROFILE))
    profile["parameters"] = [
        {
            "key": "steps",
            "label": "Steps",
            "node_id": "114",
            "input_name": "steps",
            "value_type": "integer",
        }
    ]
    parameter = WorkflowParameter("steps", "Steps", "114", "steps", ParameterValueType.INTEGER)
    plan = compile_batch(
        BatchDefinition(
            prompt_versions=(PromptVersion("prompt-v3", "Portrait prompt", "Portrait"),),
            variable_bindings=(),
            image_input_slots=(ImageInputSlot("reference", "Reference", "221", "image"),),
            image_bindings=(ImageBinding("reference", (None,)),),
            seeds=SeedInput.fixed(9),
            parameters=(parameter,),
            parameter_bindings=(ParameterBinding("steps", (None,)),),
        )
    )
    workflow_selection = BATCH_SNAPSHOT["workflow_selection"]
    assert isinstance(workflow_selection, dict)
    created = _create(
        RunFilesystemStore(projects_path, clock=lambda: FIXED_TIME),
        plan,
        None,
        batch_snapshot={
            **BATCH_SNAPSHOT,
            "prompt_versions": [
                {
                    "id": "prompt-v3",
                    "prompt_id": None,
                    "version_number": None,
                    "name": "Portrait prompt",
                    "text": "Portrait",
                }
            ],
            "variable_bindings": [],
            "image_bindings": [{"slot_key": "reference", "values": [None]}],
            "parameter_bindings": [{"parameter_key": "steps", "values": [None]}],
            "seed_intent": {"mode": "fixed", "values": [9], "random_seed_count": None},
            "workflow_selection": {
                **workflow_selection,
                "workflow": workflow,
                "workflow_profile": profile,
            },
        },
        workflow=workflow,
        workflow_profile=profile,
    )
    workflow = json.loads(json.dumps(created.workflow))
    profile = json.loads(json.dumps(created.workflow_profile))
    if corruption == "missing_parameter_target":
        del workflow["114"]["inputs"]["steps"]
    elif corruption == "connected_parameter_target":
        workflow["114"]["inputs"]["steps"] = ["3", 0]
    elif corruption == "parameter_target_collision":
        profile["parameters"][0].update({"node_id": "114", "input_name": "seed"})
    else:
        workflow["114"]["inputs"]["steps"] = "twenty"
    _rewrite_frozen_workflow_pair(created, workflow, profile)

    with pytest.raises(RunStoreError, match=message):
        RunFilesystemStore(projects_path).load_run(created.path)


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
        batch_snapshot={
            **BATCH_SNAPSHOT,
            "seed_intent": {
                "mode": "explicit",
                "values": list(range(50)),
                "random_seed_count": None,
            },
        },
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
    manifest["jobs"][1]["resolved_image_inputs"][0]["asset"]["original_filename"] = (
        "inconsistent.png"
    )
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
