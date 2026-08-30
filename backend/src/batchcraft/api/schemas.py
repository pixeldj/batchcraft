from datetime import datetime
from typing import Self
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, model_validator

from batchcraft.application import ComfyUIStatus, RunCreationInput
from batchcraft.db import ProjectRecord, PromptRecord, PromptVersionRecord
from batchcraft.domain import (
    BatchDefinition,
    CompilationWarning,
    CompiledJob,
    CompiledRunPlan,
    PromptVersion,
    ReferenceSelection,
    SeedInput,
    SeedMode,
    VariableBinding,
    VariableBindingMode,
    VariableList,
)
from batchcraft.execution import ResultRecord, RunExecutionState
from batchcraft.files import AssetRecord, BatchIdentity, ProjectIdentity, PublishedRun


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


class VariableListRequest(ApiModel):
    id: str = Field(min_length=1)
    values: list[str]


class VariableBindingRequest(ApiModel):
    placeholder: str = Field(min_length=1)
    variable_list: VariableListRequest
    mode: VariableBindingMode
    selected_values: list[str] = Field(default_factory=list)
    fixed_value: str | None = None


class ReferenceRequest(ApiModel):
    asset_id: str = Field(min_length=1)


class SeedRequest(ApiModel):
    mode: SeedMode
    values: list[int]


class BatchRequest(ApiModel):
    project: IdentityRequest
    batch: IdentityRequest
    prompt_versions: list[PromptVersionRequest] = Field(min_length=1)
    variable_bindings: list[VariableBindingRequest] = Field(default_factory=list)
    references: list[ReferenceRequest]
    seeds: SeedRequest
    workflow: dict[str, object]
    workflow_profile: dict[str, object]

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
                        variable_list=VariableList(
                            id=binding.variable_list.id,
                            values=tuple(binding.variable_list.values),
                        ),
                        mode=binding.mode,
                        selected_values=tuple(binding.selected_values),
                        fixed_value=binding.fixed_value,
                    )
                    for binding in self.variable_bindings
                ),
                references=tuple(
                    ReferenceSelection(asset_id=reference.asset_id) for reference in self.references
                ),
                seeds=SeedInput(mode=self.seeds.mode, values=tuple(self.seeds.values)),
            ),
            workflow=self.workflow,
            workflow_profile=self.workflow_profile,
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


class PromptsResponse(ApiModel):
    prompts: list[PromptResponse]


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


class PromptVersionsResponse(ApiModel):
    prompt_versions: list[LibraryPromptVersionResponse]


class PromptCreatedResponse(ApiModel):
    prompt: PromptResponse
    version: LibraryPromptVersionResponse


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


class JobPreviewResponse(ApiModel):
    ordinal: int
    prompt_version_id: str
    prompt_version_name: str
    resolved_prompt: str
    resolved_variables: list[ResolvedVariableResponse]
    reference_asset_id: str
    seed: int

    @classmethod
    def from_job(cls, job: CompiledJob, prompt_version_name: str) -> Self:
        return cls(
            ordinal=job.ordinal,
            prompt_version_id=job.prompt_version_id,
            prompt_version_name=prompt_version_name,
            resolved_prompt=job.resolved_prompt,
            resolved_variables=[
                ResolvedVariableResponse(name=variable.name, value=variable.value)
                for variable in job.resolved_variables
            ],
            reference_asset_id=job.reference_asset_id,
            seed=job.seed,
        )


class PreviewResponse(ApiModel):
    job_count: int
    warnings: list[WarningResponse]
    jobs: list[JobPreviewResponse]

    @classmethod
    def from_plan(cls, plan: CompiledRunPlan) -> Self:
        prompt_names = {version.id: version.name for version in plan.prompt_versions}
        return cls(
            job_count=plan.job_count,
            warnings=[WarningResponse.from_warning(warning) for warning in plan.warnings],
            jobs=[
                JobPreviewResponse.from_job(job, prompt_names[job.prompt_version_id])
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


class RunResponse(RunCreatedResponse):
    created_at: str
    prompt_versions: list[PromptSnapshotResponse]
    jobs: list[RunJobResponse]
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


class ErrorDetail(ApiModel):
    code: str
    message: str


class ErrorResponse(ApiModel):
    error: ErrorDetail
