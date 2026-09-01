from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Literal, Self
from urllib.parse import quote

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    model_validator,
)

from batchcraft.application import ComfyUIStatus, RunCreationInput
from batchcraft.comfyui import workflow_profile_image_inputs, workflow_profile_parameters
from batchcraft.db import (
    ProjectRecord,
    PromptListRecord,
    PromptRecord,
    PromptVersionRecord,
    SavedBatchDefinition,
    SavedBatchDetailRecord,
    SavedBatchImageBinding,
    SavedBatchListRecord,
    SavedBatchParameterBinding,
    SavedBatchPromptSelection,
    SavedBatchSeedIntent,
    SavedBatchSeedMode,
    SavedBatchVariableBinding,
    SavedBatchWorkflowProfileVersionSnapshot,
    SavedBatchWorkflowVersionSnapshot,
    WorkflowListRecord,
    WorkflowProfileListRecord,
    WorkflowProfileRecord,
    WorkflowProfileVersionRecord,
    WorkflowRecord,
    WorkflowVersionRecord,
)
from batchcraft.domain import (
    BatchDefinition,
    CompilationWarning,
    CompiledJob,
    CompiledRunPlan,
    ImageBinding,
    ImageInputSlot,
    ParameterBinding,
    PromptVersion,
    SeedInput,
    SeedMode,
    VariableBinding,
    WorkflowParameter,
    validate_parameter_alternatives,
    validate_parameter_scalar,
)
from batchcraft.execution import ResultRecord, RunExecutionState
from batchcraft.files import (
    AdoptableBatch,
    AdoptableProject,
    AssetRecord,
    BatchIdentity,
    BatchSnapshotV4,
    ProjectIdentity,
    PublishedRun,
)


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class IdentityRequest(ApiModel):
    id: str = Field(min_length=1)
    filesystem_key: str = Field(min_length=1)
    name: str = Field(min_length=1)


