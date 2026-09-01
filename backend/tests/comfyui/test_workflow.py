import copy
from typing import cast

import pytest

from batchcraft.comfyui import (
    WorkflowPreparationError,
    WorkflowPreparationValues,
    prepare_workflow,
    validate_workflow_profile,
)


def _workflow() -> dict[str, object]:
    return {
        "7": {
            "inputs": {"seed": 1, "steps": 8},
            "class_type": "KSampler",
            "_meta": {"title": "Sampler"},
        },
        "25": {
            "inputs": {"image": "original.png", "upload": "image"},
            "class_type": "LoadImage",
        },
        "34": {
            "inputs": {"prompt": "original prompt", "clip": ["3", 0]},
            "class_type": "TextEncode",
        },
        "41": {
            "inputs": {"filename_prefix": "original", "images": ["8", 0]},
            "class_type": "SaveImage",
        },
        "unrelated": {
            "inputs": {"value": {"nested": [1, 2, 3]}},
            "class_type": "Unrelated",
        },
    }


def _profile() -> dict[str, object]:
    return {
        "id": "profile-id",
        "name": "Known workflow",
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
        "parameters": [],
    }


def _values(prompt: str = "A resolved dog portrait") -> WorkflowPreparationValues:
    return WorkflowPreparationValues(
        prompt=prompt,
        image_inputs={"reference": "batchcraft/run-1/reference.png"},
        seed=123456,
        output_prefix="batchcraft/run-1/job-1",
    )


def test_prepare_workflow_maps_values_without_mutating_snapshots() -> None:
    workflow = _workflow()
    profile = _profile()
    original_workflow = copy.deepcopy(workflow)
    original_profile = copy.deepcopy(profile)

    prepared = prepare_workflow(workflow, profile, _values())

    assert prepared["34"]["inputs"]["prompt"] == "A resolved dog portrait"  # type: ignore[index]
    assert prepared["25"]["inputs"]["image"] == "batchcraft/run-1/reference.png"  # type: ignore[index]
    assert prepared["7"]["inputs"]["seed"] == 123456  # type: ignore[index]
    assert prepared["41"]["inputs"]["filename_prefix"] == "batchcraft/run-1/job-1"  # type: ignore[index]
    assert prepared["7"]["inputs"]["steps"] == 8  # type: ignore[index]
    assert prepared["34"]["inputs"]["clip"] == ["3", 0]  # type: ignore[index]
    assert prepared["unrelated"] == original_workflow["unrelated"]
    assert workflow == original_workflow
    assert profile == original_profile
    assert prepared is not workflow


def test_prepare_workflow_applies_typed_parameter_scalars_and_omits_base() -> None:
    workflow = _workflow()
    sampler = cast(dict[str, object], workflow["7"])
    cast(dict[str, object], sampler["inputs"]).update(
        {"cfg": 7.5, "enabled": False, "scheduler": "normal", "notes": "base"}
    )
    profile = _profile()
    profile["parameters"] = [
        {
            "key": "steps",
            "label": "Steps",
            "node_id": "7",
            "input_name": "steps",
            "value_type": "integer",
        },
        {
            "key": "cfg",
            "label": "CFG",
            "node_id": "7",
            "input_name": "cfg",
            "value_type": "float",
        },
        {
            "key": "enabled",
            "label": "Enabled",
            "node_id": "7",
            "input_name": "enabled",
            "value_type": "boolean",
        },
        {
            "key": "scheduler",
            "label": "Scheduler",
            "node_id": "7",
            "input_name": "scheduler",
            "value_type": "string",
        },
        {
            "key": "notes",
            "label": "Notes",
            "node_id": "7",
            "input_name": "notes",
            "value_type": "string",
        },
    ]
    values = _values()
    prepared = prepare_workflow(
        workflow,
        profile,
        WorkflowPreparationValues(
            prompt=values.prompt,
            image_inputs=values.image_inputs,
            seed=values.seed,
            output_prefix=values.output_prefix,
            parameters={"steps": -4, "cfg": 8, "enabled": True, "scheduler": ""},
        ),
    )

    inputs = prepared["7"]["inputs"]  # type: ignore[index]
    assert inputs == {
        "seed": 123456,
        "steps": -4,
        "cfg": 8,
        "enabled": True,
        "scheduler": "",
        "notes": "base",
    }


