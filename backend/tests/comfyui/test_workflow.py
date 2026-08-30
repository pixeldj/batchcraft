import copy
from typing import cast

import pytest

from batchcraft.comfyui import (
    WorkflowPreparationError,
    WorkflowPreparationValues,
    prepare_workflow,
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
        "unrelated": {"inputs": {"value": {"nested": [1, 2, 3]}}},
    }


def _profile() -> dict[str, object]:
    return {
        "id": "profile-id",
        "name": "Known workflow",
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


def _values(prompt: str = "A resolved dog portrait") -> WorkflowPreparationValues:
    return WorkflowPreparationValues(
        prompt=prompt,
        reference_image="batchcraft/run-1/reference.png",
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


def test_prepare_workflow_without_reference_preserves_base_image_value() -> None:
    workflow = _workflow()
    values = _values()

    prepared = prepare_workflow(
        workflow,
        _profile(),
        WorkflowPreparationValues(
            prompt=values.prompt,
            reference_image=None,
            seed=values.seed,
            output_prefix=values.output_prefix,
        ),
    )

    assert prepared["25"]["inputs"]["image"] == "original.png"  # type: ignore[index]
    assert prepared["34"]["inputs"]["prompt"] == values.prompt  # type: ignore[index]
    assert workflow["25"]["inputs"]["image"] == "original.png"  # type: ignore[index]


def test_prepare_workflow_without_reference_still_validates_reference_mapping() -> None:
    profile = _profile()
    profile["mappings"]["reference_image"]["input_name"] = "missing"  # type: ignore[index]
    values = _values()

    with pytest.raises(WorkflowPreparationError, match="reference_image.*missing input 'missing'"):
        prepare_workflow(
            _workflow(),
            profile,
            WorkflowPreparationValues(
                prompt=values.prompt,
                reference_image=None,
                seed=values.seed,
                output_prefix=values.output_prefix,
            ),
        )


def test_prepare_workflow_rejects_empty_reference_image_value() -> None:
    values = _values()

    with pytest.raises(WorkflowPreparationError, match="reference image value must not be empty"):
        prepare_workflow(
            _workflow(),
            _profile(),
            WorkflowPreparationValues(
                prompt=values.prompt,
                reference_image="",
                seed=values.seed,
                output_prefix=values.output_prefix,
            ),
        )


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
        reference_image=values.reference_image,
        seed=cast(int, seed),
        output_prefix=values.output_prefix,
    )

    with pytest.raises(WorkflowPreparationError, match="seed must be an integer"):
        prepare_workflow(_workflow(), _profile(), invalid_values)


def test_prepare_workflow_rejects_unresolved_prompt() -> None:
    with pytest.raises(WorkflowPreparationError, match="unresolved placeholder"):
        prepare_workflow(_workflow(), _profile(), _values("A {{animal}} portrait"))
