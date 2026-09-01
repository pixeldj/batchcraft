import asyncio
import copy
import hashlib
import json
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

import batchcraft.execution.state as state_module
from batchcraft.comfyui import (
    DownloadedArtifact,
    ExecutionEvent,
    ExecutionOutcome,
    ExecutionStatus,
    PromptSubmission,
    RemoteOutputArtifact,
    SubmissionDisposition,
    UploadedInput,
    WorkflowPreparationValues,
    prepare_workflow,
)
from batchcraft.domain import (
    BatchDefinition,
    ImageBinding,
    ImageInputSlot,
    ParameterBinding,
    ParameterValueType,
    PromptVersion,
    SeedInput,
    WorkflowParameter,
    compile_batch,
)
from batchcraft.execution import (
    ExecutionConfig,
    ExecutionStateError,
    ExecutionStateStore,
    JobExecutionStatus,
    RunExecutionState,
    RunExecutionStatus,
    execute_run,
)
from batchcraft.files import (
    AssetRecord,
    BatchIdentity,
    ProjectAssetStore,
    ProjectIdentity,
    PublishedRun,
    RunFilesystemStore,
)

FIXED_TIME = datetime(2026, 8, 27, 20, 0, tzinfo=UTC)
PROJECT = ProjectIdentity(id="project-id", filesystem_key="project_key", name="Project")
BATCH = BatchIdentity(id="batch-id", filesystem_key="batch_key", name="Batch")
WORKFLOW: dict[str, object] = {
    "7": {"class_type": "KSampler", "inputs": {"seed": 0, "steps": 20}},
    "25": {"class_type": "LoadImage", "inputs": {"image": "original.png"}},
    "26": {"class_type": "LoadImage", "inputs": {"image": "second-original.png"}},
    "34": {"class_type": "TextEncode", "inputs": {"prompt": "original"}},
    "41": {"class_type": "SaveImage", "inputs": {"filename_prefix": "original"}},
}
WORKFLOW_PROFILE: dict[str, object] = {
    "id": "profile-id",
    "name": "Profile",
    "mappings": {
        "prompt": {"node_id": "34", "input_name": "prompt", "value_type": "string"},
        "seed": {"node_id": "7", "input_name": "seed", "value_type": "integer"},
        "output_prefix": {
            "node_id": "41",
            "input_name": "filename_prefix",
            "value_type": "string",
        },
    },
    "image_inputs": [
        {"key": "identity", "label": "Identity", "node_id": "25", "input_name": "image"},
        {"key": "pose", "label": "Pose", "node_id": "26", "input_name": "image"},
    ],
    "parameters": [
        {
            "key": "steps",
            "label": "Steps",
            "node_id": "7",
            "input_name": "steps",
            "value_type": "integer",
        }
    ],
}


class SequentialValues:
    def __init__(self, *values: str) -> None:
        self._values = iter(values)

    def __call__(self) -> str:
        return next(self._values)


@dataclass(frozen=True)
class SubmissionSpec:
    disposition: SubmissionDisposition
    prompt_id: str | None = None
    status: int | None = 200
    diagnostic: str | None = None


class FakeEventSource:
    def __init__(self, fail: bool, hang: bool = False) -> None:
        self._fail = fail
        self._hang = hang

    async def events(self, prompt_id: str) -> AsyncIterator[ExecutionEvent]:
        if self._fail:
            raise RuntimeError("event stream dropped")
        if self._hang:
            await asyncio.Event().wait()
        yield ExecutionEvent(
            event_type="execution_success",
            prompt_id=prompt_id,
            node_id=None,
            data={"prompt_id": prompt_id, "node": None},
        )


class FakeEventContext(AbstractAsyncContextManager[FakeEventSource]):
    def __init__(self, source: FakeEventSource, enter_error: Exception | None = None) -> None:
        self._source = source
        self._enter_error = enter_error

    async def __aenter__(self) -> FakeEventSource:
        if self._enter_error is not None:
            raise self._enter_error
        return self._source

    async def __aexit__(self, *_args: object) -> None:
        return None


