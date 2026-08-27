import argparse
import copy
import hashlib
import json
import mimetypes
import os
import sys
import time
import traceback
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from websockets.sync.client import connect

SPIKE_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = SPIKE_ROOT.parents[1]


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Submit the known batchcraft workflow to a remote ComfyUI host."
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("COMFYUI_BASE_URL"),
        help="ComfyUI HTTP base URL. Defaults to COMFYUI_BASE_URL.",
    )
    parser.add_argument(
        "--image",
        type=Path,
        default=REPO_ROOT / "example.png",
        help="Local reference image to upload.",
    )
    parser.add_argument(
        "--workflow",
        type=Path,
        default=SPIKE_ROOT / "test-workflow.json",
        help="API-format workflow fixture.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=REPO_ROOT / "outputs" / "comfyui-spike",
        help="Parent directory for per-run diagnostics.",
    )
    parser.add_argument(
        "--prompt",
        default="Turn the reference into a polished character illustration.",
        help="Positive prompt written to node 34.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=123456789,
        help="Seed written to node 7.",
    )
    parser.add_argument(
        "--http-timeout",
        type=float,
        default=30.0,
        help="Timeout in seconds for each HTTP request.",
    )
    parser.add_argument(
        "--execution-timeout",
        type=float,
        default=900.0,
        help="Maximum seconds to wait for terminal WebSocket state.",
    )
    args = parser.parse_args()
    if not args.base_url:
        parser.error("set COMFYUI_BASE_URL or pass --base-url")
    return args


