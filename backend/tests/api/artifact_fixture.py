import hashlib
import json
import shutil
import struct
import zlib
from pathlib import Path


def artifact_png(filename: str) -> bytes:
    """A valid one-pixel PNG with exact per-artifact identity in a text chunk."""
    chunks = [
        (b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)),
        (b"tEXt", b"Artifact\0" + filename.encode()),
        (b"IDAT", zlib.compress(b"\0" + hashlib.sha256(filename.encode()).digest()[:3])),
        (b"IEND", b""),
    ]
    return b"\x89PNG\r\n\x1a\n" + b"".join(
        struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        for kind, data in chunks
    )


def write_artifact_fixture(
    projects_root: Path, artifacts: list[tuple[bytes, str | None, str]]
) -> Path:
    """Publish test-only Result records with matching hashes in a copied v1 Run."""
    fixture = Path(__file__).parent.parent / "fixtures/v1_project/project_key"
    project = projects_root / "project_key"
    shutil.copytree(fixture, project)
    run = project / "batches/batch_key/001-run"
    (run / "outputs").mkdir(exist_ok=True)
    execution_path = run / "execution.json"
    execution = json.loads(execution_path.read_text())
    results = []
    for ordinal, (content, mime, extension) in enumerate(artifacts, start=1):
        filename = f"000001-{ordinal:02}.{extension}"
        (run / "outputs" / filename).write_bytes(content)
        results.append(
            {
                "job_id": "job-1",
                "job_ordinal": 1,
                "artifact_ordinal": ordinal,
                "producing_node_id": "301",
                "output_name": "images",
                "remote_filename": filename,
                "remote_subfolder": "",
                "remote_type": "output",
                "local_path": f"outputs/{filename}",
                "content_type": mime,
                "byte_size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    execution["jobs"][0]["results"] = results
    execution_path.write_text(json.dumps(execution, sort_keys=True, separators=(",", ":")) + "\n")
    return execution_path
