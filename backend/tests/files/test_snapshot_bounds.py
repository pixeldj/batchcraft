import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from test_runs import _create, _fixture_plan

from batchcraft.domain.compiler import _prompt_matches
from batchcraft.files import RunFilesystemStore, RunStoreError
from batchcraft.files._io import canonical_json_bytes


@pytest.mark.parametrize("metadata_matches", [False, True])
def test_corrupt_snapshot_rejects_before_amplified_recompilation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    metadata_matches: bool,
) -> None:
    store = RunFilesystemStore(tmp_path / "projects")
    run = _create(store, _fixture_plan(None), None)
    manifest_path = run.path / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    template = "{{animal}}" * 4096
    manifest["batch_snapshot"]["prompt_versions"][0]["text"] = template
    manifest["batch_snapshot"]["variable_bindings"][0]["values"] = ["x" * 1024, "y" * 1024]
    if metadata_matches:
        manifest["prompt_versions"][0]["prompt_template"] = template
    manifest_path.write_bytes(canonical_json_bytes(manifest))
    before = manifest_path.read_bytes()
    allocation = Mock(side_effect=AssertionError("must not construct amplified prompt"))
    matcher = Mock(wraps=_prompt_matches)
    monkeypatch.setattr("batchcraft.domain.compiler._resolve_prompt", allocation)
    monkeypatch.setattr("batchcraft.domain.compiler._prompt_matches", matcher)
    if not metadata_matches:
        monkeypatch.setattr("batchcraft.files.runs.materialize_parameter_bindings", allocation)
    with pytest.raises(RunStoreError, match="metadata|snapshot prompt"):
        store.load_run(run.path)
    assert matcher.call_count == int(metadata_matches)
    allocation.assert_not_called()
    assert manifest_path.read_bytes() == before