def run(args: argparse.Namespace) -> Path:
    image_path = args.image.expanduser().resolve()
    workflow_path = args.workflow.expanduser().resolve()
    base_url = args.base_url.rstrip("/")
    run_id = f"{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"
    run_dir = args.output_root.expanduser().resolve() / run_id
    images_dir = run_dir / "images"
    images_dir.mkdir(parents=True)

    diagnostics: dict[str, Any] = {
        "run_id": run_id,
        "started_at": utc_now(),
        "status": "running",
        "base_url": base_url,
        "workflow_fixture": str(workflow_path),
        "reference_image": {"path": str(image_path)},
        "seed": args.seed,
    }

    try:
        if not image_path.is_file():
            raise FileNotFoundError(f"reference image not found: {image_path}")
        if not workflow_path.is_file():
            raise FileNotFoundError(f"workflow fixture not found: {workflow_path}")
        diagnostics["reference_image"].update(
            {
                "size": image_path.stat().st_size,
                "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest(),
            }
        )

        workflow_fixture = json.loads(workflow_path.read_text())
        if not isinstance(workflow_fixture, dict):
            raise TypeError("workflow fixture must contain a JSON object")
        workflow = copy.deepcopy(workflow_fixture)

        with httpx.Client(
            base_url=base_url,
            timeout=args.http_timeout,
            trust_env=False,
        ) as client:
            system_response = client.get("/system_stats")
            system_response.raise_for_status()
            system_stats = system_response.json()
            diagnostics["system_stats"] = system_stats

            system = system_stats.get("system", {})
            devices = system_stats.get("devices", [])
            device_names = ", ".join(
                str(device.get("name", "unknown")) for device in devices
            )
            print(
                f"Connected to {base_url}: ComfyUI "
                f"{system.get('comfyui_version', 'unknown')} on "
                f"{system.get('os', 'unknown')} ({device_names or 'no device reported'})"
            )

            upload_subfolder = f"batchcraft-spike/{run_id}"
            mime_type = (
                mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
            )
            with image_path.open("rb") as image_file:
                upload_response = client.post(
                    "/upload/image",
                    data={
                        "type": "input",
                        "subfolder": upload_subfolder,
                        "overwrite": "false",
                    },
                    files={"image": (image_path.name, image_file, mime_type)},
                )
            upload_response.raise_for_status()
            upload = upload_response.json()
            remote_name = upload["name"]
            remote_subfolder = (
                str(upload.get("subfolder", "")).replace("\\", "/").strip("/")
            )
            remote_image = (
                f"{remote_subfolder}/{remote_name}" if remote_subfolder else remote_name
            )
            diagnostics["upload"] = {
                "response": upload,
                "workflow_value": remote_image,
            }
            print(f"Uploaded {image_path.name} as {remote_image}")

            resolved_prompt = f"{args.prompt} [batchcraft spike {run_id}]"
            output_prefix = f"batchcraft-spike/{run_id}/result"
            try:
                workflow["34"]["inputs"]["prompt"] = resolved_prompt
                workflow["25"]["inputs"]["image"] = remote_image
                workflow["7"]["inputs"]["seed"] = args.seed
                workflow["41"]["inputs"]["filename_prefix"] = output_prefix
            except KeyError as error:
                raise ValueError(
                    f"workflow fixture is missing expected mutation field: {error}"
                ) from error

            diagnostics["mutations"] = {
                "prompt": {
                    "node_id": "34",
                    "input": "prompt",
                    "value": resolved_prompt,
                },
                "reference_image": {
                    "node_id": "25",
                    "input": "image",
                    "value": remote_image,
                },
                "seed": {"node_id": "7", "input": "seed", "value": args.seed},
                "filename_prefix": {
                    "node_id": "41",
                    "input": "filename_prefix",
                    "value": output_prefix,
                },
            }
            write_json(run_dir / "submitted-workflow.json", workflow)

            client_id = str(uuid.uuid4())
            parsed_url = urlsplit(base_url)
            websocket_url = urlunsplit(
                (
                    "wss" if parsed_url.scheme == "https" else "ws",
                    parsed_url.netloc,
                    f"{parsed_url.path.rstrip('/')}/ws",
                    urlencode({"clientId": client_id}),
                    "",
                )
            )
            diagnostics["client_id"] = client_id
            diagnostics["websocket_url"] = websocket_url

            events_path = run_dir / "events.jsonl"
            associated_event_types: list[str] = []
            terminal_event: str | None = None
            prompt_id: str | None = None

            with (
                events_path.open("w") as events_file,
                connect(
                    websocket_url,
                    open_timeout=args.http_timeout,
                    close_timeout=5,
                    max_size=None,
                    proxy=None,
                ) as websocket,
            ):
                try:
                    prompt_response = client.post(
                        "/prompt",
                        json={"prompt": workflow, "client_id": client_id},
                    )
                except httpx.RequestError as error:
                    diagnostics["submission"] = {
                        "outcome": "ambiguous",
                        "error": str(error),
                    }
                    raise RuntimeError(
                        "prompt submission outcome is ambiguous; the spike will not retry"
                    ) from error

                try:
                    prompt_body = prompt_response.json()
                except json.JSONDecodeError as error:
                    diagnostics["submission"] = {
                        "outcome": "ambiguous",
                        "http_status": prompt_response.status_code,
                        "body": prompt_response.text,
                    }
                    raise RuntimeError(
                        "prompt submission returned invalid JSON; the spike will not retry"
                    ) from error

                if prompt_response.is_success:
                    submission_outcome = "accepted"
                elif 400 <= prompt_response.status_code < 500:
                    submission_outcome = "rejected"
                else:
                    submission_outcome = "ambiguous"
                diagnostics["submission"] = {
                    "outcome": submission_outcome,
                    "http_status": prompt_response.status_code,
                    "response": prompt_body,
                }
                if submission_outcome == "ambiguous":
                    raise RuntimeError(
                        "prompt submission returned an ambiguous HTTP status; "
                        "the spike will not retry"
                    )
                prompt_response.raise_for_status()
                if not isinstance(prompt_body, dict):
                    diagnostics["submission"]["outcome"] = "ambiguous"
                    raise TypeError(
                        "prompt submission returned an unexpected JSON value; "
                        "the spike will not retry"
                    )
                prompt_id = prompt_body.get("prompt_id")
                if not prompt_id:
                    diagnostics["submission"]["outcome"] = "ambiguous"
                    raise RuntimeError(
                        "prompt submission returned no prompt_id; the spike will not retry"
                    )
                diagnostics["prompt_id"] = prompt_id
                print(f"Submitted prompt {prompt_id}")

                deadline = time.monotonic() + args.execution_timeout
                while time.monotonic() < deadline:
                    try:
                        message = websocket.recv(
                            timeout=min(5.0, max(0.1, deadline - time.monotonic()))
                        )
                    except TimeoutError:
                        continue
                    received_at = utc_now()
                    if isinstance(message, bytes):
                        event_record: dict[str, Any] = {
                            "received_at": received_at,
                            "binary_bytes": len(message),
                        }
                        events_file.write(json.dumps(event_record) + "\n")
                        events_file.flush()
                        continue

                    try:
                        event = json.loads(message)
                        event_record = {"received_at": received_at, "event": event}
                    except json.JSONDecodeError:
                        event_record = {"received_at": received_at, "text": message}
                        events_file.write(json.dumps(event_record) + "\n")
                        events_file.flush()
                        continue

                    events_file.write(json.dumps(event_record) + "\n")
                    events_file.flush()

                    event_type = event.get("type")
                    event_data = event.get("data", {})
                    if event_data.get("prompt_id") != prompt_id:
                        continue
                    associated_event_types.append(str(event_type))
                    print(f"WebSocket event for {prompt_id}: {event_type}")

                    if event_type in {
                        "execution_success",
                        "execution_error",
                        "execution_interrupted",
                    }:
                        terminal_event = str(event_type)
                        break
                    if event_type == "executing" and event_data.get("node") is None:
                        terminal_event = "executing_complete"
                        break

            if terminal_event is None:
                raise TimeoutError(
                    f"no terminal WebSocket event observed within {args.execution_timeout} seconds"
                )
            diagnostics["websocket"] = {
                "associated_event_types": associated_event_types,
                "terminal_event": terminal_event,
            }

            history_payload: dict[str, Any] | None = None
            history_entry: dict[str, Any] | None = None
            history_deadline = time.monotonic() + args.http_timeout
            while time.monotonic() < history_deadline:
                history_response = client.get(f"/history/{prompt_id}")
                history_response.raise_for_status()
                history_payload = history_response.json()
                history_entry = history_payload.get(prompt_id)
                if history_entry is not None:
                    break
                time.sleep(0.5)

            if history_payload is None or history_entry is None:
                raise TimeoutError(f"history did not contain prompt {prompt_id}")
            write_json(run_dir / "history.json", history_payload)

            history_status = history_entry.get("status", {})
            diagnostics["history_status"] = history_status
            if (
                not history_status.get("completed")
                or history_status.get("status_str") != "success"
            ):
                raise RuntimeError(
                    f"ComfyUI history did not report success: {history_status}"
                )
            print(f"History confirmed success for {prompt_id}")

            artifacts: list[dict[str, Any]] = []
            seen_remote_files: set[tuple[str, str, str]] = set()
            for node_id, node_output in history_entry.get("outputs", {}).items():
                if not isinstance(node_output, dict):
                    continue
                for output_name, output_value in node_output.items():
                    values = (
                        output_value
                        if isinstance(output_value, list)
                        else [output_value]
                    )
                    for value in values:
                        if not isinstance(value, dict) or "filename" not in value:
                            continue
                        filename = str(value["filename"])
                        subfolder = str(value.get("subfolder", ""))
                        remote_type = str(value.get("type", "output"))
                        remote_key = (filename, subfolder, remote_type)
                        if remote_key in seen_remote_files:
                            continue
                        seen_remote_files.add(remote_key)

                        artifact_response = client.get(
                            "/view",
                            params={
                                "filename": filename,
                                "subfolder": subfolder,
                                "type": remote_type,
                            },
                        )
                        artifact_response.raise_for_status()
                        artifact_ordinal = len(artifacts) + 1
                        suffix = Path(filename).suffix or ".bin"
                        local_name = f"000001-{artifact_ordinal:02d}{suffix}"
                        local_path = images_dir / local_name
                        local_path.write_bytes(artifact_response.content)
                        artifact = {
                            "artifact_ordinal": artifact_ordinal,
                            "producing_node_id": str(node_id),
                            "output_name": str(output_name),
                            "remote": {
                                "filename": filename,
                                "subfolder": subfolder,
                                "type": remote_type,
                            },
                            "local_path": str(local_path),
                            "content_type": artifact_response.headers.get(
                                "content-type"
                            ),
                            "size": len(artifact_response.content),
                            "sha256": hashlib.sha256(
                                artifact_response.content
                            ).hexdigest(),
                        }
                        artifacts.append(artifact)
                        print(f"Downloaded {filename} to {local_path}")

            if not artifacts:
                raise RuntimeError(
                    f"history for prompt {prompt_id} reported no output artifacts"
                )
            diagnostics["artifacts"] = artifacts

        diagnostics["status"] = "succeeded"
        diagnostics["completed_at"] = utc_now()
        write_json(run_dir / "diagnostics.json", diagnostics)
        return run_dir
    except BaseException as error:
        diagnostics["status"] = "failed"
        diagnostics["completed_at"] = utc_now()
        diagnostics["error"] = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
        }
        write_json(run_dir / "diagnostics.json", diagnostics)
        raise


def main() -> None:
    args = parse_args()
    try:
        run_dir = run(args)
    except BaseException as error:
        print(f"Spike failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(f"Spike succeeded. Diagnostics: {run_dir}")
