import base64
import json
import socket
from pathlib import Path

import execution_verify
import pytest

from batchcraft.domain import (
    BatchDefinition,
    ImageBinding,
    ImageInputSlot,
    PromptVersion,
    SeedInput,
    compile_batch,
)
from batchcraft.files import (
    BatchSnapshotV1,
    ProjectAssetStore,
    ProjectOwnerStore,
    PublishedRun,
    RunFilesystemStore,
)


@pytest.fixture
def prepared_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> PublishedRun:
    def reject_network(*args: object, **kwargs: object) -> None:
        pytest.fail("local preparation must not construct a ComfyUI client or contact the network")

    monkeypatch.setattr(execution_verify, "ComfyUIClient", reject_network)
    monkeypatch.setattr(socket.socket, "connect", reject_network)
    monkeypatch.setattr(socket.socket, "connect_ex", reject_network)
    image_path = tmp_path / "reference.png"
    image_path.write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i"
            "p1sAAAAASUVORK5CYII="
        )
    )
    workflow_path = tmp_path / "workflow.json"
    workflow_path.write_text(
        json.dumps(
            {
                "7": {"class_type": "KSampler", "inputs": {"seed": 0}},
                "25": {"class_type": "LoadImage", "inputs": {"image": "original.png"}},
                "34": {"class_type": "TextEncode", "inputs": {"prompt": "original"}},
                "41": {"class_type": "SaveImage", "inputs": {"filename_prefix": "original"}},
            }
        )
    )
    return execution_verify.prepare_run(
        image_path=image_path, workflow_path=workflow_path, output_root=tmp_path / "outputs"
    )


def test_preparation_publishes_owner_and_imports_asset(prepared_run: PublishedRun) -> None:
    project_path = prepared_run.path.parents[2]
    assert ProjectOwnerStore(project_path.parent).read(project_path.name) == prepared_run.project
    assets = [job.image_inputs[0].asset for job in prepared_run.jobs]
    assert len(assets) == 2
    assert assets[0] is not None
    assert assets[0] == assets[1]
    assert ProjectAssetStore(project_path).load(assets[0].sha256) == assets[0]
    assert assets[0].mime_type == "image/png"
    assert (project_path / assets[0].stored_path).read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


def test_published_plan_recompiles_from_snapshot(prepared_run: PublishedRun) -> None:
    store = RunFilesystemStore(prepared_run.path.parents[3])
    loaded = store.load_run(prepared_run.path)
    assert loaded == prepared_run
    snapshot = BatchSnapshotV1.model_validate(loaded.batch_snapshot)
    plan = compile_batch(
        BatchDefinition(
            prompt_versions=tuple(
                PromptVersion(id=prompt.id, name=prompt.name, text=prompt.text)
                for prompt in snapshot.prompt_versions
            ),
            variable_bindings=(),
            image_input_slots=(ImageInputSlot("reference", "Reference", "25", "image"),),
            image_bindings=tuple(
                ImageBinding(binding.slot_key, tuple(binding.values))
                for binding in snapshot.image_bindings
            ),
            seeds=SeedInput.explicit(tuple(snapshot.seed_intent.values)),
        )
    )
    assert plan == loaded.compiled_plan
    assert [job.ordinal for job in plan.jobs] == [1, 2]
    assert [job.seed for job in plan.jobs] == [123456789, 123456790]
    assert len({job.job_id for job in loaded.jobs}) == 2
    assert len({job.output_prefix for job in loaded.jobs}) == 2
    for job in plan.jobs:
        assert job.resolved_prompt == snapshot.prompt_versions[0].text
        assert "Turn the reference into a polished character illustration." in job.resolved_prompt
        assert job.prompt_version_id == snapshot.prompt_versions[0].id
    assert not (loaded.path / "execution.json").exists()
