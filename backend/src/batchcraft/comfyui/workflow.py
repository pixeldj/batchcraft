import copy
from collections.abc import Mapping
from typing import cast

from batchcraft.comfyui.errors import WorkflowPreparationError
from batchcraft.comfyui.models import WorkflowPreparationValues

_FRIENDLY_VALUES = ("prompt", "reference_image", "seed", "output_prefix")
_EXPECTED_VALUE_TYPES = {
    "prompt": "string",
    "reference_image": "image",
    "seed": "integer",
    "output_prefix": "string",
}


def prepare_workflow(
    base_workflow: Mapping[str, object],
    workflow_profile: Mapping[str, object],
    values: WorkflowPreparationValues,
) -> dict[str, object]:
    if "{{" in values.prompt or "}}" in values.prompt:
        raise WorkflowPreparationError("resolved prompt contains an unresolved placeholder")
    if values.reference_image == "":
        raise WorkflowPreparationError("uploaded reference image value must not be empty")
    if not isinstance(values.seed, int) or isinstance(values.seed, bool):
        raise WorkflowPreparationError("seed must be an integer")
    if not values.output_prefix:
        raise WorkflowPreparationError("output prefix must not be empty")

    validate_workflow(base_workflow)
    validate_workflow_profile(base_workflow, workflow_profile)
    workflow = copy.deepcopy(dict(base_workflow))
    profile = copy.deepcopy(dict(workflow_profile))
    mappings = _required_object(profile, "mappings", "Workflow Profile")
    friendly_values: dict[str, str | int | None] = {
        "prompt": values.prompt,
        "reference_image": values.reference_image,
        "seed": values.seed,
        "output_prefix": values.output_prefix,
    }
    for friendly_name in _FRIENDLY_VALUES:
        mapping = _required_object(mappings, friendly_name, "Workflow Profile mappings")
        node_id = _required_string(mapping, "node_id", friendly_name)
        input_name = _required_string(mapping, "input_name", friendly_name)
        node_object = cast(dict[str, object], workflow[node_id])
        input_object = cast(dict[str, object], node_object["inputs"])
        value = friendly_values[friendly_name]
        if friendly_name != "reference_image" or value is not None:
            input_object[input_name] = value

    return workflow


def validate_workflow(workflow: Mapping[str, object]) -> None:
    if not isinstance(workflow, dict) or not workflow:
        raise WorkflowPreparationError("workflow must be a non-empty API-format object")
    for node_id, node in workflow.items():
        if not isinstance(node_id, str) or not node_id:
            raise WorkflowPreparationError("workflow node IDs must be non-empty strings")
        if not isinstance(node, dict) or not all(isinstance(key, str) for key in node):
            raise WorkflowPreparationError(f"workflow node {node_id!r} must be an object")
        node_object = cast(dict[str, object], node)
        if not isinstance(node_object.get("class_type"), str) or not node_object["class_type"]:
            raise WorkflowPreparationError(
                f"workflow node {node_id!r} must define non-empty 'class_type'"
            )
        inputs = node_object.get("inputs")
        if not isinstance(inputs, dict) or not all(isinstance(key, str) for key in inputs):
            raise WorkflowPreparationError(
                f"workflow node {node_id!r} must define an 'inputs' object"
            )


def validate_workflow_profile(
    workflow: Mapping[str, object], workflow_profile: Mapping[str, object]
) -> None:
    validate_workflow(workflow)
    mappings = _required_object(workflow_profile, "mappings", "Workflow Profile")
    if set(mappings) != set(_FRIENDLY_VALUES):
        required = ", ".join(repr(value) for value in _FRIENDLY_VALUES)
        raise WorkflowPreparationError(
            f"Workflow Profile mappings must contain exactly: {required}"
        )
    used_targets: set[tuple[str, str]] = set()
    for friendly_name in _FRIENDLY_VALUES:
        mapping = _required_object(mappings, friendly_name, "Workflow Profile mappings")
        if set(mapping) != {"node_id", "input_name", "value_type"}:
            raise WorkflowPreparationError(
                f"Workflow Profile mapping {friendly_name!r} must contain exactly "
                "'node_id', 'input_name', and 'value_type'"
            )
        node_id = _required_string(mapping, "node_id", friendly_name)
        input_name = _required_string(mapping, "input_name", friendly_name)
        value_type = mapping.get("value_type")
        if value_type != _EXPECTED_VALUE_TYPES[friendly_name]:
            raise WorkflowPreparationError(
                f"Workflow Profile mapping {friendly_name!r} needs value_type "
                f"{_EXPECTED_VALUE_TYPES[friendly_name]!r}, got {value_type!r}"
            )
        target = (node_id, input_name)
        if target in used_targets:
            raise WorkflowPreparationError(
                f"Workflow Profile maps multiple friendly inputs to node {node_id!r} "
                f"input {input_name!r}"
            )
        used_targets.add(target)
        node = workflow.get(node_id)
        if not isinstance(node, dict) or not all(isinstance(key, str) for key in node):
            raise WorkflowPreparationError(
                f"Workflow Profile mapping {friendly_name!r} references missing node {node_id!r}"
            )
        inputs = cast(dict[str, object], node).get("inputs")
        if not isinstance(inputs, dict) or not all(isinstance(key, str) for key in inputs):
            raise WorkflowPreparationError(
                f"workflow node {node_id!r} has no valid inputs object for {friendly_name!r}"
            )
        if input_name not in inputs:
            raise WorkflowPreparationError(
                f"Workflow Profile mapping {friendly_name!r} references missing input "
                f"{input_name!r} on node {node_id!r}"
            )


def _required_object(data: Mapping[str, object], name: str, context: str) -> dict[str, object]:
    value = data.get(name)
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise WorkflowPreparationError(f"{context} must define a {name!r} object")
    return cast(dict[str, object], value)


def _required_string(data: Mapping[str, object], name: str, friendly_name: str) -> str:
    value = data.get(name)
    if not isinstance(value, str) or not value:
        raise WorkflowPreparationError(
            f"Workflow Profile mapping {friendly_name!r} must define non-empty {name!r}"
        )
    return value
