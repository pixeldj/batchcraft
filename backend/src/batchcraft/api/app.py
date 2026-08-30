import asyncio
import logging
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, closing
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
    ProjectPublicationError,
    ResultNotFoundError,
    RunCreationError,
    RunDataError,
    RunExecutor,
    RunNotFoundError,
    RunPublicationError,
    RunTaskRegistry,
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
    apply_migrations,
    open_connection,
)
from batchcraft.domain import CompilationError
from batchcraft.execution import execute_run
from batchcraft.files import ProjectOwnerStore

from .config import Settings
from .schemas import (
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
    PromptResponse,
    PromptsResponse,
    PromptUpdateRequest,
    PromptVersionCreateRequest,
    PromptVersionsResponse,
    ResultResponse,
    ResultsResponse,
    RunCreatedResponse,
    RunResponse,
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
) -> FastAPI:
    configured = settings or Settings.from_env()
    make_client = client_factory or _create_comfyui_client

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configured.database_path.parent.mkdir(parents=True, exist_ok=True)
        configured.projects_root.mkdir(parents=True, exist_ok=True)
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
        )
        app.state.library_service = LibraryService(
            project_store=ProjectStore(configured.database_path),
            prompt_store=PromptStore(configured.database_path),
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

    @app.get("/api/projects/{project_id}/prompts", response_model=PromptsResponse)
    async def list_prompts(
        project_id: str,
        library: LibraryDependency,
        include_archived: bool = False,
    ) -> PromptsResponse:
        prompts = await asyncio.to_thread(
            library.list_prompts, project_id, include_archived=include_archived
        )
        return PromptsResponse(prompts=[PromptResponse.from_record(item) for item in prompts])

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
        return PreviewResponse.from_plan(service.preview_batch(creation.definition))

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

    @app.exception_handler(ProjectConflictError)
    @app.exception_handler(PromptConflictError)
    @app.exception_handler(PromptVersionConflictError)
    async def library_conflict(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(status.HTTP_409_CONFLICT, "library_conflict", str(error))

    @app.exception_handler(ProjectPublicationError)
    async def project_publication_failed(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(status.HTTP_409_CONFLICT, "project_publication_failed", str(error))

    @app.exception_handler(ProjectAdoptionError)
    async def project_adoption_failed(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "project_adoption_failed", str(error)
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
