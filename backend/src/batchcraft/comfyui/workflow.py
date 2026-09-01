import copy
import math
from collections.abc import Mapping
from typing import cast

from batchcraft.comfyui.errors import WorkflowPreparationError
from batchcraft.comfyui.models import WorkflowPreparationValues
from batchcraft.domain import (
    ParameterScalar,
    ParameterValueType,
    WorkflowParameter,
    validate_parameter_scalar,
)
from batchcraft.domain.image_slots import validate_image_input_slot_key, validate_stable_key

_REQUIRED_FRIENDLY_VALUES = ("prompt", "seed", "output_prefix")
_FRIENDLY_VALUES = _REQUIRED_FRIENDLY_VALUES
_EXPECTED_VALUE_TYPES = {
    "prompt": "string",
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
    for key, value in values.image_inputs.items():
        try:
            validate_image_input_slot_key(key)
        except ValueError as error:
            raise WorkflowPreparationError(str(error)) from error
        if not isinstance(value, str) or not value:
            raise WorkflowPreparationError("uploaded image input values must not be empty")
    if not isinstance(values.seed, int) or isinstance(values.seed, bool):
        raise WorkflowPreparationError("seed must be an integer")
    if not values.output_prefix:
        raise WorkflowPreparationError("output prefix must not be empty")

    validate_workflow(base_workflow)
    validate_workflow_profile(base_workflow, workflow_profile)
    workflow = copy.deepcopy(dict(base_workflow))
    profile = copy.deepcopy(dict(workflow_profile))
    mappings = _required_object(profile, "mappings", "Workflow Profile")
    image_inputs = workflow_profile_image_inputs(profile)
    parameters = workflow_profile_parameters(profile)
    known_slot_keys = {slot[0] for slot in image_inputs}
    unknown_runtime_keys = set(values.image_inputs) - known_slot_keys
    if unknown_runtime_keys:
        names = ", ".join(repr(key) for key in sorted(unknown_runtime_keys))
        raise WorkflowPreparationError(f"uploaded image inputs contain unknown slot keys: {names}")
    parameters_by_key = {parameter.key: parameter for parameter in parameters}
    unknown_parameter_keys = set(values.parameters) - set(parameters_by_key)
    if unknown_parameter_keys:
        names = ", ".join(repr(key) for key in sorted(unknown_parameter_keys))
        raise WorkflowPreparationError(f"parameter overrides contain unknown keys: {names}")
    for parameter_key, parameter_value in values.parameters.items():
        _validate_scalar_value(
            parameter_key, parameters_by_key[parameter_key].value_type, parameter_value
        )
    friendly_values: dict[str, str | int] = {
        "prompt": values.prompt,
        "seed": values.seed,
        "output_prefix": values.output_prefix,
    }
    for friendly_name in mappings:
        mapping = _required_object(mappings, friendly_name, "Workflow Profile mappings")
        node_id = _required_string(mapping, "node_id", friendly_name)
        input_name = _required_string(mapping, "input_name", friendly_name)
        node_object = cast(dict[str, object], workflow[node_id])
        input_object = cast(dict[str, object], node_object["inputs"])
        friendly_value = friendly_values[friendly_name]
        input_object[input_name] = friendly_value
    for slot_key, _label, node_id, input_name in image_inputs:
        image_value = values.image_inputs.get(slot_key)
        if image_value is not None:
            node_object = cast(dict[str, object], workflow[node_id])
            cast(dict[str, object], node_object["inputs"])[input_name] = image_value
    for parameter in parameters:
        if parameter.key in values.parameters:
            node_object = cast(dict[str, object], workflow[parameter.node_id])
            cast(dict[str, object], node_object["inputs"])[parameter.input_name] = (
                values.parameters[parameter.key]
            )

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
    unknown = set(mappings) - set(_FRIENDLY_VALUES)
    if unknown:
        names = ", ".join(repr(value) for value in sorted(unknown))
        raise WorkflowPreparationError(
            f"Workflow Profile mappings contain unsupported mapping names: {names}"
        )
    missing = set(_REQUIRED_FRIENDLY_VALUES) - set(mappings)
    if missing:
        required = ", ".join(repr(value) for value in _REQUIRED_FRIENDLY_VALUES)
        raise WorkflowPreparationError(
            f"Workflow Profile mappings must contain required mappings: {required}"
        )
    used_targets: set[tuple[str, str]] = set()
    for friendly_name in mappings:
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
        if _is_connection_value(inputs[input_name]):
            raise WorkflowPreparationError(
                f"Workflow Profile mapping {friendly_name!r} targets connected input "
                f"{input_name!r} on node {node_id!r}; mappings must target literal input values"
            )
    for slot_key, _label, node_id, input_name in workflow_profile_image_inputs(workflow_profile):
        target = (node_id, input_name)
        if target in used_targets:
            raise WorkflowPreparationError(
                f"Workflow Profile maps multiple inputs to node {node_id!r} input {input_name!r}"
            )
        used_targets.add(target)
        node = workflow.get(node_id)
        if not isinstance(node, dict):
            raise WorkflowPreparationError(
                f"Workflow Profile image input {slot_key!r} references missing node {node_id!r}"
            )
        inputs = node.get("inputs")
        if not isinstance(inputs, dict) or input_name not in inputs:
            raise WorkflowPreparationError(
                f"Workflow Profile image input {slot_key!r} references missing input "
                f"{input_name!r} on node {node_id!r}"
            )
        if _is_connection_value(inputs[input_name]):
            raise WorkflowPreparationError(
                f"Workflow Profile image input {slot_key!r} targets connected input"
            )
    for parameter in workflow_profile_parameters(workflow_profile):
        target = (parameter.node_id, parameter.input_name)
        if target in used_targets:
            raise WorkflowPreparationError(
                f"Workflow Profile maps multiple inputs to node {parameter.node_id!r} "
                f"input {parameter.input_name!r}"
            )
        used_targets.add(target)
        node = workflow.get(parameter.node_id)
        if not isinstance(node, dict):
            raise WorkflowPreparationError(
                f"Workflow Profile parameter {parameter.key!r} references missing node "
                f"{parameter.node_id!r}"
            )
        inputs = node.get("inputs")
        if not isinstance(inputs, dict) or parameter.input_name not in inputs:
            raise WorkflowPreparationError(
                f"Workflow Profile parameter {parameter.key!r} references missing input "
                f"{parameter.input_name!r} on node {parameter.node_id!r}"
            )
        base_value = inputs[parameter.input_name]
        if _is_connection_value(base_value):
            raise WorkflowPreparationError(
                f"Workflow Profile parameter {parameter.key!r} targets connected input"
            )
        _validate_scalar_value(
            parameter.key, parameter.value_type, base_value, context="base value"
        )


def workflow_profile_image_inputs(
    profile: Mapping[str, object],
) -> tuple[tuple[str, str, str, str], ...]:
    raw = profile.get("image_inputs")
    if not isinstance(raw, list):
        raise WorkflowPreparationError("Workflow Profile must define an 'image_inputs' array")
    slots: list[tuple[str, str, str, str]] = []
    keys: set[str] = set()
    for value in raw:
        if not isinstance(value, dict) or set(value) != {"key", "label", "node_id", "input_name"}:
            raise WorkflowPreparationError(
                "Workflow Profile image inputs must contain exactly key, label, node_id, and input_name"
            )
        try:
            key = validate_image_input_slot_key(value.get("key"))
        except ValueError as error:
            raise WorkflowPreparationError(str(error)) from error
        if key in keys:
            raise WorkflowPreparationError(f"duplicate Workflow Profile image input key: {key!r}")
        keys.add(key)
        label = value.get("label")
        node_id = value.get("node_id")
        input_name = value.get("input_name")
        if not isinstance(label, str) or not label.strip():
            raise WorkflowPreparationError(f"Workflow Profile image input {key!r} needs a label")
        if (
            not isinstance(node_id, str)
            or not node_id
            or not isinstance(input_name, str)
            or not input_name
        ):
            raise WorkflowPreparationError(
                f"Workflow Profile image input {key!r} has an invalid target"
            )
        slots.append((key, label, node_id, input_name))
    return tuple(slots)


def workflow_profile_parameters(
    profile: Mapping[str, object],
) -> tuple[WorkflowParameter, ...]:
    raw = profile.get("parameters")
    if not isinstance(raw, list):
        raise WorkflowPreparationError("Workflow Profile must define a 'parameters' array")
    parameters: list[WorkflowParameter] = []
    keys: set[str] = set()
    for value in raw:
        if not isinstance(value, dict) or set(value) != {
            "key",
            "label",
            "node_id",
            "input_name",
            "value_type",
        }:
            raise WorkflowPreparationError(
                "Workflow Profile parameters must contain exactly key, label, node_id, "
                "input_name, and value_type"
            )
        try:
            key = validate_stable_key(value.get("key"))
        except ValueError as error:
            raise WorkflowPreparationError(f"workflow parameter {error}") from error
        if key in keys:
            raise WorkflowPreparationError(f"duplicate Workflow Profile parameter key: {key!r}")
        keys.add(key)
        label = value.get("label")
        node_id = value.get("node_id")
        input_name = value.get("input_name")
        try:
            raw_value_type = value.get("value_type")
            if not isinstance(raw_value_type, str):
                raise ValueError
            value_type = ParameterValueType(raw_value_type)
        except (TypeError, ValueError) as error:
            raise WorkflowPreparationError(
                f"Workflow Profile parameter {key!r} has unsupported value_type"
            ) from error
        if not isinstance(label, str) or not label.strip():
            raise WorkflowPreparationError(f"Workflow Profile parameter {key!r} needs a label")
        if (
            not isinstance(node_id, str)
            or not node_id
            or not isinstance(input_name, str)
            or not input_name
        ):
            raise WorkflowPreparationError(
                f"Workflow Profile parameter {key!r} has an invalid target"
            )
        parameters.append(WorkflowParameter(key, label, node_id, input_name, value_type))
    return tuple(parameters)


def _validate_scalar_value(
    key: str,
    value_type: ParameterValueType,
    value: object,
    *,
    context: str = "override",
) -> ParameterScalar:
    try:
        validate_parameter_scalar(value)
    except ValueError as error:
        raise WorkflowPreparationError(
            f"Workflow Profile parameter {key!r} {context} is invalid: {error}"
        ) from error
    valid = False
    if value_type is ParameterValueType.STRING:
        valid = isinstance(value, str)
    elif value_type is ParameterValueType.INTEGER:
        valid = (
            isinstance(value, int)
            and not isinstance(value, bool)
            and -(2**53 - 1) <= value <= 2**53 - 1
        )
    elif value_type is ParameterValueType.FLOAT:
        valid = (
            isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        )
    elif value_type is ParameterValueType.BOOLEAN:
        valid = isinstance(value, bool)
    if not valid:
        raise WorkflowPreparationError(
            f"Workflow Profile parameter {key!r} {context} must be {value_type.value}"
        )
    return cast(ParameterScalar, value)


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


def _is_connection_value(value: object) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], str)
        and bool(value[0])
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
        and value[1] >= 0
    )