def test_profile_parameter_validation_rejects_collisions_and_base_type_mismatch() -> None:
    profile = _profile()
    profile["parameters"] = [
        {
            "key": "steps",
            "label": "Steps",
            "node_id": "7",
            "input_name": "seed",
            "value_type": "integer",
        }
    ]
    with pytest.raises(WorkflowPreparationError, match="maps multiple inputs"):
        validate_workflow_profile(_workflow(), profile)

    profile["parameters"][0]["input_name"] = "steps"  # type: ignore[index]
    profile["parameters"][0]["value_type"] = "boolean"  # type: ignore[index]
    with pytest.raises(WorkflowPreparationError, match="base value must be boolean"):
        validate_workflow_profile(_workflow(), profile)


def test_profile_parameter_validation_rejects_connected_target() -> None:
    profile = _profile()
    profile["parameters"] = [
        {
            "key": "clip",
            "label": "Clip",
            "node_id": "34",
            "input_name": "clip",
            "value_type": "string",
        }
    ]

    with pytest.raises(WorkflowPreparationError, match="parameter 'clip'.*connected input"):
        validate_workflow_profile(_workflow(), profile)


def test_prepare_workflow_without_runtime_image_preserves_base_image_value() -> None:
    workflow = _workflow()
    profile = _profile()
    values = _values()

    prepared = prepare_workflow(
        workflow,
        profile,
        WorkflowPreparationValues(
            prompt=values.prompt,
            image_inputs={},
            seed=values.seed,
            output_prefix=values.output_prefix,
        ),
    )

    assert prepared["25"]["inputs"]["image"] == "original.png"  # type: ignore[index]
    assert prepared["34"]["inputs"]["prompt"] == values.prompt  # type: ignore[index]
    assert workflow["25"]["inputs"]["image"] == "original.png"  # type: ignore[index]


def test_prepare_workflow_without_runtime_image_still_validates_slot_target() -> None:
    profile = _profile()
    profile["image_inputs"][0]["input_name"] = "missing"  # type: ignore[index]
    values = _values()

    with pytest.raises(
        WorkflowPreparationError, match="image input 'reference'.*missing input 'missing'"
    ):
        prepare_workflow(
            _workflow(),
            profile,
            WorkflowPreparationValues(
                prompt=values.prompt,
                image_inputs={},
                seed=values.seed,
                output_prefix=values.output_prefix,
            ),
        )


def test_prepare_workflow_rejects_empty_image_value() -> None:
    values = _values()

    with pytest.raises(WorkflowPreparationError, match="image input values must not be empty"):
        prepare_workflow(
            _workflow(),
            _profile(),
            WorkflowPreparationValues(
                prompt=values.prompt,
                image_inputs={"reference": ""},
                seed=values.seed,
                output_prefix=values.output_prefix,
            ),
        )


def test_profile_rejects_two_image_slots_targeting_the_same_workflow_input() -> None:
    profile = _profile()
    image_inputs = cast(list[object], profile["image_inputs"])
    image_inputs.append(
        {"key": "alternate", "label": "Alternate", "node_id": "25", "input_name": "image"}
    )

    with pytest.raises(WorkflowPreparationError, match="maps multiple inputs to node '25'"):
        validate_workflow_profile(_workflow(), profile)


def test_profile_rejects_image_slot_targeting_a_core_mapping_input() -> None:
    profile = _profile()
    image_input = cast(list[dict[str, object]], profile["image_inputs"])[0]
    image_input["node_id"] = "34"
    image_input["input_name"] = "prompt"

    with pytest.raises(WorkflowPreparationError, match="maps multiple inputs to node '34'"):
        validate_workflow_profile(_workflow(), profile)


