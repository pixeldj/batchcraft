"""Copied v1 Project fixtures for historical API tests."""

import hashlib
import json
import shutil
from pathlib import Path

from batchcraft.api import Settings

FIXTURE = Path(__file__).parent.parent / "fixtures" / "v1_project" / "project_key"


def _copy_fixture(settings: Settings) -> Path:
    settings.projects_root.mkdir()
    project = settings.projects_root / "project_key"
    shutil.copytree(FIXTURE, project)
    # Git does not preserve the fixture's empty outputs directory.
    (project / "batches" / "batch_key" / "001-run" / "outputs").mkdir(exist_ok=True)
    return project


def _add_result(project: Path) -> Path:
    run = project / "batches" / "batch_key" / "001-run"
    result_path = run / "outputs" / "000001-01.png"
    content = b"result-bytes"
    result_path.write_bytes(content)
    execution_path = run / "execution.json"
    execution = json.loads(execution_path.read_text())
    execution["jobs"][0]["results"] = [
        {
            "job_id": "job-1",
            "job_ordinal": 1,
            "artifact_ordinal": 1,
            "producing_node_id": "301",
            "output_name": "images",
            "remote_filename": "result.png",
            "remote_subfolder": "",
            "remote_type": "output",
            "local_path": "outputs/000001-01.png",
            "content_type": "image/png",
            "byte_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    ]
    execution_path.write_text(json.dumps(execution, sort_keys=True, separators=(",", ":")) + "\n")
    return result_path