class FakeExecutionClient:
    def __init__(
        self,
        *,
        submissions: list[SubmissionSpec | Exception],
        histories: dict[str, list[ExecutionOutcome | None]],
        downloads: dict[RemoteOutputArtifact, tuple[bytes, str | None] | Exception] | None = None,
        websocket_failures: set[int] | None = None,
        websocket_hangs: set[int] | None = None,
        websocket_open_failures: set[int] | None = None,
    ) -> None:
        self.submissions = submissions
        self.histories = histories
        self.downloads = downloads or {}
        self.websocket_failures = websocket_failures or set()
        self.websocket_hangs = websocket_hangs or set()
        self.websocket_open_failures = websocket_open_failures or set()
        self.uploads: list[tuple[str, bytes, str, str]] = []
        self.submitted_workflows: list[dict[str, object]] = []
        self.call_log: list[str] = []
        self.active_prompts = 0
        self.max_active_prompts = 0
        self._stream_number = 0
        self._terminal_prompts: set[str] = set()

    async def upload_input(
        self,
        *,
        filename: str,
        content: bytes,
        mime_type: str = "application/octet-stream",
        subfolder: str = "",
    ) -> UploadedInput:
        self.uploads.append((filename, content, mime_type, subfolder))
        self.call_log.append(f"upload:{subfolder}")
        return UploadedInput(
            name=filename,
            subfolder=subfolder,
            remote_type="input",
            workflow_value=f"{subfolder}/{filename}",
        )

    def open_event_stream(self, client_id: str) -> AbstractAsyncContextManager[FakeEventSource]:
        self._stream_number += 1
        self.call_log.append(f"open:{client_id}")
        return FakeEventContext(
            FakeEventSource(
                self._stream_number in self.websocket_failures,
                self._stream_number in self.websocket_hangs,
            ),
            (
                RuntimeError("event stream did not open")
                if self._stream_number in self.websocket_open_failures
                else None
            ),
        )

    async def submit_prompt(
        self, workflow: Mapping[str, object], *, client_id: str
    ) -> PromptSubmission:
        if not self.submissions:
            raise AssertionError("unexpected prompt submission")
        spec = self.submissions.pop(0)
        self.submitted_workflows.append(copy.deepcopy(dict(workflow)))
        if isinstance(spec, Exception):
            self.call_log.append("submit:raised")
            raise spec
        self.call_log.append(f"submit:{spec.prompt_id or spec.disposition.value}")
        if spec.disposition is SubmissionDisposition.ACCEPTED:
            assert self.active_prompts == 0, "queue depth exceeded one"
            self.active_prompts += 1
            self.max_active_prompts = max(self.max_active_prompts, self.active_prompts)
        return PromptSubmission(
            disposition=spec.disposition,
            client_id=client_id,
            prompt_id=spec.prompt_id,
            http_status=spec.status,
            response={"prompt_id": spec.prompt_id} if spec.prompt_id else None,
            diagnostic=spec.diagnostic,
        )

    async def get_history(self, prompt_id: str) -> ExecutionOutcome | None:
        self.call_log.append(f"history:{prompt_id}")
        values = self.histories[prompt_id]
        outcome = values.pop(0) if len(values) > 1 else values[0]
        if (
            outcome is not None
            and outcome.status is not ExecutionStatus.PENDING
            and prompt_id not in self._terminal_prompts
        ):
            self._terminal_prompts.add(prompt_id)
            self.active_prompts -= 1
        return outcome

    async def download_artifact(self, artifact: RemoteOutputArtifact) -> DownloadedArtifact:
        self.call_log.append(f"download:{artifact.producing_node_id}:{artifact.output_name}")
        value = self.downloads[artifact]
        if isinstance(value, Exception):
            raise value
        content, content_type = value
        return DownloadedArtifact(
            remote=artifact,
            content=content,
            content_type=content_type,
            sha256=hashlib.sha256(content).hexdigest(),
        )


