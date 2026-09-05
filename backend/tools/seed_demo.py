"""Add one sample Saved Batch to the running development sandbox through its real API."""

from typing import Any

import httpx


def main() -> None:
    with httpx.Client(base_url="http://127.0.0.1:8001", timeout=30, trust_env=False) as client:
        status = client.get("/api/comfyui/status")
        status.raise_for_status()
        if "Fake ComfyUI - no GPU or network" not in status.text:
            raise RuntimeError("Refusing to seed an instance without the sandbox client")

        def post(path: str, data: dict[str, Any]) -> dict[str, Any]:
            response = client.post(path, json=data)
            response.raise_for_status()
            return dict(response.json())

        existing = client.get("/api/projects")
        existing.raise_for_status()
        if any(item["filesystem_key"] == "sandbox" for item in existing.json()["projects"]):
            raise RuntimeError("Sandbox Project already exists; nothing was changed")
        project = post("/api/projects", {"name": "Sandbox", "filesystem_key": "sandbox"})
        prompt = post(
            f"/api/projects/{project['id']}/prompts",
            {
                "name": "Landscape",
                "text": "A {{subject}} at sunset",
            },
        )["version"]
        workflow = post(
            f"/api/projects/{project['id']}/workflows",
            {
                "name": "Simulated landscape",
                "workflow": {
                    "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "Landscape"}},
                    "2": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20}},
                    "3": {"class_type": "SaveImage", "inputs": {"filename_prefix": "sandbox"}},
                },
            },
        )
        profile = post(
            f"/api/workflows/{workflow['workflow']['id']}/profiles",
            {
                "name": "Sandbox profile",
                "workflow_version_id": workflow["version"]["id"],
                "mappings": {
                    "prompt": {"node_id": "1", "input_name": "text", "value_type": "string"},
                    "seed": {"node_id": "2", "input_name": "seed", "value_type": "integer"},
                    "output_prefix": {
                        "node_id": "3",
                        "input_name": "filename_prefix",
                        "value_type": "string",
                    },
                },
                "image_inputs": [],
                "parameters": [
                    {
                        "key": "steps",
                        "label": "Steps",
                        "node_id": "2",
                        "input_name": "steps",
                        "value_type": "integer",
                    }
                ],
            },
        )
        post(
            f"/api/projects/{project['id']}/batches",
            {
                "name": "Landscape comparison",
                "filesystem_key": "landscape_comparison",
                "prompt_selections": [
                    {
                        "prompt_version_id": prompt["id"],
                        "name_snapshot": prompt["name_snapshot"],
                        "text": prompt["text"],
                    }
                ],
                "variable_bindings": [{"placeholder": "subject", "values": ["mountain", "river"]}],
                "parameter_bindings": [
                    {"parameter_key": "steps", "mode": "values", "values": [None, 30]}
                ],
                "seed_intent": {"mode": "fixed", "values": [42], "random_seed_count": None},
                "selected_workflow_version": {
                    key: workflow["version"][key] for key in ("id", "content_sha256", "workflow")
                },
                "selected_workflow_profile_id": profile["workflow_profile"]["id"],
                "selected_workflow_profile_version": {
                    key: profile["version"][key]
                    for key in (
                        "id",
                        "workflow_profile_id",
                        "workflow_version_id",
                        "content_sha256",
                        "profile",
                    )
                },
            },
        )
    print(
        "Select Project 'Sandbox' and Saved Batch 'Landscape comparison', then Preview and Start."
    )
    print("Only simulated generation is available here. No existing Project was replaced.")


if __name__ == "__main__":
    main()
