from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from batchcraft.domain import CompiledJob, CompiledRunPlan


@dataclass(frozen=True, slots=True)
class ProjectIdentity:
    id: str
    filesystem_key: str
    name: str


@dataclass(frozen=True, slots=True)
class AdoptableProject:
    filesystem_key: str
    owner_state: Literal["owned", "ownerless"]
    project_id: str | None
    initial_name: str | None


@dataclass(frozen=True, slots=True)
class BatchIdentity:
    id: str
    filesystem_key: str
    name: str


@dataclass(frozen=True, slots=True)
class AssetRecord:
    asset_id: str
    sha256: str
    original_filename: str
    mime_type: str | None
    byte_size: int
    stored_path: str
    created_at: str


@dataclass(frozen=True, slots=True)
class PersistedJob:
    job_id: str
    compiled_job: CompiledJob
    reference_asset: AssetRecord | None


@dataclass(frozen=True, slots=True)
class PublishedRun:
    run_id: str
    run_number: int
    created_at: str
    path: Path
    project: ProjectIdentity
    batch: BatchIdentity
    batch_snapshot: dict[str, object] | None
    compiled_plan: CompiledRunPlan
    jobs: tuple[PersistedJob, ...]
    workflow: dict[str, object]
    workflow_profile: dict[str, object]
    workflow_sha256: str
    workflow_profile_sha256: str