def _published_run(
    tmp_path: Path,
    *,
    job_count: int = 2,
    with_images: bool = True,
    vary_prompt_and_seed: bool = False,
    image_alternatives: bool = False,
    parameter_value: int | None = -5,
) -> tuple[PublishedRun, tuple[bytes, ...]]:
    projects_path = tmp_path / "projects"
    project_path = projects_path / PROJECT.filesystem_key
    contents: tuple[bytes, ...] = ()
    assets: tuple[AssetRecord, ...] = ()
    if with_images:
        sources = (tmp_path / "first.png", tmp_path / "second.webp")
        contents = (b"first reference", b"second reference")
        for source, content in zip(sources, contents, strict=True):
            source.write_bytes(content)
        asset_ids = SequentialValues("asset-1", "asset-2")
        asset_store = ProjectAssetStore(
            project_path, id_factory=asset_ids, clock=lambda: FIXED_TIME
        )
        assets = tuple(asset_store.import_file(source) for source in sources)
    prompts: tuple[PromptVersion, ...]
    if vary_prompt_and_seed:
        assert not with_images
        prompts = (
            PromptVersion(id="prompt-1", name="Prompt 1", text="resolved prompt 1"),
            PromptVersion(id="prompt-2", name="Prompt 2", text="resolved prompt 2"),
        )
        seeds = SeedInput.explicit((101, 102))
        seed_mode = "explicit"
    else:
        prompts = (PromptVersion(id="prompt-version", name="Prompt", text="resolved prompt"),)
        seeds = SeedInput.explicit(tuple(101 + index for index in range(job_count)))
        seed_mode = "explicit"
    slots = (
        ImageInputSlot("identity", "Identity", "25", "image"),
        ImageInputSlot("pose", "Pose", "26", "image"),
    )
    image_bindings = (
        ImageBinding(
            "identity",
            (
                (None, assets[0].asset_id)
                if image_alternatives
                else ((assets[0].asset_id if assets else None),)
            ),
        ),
        ImageBinding("pose", ((assets[1].asset_id if assets else None),)),
    )
    plan = compile_batch(
        BatchDefinition(
            prompt_versions=prompts,
            variable_bindings=(),
            image_input_slots=slots,
            image_bindings=image_bindings,
            seeds=seeds,
            parameters=(
                WorkflowParameter("steps", "Steps", "7", "steps", ParameterValueType.INTEGER),
            ),
            parameter_bindings=(ParameterBinding("steps", (parameter_value,)),),
        )
    )
    run_ids = SequentialValues(
        "run-id", *(f"job-{index}" for index in range(1, plan.job_count + 1))
    )
    run = RunFilesystemStore(
        projects_path,
        id_factory=run_ids,
        clock=lambda: FIXED_TIME,
    ).create_run(
        project=PROJECT,
        batch=BATCH,
        batch_snapshot={
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
                    "id": prompt.id,
                    "prompt_id": None,
                    "version_number": None,
                    "name": prompt.name,
                    "text": prompt.text,
                }
                for prompt in prompts
            ],
            "variable_bindings": [],
            "image_bindings": [
                {"slot_key": binding.slot_key, "values": list(binding.values)}
                for binding in image_bindings
            ],
            "parameter_bindings": [{"parameter_key": "steps", "values": [parameter_value]}],
            "seed_intent": {
                "mode": seed_mode,
                "values": list(seeds.values),
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
        },
        plan=plan,
        image_assets={asset.asset_id: asset for asset in assets},
        workflow=WORKFLOW,
        workflow_profile=WORKFLOW_PROFILE,
    )
    return run, contents * plan.job_count


def _outcome(
    prompt_id: str,
    status: ExecutionStatus,
    *artifacts: RemoteOutputArtifact,
) -> ExecutionOutcome:
    return ExecutionOutcome(
        prompt_id=prompt_id,
        status=status,
        artifacts=artifacts,
        status_data={
            "completed": status is not ExecutionStatus.PENDING,
            "status_str": status.value,
        },
    )


def _run(
    run: PublishedRun,
    client: FakeExecutionClient,
    *,
    preparer: Callable[
        [Mapping[str, object], Mapping[str, object], WorkflowPreparationValues],
        dict[str, object],
    ] = prepare_workflow,
    config: ExecutionConfig | None = None,
    monotonic: Callable[[], float] | None = None,
    state_store: ExecutionStateStore | None = None,
) -> RunExecutionState:
    client_ids = SequentialValues(*(f"client-{i}" for i in range(1, 20)))
    if monotonic is None:
        return asyncio.run(
            execute_run(
                run=run,
                client=client,
                config=config,
                state_store=state_store,
                workflow_preparer=preparer,
                clock=lambda: FIXED_TIME,
                id_factory=client_ids,
            )
        )
    return asyncio.run(
        execute_run(
            run=run,
            client=client,
            config=config,
            state_store=state_store,
            workflow_preparer=preparer,
            clock=lambda: FIXED_TIME,
            id_factory=client_ids,
            monotonic=monotonic,
        )
    )


