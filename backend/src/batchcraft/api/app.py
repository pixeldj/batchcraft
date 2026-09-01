import asyncio
import logging
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, closing
from datetime import datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Annotated, cast

from fastapi import Depends, FastAPI, File, Request, UploadFile, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from batchcraft.application import (
    ApplicationComfyUIClient,
    AssetDataError,
    AssetImportInput,
    AssetNotFoundError,
    AssetPublicationError,
    AssetUploadError,
    BatchcraftService,
    ExecutionAlreadyActiveError,
    ExecutionNotEligibleError,
    InvalidProjectKeyError,
    LibraryService,
    ProjectAdoptionError,
    ProjectDiscoveryError,
    ProjectPublicationError,
    ResultNotFoundError,
    RunCreationError,
    RunDataError,
    RunDiscardNotEligibleError,
    RunExecutor,
    RunNotFoundError,
    RunPublicationError,
    RunTaskRegistry,
    SavedBatchAdoptionError,
    SavedBatchDiscoveryError,
    SavedBatchOwnershipError,
    SavedBatchPublicationError,
    SavedBatchRevisionConflictError,
)
from batchcraft.comfyui import ComfyUIClient, WorkflowPreparationError
from batchcraft.db import (
    ProjectConflictError,
    ProjectNotFoundError,
    ProjectStore,
    ProjectValidationError,
    PromptConflictError,
    PromptNotFoundError,
    PromptProjectNotFoundError,
    PromptStore,
    PromptValidationError,
    PromptVersionConflictError,
    PromptVersionNotFoundError,
    SavedBatchConflictError,
    SavedBatchIntegrityError,
    SavedBatchNotFoundError,
    SavedBatchStore,
    SavedBatchValidationError,
    WorkflowConflictError,
    WorkflowNotFoundError,
    WorkflowProfileConflictError,
    WorkflowProfileNotFoundError,
    WorkflowProfileOwnershipError,
    WorkflowProfileStore,
    WorkflowProfileValidationError,
    WorkflowProfileVersionConflictError,
    WorkflowProfileVersionNotFoundError,
    WorkflowProfileWorkflowNotFoundError,
    WorkflowProfileWorkflowVersionNotFoundError,
    WorkflowProjectNotFoundError,
    WorkflowStore,
    WorkflowValidationError,
    WorkflowVersionConflictError,
    WorkflowVersionNotFoundError,
    apply_migrations,
    open_connection,
)
from batchcraft.domain import CompilationError
from batchcraft.execution import execute_run
from batchcraft.files import ProjectOwnerStore

from .config import Settings
from .schemas import (
    AdoptableBatchesResponse,
    AdoptableBatchResponse,
    AdoptableProjectResponse,
    AdoptableProjectsResponse,
    AssetResponse,
    AssetsResponse,
    BatchRequest,
    ComfyUIStatusResponse,
    ErrorDetail,
    ErrorResponse,
    ExecutionResponse,
    ExecutionStartedResponse,
    HealthResponse,
    LibraryPromptVersionResponse,
    PreviewResponse,
    ProjectAdoptRequest,
    ProjectCreateRequest,
    ProjectResponse,
    ProjectsResponse,
    ProjectUpdateRequest,
    PromptCreatedResponse,
    PromptCreateRequest,
    PromptListResponse,
    PromptResponse,
    PromptsResponse,
    PromptUpdateRequest,
    PromptVersionCreateRequest,
    PromptVersionsResponse,
    ResultResponse,
    ResultsResponse,
    RunCreatedResponse,
    RunResponse,
    SavedBatchAdoptRequest,
    SavedBatchCreateRequest,
    SavedBatchDetailResponse,
    SavedBatchesResponse,
    SavedBatchListResponse,
    SavedBatchUpdateRequest,
    WorkflowCreatedResponse,
    WorkflowCreateRequest,
    WorkflowListResponse,
    WorkflowProfileCreatedResponse,
    WorkflowProfileCreateRequest,
    WorkflowProfileListResponse,
    WorkflowProfileResponse,
    WorkflowProfilesResponse,
    WorkflowProfileUpdateRequest,
    WorkflowProfileVersionCreateRequest,
    WorkflowProfileVersionResponse,
    WorkflowProfileVersionsResponse,
    WorkflowResponse,
    WorkflowsResponse,
    WorkflowUpdateRequest,
    WorkflowVersionCreateRequest,
    WorkflowVersionResponse,
    WorkflowVersionsResponse,
)

logger = logging.getLogger(__name__)
ClientFactory = Callable[[Settings], ApplicationComfyUIClient]


def _service(request: Request) -> BatchcraftService:
    return cast(BatchcraftService, request.app.state.service)


ServiceDependency = Annotated[BatchcraftService, Depends(_service)]


def _library(request: Request) -> LibraryService:
    return cast(LibraryService, request.app.state.library_service)


LibraryDependency = Annotated[LibraryService, Depends(_library)]


