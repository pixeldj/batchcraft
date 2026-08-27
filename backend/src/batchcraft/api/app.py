import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Annotated, cast

from fastapi import Depends, FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from batchcraft.application import (
    ApplicationComfyUIClient,
    AssetNotFoundError,
    BatchcraftService,
    ExecutionAlreadyActiveError,
    ExecutionNotEligibleError,
    ResultNotFoundError,
    RunCreationError,
    RunDataError,
    RunExecutor,
    RunNotFoundError,
    RunPublicationError,
    RunTaskRegistry,
)
from batchcraft.comfyui import ComfyUIClient, WorkflowPreparationError
from batchcraft.domain import CompilationError
from batchcraft.execution import execute_run

from .config import Settings
from .schemas import (
    BatchRequest,
    ComfyUIStatusResponse,
    ErrorDetail,
    ErrorResponse,
    ExecutionResponse,
    ExecutionStartedResponse,
    HealthResponse,
    PreviewResponse,
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
        configured.projects_root.mkdir(parents=True, exist_ok=True)
        client = make_client(configured)
        registry = RunTaskRegistry()
        app.state.service = BatchcraftService(
            projects_root=configured.projects_root,
            comfyui_client=client,
            task_registry=registry,
            execution_config=configured.execution_config,
            executor=executor,
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
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )
    _register_error_handlers(app)

    @app.get("/api/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", version=_package_version())

    @app.get("/api/comfyui/status", response_model=ComfyUIStatusResponse)
    async def comfyui_status(service: ServiceDependency) -> ComfyUIStatusResponse:
        return ComfyUIStatusResponse.from_status(await service.get_comfyui_status())

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


app = create_app()