def test_two_jobs_execute_sequentially_with_frozen_inputs_and_ingested_results(
    tmp_path: Path,
) -> None:
    run, asset_contents = _published_run(tmp_path)
    artifact_1 = RemoteOutputArtifact("41", "images", "../../portrait.PNG", "remote\\one", "output")
    artifact_2 = RemoteOutputArtifact("52", "images", "shared.webp", "remote", "output")
    artifact_3 = RemoteOutputArtifact("53", "preview", "..\\..\\payload", "temp", "temp")
    client = FakeExecutionClient(
        submissions=[
            SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1"),
            SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-2"),
        ],
        histories={
            "prompt-1": [_outcome("prompt-1", ExecutionStatus.SUCCEEDED, artifact_1)],
            "prompt-2": [_outcome("prompt-2", ExecutionStatus.SUCCEEDED, artifact_2, artifact_3)],
        },
        downloads={
            artifact_1: (b"result one", "image/png"),
            artifact_2: (b"result two", "image/webp"),
            artifact_3: (b"result three", "image/webp"),
        },
    )
    preparation_calls: list[
        tuple[Mapping[str, object], Mapping[str, object], WorkflowPreparationValues]
    ] = []

    def observing_preparer(
        workflow: Mapping[str, object],
        profile: Mapping[str, object],
        values: WorkflowPreparationValues,
    ) -> dict[str, object]:
        preparation_calls.append((workflow, profile, values))
        return prepare_workflow(workflow, profile, values)

    immutable_files = {
        name: (run.path / name).read_bytes()
        for name in ("manifest.json", "workflow.json", "workflow-profile.json")
    }
    original_plan = copy.deepcopy(run.compiled_plan)

    state = _run(run, client, preparer=observing_preparer)

    assert state.status is RunExecutionStatus.SUCCEEDED
    assert [job.status for job in state.jobs] == [
        JobExecutionStatus.SUCCEEDED,
        JobExecutionStatus.SUCCEEDED,
    ]
    assert [job.prompt_id for job in state.jobs] == ["prompt-1", "prompt-2"]
    assert client.max_active_prompts == 1
    assert [upload[1] for upload in client.uploads] == list(asset_contents)
    assert [call[2].prompt for call in preparation_calls] == [
        "resolved prompt",
        "resolved prompt",
    ]
    assert [call[2].seed for call in preparation_calls] == [101, 102]
    assert all(call[0] is run.workflow for call in preparation_calls)
    assert all(call[1] is run.workflow_profile for call in preparation_calls)
    assert [tuple(call[2].image_inputs) for call in preparation_calls] == [
        ("identity", "pose"),
        ("identity", "pose"),
    ]
    assert preparation_calls[0][2].image_inputs["identity"].endswith("/01-identity.png")
    assert preparation_calls[0][2].image_inputs["pose"].endswith("/02-pose.webp")
    assert [upload[0] for upload in client.uploads] == [
        "01-identity.png",
        "02-pose.webp",
        "01-identity.png",
        "02-pose.webp",
    ]
    assert preparation_calls[0][2].output_prefix == "batchcraft/run-id/job-1/result"
    assert preparation_calls[1][2].output_prefix == "batchcraft/run-id/job-2/result"
    assert client.call_log.index("history:prompt-1") < client.call_log.index("submit:prompt-2")
    assert client.call_log.index("download:41:images") < client.call_log.index("submit:prompt-2")

    results = tuple(result for job in state.jobs for result in job.results)
    assert [result.local_path for result in results] == [
        "outputs/000001-01.png",
        "outputs/000002-01.webp",
        "outputs/000002-02.webp",
    ]
    assert [result.artifact_ordinal for result in state.jobs[1].results] == [1, 2]
    assert [(result.producing_node_id, result.output_name) for result in results] == [
        ("41", "images"),
        ("52", "images"),
        ("53", "preview"),
    ]
    assert [result.byte_size for result in results] == [10, 10, 12]
    assert [result.content_type for result in results] == [
        "image/png",
        "image/webp",
        "image/webp",
    ]
    assert all((run.path / result.local_path).is_file() for result in results)
    assert all((run.path / result.local_path).parent == run.path / "outputs" for result in results)
    assert results[0].remote_filename == "../../portrait.PNG"
    assert results[0].remote_subfolder == "remote\\one"
    assert results[0].sha256 == hashlib.sha256(b"result one").hexdigest()
    assert ExecutionStateStore(run.path).load(run) == state
    assert run.compiled_plan == original_plan
    assert all(
        (run.path / name).read_bytes() == content for name, content in immutable_files.items()
    )


def test_each_job_uses_its_own_compiled_prompt_and_seed(tmp_path: Path) -> None:
    run, _ = _published_run(
        tmp_path,
        with_images=False,
        vary_prompt_and_seed=True,
    )
    prompt_ids = [f"prompt-{index}" for index in range(1, 5)]
    client = FakeExecutionClient(
        submissions=[
            SubmissionSpec(SubmissionDisposition.ACCEPTED, prompt_id) for prompt_id in prompt_ids
        ],
        histories={
            prompt_id: [_outcome(prompt_id, ExecutionStatus.SUCCEEDED)] for prompt_id in prompt_ids
        },
    )
    preparation_values: list[WorkflowPreparationValues] = []

    def observing_preparer(
        workflow: Mapping[str, object],
        profile: Mapping[str, object],
        values: WorkflowPreparationValues,
    ) -> dict[str, object]:
        preparation_values.append(values)
        return prepare_workflow(workflow, profile, values)

    state = _run(run, client, preparer=observing_preparer)

    assert state.status is RunExecutionStatus.SUCCEEDED
    assert [(values.prompt, values.seed) for values in preparation_values] == [
        ("resolved prompt 1", 101),
        ("resolved prompt 1", 102),
        ("resolved prompt 2", 101),
        ("resolved prompt 2", 102),
    ]


