from typing import Self
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field

from batchcraft.application import ComfyUIStatus, RunCreationInput
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
    prompt_version: PromptVersionRequest
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
                prompt_version=PromptVersion(
                    id=self.prompt_version.id,
                    text=self.prompt_version.text,
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
    resolved_prompt: str
    resolved_variables: list[ResolvedVariableResponse]
    reference_asset_id: str
    seed: int

    @classmethod
    def from_job(cls, job: CompiledJob) -> Self:
        return cls(
            ordinal=job.ordinal,
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
        return cls(
            job_count=plan.job_count,
            warnings=[WarningResponse.from_warning(warning) for warning in plan.warnings],
            jobs=[JobPreviewResponse.from_job(job) for job in plan.jobs],
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


class RunResponse(RunCreatedResponse):
    created_at: str
    execution: ExecutionResponse

    @classmethod
    def from_run_and_state(cls, run: PublishedRun, state: RunExecutionState) -> Self:
        created = RunCreatedResponse.from_run(run)
        return cls(
            **created.model_dump(),
            created_at=run.created_at,
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
