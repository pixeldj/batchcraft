from collections.abc import Collection

from batchcraft.version import batchcraft_version

PROJECT_FORMAT = "batchcraft.project"
BATCH_FORMAT = "batchcraft.batch"
ASSET_FORMAT = "batchcraft.asset"
RUN_FORMAT = "batchcraft.run"
MANIFEST_FORMAT = "batchcraft.manifest"
BATCH_SNAPSHOT_FORMAT = "batchcraft.batch-snapshot"
EXECUTION_FORMAT = "batchcraft.execution"
WORKFLOW_SNAPSHOT_FORMAT = "batchcraft.workflow-snapshot"
WORKFLOW_PROFILE_SNAPSHOT_FORMAT = "batchcraft.workflow-profile-snapshot"
MANIFEST_CSV_FORMAT = "batchcraft.manifest-csv"

PROJECT_FORMAT_VERSION = 1
BATCH_FORMAT_VERSION = 1
ASSET_FORMAT_VERSION = 1
RUN_FORMAT_VERSION = 1
MANIFEST_FORMAT_VERSION = 1
BATCH_SNAPSHOT_FORMAT_VERSION = 1
EXECUTION_FORMAT_VERSION = 1
WORKFLOW_SNAPSHOT_FORMAT_VERSION = 1
WORKFLOW_PROFILE_SNAPSHOT_FORMAT_VERSION = 1
MANIFEST_CSV_FORMAT_VERSION = 1

_FORMAT_VERSIONS = {
    PROJECT_FORMAT: PROJECT_FORMAT_VERSION,
    BATCH_FORMAT: BATCH_FORMAT_VERSION,
    ASSET_FORMAT: ASSET_FORMAT_VERSION,
    RUN_FORMAT: RUN_FORMAT_VERSION,
    MANIFEST_FORMAT: MANIFEST_FORMAT_VERSION,
    BATCH_SNAPSHOT_FORMAT: BATCH_SNAPSHOT_FORMAT_VERSION,
    EXECUTION_FORMAT: EXECUTION_FORMAT_VERSION,
    WORKFLOW_SNAPSHOT_FORMAT: WORKFLOW_SNAPSHOT_FORMAT_VERSION,
    WORKFLOW_PROFILE_SNAPSHOT_FORMAT: WORKFLOW_PROFILE_SNAPSHOT_FORMAT_VERSION,
    MANIFEST_CSV_FORMAT: MANIFEST_CSV_FORMAT_VERSION,
}


def format_header(format_name: str, producer_version: str | None = None) -> dict[str, object]:
    return {
        "format": format_name,
        "format_version": _format_version(format_name),
        "created_by": {
            "batchcraft_version": producer_version or batchcraft_version(),
        },
    }


def validate_format_record(
    data: dict[str, object],
    format_name: str,
    fields: Collection[str],
) -> str:
    require_exact_keys(data, {"format", "format_version", "created_by", *fields}, format_name)
    if data["format"] != format_name:
        raise ValueError(f"wrong format identity for {format_name}: {data['format']!r}")
    version_value = data["format_version"]
    if type(version_value) is not int or version_value != _format_version(format_name):
        raise ValueError(f"unsupported format version for {format_name}")
    created_by = data["created_by"]
    if not isinstance(created_by, dict):
        raise ValueError(f"created_by must be an object for {format_name}")
    require_exact_keys(created_by, {"batchcraft_version"}, f"{format_name} created_by")
    producer_version = created_by["batchcraft_version"]
    if not isinstance(producer_version, str) or not producer_version.strip():
        raise ValueError(f"batchcraft_version must be a non-empty string for {format_name}")
    return producer_version


def validate_descriptor(
    data: dict[str, object],
    format_name: str,
    fields: Collection[str],
) -> None:
    require_exact_keys(data, {"format", "format_version", *fields}, format_name)
    if data["format"] != format_name:
        raise ValueError(f"wrong format identity for {format_name}: {data['format']!r}")
    version_value = data["format_version"]
    if type(version_value) is not int or version_value != _format_version(format_name):
        raise ValueError(f"unsupported format version for {format_name}")


def require_exact_keys(
    data: dict[str, object], expected: Collection[str], description: str
) -> None:
    actual = set(data)
    expected_set = set(expected)
    if actual != expected_set:
        missing = sorted(expected_set - actual)
        unexpected = sorted(actual - expected_set)
        details: list[str] = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if unexpected:
            details.append(f"unexpected {', '.join(unexpected)}")
        raise ValueError(f"invalid {description} shape: {'; '.join(details)}")


def _format_version(format_name: str) -> int:
    try:
        return _FORMAT_VERSIONS[format_name]
    except KeyError as error:
        raise ValueError(f"unknown batchcraft format: {format_name!r}") from error
