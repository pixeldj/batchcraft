import asyncio
import copy
import json
import mimetypes
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from batchcraft.comfyui import (
    ComfyUIClient,
    ExecutionStatus,
    SubmissionDisposition,
    WorkflowPreparationValues,
    prepare_workflow,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_IMAGE = REPO_ROOT / "example.png"
DEFAULT_WORKFLOW = REPO_ROOT / "spikes" / "comfyui-client" / "test-workflow.json"
WORKFLOW_PROFILE: dict[str, object] = {
    "id": "comfyui-live-verification",
    "name": "Known spike workflow",
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
        {"key": "reference", "label": "Reference", "node_id": "25", "input_name": "image"}
    ],
}


def _configured_path(environment_name: str, default: Path) -> Path:
    configured = os.environ.get(environment_name)
    return Path(configured).expanduser().resolve() if configured else default.resolve()


def _load_json_object(content: bytes, context: str) -> dict[str, object]:
    value: object = json.loads(content)
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise TypeError(f"{context} must contain a JSON object")
    return cast(dict[str, object], value)


async def verify() -> dict[str, object]:
    base_url = os.environ.get("COMFYUI_BASE_URL")
    if not base_url:
        raise RuntimeError("set COMFYUI_BASE_URL to opt into live verification")

    image_path = _configured_path("COMFYUI_LIVE_IMAGE", DEFAULT_IMAGE)
    workflow_path = _configured_path("COMFYUI_LIVE_WORKFLOW", DEFAULT_WORKFLOW)
    http_timeout = float(os.environ.get("COMFYUI_LIVE_HTTP_TIMEOUT", "30"))
    execution_timeout = float(os.environ.get("COMFYUI_LIVE_EXECUTION_TIMEOUT", "900"))
    if not image_path.is_file():
        raise FileNotFoundError(f"live verification image not found: {image_path}")
    if not workflow_path.is_file():
        raise FileNotFoundError(f"live verification workflow not found: {workflow_path}")

    workflow_bytes = workflow_path.read_bytes()
    base_workflow = _load_json_object(workflow_bytes, "live verification workflow")
    workflow_snapshot = copy.deepcopy(base_workflow)
    profile_snapshot = copy.deepcopy(WORKFLOW_PROFILE)
    verification_id = f"{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"
    client_id = str(uuid.uuid4())
    seed = 123456789

    async with ComfyUIClient(base_url, timeout=http_timeout) as client:
        server_info = await client.get_server_info()
        uploaded = await client.upload_input(
            filename=image_path.name,
            content=image_path.read_bytes(),
            mime_type=mimetypes.guess_type(image_path.name)[0] or "application/octet-stream",
            subfolder=f"batchcraft-live/{verification_id}",
        )
        prepared_workflow = prepare_workflow(
            base_workflow,
            WORKFLOW_PROFILE,
            WorkflowPreparationValues(
                prompt=(
                    "Turn the reference into a polished character illustration. "
                    f"[batchcraft production live verification {verification_id}]"
                ),
                image_inputs={"reference": uploaded.workflow_value},
                seed=seed,
                output_prefix=f"batchcraft-live/{verification_id}/result",
            ),
        )
        if base_workflow != workflow_snapshot or profile_snapshot != WORKFLOW_PROFILE:
            raise RuntimeError("workflow preparation mutated a source snapshot")

        event_types: list[str] = []
        async with client.open_event_stream(client_id) as event_stream:
            submission = await client.submit_prompt(prepared_workflow, client_id=client_id)
            if submission.disposition is SubmissionDisposition.UNKNOWN:
                raise RuntimeError(
                    "live prompt submission outcome is ambiguous; submission was not retried"
                )
            if submission.disposition is SubmissionDisposition.REJECTED:
                raise RuntimeError(f"live prompt submission was rejected: {submission.diagnostic}")
            if submission.prompt_id is None:
                raise RuntimeError("accepted live prompt submission has no prompt_id")
            prompt_id = submission.prompt_id

            async with asyncio.timeout(execution_timeout):
                async for event in event_stream.events(prompt_id):
                    event_types.append(event.event_type)
                    if event.is_terminal_advisory:
                        break

        history_deadline = asyncio.get_running_loop().time() + http_timeout
        outcome = await client.get_history(prompt_id)
        while outcome is None or outcome.status is ExecutionStatus.PENDING:
            if asyncio.get_running_loop().time() >= history_deadline:
                raise TimeoutError(f"history did not reach terminal state for {prompt_id}")
            await asyncio.sleep(0.5)
            outcome = await client.get_history(prompt_id)
        if outcome.status is not ExecutionStatus.SUCCEEDED:
            raise RuntimeError(f"live execution failed: {outcome.status_data}")
        if not outcome.artifacts:
            raise RuntimeError("successful live execution reported no output artifacts")

        downloads = [await client.download_artifact(artifact) for artifact in outcome.artifacts]

    if base_workflow != workflow_snapshot or profile_snapshot != WORKFLOW_PROFILE:
        raise RuntimeError("live verification mutated a source snapshot")
    if workflow_path.read_bytes() != workflow_bytes:
        raise RuntimeError("live verification changed the checked-in workflow fixture")

    system = server_info.data.get("system")
    return {
        "status": "succeeded",
        "verification_id": verification_id,
        "comfyui_version": system.get("comfyui_version") if isinstance(system, dict) else None,
        "prompt_id": prompt_id,
        "event_types": event_types,
        "artifact_count": len(outcome.artifacts),
        "downloads": [
            {
                "filename": download.remote.filename,
                "subfolder": download.remote.subfolder,
                "type": download.remote.remote_type,
                "size": len(download.content),
                "sha256": download.sha256,
            }
            for download in downloads
        ],
        "snapshots_unchanged": True,
    }


def main() -> None:
    print(json.dumps(asyncio.run(verify()), indent=2))


if __name__ == "__main__":
    main()
