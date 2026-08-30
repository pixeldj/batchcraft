from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


@dataclass(frozen=True, slots=True)
class ProjectRecord:
    id: str
    name: str
    filesystem_key: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


@dataclass(frozen=True, slots=True)
class PromptRecord:
    id: str
    project_id: str
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


@dataclass(frozen=True, slots=True)
class PromptVersionRecord:
    id: str
    prompt_id: str
    version_number: int
    name_snapshot: str
    text: str
    note: str | None
    created_at: datetime
    archived_at: datetime | None


@dataclass(frozen=True, slots=True)
class PromptListRecord:
    id: str
    project_id: str
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None
    latest_active_version: PromptVersionRecord | None


@dataclass(frozen=True, slots=True)
class WorkflowRecord:
    id: str
    project_id: str
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


@dataclass(frozen=True, slots=True)
class WorkflowVersionRecord:
    id: str
    workflow_id: str
    project_id: str
    version_number: int
    name_snapshot: str
    workflow: dict[str, object]
    content_sha256: str
    note: str | None
    created_at: datetime
    archived_at: datetime | None


@dataclass(frozen=True, slots=True)
class WorkflowListRecord(WorkflowRecord):
    latest_active_version: WorkflowVersionRecord | None


@dataclass(frozen=True, slots=True)
class WorkflowProfileRecord:
    id: str
    workflow_id: str
    project_id: str
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


@dataclass(frozen=True, slots=True)
class WorkflowProfileVersionRecord:
    id: str
    workflow_profile_id: str
    workflow_id: str
    project_id: str
    workflow_version_id: str
    version_number: int
    name_snapshot: str
    profile: dict[str, object]
    content_sha256: str
    note: str | None
    created_at: datetime
    archived_at: datetime | None


@dataclass(frozen=True, slots=True)
class WorkflowProfileListRecord(WorkflowProfileRecord):
    latest_compatible_version: WorkflowProfileVersionRecord | None


class SavedBatchSeedMode(StrEnum):
    FIXED = "fixed"
    EXPLICIT = "explicit"
    RANDOM = "random"


class SavedBatchVariableBindingMode(StrEnum):
    ALL = "all"
    FIXED = "fixed"


@dataclass(frozen=True, slots=True)
class SavedBatchSeedIntent:
    mode: SavedBatchSeedMode
    values: tuple[int, ...] = ()
    random_seed_count: int | None = None

    @classmethod
    def fixed(cls, seed: int) -> "SavedBatchSeedIntent":
        return cls(mode=SavedBatchSeedMode.FIXED, values=(seed,))

    @classmethod
    def explicit(cls, seeds: tuple[int, ...]) -> "SavedBatchSeedIntent":
        return cls(mode=SavedBatchSeedMode.EXPLICIT, values=seeds)

    @classmethod
    def random(cls, count: int) -> "SavedBatchSeedIntent":
        return cls(mode=SavedBatchSeedMode.RANDOM, random_seed_count=count)


@dataclass(frozen=True, slots=True)
class SavedBatchPromptSelection:
    prompt_version_id: str
    name_snapshot: str
    text: str
    prompt_id: str | None = None
    prompt_name: str | None = None
    version_number: int | None = None
    prompt_archived_at: datetime | None = None
    version_archived_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class SavedBatchVariableBinding:
    placeholder: str
    variable_list_id: str
    values: tuple[str, ...]
    selected_values: tuple[str, ...]
    mode: SavedBatchVariableBindingMode
    fixed_value: str | None = None


@dataclass(frozen=True, slots=True)
class SavedBatchReferenceSelection:
    asset_id: str


@dataclass(frozen=True, slots=True)
class SavedBatchWorkflowVersionSnapshot:
    id: str
    content_sha256: str
    workflow: dict[str, object]
    workflow_id: str | None = None
    workflow_name: str | None = None
    version_number: int | None = None
    name_snapshot: str | None = None
    workflow_archived_at: datetime | None = None
    version_archived_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class SavedBatchWorkflowProfileVersionSnapshot:
    id: str
    workflow_profile_id: str
    workflow_version_id: str
    content_sha256: str
    profile: dict[str, object]
    workflow_profile_name: str | None = None
    version_number: int | None = None
    name_snapshot: str | None = None
    workflow_profile_archived_at: datetime | None = None
    version_archived_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class SavedBatchDefinition:
    name: str
    description: str | None
    seed_intent: SavedBatchSeedIntent
    prompt_selections: tuple[SavedBatchPromptSelection, ...] = ()
    variable_bindings: tuple[SavedBatchVariableBinding, ...] = ()
    reference_selections: tuple[SavedBatchReferenceSelection, ...] = ()
    selected_workflow_version: SavedBatchWorkflowVersionSnapshot | None = None
    selected_workflow_profile_id: str | None = None
    selected_workflow_profile_version: SavedBatchWorkflowProfileVersionSnapshot | None = None


@dataclass(frozen=True, slots=True)
class SavedBatchRecord:
    id: str
    project_id: str
    filesystem_key: str
    name: str
    description: str | None
    revision: int
    seed_mode: SavedBatchSeedMode
    seed_values: tuple[int, ...]
    random_seed_count: int | None
    selected_workflow_version_id: str | None
    selected_workflow_profile_id: str | None
    selected_workflow_profile_version_id: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


@dataclass(frozen=True, slots=True)
class SavedBatchListRecord(SavedBatchRecord):
    pass


@dataclass(frozen=True, slots=True)
class SavedBatchDetailRecord(SavedBatchRecord):
    prompt_selections: tuple[SavedBatchPromptSelection, ...]
    variable_bindings: tuple[SavedBatchVariableBinding, ...]
    reference_selections: tuple[SavedBatchReferenceSelection, ...]
    selected_workflow_version: SavedBatchWorkflowVersionSnapshot | None
    selected_workflow_profile_name: str | None
    selected_workflow_profile_archived_at: datetime | None
    selected_workflow_profile_version: SavedBatchWorkflowProfileVersionSnapshot | None
