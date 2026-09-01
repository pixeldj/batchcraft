import asyncio
import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from batchcraft.comfyui import ComfyUIClient
from batchcraft.domain import CompiledJob, CompiledRunPlan, PromptVersion
from batchcraft.execution import ExecutionConfig, RunExecutionStatus, execute_run
from batchcraft.files import (
    BatchIdentity,
    ProjectAssetStore,
    ProjectIdentity,
    RunFilesystemStore,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_IMAGE = REPO_ROOT / "example.png"
DEFAULT_WORKFLOW = REPO_ROOT / "spikes" / "comfyui-client" / "test-workflow.json"
WORKFLOW_PROFILE: dict[str, object] = {
    "id": "execution-live-verification",
    "name": "Known spike workflow",
    "mappings": {
        "prompt": {"node_id": "34", "input_name": "prompt", "value_type": "string"},
        "reference_image": {
            "node_id": "25",
            "input_name": "image",
            "value_type": "image",
        },
        "seed": {"node_id": "7", "input_name": "seed", "value_type": "integer"},
        "output_prefix": {
            "node_id": "41",
            "input_name": "filename_prefix",
            "value_type": "string",
        },
    },
}


def _configured_path(environment_name: str, default: Path) -> Path:
    configured = os.environ.get(environment_name)
    return Path(configured).expanduser().resolve() if configured else default.resolve()


def _load_json_object(path: Path) -> dict[str, object]:
    value: object = json.loads(path.read_bytes())
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise TypeError(f"workflow must contain a JSON object: {path}")
    return cast(dict[str, object], value)


async def verify() -> dict[str, object]:
    base_url = os.environ.get("COMFYUI_BASE_URL")
    if not base_url:
        raise RuntimeError("set COMFYUI_BASE_URL to opt into live execution verification")
    image_path = _configured_path("COMFYUI_LIVE_IMAGE", DEFAULT_IMAGE)
    workflow_path = _configured_path("COMFYUI_LIVE_WORKFLOW", DEFAULT_WORKFLOW)
    output_root = _configured_path(
        "BATCHCRAFT_LIVE_OUTPUT_ROOT", REPO_ROOT / "outputs" / "comfyui-execution"
    )
    http_timeout = float(os.environ.get("COMFYUI_LIVE_HTTP_TIMEOUT", "30"))
    execution_timeout = float(os.environ.get("COMFYUI_LIVE_EXECUTION_TIMEOUT", "900"))
    if not image_path.is_file() or not workflow_path.is_file():
        raise FileNotFoundError("live verification requires the configured image and workflow")
    workflow = _load_json_object(workflow_path)

    verification_id = f"{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"
    projects_path = output_root / verification_id / "projects"
    project = ProjectIdentity(
        id=str(uuid.uuid4()),
        filesystem_key="live_project",
        name="Live execution verification",
    )
    batch = BatchIdentity(
        id=str(uuid.uuid4()),
        filesystem_key="live_batch",
        name="Two sequential Jobs",
    )
    asset = ProjectAssetStore(projects_path / project.filesystem_key).import_file(image_path)
    plan = CompiledRunPlan(
        prompt_versions=(
            PromptVersion(
                id="live-prompt-version",
                name="Live verification prompt",
                text="live verification prompt",
            ),
        ),
        jobs=tuple(
            CompiledJob(
                ordinal=ordinal,
                prompt_version_id="live-prompt-version",
                resolved_prompt=(
                    "Turn the reference into a polished character illustration. "
                    f"[batchcraft sequential live verification {verification_id} Job {ordinal}]"
                ),
                resolved_variables=(),
                reference_asset_id=asset.asset_id,
                seed=123456788 + ordinal,
            )
            for ordinal in (1, 2)
        ),
        warnings=(),
    )
    run = RunFilesystemStore(projects_path).create_run(
        project=project,
        batch=batch,
        batch_snapshot={
            "snapshot_version": 2,
            "project": {
                "id": project.id,
                "filesystem_key": project.filesystem_key,
                "name": project.name,
            },
            "source_saved_batch": None,
            "batch": {
                "id": batch.id,
                "filesystem_key": batch.filesystem_key,
                "name": batch.name,
                "description": None,
            },
            "prompt_versions": [
                {
                    "id": "live-prompt-version",
                    "prompt_id": None,
                    "version_number": None,
                    "name": "Live verification prompt",
                    "text": "live verification prompt",
                }
            ],
            "variable_bindings": [],
            "references": [{"asset_id": asset.asset_id}],
            "seed_intent": {
                "mode": "explicit",
                "values": [123456789, 123456790],
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
                "workflow": workflow,
                "workflow_profile": WORKFLOW_PROFILE,
            },
        },
        plan=plan,
        reference_assets={asset.asset_id: asset},
        workflow=workflow,
        workflow_profile=WORKFLOW_PROFILE,
    )
    immutable = {
        name: (run.path / name).read_bytes()
        for name in (
            "run.json",
            "manifest.json",
            "manifest.csv",
            "workflow.json",
            "workflow-profile.json",
        )
    }

    async with ComfyUIClient(base_url, timeout=http_timeout) as client:
        server_info = await client.get_server_info()
        state = await execute_run(
            run=run,
            client=client,
            config=ExecutionConfig(
                websocket_timeout_seconds=execution_timeout,
                history_timeout_seconds=execution_timeout,
                history_poll_interval_seconds=0.5,
            ),
        )

    if state.status is not RunExecutionStatus.SUCCEEDED:
        raise RuntimeError(f"live execution did not succeed: {state}")
    prompt_ids = tuple(job.prompt_id for job in state.jobs)
    if len(set(prompt_ids)) != 2 or None in prompt_ids:
        raise RuntimeError("live Jobs did not receive distinct prompt IDs")
    if state.jobs[0].completed_at is None or state.jobs[1].started_at is None:
        raise RuntimeError("live Job timestamps are incomplete")
    if state.jobs[1].started_at < state.jobs[0].completed_at:
        raise RuntimeError("Job 2 started before Job 1 completed")
    if any(not job.results for job in state.jobs):
        raise RuntimeError("each live Job must ingest at least one Result")
    if any((run.path / name).read_bytes() != content for name, content in immutable.items()):
        raise RuntimeError("live execution changed immutable Run provenance")

    system = server_info.data.get("system")
    return {
        "status": state.status.value,
        "comfyui_version": system.get("comfyui_version") if isinstance(system, dict) else None,
        "run_path": str(run.path),
        "execution_state": str(run.path / "execution.json"),
        "prompt_ids": prompt_ids,
        "results": [
            {
                "job_ordinal": result.job_ordinal,
                "artifact_ordinal": result.artifact_ordinal,
                "local_path": result.local_path,
                "byte_size": result.byte_size,
                "sha256": result.sha256,
            }
            for job in state.jobs
            for result in job.results
        ],
        "provenance_unchanged": True,
    }


def main() -> None:
    print(json.dumps(asyncio.run(verify()), indent=2))


if __name__ == "__main__":
    main()