def test_null_bindings_skip_upload_and_preserve_base_workflow_values(
    tmp_path: Path,
) -> None:
    run, _ = _published_run(tmp_path, job_count=1, with_images=False, parameter_value=None)
    client = FakeExecutionClient(
        submissions=[SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1")],
        histories={"prompt-1": [_outcome("prompt-1", ExecutionStatus.SUCCEEDED)]},
    )
    preparation_values: list[WorkflowPreparationValues] = []

    def observing_preparer(
        workflow: Mapping[str, object],
        profile: Mapping[str, object],
        values: WorkflowPreparationValues,
    ) -> dict[str, object]:
        preparation_values.append(values)
        return prepare_workflow(workflow, profile, values)

    state = _run(run, client, preparer=observing_preparer)

    assert state.status is RunExecutionStatus.SUCCEEDED
    assert state.jobs[0].status is JobExecutionStatus.SUCCEEDED
    assert client.uploads == []
    assert [dict(values.image_inputs) for values in preparation_values] == [{}]
    assert [dict(values.parameters) for values in preparation_values] == [{}]
    assert len(client.submitted_workflows) == 1
    assert client.submitted_workflows[0]["7"]["inputs"]["steps"] == 20  # type: ignore[index]
    assert client.submitted_workflows[0]["25"]["inputs"]["image"] == "original.png"  # type: ignore[index]
    assert client.submitted_workflows[0]["26"]["inputs"]["image"] == "second-original.png"  # type: ignore[index]


def test_cartesian_jobs_reach_executor_with_one_resolved_value_per_slot(
    tmp_path: Path,
) -> None:
    run, _ = _published_run(tmp_path, job_count=1, image_alternatives=True)
    client = FakeExecutionClient(
        submissions=[
            SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1"),
            SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-2"),
        ],
        histories={
            "prompt-1": [_outcome("prompt-1", ExecutionStatus.SUCCEEDED)],
            "prompt-2": [_outcome("prompt-2", ExecutionStatus.SUCCEEDED)],
        },
    )
    preparation_values: list[WorkflowPreparationValues] = []

    def observing_preparer(
        workflow: Mapping[str, object],
        profile: Mapping[str, object],
        values: WorkflowPreparationValues,
    ) -> dict[str, object]:
        preparation_values.append(values)
        return prepare_workflow(workflow, profile, values)

    state = _run(run, client, preparer=observing_preparer)

    assert state.status is RunExecutionStatus.SUCCEEDED
    assert [tuple(values.image_inputs) for values in preparation_values] == [
        ("pose",),
        ("identity", "pose"),
    ]
    assert [upload[0] for upload in client.uploads] == [
        "02-pose.webp",
        "01-identity.png",
        "02-pose.webp",
    ]
    assert client.submitted_workflows[0]["25"]["inputs"]["image"] == "original.png"  # type: ignore[index]
    second_identity = client.submitted_workflows[1]["25"]["inputs"]["image"]  # type: ignore[index]
    assert str(second_identity).endswith("/01-identity.png")


@pytest.mark.parametrize(
    ("spec", "expected_run", "expected_job"),
    [
        (
            SubmissionSpec(
                SubmissionDisposition.REJECTED,
                status=400,
                diagnostic="workflow rejected",
            ),
            RunExecutionStatus.FAILED,
            JobExecutionStatus.FAILED,
        ),
        (
            SubmissionSpec(
                SubmissionDisposition.UNKNOWN,
                status=503,
                diagnostic="response lost",
            ),
            RunExecutionStatus.BLOCKED,
            JobExecutionStatus.SUBMISSION_UNKNOWN,
        ),
    ],
)
def test_rejected_or_unknown_submission_stops_without_retrying_or_advancing(
    tmp_path: Path,
    spec: SubmissionSpec,
    expected_run: RunExecutionStatus,
    expected_job: JobExecutionStatus,
) -> None:
    run, _ = _published_run(tmp_path)
    client = FakeExecutionClient(submissions=[spec], histories={})

    state = _run(run, client)

    assert state.status is expected_run
    assert state.jobs[0].status is expected_job
    assert state.jobs[1].status is JobExecutionStatus.PENDING
    assert state.jobs[0].submission_disposition is spec.disposition
    assert state.jobs[0].submission_http_status == spec.status
    assert len(client.submitted_workflows) == 1
    assert len(client.uploads) == 2
    if spec.disposition is SubmissionDisposition.UNKNOWN:
        assert state.jobs[0].prompt_id is None
        assert state.completed_at is None


def test_websocket_failure_after_acceptance_falls_back_to_successful_history(
    tmp_path: Path,
) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    client = FakeExecutionClient(
        submissions=[SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1")],
        histories={"prompt-1": [_outcome("prompt-1", ExecutionStatus.SUCCEEDED)]},
        websocket_failures={1},
    )

    state = _run(run, client)

    assert state.status is RunExecutionStatus.SUCCEEDED
    assert state.jobs[0].status is JobExecutionStatus.SUCCEEDED
    assert state.jobs[0].results == ()
    assert client.call_log.count("history:prompt-1") == 1


def test_history_reconciliation_is_not_gated_by_websocket_observation(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    client = FakeExecutionClient(
        submissions=[SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1")],
        histories={"prompt-1": [_outcome("prompt-1", ExecutionStatus.SUCCEEDED)]},
        websocket_hangs={1},
    )

    state = _run(
        run,
        client,
        config=ExecutionConfig(websocket_timeout_seconds=60),
    )

    assert state.status is RunExecutionStatus.SUCCEEDED
    assert client.call_log.count("history:prompt-1") == 1


def test_history_failure_stops_later_jobs(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path)
    client = FakeExecutionClient(
        submissions=[SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1")],
        histories={"prompt-1": [_outcome("prompt-1", ExecutionStatus.FAILED)]},
    )

    state = _run(run, client)

    assert state.status is RunExecutionStatus.FAILED
    assert state.jobs[0].status is JobExecutionStatus.FAILED
    assert state.jobs[0].history_status == {"completed": True, "status_str": "failed"}
    assert state.jobs[1].status is JobExecutionStatus.PENDING
    assert len(client.submitted_workflows) == 1


def test_history_polling_is_bounded_and_preserves_known_prompt_for_recovery(
    tmp_path: Path,
) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    client = FakeExecutionClient(
        submissions=[SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1")],
        histories={"prompt-1": [None]},
    )
    monotonic_values = iter((0.0, 0.0, 10.0))

    def monotonic() -> float:
        return next(monotonic_values)

    state = _run(
        run,
        client,
        config=ExecutionConfig(history_timeout_seconds=5, history_poll_interval_seconds=1),
        monotonic=monotonic,
    )

    assert state.status is RunExecutionStatus.BLOCKED
    assert state.jobs[0].status is JobExecutionStatus.SUBMITTED
    assert state.jobs[0].prompt_id == "prompt-1"
    assert "timed out" in (state.jobs[0].error or "")
    assert client.call_log.count("history:prompt-1") == 1


def test_history_timeout_bounds_an_in_flight_request(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)

    class HangingHistoryClient(FakeExecutionClient):
        async def get_history(self, prompt_id: str) -> ExecutionOutcome | None:
            self.call_log.append(f"history:{prompt_id}")
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    client = HangingHistoryClient(
        submissions=[SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1")],
        histories={"prompt-1": [None]},
    )

    state = _run(
        run,
        client,
        config=ExecutionConfig(history_timeout_seconds=0.01, history_poll_interval_seconds=0.01),
    )

    assert state.status is RunExecutionStatus.BLOCKED
    assert state.jobs[0].status is JobExecutionStatus.SUBMITTED
    assert client.call_log.count("history:prompt-1") == 1


def test_submission_exception_is_persisted_as_unknown_and_never_retried(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path)
    client = FakeExecutionClient(
        submissions=[RuntimeError("response connection dropped")],
        histories={},
    )

    state = _run(run, client)

    assert state.status is RunExecutionStatus.BLOCKED
    assert state.jobs[0].status is JobExecutionStatus.SUBMISSION_UNKNOWN
    assert state.jobs[0].client_id == "client-1"
    assert state.jobs[0].submission_disposition is SubmissionDisposition.UNKNOWN
    assert "response connection dropped" in (state.jobs[0].error or "")
    assert state.jobs[1].status is JobExecutionStatus.PENDING
    assert len(client.submitted_workflows) == 1


def test_websocket_open_failure_does_not_submit_prompt(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    client = FakeExecutionClient(
        submissions=[SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1")],
        histories={},
        websocket_open_failures={1},
    )

    state = _run(run, client)

    assert state.status is RunExecutionStatus.FAILED
    assert state.jobs[0].status is JobExecutionStatus.FAILED
    assert client.submitted_workflows == []


def test_job_succeeds_only_after_every_result_is_stored(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    first = RemoteOutputArtifact("41", "images", "one.png", "", "output")
    second = RemoteOutputArtifact("52", "images", "two.png", "", "output")
    client = FakeExecutionClient(
        submissions=[SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1")],
        histories={"prompt-1": [_outcome("prompt-1", ExecutionStatus.SUCCEEDED, first, second)]},
        downloads={
            first: (b"first", "image/png"),
            second: RuntimeError("download failed"),
        },
    )

    state = _run(run, client)

    assert state.status is RunExecutionStatus.FAILED
    assert state.jobs[0].status is JobExecutionStatus.FAILED
    assert len(state.jobs[0].results) == 1
    assert (run.path / "outputs" / "000001-01.png").read_bytes() == b"first"
    assert not (run.path / "outputs" / "000001-02.png").exists()


def test_result_is_removed_if_its_state_update_fails(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    artifact = RemoteOutputArtifact("41", "images", "one.png", "", "output")
    client = FakeExecutionClient(
        submissions=[SubmissionSpec(SubmissionDisposition.ACCEPTED, "prompt-1")],
        histories={"prompt-1": [_outcome("prompt-1", ExecutionStatus.SUCCEEDED, artifact)]},
        downloads={artifact: (b"result", "image/png")},
    )

    class FailResultStateOnce(ExecutionStateStore):
        failed = False

        def save(self, published_run: PublishedRun, state: RunExecutionState) -> None:
            if not self.failed and any(job.results for job in state.jobs):
                self.failed = True
                raise ExecutionStateError("simulated Result state failure")
            super().save(published_run, state)

    store = FailResultStateOnce(run.path)

    state = _run(run, client, state_store=store)

    assert state.status is RunExecutionStatus.FAILED
    assert state.jobs[0].results == ()
    assert not (run.path / "outputs" / "000001-01.png").exists()
    assert store.load(run) == state


def test_execution_state_round_trips_and_atomic_failure_preserves_previous_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    store = ExecutionStateStore(run.path)
    initial = store.initialize(run)
    state_bytes = store.state_path.read_bytes()
    running = replace(
        initial,
        status=RunExecutionStatus.RUNNING,
        started_at="2026-08-27T20:00:00Z",
    )

    def fail_after_partial_write(path: Path, _content: bytes) -> None:
        path.write_bytes(b"{")
        raise OSError("simulated state write failure")

    monkeypatch.setattr(state_module, "write_bytes", fail_after_partial_write)

    with pytest.raises(ExecutionStateError, match="simulated state write failure"):
        store.save(run, running)

    assert store.state_path.read_bytes() == state_bytes
    assert store.load(run) == initial
    assert not tuple(run.path.glob(".execution.json.*.tmp"))


def test_execution_v2_rejects_v1_and_cancelled_is_terminal(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    store = ExecutionStateStore(run.path)
    initial = store.initialize(run)
    cancelled = replace(
        initial,
        status=RunExecutionStatus.CANCELLED,
        completed_at="2026-08-31T12:30:00Z",
        diagnostics=("discarded_before_start",),
    )
    store.save(run, cancelled)

    assert store.load(run) == cancelled
    with pytest.raises(ExecutionStateError, match="terminal Run execution state"):
        store.save(run, replace(cancelled, completed_at="later"))

    data = json.loads(store.state_path.read_text())
    assert data["format_version"] == 2
    for invalid_version in (1, True, 2.0):
        data["format_version"] = invalid_version
        store.state_path.write_text(json.dumps(data))
        with pytest.raises(
            ExecutionStateError,
            match="format_version must be a positive integer|unsupported execution state format",
        ):
            store.load(run)


def test_blocked_and_unknown_states_allow_explicit_reconciliation(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    store = ExecutionStateStore(run.path)
    initial = store.initialize(run)
    running = replace(
        initial,
        status=RunExecutionStatus.RUNNING,
        started_at="2026-08-27T20:00:00Z",
    )
    store.save(run, running)
    preparing = replace(
        running,
        jobs=(
            replace(
                running.jobs[0],
                status=JobExecutionStatus.PREPARING,
                client_id="client-1",
                started_at="2026-08-27T20:00:00Z",
            ),
        ),
    )
    store.save(run, preparing)
    submitting = replace(
        preparing,
        jobs=(replace(preparing.jobs[0], status=JobExecutionStatus.SUBMITTING),),
    )
    store.save(run, submitting)
    blocked = replace(
        submitting,
        status=RunExecutionStatus.BLOCKED,
        jobs=(
            replace(
                submitting.jobs[0],
                status=JobExecutionStatus.SUBMISSION_UNKNOWN,
                submission_disposition=SubmissionDisposition.UNKNOWN,
                error="submission outcome unknown",
            ),
        ),
    )
    store.save(run, blocked)
    reconciled = replace(
        blocked,
        status=RunExecutionStatus.RUNNING,
        jobs=(
            replace(
                blocked.jobs[0],
                status=JobExecutionStatus.SUBMITTED,
                submission_disposition=SubmissionDisposition.ACCEPTED,
                prompt_id="prompt-1",
                error=None,
            ),
        ),
    )

    store.save(run, reconciled)

    assert store.load(run) == reconciled


def test_unknown_submission_can_be_reconciled_to_failed(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    store = ExecutionStateStore(run.path)
    initial = store.initialize(run)
    running = replace(initial, status=RunExecutionStatus.RUNNING, started_at="started")
    store.save(run, running)
    preparing = replace(
        running,
        jobs=(
            replace(
                running.jobs[0],
                status=JobExecutionStatus.PREPARING,
                client_id="client-1",
                started_at="started",
            ),
        ),
    )
    store.save(run, preparing)
    submitting = replace(
        preparing,
        jobs=(replace(preparing.jobs[0], status=JobExecutionStatus.SUBMITTING),),
    )
    store.save(run, submitting)
    blocked = replace(
        submitting,
        status=RunExecutionStatus.BLOCKED,
        jobs=(
            replace(
                submitting.jobs[0],
                status=JobExecutionStatus.SUBMISSION_UNKNOWN,
                submission_disposition=SubmissionDisposition.UNKNOWN,
            ),
        ),
    )
    store.save(run, blocked)
    failed = replace(
        blocked,
        status=RunExecutionStatus.FAILED,
        completed_at="completed",
        jobs=(
            replace(
                blocked.jobs[0],
                status=JobExecutionStatus.FAILED,
                submission_disposition=SubmissionDisposition.REJECTED,
                completed_at="completed",
                error="submission was not accepted",
            ),
        ),
    )

    store.save(run, failed)

    assert store.load(run) == failed
    with pytest.raises(ExecutionStateError, match="terminal Run execution state"):
        store.save(run, replace(failed, diagnostics=("rewrite",)))


def test_save_hashes_only_new_results_while_load_verifies_all_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    store = ExecutionStateStore(run.path)
    initial = store.initialize(run)
    content = b"result"
    result = store.persist_result(
        job_id="job-1",
        job_ordinal=1,
        artifact_ordinal=1,
        downloaded=DownloadedArtifact(
            remote=RemoteOutputArtifact("41", "images", "result.png", "", "output"),
            content=content,
            content_type="image/png",
            sha256=hashlib.sha256(content).hexdigest(),
        ),
    )
    hashed_paths: list[Path] = []
    real_sha256_file = state_module._sha256_file

    def counting_sha256_file(path: Path) -> str:
        hashed_paths.append(path)
        return real_sha256_file(path)

    monkeypatch.setattr(state_module, "_sha256_file", counting_sha256_file)
    running = replace(
        initial,
        status=RunExecutionStatus.RUNNING,
        started_at="started",
        jobs=(replace(initial.jobs[0], results=(result,)),),
    )
    store.save(run, running)
    store.save(run, replace(running, diagnostics=("metadata update",)))

    assert hashed_paths == [run.path / result.local_path]

    store.load(run)

    assert hashed_paths == [run.path / result.local_path, run.path / result.local_path]


def test_result_storage_rejects_symlinked_outputs_directory(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    outside = tmp_path / "outside"
    outside.mkdir()
    (run.path / "outputs").rmdir()
    (run.path / "outputs").symlink_to(outside, target_is_directory=True)
    artifact = RemoteOutputArtifact("41", "images", "result.png", "", "output")
    content = b"result"

    with pytest.raises(ExecutionStateError, match="real directory"):
        ExecutionStateStore(run.path).persist_result(
            job_id="job-1",
            job_ordinal=1,
            artifact_ordinal=1,
            downloaded=DownloadedArtifact(
                remote=artifact,
                content=content,
                content_type="image/png",
                sha256=hashlib.sha256(content).hexdigest(),
            ),
        )

    assert tuple(outside.iterdir()) == ()


def test_result_storage_never_replaces_different_existing_bytes(tmp_path: Path) -> None:
    run, _ = _published_run(tmp_path, job_count=1)
    store = ExecutionStateStore(run.path)
    artifact = RemoteOutputArtifact("41", "images", "result.png", "", "output")

    def downloaded(content: bytes) -> DownloadedArtifact:
        return DownloadedArtifact(
            remote=artifact,
            content=content,
            content_type="image/png",
            sha256=hashlib.sha256(content).hexdigest(),
        )

    first = store.persist_result(
        job_id="job-1",
        job_ordinal=1,
        artifact_ordinal=1,
        downloaded=downloaded(b"first"),
    )

    with pytest.raises(ExecutionStateError, match="different content"):
        store.persist_result(
            job_id="job-1",
            job_ordinal=1,
            artifact_ordinal=1,
            downloaded=downloaded(b"second"),
        )

    assert (run.path / first.local_path).read_bytes() == b"first"