def create_app(
    settings: Settings | None = None,
    *,
    client_factory: ClientFactory | None = None,
    executor: RunExecutor = execute_run,
    clock: Callable[[], datetime] | None = None,
) -> FastAPI:
    configured = settings or Settings.from_env()
    make_client = client_factory or _create_comfyui_client

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configured.database_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(open_connection(configured.database_path)) as connection:
            apply_migrations(connection)
        client = make_client(configured)
        registry = RunTaskRegistry()
        app.state.service = BatchcraftService(
            projects_root=configured.projects_root,
            comfyui_client=client,
            task_registry=registry,
            execution_config=configured.execution_config,
            executor=executor,
            clock=clock,
        )
        app.state.library_service = LibraryService(
            project_store=ProjectStore(configured.database_path),
            prompt_store=PromptStore(configured.database_path),
            workflow_store=WorkflowStore(configured.database_path),
            workflow_profile_store=WorkflowProfileStore(configured.database_path),
            saved_batch_store=SavedBatchStore(configured.database_path),
            owner_store=ProjectOwnerStore(configured.projects_root),
        )
        try:
            yield
        finally:
            await registry.shutdown()
            await client.aclose()

    app = FastAPI(
        title="batchcraft API",
        version=_package_version(),
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[configured.frontend_origin],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["Content-Type"],
    )
    _register_error_handlers(app)

    @app.get("/api/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", version=_package_version())

    @app.get("/api/comfyui/status", response_model=ComfyUIStatusResponse)
    async def comfyui_status(service: ServiceDependency) -> ComfyUIStatusResponse:
        return ComfyUIStatusResponse.from_status(await service.get_comfyui_status())

    @app.get("/api/projects", response_model=ProjectsResponse)
    async def list_projects(
        library: LibraryDependency, include_archived: bool = False
    ) -> ProjectsResponse:
        projects = await asyncio.to_thread(library.list_projects, include_archived=include_archived)
        return ProjectsResponse(projects=[ProjectResponse.from_record(item) for item in projects])

    @app.post(
        "/api/projects",
        response_model=ProjectResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_project(
        request: ProjectCreateRequest, library: LibraryDependency
    ) -> ProjectResponse:
        project = await asyncio.to_thread(
            library.create_project,
            name=request.name,
            filesystem_key=request.filesystem_key,
            description=request.description,
        )
        return ProjectResponse.from_record(project)

    @app.post(
        "/api/projects/adopt",
        response_model=ProjectResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def adopt_project(
        request: ProjectAdoptRequest, library: LibraryDependency
    ) -> ProjectResponse:
        project = await asyncio.to_thread(
            library.adopt_project,
            filesystem_key=request.filesystem_key,
            project_id=request.project_id,
            name=request.name,
            description=request.description,
        )
        return ProjectResponse.from_record(project)

    @app.get("/api/projects/adoptable", response_model=AdoptableProjectsResponse)
    async def list_adoptable_projects(
        library: LibraryDependency,
    ) -> AdoptableProjectsResponse:
        projects = await asyncio.to_thread(library.list_adoptable_projects)
        return AdoptableProjectsResponse(
            projects=[AdoptableProjectResponse.from_candidate(item) for item in projects]
        )

    @app.get("/api/projects/{project_id}", response_model=ProjectResponse)
    async def get_project(project_id: str, library: LibraryDependency) -> ProjectResponse:
        return ProjectResponse.from_record(await asyncio.to_thread(library.get_project, project_id))

    @app.patch("/api/projects/{project_id}", response_model=ProjectResponse)
    async def update_project(
        project_id: str, request: ProjectUpdateRequest, library: LibraryDependency
    ) -> ProjectResponse:
        project = await asyncio.to_thread(
            library.update_project,
            project_id,
            name=request.name,
            description=request.description,
            update_description="description" in request.model_fields_set,
        )
        return ProjectResponse.from_record(project)

    @app.post("/api/projects/{project_id}/archive", response_model=ProjectResponse)
    async def archive_project(project_id: str, library: LibraryDependency) -> ProjectResponse:
        return ProjectResponse.from_record(
            await asyncio.to_thread(library.archive_project, project_id)
        )

    @app.get(
        "/api/projects/{project_id}/batches/adoptable",
        response_model=AdoptableBatchesResponse,
    )
    async def list_adoptable_saved_batches(
        project_id: str, library: LibraryDependency
    ) -> AdoptableBatchesResponse:
        batches = await asyncio.to_thread(library.list_adoptable_saved_batches, project_id)
        return AdoptableBatchesResponse(
            batches=[AdoptableBatchResponse.from_candidate(item) for item in batches]
        )

    @app.get("/api/projects/{project_id}/batches", response_model=SavedBatchesResponse)
    async def list_saved_batches(
        project_id: str,
        library: LibraryDependency,
        include_archived: bool = False,
    ) -> SavedBatchesResponse:
        batches = await asyncio.to_thread(
            library.list_saved_batches, project_id, include_archived=include_archived
        )
        return SavedBatchesResponse(
            batches=[SavedBatchListResponse.from_record(item) for item in batches]
        )

    @app.post(
        "/api/projects/{project_id}/batches",
        response_model=SavedBatchDetailResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_saved_batch(
        project_id: str,
        request: SavedBatchCreateRequest,
        library: LibraryDependency,
    ) -> SavedBatchDetailResponse:
        batch = await asyncio.to_thread(
            library.create_saved_batch,
            project_id,
            filesystem_key=request.filesystem_key,
            definition=request.to_definition(),
        )
        return SavedBatchDetailResponse.from_detail(batch)

    @app.post(
        "/api/projects/{project_id}/batches/adopt",
        response_model=SavedBatchDetailResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def adopt_saved_batch(
        project_id: str,
        request: SavedBatchAdoptRequest,
        library: LibraryDependency,
    ) -> SavedBatchDetailResponse:
        batch = await asyncio.to_thread(
            library.adopt_saved_batch,
            project_id,
            filesystem_key=request.filesystem_key,
            batch_id=request.batch_id,
            definition=request.to_definition(),
        )
        return SavedBatchDetailResponse.from_detail(batch)

    @app.get("/api/batches/{batch_id}", response_model=SavedBatchDetailResponse)
    async def get_saved_batch(
        batch_id: str, library: LibraryDependency
    ) -> SavedBatchDetailResponse:
        return SavedBatchDetailResponse.from_detail(
            await asyncio.to_thread(library.get_saved_batch, batch_id)
        )

    @app.patch("/api/batches/{batch_id}", response_model=SavedBatchDetailResponse)
    async def update_saved_batch(
        batch_id: str,
        request: SavedBatchUpdateRequest,
        library: LibraryDependency,
    ) -> SavedBatchDetailResponse:
        batch = await asyncio.to_thread(
            library.update_saved_batch,
            batch_id,
            definition=request.to_definition(),
            expected_revision=request.expected_revision,
        )
        return SavedBatchDetailResponse.from_detail(batch)

    @app.post("/api/batches/{batch_id}/archive", response_model=SavedBatchDetailResponse)
    async def archive_saved_batch(
        batch_id: str, library: LibraryDependency
    ) -> SavedBatchDetailResponse:
        return SavedBatchDetailResponse.from_detail(
            await asyncio.to_thread(library.archive_saved_batch, batch_id)
        )

    @app.get("/api/projects/{project_id}/prompts", response_model=PromptsResponse)
    async def list_prompts(
        project_id: str,
        library: LibraryDependency,
        include_archived: bool = False,
    ) -> PromptsResponse:
        prompts = await asyncio.to_thread(
            library.list_prompts, project_id, include_archived=include_archived
        )
        return PromptsResponse(
            prompts=[PromptListResponse.from_list_record(item) for item in prompts]
        )

    @app.post(
        "/api/projects/{project_id}/prompts",
        response_model=PromptCreatedResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_prompt(
        project_id: str, request: PromptCreateRequest, library: LibraryDependency
    ) -> PromptCreatedResponse:
        prompt, prompt_version = await asyncio.to_thread(
            library.create_prompt,
            project_id,
            name=request.name,
            description=request.description,
            text=request.text,
            note=request.note,
        )
        return PromptCreatedResponse(
            prompt=PromptResponse.from_record(prompt),
            version=LibraryPromptVersionResponse.from_record(prompt_version),
        )

    @app.get("/api/prompts/{prompt_id}", response_model=PromptResponse)
    async def get_prompt(prompt_id: str, library: LibraryDependency) -> PromptResponse:
        return PromptResponse.from_record(await asyncio.to_thread(library.get_prompt, prompt_id))

    @app.patch("/api/prompts/{prompt_id}", response_model=PromptResponse)
    async def update_prompt(
        prompt_id: str, request: PromptUpdateRequest, library: LibraryDependency
    ) -> PromptResponse:
        prompt = await asyncio.to_thread(
            library.update_prompt,
            prompt_id,
            name=request.name,
            description=request.description,
            update_description="description" in request.model_fields_set,
        )
        return PromptResponse.from_record(prompt)

    @app.post("/api/prompts/{prompt_id}/archive", response_model=PromptResponse)
    async def archive_prompt(prompt_id: str, library: LibraryDependency) -> PromptResponse:
        return PromptResponse.from_record(
            await asyncio.to_thread(library.archive_prompt, prompt_id)
        )

    @app.get("/api/prompts/{prompt_id}/versions", response_model=PromptVersionsResponse)
    async def list_prompt_versions(
        prompt_id: str,
        library: LibraryDependency,
        include_archived: bool = False,
    ) -> PromptVersionsResponse:
        versions = await asyncio.to_thread(
            library.list_prompt_versions, prompt_id, include_archived=include_archived
        )
        return PromptVersionsResponse(
            prompt_versions=[LibraryPromptVersionResponse.from_record(item) for item in versions]
        )

    @app.post(
        "/api/prompts/{prompt_id}/versions",
        response_model=LibraryPromptVersionResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_prompt_version(
        prompt_id: str,
        request: PromptVersionCreateRequest,
        library: LibraryDependency,
    ) -> LibraryPromptVersionResponse:
        prompt_version = await asyncio.to_thread(
            library.create_prompt_version,
            prompt_id,
            text=request.text,
            note=request.note,
        )
        return LibraryPromptVersionResponse.from_record(prompt_version)

    @app.get("/api/prompt-versions/{version_id}", response_model=LibraryPromptVersionResponse)
    async def get_prompt_version(
        version_id: str, library: LibraryDependency
    ) -> LibraryPromptVersionResponse:
        return LibraryPromptVersionResponse.from_record(
            await asyncio.to_thread(library.get_prompt_version, version_id)
        )

    @app.post(
        "/api/prompt-versions/{version_id}/archive",
        response_model=LibraryPromptVersionResponse,
    )
    async def archive_prompt_version(
        version_id: str, library: LibraryDependency
    ) -> LibraryPromptVersionResponse:
        return LibraryPromptVersionResponse.from_record(
            await asyncio.to_thread(library.archive_prompt_version, version_id)
        )

    @app.post(
        "/api/prompt-versions/{version_id}/restore",
        response_model=LibraryPromptVersionResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def restore_prompt_version(
        version_id: str, library: LibraryDependency
    ) -> LibraryPromptVersionResponse:
        return LibraryPromptVersionResponse.from_record(
            await asyncio.to_thread(library.restore_prompt_version, version_id)
        )

    @app.get("/api/projects/{project_id}/workflows", response_model=WorkflowsResponse)
    async def list_workflows(
        project_id: str,
        library: LibraryDependency,
        include_archived: bool = False,
    ) -> WorkflowsResponse:
        workflows = await asyncio.to_thread(
            library.list_workflows, project_id, include_archived=include_archived
        )
        return WorkflowsResponse(
            workflows=[WorkflowListResponse.from_list_record(item) for item in workflows]
        )

    @app.post(
        "/api/projects/{project_id}/workflows",
        response_model=WorkflowCreatedResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_workflow(
        project_id: str,
        request: WorkflowCreateRequest,
        library: LibraryDependency,
    ) -> WorkflowCreatedResponse:
        workflow, workflow_version = await asyncio.to_thread(
            library.create_workflow,
            project_id,
            name=request.name,
            description=request.description,
            workflow=request.workflow,
            note=request.note,
        )
        return WorkflowCreatedResponse(
            workflow=WorkflowResponse.from_record(workflow),
            version=WorkflowVersionResponse.from_record(workflow_version),
        )

    @app.get("/api/workflows/{workflow_id}", response_model=WorkflowResponse)
    async def get_workflow(workflow_id: str, library: LibraryDependency) -> WorkflowResponse:
        return WorkflowResponse.from_record(
            await asyncio.to_thread(library.get_workflow, workflow_id)
        )

    @app.patch("/api/workflows/{workflow_id}", response_model=WorkflowResponse)
    async def update_workflow(
        workflow_id: str,
        request: WorkflowUpdateRequest,
        library: LibraryDependency,
    ) -> WorkflowResponse:
        workflow = await asyncio.to_thread(
            library.update_workflow,
            workflow_id,
            name=request.name,
            description=request.description,
            update_description="description" in request.model_fields_set,
        )
        return WorkflowResponse.from_record(workflow)

    @app.post("/api/workflows/{workflow_id}/archive", response_model=WorkflowResponse)
    async def archive_workflow(workflow_id: str, library: LibraryDependency) -> WorkflowResponse:
        return WorkflowResponse.from_record(
            await asyncio.to_thread(library.archive_workflow, workflow_id)
        )

    @app.get("/api/workflows/{workflow_id}/versions", response_model=WorkflowVersionsResponse)
    async def list_workflow_versions(
        workflow_id: str,
        library: LibraryDependency,
        include_archived: bool = False,
    ) -> WorkflowVersionsResponse:
        versions = await asyncio.to_thread(
            library.list_workflow_versions,
            workflow_id,
            include_archived=include_archived,
        )
        return WorkflowVersionsResponse(
            workflow_versions=[WorkflowVersionResponse.from_record(item) for item in versions]
        )

    @app.post(
        "/api/workflows/{workflow_id}/versions",
        response_model=WorkflowVersionResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_workflow_version(
        workflow_id: str,
        request: WorkflowVersionCreateRequest,
        library: LibraryDependency,
    ) -> WorkflowVersionResponse:
        version = await asyncio.to_thread(
            library.create_workflow_version,
            workflow_id,
            workflow=request.workflow,
            note=request.note,
        )
        return WorkflowVersionResponse.from_record(version)

    @app.get("/api/workflow-versions/{version_id}", response_model=WorkflowVersionResponse)
    async def get_workflow_version(
        version_id: str, library: LibraryDependency
    ) -> WorkflowVersionResponse:
        return WorkflowVersionResponse.from_record(
            await asyncio.to_thread(library.get_workflow_version, version_id)
        )

    @app.post(
        "/api/workflow-versions/{version_id}/archive",
        response_model=WorkflowVersionResponse,
    )
    async def archive_workflow_version(
        version_id: str, library: LibraryDependency
    ) -> WorkflowVersionResponse:
        return WorkflowVersionResponse.from_record(
            await asyncio.to_thread(library.archive_workflow_version, version_id)
        )

    @app.get(
        "/api/workflows/{workflow_id}/profiles",
        response_model=WorkflowProfilesResponse,
    )
    async def list_workflow_profiles(
        workflow_id: str,
        library: LibraryDependency,
        workflow_version_id: str | None = None,
        include_archived: bool = False,
    ) -> WorkflowProfilesResponse:
        profiles = await asyncio.to_thread(
            library.list_workflow_profiles,
            workflow_id,
            workflow_version_id=workflow_version_id,
            include_archived=include_archived,
        )
        return WorkflowProfilesResponse(
            workflow_profiles=[
                WorkflowProfileListResponse.from_list_record(item) for item in profiles
            ]
        )

    @app.post(
        "/api/workflows/{workflow_id}/profiles",
        response_model=WorkflowProfileCreatedResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_workflow_profile(
        workflow_id: str,
        request: WorkflowProfileCreateRequest,
        library: LibraryDependency,
    ) -> WorkflowProfileCreatedResponse:
        profile, profile_version = await asyncio.to_thread(
            library.create_workflow_profile,
            workflow_id,
            name=request.name,
            description=request.description,
            workflow_version_id=request.workflow_version_id,
            mappings=request.mappings,
            image_inputs=request.image_inputs,
            parameters=request.parameters,
            note=request.note,
        )
        return WorkflowProfileCreatedResponse(
            workflow_profile=WorkflowProfileResponse.from_record(profile),
            version=WorkflowProfileVersionResponse.from_record(profile_version),
        )

    @app.get("/api/workflow-profiles/{profile_id}", response_model=WorkflowProfileResponse)
    async def get_workflow_profile(
        profile_id: str, library: LibraryDependency
    ) -> WorkflowProfileResponse:
        return WorkflowProfileResponse.from_record(
            await asyncio.to_thread(library.get_workflow_profile, profile_id)
        )

    @app.patch("/api/workflow-profiles/{profile_id}", response_model=WorkflowProfileResponse)
    async def update_workflow_profile(
        profile_id: str,
        request: WorkflowProfileUpdateRequest,
        library: LibraryDependency,
    ) -> WorkflowProfileResponse:
        profile = await asyncio.to_thread(
            library.update_workflow_profile,
            profile_id,
            name=request.name,
            description=request.description,
            update_description="description" in request.model_fields_set,
        )
        return WorkflowProfileResponse.from_record(profile)

    @app.post(
        "/api/workflow-profiles/{profile_id}/archive",
        response_model=WorkflowProfileResponse,
    )
    async def archive_workflow_profile(
        profile_id: str, library: LibraryDependency
    ) -> WorkflowProfileResponse:
        return WorkflowProfileResponse.from_record(
            await asyncio.to_thread(library.archive_workflow_profile, profile_id)
        )

    @app.get(
        "/api/workflow-profiles/{profile_id}/versions",
        response_model=WorkflowProfileVersionsResponse,
    )
    async def list_workflow_profile_versions(
        profile_id: str,
        library: LibraryDependency,
        include_archived: bool = False,
    ) -> WorkflowProfileVersionsResponse:
        versions = await asyncio.to_thread(
            library.list_workflow_profile_versions,
            profile_id,
            include_archived=include_archived,
        )
        return WorkflowProfileVersionsResponse(
            workflow_profile_versions=[
                WorkflowProfileVersionResponse.from_record(item) for item in versions
            ]
        )

    @app.post(
        "/api/workflow-profiles/{profile_id}/versions",
        response_model=WorkflowProfileVersionResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_workflow_profile_version(
        profile_id: str,
        request: WorkflowProfileVersionCreateRequest,
        library: LibraryDependency,
    ) -> WorkflowProfileVersionResponse:
        version = await asyncio.to_thread(
            library.create_workflow_profile_version,
            profile_id,
            workflow_version_id=request.workflow_version_id,
            mappings=request.mappings,
            image_inputs=request.image_inputs,
            parameters=request.parameters,
            note=request.note,
        )
        return WorkflowProfileVersionResponse.from_record(version)

    @app.get(
        "/api/workflow-profile-versions/{version_id}",
        response_model=WorkflowProfileVersionResponse,
    )
    async def get_workflow_profile_version(
        version_id: str, library: LibraryDependency
    ) -> WorkflowProfileVersionResponse:
        return WorkflowProfileVersionResponse.from_record(
            await asyncio.to_thread(library.get_workflow_profile_version, version_id)
        )

    @app.post(
        "/api/workflow-profile-versions/{version_id}/archive",
        response_model=WorkflowProfileVersionResponse,
    )
    async def archive_workflow_profile_version(
        version_id: str, library: LibraryDependency
    ) -> WorkflowProfileVersionResponse:
        return WorkflowProfileVersionResponse.from_record(
            await asyncio.to_thread(library.archive_workflow_profile_version, version_id)
        )

    @app.get("/api/projects/{project_key}/assets", response_model=AssetsResponse)
    async def list_project_assets(
        project_key: str,
        service: ServiceDependency,
    ) -> AssetsResponse:
        return AssetsResponse(
            assets=[
                AssetResponse.from_asset(project_key, asset)
                for asset in service.list_project_assets(project_key)
            ]
        )

    @app.post(
        "/api/projects/{project_key}/assets",
        response_model=AssetsResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def import_project_assets(
        project_key: str,
        service: ServiceDependency,
        files: Annotated[list[UploadFile], File()],
    ) -> AssetsResponse:
        with tempfile.TemporaryDirectory(prefix="batchcraft-assets-") as temporary_directory:
            try:
                staged = await _stage_asset_uploads(files, Path(temporary_directory))
                assets = service.import_project_assets(project_key, staged)
            finally:
                for upload in files:
                    await upload.close()
        return AssetsResponse(
            assets=[AssetResponse.from_asset(project_key, asset) for asset in assets]
        )

    @app.get("/api/projects/{project_key}/assets/{asset_id}/content")
    async def get_project_asset_content(
        project_key: str,
        asset_id: str,
        service: ServiceDependency,
    ) -> Response:
        asset, content = service.get_project_asset_content(project_key, asset_id)
        return Response(content=content, media_type=asset.mime_type)

    @app.post("/api/batches/preview", response_model=PreviewResponse)
    async def preview_batch(
        request: BatchRequest,
        service: ServiceDependency,
    ) -> PreviewResponse:
        creation = request.to_creation_input()
        plan, image_assets = service.preview_batch(creation)
        return PreviewResponse.from_plan(plan, image_assets)

    @app.post(
        "/api/runs",
        response_model=RunCreatedResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_run(
        request: BatchRequest,
        service: ServiceDependency,
    ) -> RunCreatedResponse:
        return RunCreatedResponse.from_run(service.create_run(request.to_creation_input()))

    @app.get("/api/runs/{run_id}", response_model=RunResponse)
    async def get_run(
        run_id: str,
        service: ServiceDependency,
    ) -> RunResponse:
        run = service.get_run(run_id)
        return RunResponse.from_run_and_state(run, service.get_execution_state(run))

    @app.post(
        "/api/runs/{run_id}/execute",
        response_model=ExecutionStartedResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def start_execution(
        run_id: str,
        service: ServiceDependency,
    ) -> ExecutionStartedResponse:
        run = await service.start_execution(run_id)
        return ExecutionStartedResponse(run_id=run.run_id, status="accepted")

    @app.get("/api/runs/{run_id}/execution", response_model=ExecutionResponse)
    async def get_execution(
        run_id: str,
        service: ServiceDependency,
    ) -> ExecutionResponse:
        run = service.get_run(run_id)
        return ExecutionResponse.from_state(service.get_execution_state(run))

    @app.post("/api/runs/{run_id}/discard", response_model=ExecutionResponse)
    async def discard_run(
        run_id: str,
        service: ServiceDependency,
    ) -> ExecutionResponse:
        return ExecutionResponse.from_state(await service.discard_run(run_id))

    @app.get("/api/runs/{run_id}/results", response_model=ResultsResponse)
    async def list_results(
        run_id: str,
        service: ServiceDependency,
    ) -> ResultsResponse:
        run = service.get_run(run_id)
        return ResultsResponse(
            run_id=run_id,
            results=[
                ResultResponse.from_result(run_id, result) for result in service.list_results(run)
            ],
        )

    @app.get("/api/runs/{run_id}/results/{job_ordinal}/{artifact_ordinal}")
    async def get_result_file(
        run_id: str,
        job_ordinal: int,
        artifact_ordinal: int,
        service: ServiceDependency,
    ) -> Response:
        run = service.get_run(run_id)
        result, content = service.get_result(run, job_ordinal, artifact_ordinal)
        return Response(
            content=content,
            media_type=result.content_type or "application/octet-stream",
            headers={"Content-Disposition": f'inline; filename="{Path(result.local_path).name}"'},
        )

    return app


def _create_comfyui_client(settings: Settings) -> ComfyUIClient:
    return ComfyUIClient(
        settings.comfyui_base_url,
        timeout=settings.comfyui_timeout_seconds,
    )


def _package_version() -> str:
    try:
        return version("batchcraft")
    except PackageNotFoundError:
        return "0.1.0"


def _register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_request", "Request data is invalid"
        )

    @app.exception_handler(ProjectValidationError)
    @app.exception_handler(PromptValidationError)
    @app.exception_handler(WorkflowValidationError)
    @app.exception_handler(WorkflowProfileValidationError)
    @app.exception_handler(SavedBatchValidationError)
    async def invalid_library_input(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_library_input", str(error)
        )

    @app.exception_handler(ProjectNotFoundError)
    async def missing_project(_request: Request, _error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND, "project_not_found", "Project was not found"
        )

    @app.exception_handler(PromptProjectNotFoundError)
    @app.exception_handler(WorkflowProjectNotFoundError)
    async def missing_prompt_project(_request: Request, _error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND, "project_not_found", "Project was not found"
        )

    @app.exception_handler(PromptNotFoundError)
    async def missing_prompt(_request: Request, _error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND, "prompt_not_found", "Prompt was not found"
        )

    @app.exception_handler(PromptVersionNotFoundError)
    async def missing_prompt_version(_request: Request, _error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND,
            "prompt_version_not_found",
            "PromptVersion was not found",
        )

    @app.exception_handler(WorkflowNotFoundError)
    @app.exception_handler(WorkflowProfileWorkflowNotFoundError)
    async def missing_workflow(_request: Request, _error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND, "workflow_not_found", "Workflow was not found"
        )

    @app.exception_handler(WorkflowVersionNotFoundError)
    @app.exception_handler(WorkflowProfileWorkflowVersionNotFoundError)
    async def missing_workflow_version(_request: Request, _error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND,
            "workflow_version_not_found",
            "WorkflowVersion was not found",
        )

    @app.exception_handler(WorkflowProfileNotFoundError)
    async def missing_workflow_profile(_request: Request, _error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND,
            "workflow_profile_not_found",
            "Workflow Profile was not found",
        )

    @app.exception_handler(WorkflowProfileVersionNotFoundError)
    async def missing_workflow_profile_version(
        _request: Request, _error: Exception
    ) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND,
            "workflow_profile_version_not_found",
            "Workflow Profile version was not found",
        )

    @app.exception_handler(SavedBatchNotFoundError)
    async def missing_saved_batch(_request: Request, _error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND, "saved_batch_not_found", "Saved Batch was not found"
        )

    @app.exception_handler(SavedBatchIntegrityError)
    @app.exception_handler(SavedBatchOwnershipError)
    @app.exception_handler(SavedBatchAdoptionError)
    async def invalid_saved_batch_integrity(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "saved_batch_integrity_error",
            str(error),
        )

    @app.exception_handler(SavedBatchRevisionConflictError)
    async def saved_batch_revision_conflict(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_409_CONFLICT, "saved_batch_revision_conflict", str(error)
        )

    @app.exception_handler(WorkflowProfileOwnershipError)
    async def invalid_workflow_profile_ownership(
        _request: Request, error: Exception
    ) -> JSONResponse:
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "invalid_workflow_profile_target",
            str(error),
        )

    @app.exception_handler(ProjectConflictError)
    @app.exception_handler(PromptConflictError)
    @app.exception_handler(PromptVersionConflictError)
    @app.exception_handler(WorkflowConflictError)
    @app.exception_handler(WorkflowVersionConflictError)
    @app.exception_handler(WorkflowProfileConflictError)
    @app.exception_handler(WorkflowProfileVersionConflictError)
    @app.exception_handler(SavedBatchConflictError)
    async def library_conflict(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(status.HTTP_409_CONFLICT, "library_conflict", str(error))

    @app.exception_handler(ProjectPublicationError)
    async def project_publication_failed(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(status.HTTP_409_CONFLICT, "project_publication_failed", str(error))

    @app.exception_handler(SavedBatchPublicationError)
    async def saved_batch_publication_failed(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_409_CONFLICT, "saved_batch_publication_conflict", str(error)
        )

    @app.exception_handler(ProjectAdoptionError)
    async def project_adoption_failed(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "project_adoption_failed", str(error)
        )

    @app.exception_handler(ProjectDiscoveryError)
    async def project_discovery_failed(
        _request: Request, error: ProjectDiscoveryError
    ) -> JSONResponse:
        logger.error("Project discovery failed: %s", error)
        return _error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "project_discovery_failed",
            "Projects could not be discovered",
        )

    @app.exception_handler(SavedBatchDiscoveryError)
    async def saved_batch_discovery_failed(
        _request: Request, error: SavedBatchDiscoveryError
    ) -> JSONResponse:
        logger.error("Saved Batch discovery failed: %s", error)
        return _error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "saved_batch_discovery_failed",
            "Saved Batches could not be discovered",
        )

    @app.exception_handler(CompilationError)
    async def invalid_batch(_request: Request, error: CompilationError) -> JSONResponse:
        return _error_response(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_batch", str(error))

    @app.exception_handler(WorkflowPreparationError)
    async def invalid_workflow(_request: Request, error: WorkflowPreparationError) -> JSONResponse:
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "invalid_workflow_profile",
            str(error),
        )

    @app.exception_handler(AssetNotFoundError)
    async def missing_asset(_request: Request, error: AssetNotFoundError) -> JSONResponse:
        return _error_response(status.HTTP_404_NOT_FOUND, "project_asset_not_found", str(error))

    @app.exception_handler(InvalidProjectKeyError)
    async def invalid_project_key(_request: Request, error: InvalidProjectKeyError) -> JSONResponse:
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_project_key", str(error)
        )

    @app.exception_handler(AssetUploadError)
    async def invalid_asset_upload(_request: Request, error: AssetUploadError) -> JSONResponse:
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_asset_upload", str(error)
        )

    @app.exception_handler(AssetDataError)
    async def invalid_asset_data(_request: Request, error: AssetDataError) -> JSONResponse:
        logger.error("Invalid Project asset data: %s", error)
        return _error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "invalid_asset_data",
            "Project asset data is invalid",
        )

    @app.exception_handler(AssetPublicationError)
    async def asset_publication_failed(
        _request: Request, error: AssetPublicationError
    ) -> JSONResponse:
        logger.error("Project asset publication failed: %s", error)
        return _error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "asset_publication_failed",
            "Project assets could not be published",
        )

    @app.exception_handler(RunNotFoundError)
    async def missing_run(_request: Request, _error: RunNotFoundError) -> JSONResponse:
        return _error_response(status.HTTP_404_NOT_FOUND, "run_not_found", "Run was not found")

    @app.exception_handler(ResultNotFoundError)
    async def missing_result(_request: Request, _error: ResultNotFoundError) -> JSONResponse:
        return _error_response(
            status.HTTP_404_NOT_FOUND, "result_not_found", "Result was not found"
        )

    @app.exception_handler(ExecutionAlreadyActiveError)
    async def active_execution(
        _request: Request, _error: ExecutionAlreadyActiveError
    ) -> JSONResponse:
        return _error_response(
            status.HTTP_409_CONFLICT,
            "execution_already_active",
            "Run execution is already active",
        )

    @app.exception_handler(ExecutionNotEligibleError)
    async def ineligible_execution(
        _request: Request, error: ExecutionNotEligibleError
    ) -> JSONResponse:
        return _error_response(
            status.HTTP_409_CONFLICT,
            "execution_not_eligible",
            str(error),
        )

    @app.exception_handler(RunDiscardNotEligibleError)
    async def ineligible_run_discard(
        _request: Request, error: RunDiscardNotEligibleError
    ) -> JSONResponse:
        return _error_response(
            status.HTTP_409_CONFLICT,
            "run_discard_not_eligible",
            str(error),
        )

    @app.exception_handler(RunCreationError)
    async def invalid_run(_request: Request, error: RunCreationError) -> JSONResponse:
        logger.info("Run creation rejected: %s", error)
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "run_creation_failed",
            "Run could not be created",
        )

    @app.exception_handler(RunPublicationError)
    async def publication_failed(_request: Request, error: RunPublicationError) -> JSONResponse:
        logger.error("Run publication failed: %s", error)
        return _error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "run_publication_failed",
            "Run could not be published",
        )

    @app.exception_handler(RunDataError)
    async def invalid_stored_run(_request: Request, error: RunDataError) -> JSONResponse:
        logger.error("Invalid durable Run data: %s", error)
        return _error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "invalid_run_data",
            "Durable Run data is invalid",
        )

    @app.exception_handler(Exception)
    async def unexpected_error(_request: Request, error: Exception) -> JSONResponse:
        logger.error(
            "Unhandled API error",
            exc_info=(type(error), error, error.__traceback__),
        )
        return _error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "internal_error",
            "An unexpected error occurred",
        )


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    body = ErrorResponse(error=ErrorDetail(code=code, message=message))
    return JSONResponse(status_code=status_code, content=body.model_dump())


async def _stage_asset_uploads(
    uploads: list[UploadFile], temporary_root: Path
) -> tuple[AssetImportInput, ...]:
    staged: list[AssetImportInput] = []
    for index, upload in enumerate(uploads):
        filename = _safe_upload_filename(upload.filename)
        upload_path = temporary_root / str(index) / filename
        upload_path.parent.mkdir()
        with upload_path.open("xb") as output:
            while chunk := await upload.read(1024 * 1024):
                output.write(chunk)
        staged.append(AssetImportInput(source=upload_path, content_type=upload.content_type or ""))
    return tuple(staged)


def _safe_upload_filename(filename: str | None) -> str:
    normalized = (filename or "").replace("\\", "/")
    basename = normalized.rsplit("/", maxsplit=1)[-1]
    if (
        not basename
        or basename in {".", ".."}
        or any(ord(character) < 32 for character in basename)
    ):
        raise AssetUploadError("Uploaded image filename is invalid")
    return basename


app = create_app()