def test_prepare_workflow_rejects_missing_mapped_node() -> None:
    profile = _profile()
    profile["mappings"]["prompt"]["node_id"] = "missing"  # type: ignore[index]

    with pytest.raises(WorkflowPreparationError, match="prompt.*missing node 'missing'"):
        prepare_workflow(_workflow(), profile, _values())


def test_prepare_workflow_rejects_missing_mapped_input() -> None:
    profile = _profile()
    profile["mappings"]["seed"]["input_name"] = "noise_seed"  # type: ignore[index]

    with pytest.raises(WorkflowPreparationError, match="seed.*missing input 'noise_seed'.*'7'"):
        prepare_workflow(_workflow(), profile, _values())


def test_prepare_workflow_rejects_incorrect_mapping_type() -> None:
    profile = _profile()
    profile["mappings"]["seed"]["value_type"] = "string"  # type: ignore[index]

    with pytest.raises(WorkflowPreparationError, match="seed.*value_type 'integer'.*'string'"):
        prepare_workflow(_workflow(), profile, _values())


@pytest.mark.parametrize("seed", ["123", 123.0, True])
def test_prepare_workflow_rejects_non_integer_runtime_seed(seed: object) -> None:
    values = _values()
    invalid_values = WorkflowPreparationValues(
        prompt=values.prompt,
        image_inputs=values.image_inputs,
        seed=cast(int, seed),
        output_prefix=values.output_prefix,
    )

    with pytest.raises(WorkflowPreparationError, match="seed must be an integer"):
        prepare_workflow(_workflow(), _profile(), invalid_values)


def test_prepare_workflow_rejects_unresolved_prompt() -> None:
    with pytest.raises(WorkflowPreparationError, match="unresolved placeholder"):
        prepare_workflow(_workflow(), _profile(), _values("A {{animal}} portrait"))


def test_prepare_workflow_rejects_non_api_workflow_node() -> None:
    workflow = _workflow()
    workflow["34"] = {"inputs": {"prompt": "original"}}

    with pytest.raises(WorkflowPreparationError, match="node '34'.*class_type"):
        prepare_workflow(workflow, _profile(), _values())


@pytest.mark.parametrize("missing", ("prompt", "seed", "output_prefix"))
def test_validate_workflow_profile_requires_core_mappings(missing: str) -> None:
    profile = _profile()
    cast(dict[str, object], profile["mappings"]).pop(missing)

    with pytest.raises(WorkflowPreparationError, match="required mappings"):
        validate_workflow_profile(_workflow(), profile)


def test_validate_workflow_profile_rejects_unknown_mapping_names() -> None:
    profile = _profile()
    profile["mappings"]["extra"] = {  # type: ignore[index]
        "node_id": "7",
        "input_name": "steps",
        "value_type": "integer",
    }

    with pytest.raises(WorkflowPreparationError, match="unsupported mapping names.*'extra'"):
        validate_workflow_profile(_workflow(), profile)


def test_prepare_workflow_rejects_unknown_runtime_slot() -> None:
    values = _values()
    invalid = WorkflowPreparationValues(
        prompt=values.prompt,
        image_inputs={"unknown": "image.png"},
        seed=values.seed,
        output_prefix=values.output_prefix,
    )
    with pytest.raises(WorkflowPreparationError, match="unknown slot keys.*'unknown'"):
        prepare_workflow(_workflow(), _profile(), invalid)


def test_validate_workflow_profile_rejects_connection_valued_mapping_target() -> None:
    profile = _profile()
    profile["mappings"]["prompt"]["input_name"] = "clip"  # type: ignore[index]

    with pytest.raises(
        WorkflowPreparationError,
        match="prompt.*connected input 'clip'.*literal input values",
    ):
        validate_workflow_profile(_workflow(), profile)