class PromptVersionRequest(ApiModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    text: str


class VariableBindingRequest(ApiModel):
    placeholder: str = Field(min_length=1)
    values: list[str]


class ImageBindingRequest(ApiModel):
    slot_key: str
    values: list[str | None] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_values(self) -> Self:
        _validate_image_binding_values(self.values)
        return self


SafeSeed = Annotated[int, Field(strict=True, ge=0, le=2**53 - 1)]
SafeSignedInteger = Annotated[int, Field(strict=True, ge=-(2**53 - 1), le=2**53 - 1)]
FiniteFloat = Annotated[float, Field(strict=True, allow_inf_nan=False)]
ParameterScalarRequest = Annotated[
    StrictStr | SafeSignedInteger | FiniteFloat | StrictBool,
    BeforeValidator(validate_parameter_scalar),
]


class ParameterBindingRequest(ApiModel):
    parameter_key: str
    values: list[ParameterScalarRequest | None] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_values(self) -> Self:
        validate_parameter_alternatives(self.values)
        return self


class SeedRequest(ApiModel):
    mode: SeedMode
    values: list[SafeSeed]


class BatchRequest(ApiModel):
    project: IdentityRequest
    batch: IdentityRequest
    prompt_versions: list[PromptVersionRequest] = Field(min_length=1)
    variable_bindings: list[VariableBindingRequest] = Field(default_factory=list)
    image_bindings: list[ImageBindingRequest]
    parameter_bindings: list[ParameterBindingRequest]
    seeds: SeedRequest
    workflow: dict[str, object]
    workflow_profile: dict[str, object]
    batch_snapshot: BatchSnapshotV4

    @model_validator(mode="after")
    def validate_snapshot_consistency(self) -> Self:
        parameter_keys = [binding.parameter_key for binding in self.parameter_bindings]
        if len(set(parameter_keys)) != len(parameter_keys):
            raise ValueError("parameter bindings must have unique parameter keys")
        snapshot = self.batch_snapshot
        if (
            snapshot.project.id,
            snapshot.project.filesystem_key,
            snapshot.project.name,
        ) != (self.project.id, self.project.filesystem_key, self.project.name):
            raise ValueError("Batch snapshot Project identity does not match the request")
        if (
            snapshot.batch.id != self.batch.id
            or snapshot.batch.filesystem_key != self.batch.filesystem_key
            or snapshot.batch.name != self.batch.name
        ):
            raise ValueError("Batch snapshot identity does not match the request")
        snapshot_prompts = [(item.id, item.name, item.text) for item in snapshot.prompt_versions]
        request_prompts = [(item.id, item.name, item.text) for item in self.prompt_versions]
        if snapshot_prompts != request_prompts:
            raise ValueError("Batch snapshot PromptVersion order or content does not match")
        snapshot_bindings = [
            (
                item.placeholder,
                item.values,
            )
            for item in snapshot.variable_bindings
        ]
        request_bindings = [
            (
                item.placeholder,
                item.values,
            )
            for item in self.variable_bindings
        ]
        if snapshot_bindings != request_bindings:
            raise ValueError("Batch snapshot variable bindings do not match")
        if [(item.slot_key, item.values) for item in snapshot.image_bindings] != [
            (item.slot_key, item.values) for item in self.image_bindings
        ]:
            raise ValueError("Batch snapshot image bindings do not match")
        if [(item.parameter_key, item.values) for item in snapshot.parameter_bindings] != [
            (item.parameter_key, item.values) for item in self.parameter_bindings
        ]:
            raise ValueError("Batch snapshot parameter bindings do not match")
        workflow = snapshot.workflow_selection
        if workflow.workflow != self.workflow or workflow.workflow_profile != self.workflow_profile:
            raise ValueError("Batch snapshot Workflow selection does not match")
        intent = snapshot.seed_intent
        if intent.mode == "random":
            if (
                self.seeds.mode is not SeedMode.EXPLICIT
                or len(self.seeds.values) != intent.random_seed_count
            ):
                raise ValueError("Random seed intent does not match materialized request seeds")
        elif intent.mode != self.seeds.mode.value or intent.values != self.seeds.values:
            raise ValueError("Batch snapshot seed intent does not match request seeds")
        return self

    def to_creation_input(self) -> RunCreationInput:
        return RunCreationInput(
            project=ProjectIdentity(
                id=self.project.id,
                filesystem_key=self.project.filesystem_key,
                name=self.project.name,
            ),
            batch=BatchIdentity(
                id=self.batch.id,
                filesystem_key=self.batch.filesystem_key,
                name=self.batch.name,
            ),
            definition=BatchDefinition(
                prompt_versions=tuple(
                    PromptVersion(id=version.id, name=version.name, text=version.text)
                    for version in self.prompt_versions
                ),
                variable_bindings=tuple(
                    VariableBinding(
                        placeholder=binding.placeholder,
                        values=tuple(binding.values),
                    )
                    for binding in self.variable_bindings
                ),
                image_input_slots=tuple(
                    ImageInputSlot(key=key, label=label, node_id=node_id, input_name=input_name)
                    for key, label, node_id, input_name in _profile_image_inputs(
                        self.workflow_profile
                    )
                ),
                image_bindings=tuple(
                    ImageBinding(slot_key=binding.slot_key, values=tuple(binding.values))
                    for binding in self.image_bindings
                ),
                parameters=_profile_parameters(self.workflow_profile),
                parameter_bindings=tuple(
                    ParameterBinding(
                        parameter_key=binding.parameter_key, values=tuple(binding.values)
                    )
                    for binding in self.parameter_bindings
                ),
                seeds=SeedInput(mode=self.seeds.mode, values=tuple(self.seeds.values)),
            ),
            workflow=self.workflow,
            workflow_profile=self.workflow_profile,
            batch_snapshot=self.batch_snapshot.model_dump(mode="json"),
        )


class HealthResponse(ApiModel):
    status: str
    version: str


class ProjectCreateRequest(ApiModel):
    name: str = Field(min_length=1)
    filesystem_key: str = Field(min_length=1)
    description: str | None = None


class ProjectAdoptRequest(ApiModel):
    filesystem_key: str = Field(min_length=1)
    project_id: str | None = Field(default=None, min_length=1)
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None


class ProjectUpdateRequest(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None

    @model_validator(mode="after")
    def validate_update(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("at least one Project field is required")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("Project name cannot be null")
        return self


class ProjectResponse(ApiModel):
    id: str
    name: str
    filesystem_key: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None

    @classmethod
    def from_record(cls, project: ProjectRecord) -> Self:
        return cls(
            id=project.id,
            name=project.name,
            filesystem_key=project.filesystem_key,
            description=project.description,
            created_at=project.created_at,
            updated_at=project.updated_at,
            archived_at=project.archived_at,
        )


class ProjectsResponse(ApiModel):
    projects: list[ProjectResponse]


class AdoptableProjectResponse(ApiModel):
    filesystem_key: str
    owner_state: Literal["owned", "ownerless"]
    project_id: str | None
    initial_name: str | None

    @classmethod
    def from_candidate(cls, project: AdoptableProject) -> Self:
        return cls(
            filesystem_key=project.filesystem_key,
            owner_state=project.owner_state,
            project_id=project.project_id,
            initial_name=project.initial_name,
        )


class AdoptableProjectsResponse(ApiModel):
    projects: list[AdoptableProjectResponse]


class SavedBatchPromptSelectionRequest(ApiModel):
    prompt_version_id: str = Field(min_length=1)
    name_snapshot: str = Field(min_length=1)
    text: str = Field(min_length=1)
    prompt_id: str | None = Field(default=None, min_length=1)
    prompt_name: str | None = Field(default=None, min_length=1)
    version_number: int | None = Field(default=None, strict=True, ge=1)
    prompt_archived_at: datetime | None = None
    version_archived_at: datetime | None = None


class SavedBatchVariableBindingRequest(ApiModel):
    placeholder: str
    values: list[str]


class SavedBatchImageBindingRequest(ApiModel):
    slot_key: str
    values: list[str | None] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_values(self) -> Self:
        _validate_image_binding_values(self.values)
        return self


class SavedBatchParameterBindingRequest(ApiModel):
    parameter_key: str
    values: list[ParameterScalarRequest | None] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_values(self) -> Self:
        validate_parameter_alternatives(self.values)
        return self


class SavedBatchSeedIntentRequest(ApiModel):
    mode: SavedBatchSeedMode
    values: list[SafeSeed]
    random_seed_count: int | None = Field(default=None, strict=True, ge=1, le=100)

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        if self.mode is SavedBatchSeedMode.FIXED and (
            len(self.values) != 1 or self.random_seed_count is not None
        ):
            raise ValueError("fixed seed intent requires one value and no random count")
        if self.mode is SavedBatchSeedMode.EXPLICIT and (
            not self.values or self.random_seed_count is not None
        ):
            raise ValueError("explicit seed intent requires values and no random count")
        if self.mode is SavedBatchSeedMode.RANDOM and (
            self.values or self.random_seed_count is None
        ):
            raise ValueError("random seed intent requires a count and no values")
        return self


class SavedBatchWorkflowVersionRequest(ApiModel):
    id: str = Field(min_length=1)
    content_sha256: str = Field(pattern="^[0-9a-f]{64}$")
    workflow: dict[str, object]
    workflow_id: str | None = Field(default=None, min_length=1)
    workflow_name: str | None = Field(default=None, min_length=1)
    version_number: int | None = Field(default=None, strict=True, ge=1)
    name_snapshot: str | None = Field(default=None, min_length=1)
    workflow_archived_at: datetime | None = None
    version_archived_at: datetime | None = None


class SavedBatchWorkflowProfileVersionRequest(ApiModel):
    id: str = Field(min_length=1)
    workflow_profile_id: str = Field(min_length=1)
    workflow_version_id: str = Field(min_length=1)
    content_sha256: str = Field(pattern="^[0-9a-f]{64}$")
    profile: dict[str, object]
    workflow_profile_name: str | None = Field(default=None, min_length=1)
    version_number: int | None = Field(default=None, strict=True, ge=1)
    name_snapshot: str | None = Field(default=None, min_length=1)
    workflow_profile_archived_at: datetime | None = None
    version_archived_at: datetime | None = None


class SavedBatchDefinitionRequest(ApiModel):
    name: str = Field(min_length=1)
    description: str | None = None
    prompt_selections: list[SavedBatchPromptSelectionRequest] = Field(default_factory=list)
    variable_bindings: list[SavedBatchVariableBindingRequest] = Field(default_factory=list)
    image_bindings: list[SavedBatchImageBindingRequest] = Field(default_factory=list)
    parameter_bindings: list[SavedBatchParameterBindingRequest] = Field(default_factory=list)
    seed_intent: SavedBatchSeedIntentRequest
    selected_workflow_version: SavedBatchWorkflowVersionRequest | None = None
    selected_workflow_profile_id: str | None = Field(default=None, min_length=1)
    selected_workflow_profile_version: SavedBatchWorkflowProfileVersionRequest | None = None

    @model_validator(mode="after")
    def validate_definition(self) -> Self:
        if not self.name.strip():
            raise ValueError("Saved Batch name must be nonblank")
        if self.description is not None and not self.description.strip():
            raise ValueError("Saved Batch description must be nonblank when provided")
        parameter_keys = [binding.parameter_key for binding in self.parameter_bindings]
        if len(set(parameter_keys)) != len(parameter_keys):
            raise ValueError("parameter bindings must have unique parameter keys")
        profile = self.selected_workflow_profile_version
        if profile is not None and profile.workflow_profile_id != self.selected_workflow_profile_id:
            raise ValueError("Workflow Profile version must match the selected logical Profile")
        return self

    def to_definition(self) -> SavedBatchDefinition:
        workflow = self.selected_workflow_version
        profile = self.selected_workflow_profile_version
        return SavedBatchDefinition(
            name=self.name,
            description=self.description,
            seed_intent=SavedBatchSeedIntent(
                mode=self.seed_intent.mode,
                values=tuple(self.seed_intent.values),
                random_seed_count=self.seed_intent.random_seed_count,
            ),
            prompt_selections=tuple(
                SavedBatchPromptSelection(item.prompt_version_id, item.name_snapshot, item.text)
                for item in self.prompt_selections
            ),
            variable_bindings=tuple(
                SavedBatchVariableBinding(
                    placeholder=item.placeholder,
                    values=tuple(item.values),
                )
                for item in self.variable_bindings
            ),
            image_bindings=tuple(
                SavedBatchImageBinding(item.slot_key, tuple(item.values))
                for item in self.image_bindings
            ),
            parameter_bindings=tuple(
                SavedBatchParameterBinding(item.parameter_key, tuple(item.values))
                for item in self.parameter_bindings
            ),
            selected_workflow_version=(
                None
                if workflow is None
                else SavedBatchWorkflowVersionSnapshot(
                    id=workflow.id,
                    content_sha256=workflow.content_sha256,
                    workflow=workflow.workflow,
                )
            ),
            selected_workflow_profile_id=self.selected_workflow_profile_id,
            selected_workflow_profile_version=(
                None
                if profile is None
                else SavedBatchWorkflowProfileVersionSnapshot(
                    id=profile.id,
                    workflow_profile_id=profile.workflow_profile_id,
                    workflow_version_id=profile.workflow_version_id,
                    content_sha256=profile.content_sha256,
                    profile=profile.profile,
                )
            ),
        )


class SavedBatchCreateRequest(SavedBatchDefinitionRequest):
    filesystem_key: str = Field(min_length=1)


class SavedBatchAdoptRequest(SavedBatchCreateRequest):
    batch_id: str | None = Field(default=None, min_length=1)


class SavedBatchUpdateRequest(SavedBatchDefinitionRequest):
    expected_revision: int = Field(strict=True, ge=1)


class SavedBatchListResponse(ApiModel):
    id: str
    project_id: str
    filesystem_key: str
    name: str
    revision: int
    updated_at: datetime
    archived_at: datetime | None

    @classmethod
    def from_record(cls, batch: SavedBatchListRecord | SavedBatchDetailRecord) -> Self:
        return cls(
            id=batch.id,
            project_id=batch.project_id,
            filesystem_key=batch.filesystem_key,
            name=batch.name,
            revision=batch.revision,
            updated_at=batch.updated_at,
            archived_at=batch.archived_at,
        )


class SavedBatchDetailResponse(SavedBatchListResponse):
    description: str | None
    seed_mode: SavedBatchSeedMode
    seed_values: list[int]
    random_seed_count: int | None
    selected_workflow_version_id: str | None
    selected_workflow_profile_id: str | None
    selected_workflow_profile_version_id: str | None
    created_at: datetime
    prompt_selections: list[SavedBatchPromptSelectionRequest]
    variable_bindings: list[SavedBatchVariableBindingRequest]
    image_bindings: list[SavedBatchImageBindingRequest]
    parameter_bindings: list[SavedBatchParameterBindingRequest]
    selected_workflow_version: SavedBatchWorkflowVersionRequest | None
    selected_workflow_profile_name: str | None
    selected_workflow_profile_archived_at: datetime | None
    selected_workflow_profile_version: SavedBatchWorkflowProfileVersionRequest | None

    @classmethod
    def from_detail(cls, batch: SavedBatchDetailRecord) -> Self:
        return cls.model_validate(
            {
                **SavedBatchListResponse.from_record(batch).model_dump(),
                "description": batch.description,
                "seed_mode": batch.seed_mode,
                "seed_values": list(batch.seed_values),
                "random_seed_count": batch.random_seed_count,
                "selected_workflow_version_id": batch.selected_workflow_version_id,
                "selected_workflow_profile_id": batch.selected_workflow_profile_id,
                "selected_workflow_profile_version_id": (
                    batch.selected_workflow_profile_version_id
                ),
                "created_at": batch.created_at,
                "prompt_selections": [asdict(item) for item in batch.prompt_selections],
                "variable_bindings": [
                    {
                        "placeholder": item.placeholder,
                        "values": list(item.values),
                    }
                    for item in batch.variable_bindings
                ],
                "image_bindings": [
                    {"slot_key": item.slot_key, "values": list(item.values)}
                    for item in batch.image_bindings
                ],
                "parameter_bindings": [
                    {"parameter_key": item.parameter_key, "values": list(item.values)}
                    for item in batch.parameter_bindings
                ],
                "selected_workflow_version": (
                    None
                    if batch.selected_workflow_version is None
                    else asdict(batch.selected_workflow_version)
                ),
                "selected_workflow_profile_name": batch.selected_workflow_profile_name,
                "selected_workflow_profile_archived_at": (
                    batch.selected_workflow_profile_archived_at
                ),
                "selected_workflow_profile_version": (
                    None
                    if batch.selected_workflow_profile_version is None
                    else asdict(batch.selected_workflow_profile_version)
                ),
            }
        )


class SavedBatchesResponse(ApiModel):
    batches: list[SavedBatchListResponse]


class AdoptableBatchResponse(ApiModel):
    filesystem_key: str
    owner_state: Literal["owned", "ownerless"]
    batch_id: str | None
    initial_name: str | None

    @classmethod
    def from_candidate(cls, batch: AdoptableBatch) -> Self:
        return cls(**{field: getattr(batch, field) for field in cls.model_fields})


class AdoptableBatchesResponse(ApiModel):
    batches: list[AdoptableBatchResponse]


class PromptCreateRequest(ApiModel):
    name: str = Field(min_length=1)
    description: str | None = None
    text: str = Field(min_length=1)
    note: str | None = None


class PromptUpdateRequest(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None

    @model_validator(mode="after")
    def validate_update(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("at least one Prompt field is required")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("Prompt name cannot be null")
        return self


class PromptVersionCreateRequest(ApiModel):
    text: str = Field(min_length=1)
    note: str | None = None


class PromptResponse(ApiModel):
    id: str
    project_id: str
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None

    @classmethod
    def from_record(cls, prompt: PromptRecord) -> Self:
        return cls(
            id=prompt.id,
            project_id=prompt.project_id,
            name=prompt.name,
            description=prompt.description,
            created_at=prompt.created_at,
            updated_at=prompt.updated_at,
            archived_at=prompt.archived_at,
        )


class LibraryPromptVersionResponse(ApiModel):
    id: str
    prompt_id: str
    version_number: int
    name_snapshot: str
    text: str
    note: str | None
    created_at: datetime
    archived_at: datetime | None

    @classmethod
    def from_record(cls, version: PromptVersionRecord) -> Self:
        return cls(
            id=version.id,
            prompt_id=version.prompt_id,
            version_number=version.version_number,
            name_snapshot=version.name_snapshot,
            text=version.text,
            note=version.note,
            created_at=version.created_at,
            archived_at=version.archived_at,
        )


class PromptListResponse(PromptResponse):
    latest_active_version: LibraryPromptVersionResponse | None

    @classmethod
    def from_list_record(cls, prompt: PromptListRecord) -> Self:
        return cls(
            id=prompt.id,
            project_id=prompt.project_id,
            name=prompt.name,
            description=prompt.description,
            created_at=prompt.created_at,
            updated_at=prompt.updated_at,
            archived_at=prompt.archived_at,
            latest_active_version=(
                None
                if prompt.latest_active_version is None
                else LibraryPromptVersionResponse.from_record(prompt.latest_active_version)
            ),
        )


class PromptsResponse(ApiModel):
    prompts: list[PromptListResponse]


class PromptVersionsResponse(ApiModel):
    prompt_versions: list[LibraryPromptVersionResponse]


class PromptCreatedResponse(ApiModel):
    prompt: PromptResponse
    version: LibraryPromptVersionResponse


class WorkflowCreateRequest(ApiModel):
    name: str = Field(min_length=1)
    description: str | None = None
    workflow: dict[str, object]
    note: str | None = None


class WorkflowUpdateRequest(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None

    @model_validator(mode="after")
    def validate_update(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("at least one Workflow field is required")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("Workflow name cannot be null")
        return self


class WorkflowVersionCreateRequest(ApiModel):
    workflow: dict[str, object]
    note: str | None = None


class WorkflowResponse(ApiModel):
    id: str
    project_id: str
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None

    @classmethod
    def from_record(cls, workflow: WorkflowRecord) -> Self:
        return cls(**{field: getattr(workflow, field) for field in cls.model_fields})


class WorkflowVersionResponse(ApiModel):
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

    @classmethod
    def from_record(cls, version: WorkflowVersionRecord) -> Self:
        return cls(**{field: getattr(version, field) for field in cls.model_fields})


class WorkflowListResponse(WorkflowResponse):
    latest_active_version: WorkflowVersionResponse | None

    @classmethod
    def from_list_record(cls, workflow: WorkflowListRecord) -> Self:
        return cls(
            **{field: getattr(workflow, field) for field in WorkflowResponse.model_fields},
            latest_active_version=(
                None
                if workflow.latest_active_version is None
                else WorkflowVersionResponse.from_record(workflow.latest_active_version)
            ),
        )


class WorkflowsResponse(ApiModel):
    workflows: list[WorkflowListResponse]


class WorkflowVersionsResponse(ApiModel):
    workflow_versions: list[WorkflowVersionResponse]


class WorkflowCreatedResponse(ApiModel):
    workflow: WorkflowResponse
    version: WorkflowVersionResponse


class WorkflowProfileCreateRequest(ApiModel):
    name: str = Field(min_length=1)
    description: str | None = None
    workflow_version_id: str = Field(min_length=1)
    mappings: dict[str, object]
    image_inputs: list[dict[str, object]] = Field(default_factory=list)
    parameters: list[dict[str, object]]
    note: str | None = None


class WorkflowProfileUpdateRequest(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None

    @model_validator(mode="after")
    def validate_update(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("at least one Workflow Profile field is required")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("Workflow Profile name cannot be null")
        return self


class WorkflowProfileVersionCreateRequest(ApiModel):
    workflow_version_id: str = Field(min_length=1)
    mappings: dict[str, object]
    image_inputs: list[dict[str, object]] = Field(default_factory=list)
    parameters: list[dict[str, object]]
    note: str | None = None


class WorkflowProfileResponse(ApiModel):
    id: str
    workflow_id: str
    project_id: str
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None

    @classmethod
    def from_record(cls, profile: WorkflowProfileRecord) -> Self:
        return cls(**{field: getattr(profile, field) for field in cls.model_fields})


class WorkflowProfileVersionResponse(ApiModel):
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

    @classmethod
    def from_record(cls, version: WorkflowProfileVersionRecord) -> Self:
        return cls(**{field: getattr(version, field) for field in cls.model_fields})


class WorkflowProfileListResponse(WorkflowProfileResponse):
    latest_compatible_version: WorkflowProfileVersionResponse | None

    @classmethod
    def from_list_record(cls, profile: WorkflowProfileListRecord) -> Self:
        return cls(
            **{field: getattr(profile, field) for field in WorkflowProfileResponse.model_fields},
            latest_compatible_version=(
                None
                if profile.latest_compatible_version is None
                else WorkflowProfileVersionResponse.from_record(profile.latest_compatible_version)
            ),
        )


class WorkflowProfilesResponse(ApiModel):
    workflow_profiles: list[WorkflowProfileListResponse]


class WorkflowProfileVersionsResponse(ApiModel):
    workflow_profile_versions: list[WorkflowProfileVersionResponse]


class WorkflowProfileCreatedResponse(ApiModel):
    workflow_profile: WorkflowProfileResponse
    version: WorkflowProfileVersionResponse


class ComfyUIStatusResponse(ApiModel):
    reachable: bool
    version: str | None
    devices: list[str]
    diagnostic: str | None

    @classmethod
    def from_status(cls, status: ComfyUIStatus) -> Self:
        return cls(
            reachable=status.reachable,
            version=status.version,
            devices=list(status.devices),
            diagnostic=status.diagnostic,
        )


class AssetResponse(ApiModel):
    asset_id: str
    original_filename: str
    content_type: str
    byte_size: int
    sha256: str
    created_at: str
    content_url: str

    @classmethod
    def from_asset(cls, project_key: str, asset: AssetRecord) -> Self:
        return cls(
            asset_id=asset.asset_id,
            original_filename=asset.original_filename,
            content_type=asset.mime_type or "application/octet-stream",
            byte_size=asset.byte_size,
            sha256=asset.sha256,
            created_at=asset.created_at,
            content_url=(
                f"/api/projects/{quote(project_key, safe='')}/assets/"
                f"{quote(asset.asset_id, safe='')}/content"
            ),
        )


class AssetsResponse(ApiModel):
    assets: list[AssetResponse]


class WarningResponse(ApiModel):
    code: str
    message: str
    placeholder: str

    @classmethod
    def from_warning(cls, warning: CompilationWarning) -> Self:
        return cls(
            code=warning.code.value,
            message=warning.message,
            placeholder=warning.placeholder,
        )


class ResolvedVariableResponse(ApiModel):
    name: str
    value: str


class ResolvedImageInputResponse(ApiModel):
    slot_key: str
    label: str
    asset_id: str | None
    filename: str | None = None


class ResolvedParameterResponse(ApiModel):
    parameter_key: str
    label: str
    value: ParameterScalarRequest | None


class JobPreviewResponse(ApiModel):
    ordinal: int
    prompt_version_id: str
    prompt_version_name: str
    resolved_prompt: str
    resolved_variables: list[ResolvedVariableResponse]
    resolved_image_inputs: list["ResolvedImageInputResponse"]
    resolved_parameters: list[ResolvedParameterResponse]
    seed: int

    @classmethod
    def from_job(
        cls,
        job: CompiledJob,
        prompt_version_name: str,
        slot_labels: dict[str, str],
        parameter_labels: dict[str, str],
        image_assets: dict[str, AssetRecord] | None = None,
    ) -> Self:
        return cls(
            ordinal=job.ordinal,
            prompt_version_id=job.prompt_version_id,
            prompt_version_name=prompt_version_name,
            resolved_prompt=job.resolved_prompt,
            resolved_variables=[
                ResolvedVariableResponse(name=variable.name, value=variable.value)
                for variable in job.resolved_variables
            ],
            resolved_image_inputs=[
                ResolvedImageInputResponse(
                    slot_key=item.slot_key,
                    label=slot_labels[item.slot_key],
                    asset_id=item.asset_id,
                    filename=(
                        None
                        if image_assets is None or item.asset_id is None
                        else image_assets[item.asset_id].original_filename
                    ),
                )
                for item in job.resolved_image_inputs
            ],
            resolved_parameters=[
                ResolvedParameterResponse(
                    parameter_key=item.parameter_key,
                    label=parameter_labels[item.parameter_key],
                    value=item.value,
                )
                for item in job.resolved_parameters
            ],
            seed=job.seed,
        )


class PreviewResponse(ApiModel):
    job_count: int
    warnings: list[WarningResponse]
    jobs: list[JobPreviewResponse]

    @classmethod
    def from_plan(
        cls, plan: CompiledRunPlan, image_assets: dict[str, AssetRecord] | None = None
    ) -> Self:
        prompt_names = {version.id: version.name for version in plan.prompt_versions}
        slot_labels = {slot.key: slot.label for slot in plan.image_input_slots}
        parameter_labels = {parameter.key: parameter.label for parameter in plan.parameters}
        return cls(
            job_count=plan.job_count,
            warnings=[WarningResponse.from_warning(warning) for warning in plan.warnings],
            jobs=[
                JobPreviewResponse.from_job(
                    job,
                    prompt_names[job.prompt_version_id],
                    slot_labels,
                    parameter_labels,
                    image_assets,
                )
                for job in plan.jobs
            ],
        )


class JobExecutionResponse(ApiModel):
    ordinal: int
    status: str
    prompt_id: str | None
    started_at: str | None
    completed_at: str | None
    error: str | None
    diagnostics: list[str]
    result_count: int


class ExecutionResponse(ApiModel):
    run_id: str
    status: str
    started_at: str | None
    completed_at: str | None
    current_job_ordinal: int | None
    error: str | None
    diagnostics: list[str]
    jobs: list[JobExecutionResponse]

    @classmethod
    def from_state(cls, state: RunExecutionState) -> Self:
        return cls(
            run_id=state.run_id,
            status=state.status.value,
            started_at=state.started_at,
            completed_at=state.completed_at,
            current_job_ordinal=state.current_job_ordinal,
            error=state.error,
            diagnostics=list(state.diagnostics),
            jobs=[
                JobExecutionResponse(
                    ordinal=job.ordinal,
                    status=job.status.value,
                    prompt_id=job.prompt_id,
                    started_at=job.started_at,
                    completed_at=job.completed_at,
                    error=job.error,
                    diagnostics=list(job.diagnostics),
                    result_count=len(job.results),
                )
                for job in state.jobs
            ],
        )


class RunCreatedResponse(ApiModel):
    run_id: str
    run_number: int
    project_id: str
    project_name: str
    batch_id: str
    batch_name: str
    job_count: int
    durable_status: str

    @classmethod
    def from_run(cls, run: PublishedRun) -> Self:
        return cls(
            run_id=run.run_id,
            run_number=run.run_number,
            project_id=run.project.id,
            project_name=run.project.name,
            batch_id=run.batch.id,
            batch_name=run.batch.name,
            job_count=run.compiled_plan.job_count,
            durable_status="created",
        )


class PromptSnapshotResponse(ApiModel):
    id: str
    name: str
    text: str


class RunJobResponse(ApiModel):
    ordinal: int
    prompt_version_id: str


class RunPlanResponse(ApiModel):
    job_count: int
    warnings: list[WarningResponse]
    jobs: list[JobPreviewResponse]

    @classmethod
    def from_run(cls, run: PublishedRun) -> Self:
        prompt_names = {version.id: version.name for version in run.compiled_plan.prompt_versions}
        slot_labels = {slot.key: slot.label for slot in run.compiled_plan.image_input_slots}
        parameter_labels = {
            parameter.key: parameter.label for parameter in run.compiled_plan.parameters
        }
        return cls(
            job_count=run.compiled_plan.job_count,
            warnings=[
                WarningResponse.from_warning(warning) for warning in run.compiled_plan.warnings
            ],
            jobs=[
                JobPreviewResponse.model_validate(
                    {
                        **JobPreviewResponse.from_job(
                            persisted.compiled_job,
                            prompt_names[persisted.compiled_job.prompt_version_id],
                            slot_labels,
                            parameter_labels,
                        ).model_dump(),
                        "resolved_image_inputs": [
                            ResolvedImageInputResponse(
                                slot_key=item.slot_key,
                                label=item.slot_label,
                                asset_id=(None if item.asset is None else item.asset.asset_id),
                                filename=(
                                    None if item.asset is None else item.asset.original_filename
                                ),
                            )
                            for item in persisted.image_inputs
                        ],
                    }
                )
                for persisted in run.jobs
            ],
        )


class RunResponse(RunCreatedResponse):
    created_at: str
    prompt_versions: list[PromptSnapshotResponse]
    jobs: list[RunJobResponse]
    plan: RunPlanResponse
    batch_snapshot: BatchSnapshotV4
    execution: ExecutionResponse

    @classmethod
    def from_run_and_state(cls, run: PublishedRun, state: RunExecutionState) -> Self:
        created = RunCreatedResponse.from_run(run)
        return cls(
            **created.model_dump(),
            created_at=run.created_at,
            prompt_versions=[
                PromptSnapshotResponse(id=version.id, name=version.name, text=version.text)
                for version in run.compiled_plan.prompt_versions
            ],
            jobs=[
                RunJobResponse(
                    ordinal=job.ordinal,
                    prompt_version_id=job.prompt_version_id,
                )
                for job in run.compiled_plan.jobs
            ],
            plan=RunPlanResponse.from_run(run),
            batch_snapshot=BatchSnapshotV4.model_validate(run.batch_snapshot),
            execution=ExecutionResponse.from_state(state),
        )


class ExecutionStartedResponse(ApiModel):
    run_id: str
    status: str


class ResultResponse(ApiModel):
    job_ordinal: int
    artifact_ordinal: int
    producing_node_id: str
    output_name: str
    remote_filename: str
    content_type: str | None
    byte_size: int
    sha256: str
    download_url: str

    @classmethod
    def from_result(cls, run_id: str, result: ResultRecord) -> Self:
        return cls(
            job_ordinal=result.job_ordinal,
            artifact_ordinal=result.artifact_ordinal,
            producing_node_id=result.producing_node_id,
            output_name=result.output_name,
            remote_filename=result.remote_filename,
            content_type=result.content_type,
            byte_size=result.byte_size,
            sha256=result.sha256,
            download_url=(
                f"/api/runs/{run_id}/results/{result.job_ordinal}/{result.artifact_ordinal}"
            ),
        )


class ResultsResponse(ApiModel):
    run_id: str
    results: list[ResultResponse]


def _validate_image_binding_values(values: list[str | None]) -> None:
    if any(value is not None and not value.strip() for value in values):
        raise ValueError("image binding values must be nonblank asset IDs or null")
    if len(set(values)) != len(values):
        raise ValueError("image binding values must not contain exact duplicates")
    if None in values and values[0] is not None:
        raise ValueError("image binding values must place Base workflow first")


def _profile_image_inputs(profile: dict[str, object]) -> tuple[tuple[str, str, str, str], ...]:
    return workflow_profile_image_inputs(profile)


def _profile_parameters(profile: dict[str, object]) -> tuple[WorkflowParameter, ...]:
    return workflow_profile_parameters(profile)


class ErrorDetail(ApiModel):
    code: str
    message: str


class ErrorResponse(ApiModel):
    error: ErrorDetail
