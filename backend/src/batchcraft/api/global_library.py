"""Additive BC-026 HTTP contracts; Project copy results retain existing DTOs."""

from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import Field

from batchcraft.api.artifacts import ReadCapacity, file_operation
from batchcraft.api.schemas import ApiModel, WorkflowCreatedResponse, WorkflowProfileCreatedResponse
from batchcraft.application import BatchcraftService
from batchcraft.application.library import LibraryService
from batchcraft.db.global_workflows import GlobalWorkflowStore, HistoricalSetupImport


class ProfileCopySelection(ApiModel):
    version_id: str = Field(min_length=1, max_length=200)
    name: str | None = Field(default=None, min_length=1, max_length=200)


class SetupCopyRequest(ApiModel):
    request_id: str = Field(min_length=1, max_length=200)
    project_id: str = Field(min_length=1, max_length=200)
    workflow_version_id: str = Field(min_length=1, max_length=200)
    profiles: list[ProfileCopySelection] = Field(default_factory=list, max_length=50)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, min_length=1, max_length=2000)


class AuthoringRequest(ApiModel):
    request_id: str = Field(min_length=1, max_length=200)


class RunSetupImportRequest(AuthoringRequest):
    run_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=200)
    profile_name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, min_length=1, max_length=2000)
    expected_workflow_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    expected_profile_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class RunSetupResponse(ApiModel):
    run_id: str
    project_id: str
    batch_id: str
    project_name: str
    batch_name: str
    run_name: str | None
    run_number: str
    workflow_name: str | None
    profile_name: str | None
    workflow: dict[str, object]
    profile: dict[str, object]
    source: dict[str, object]


class WorkflowSaveRequest(AuthoringRequest):
    workflow: dict[str, object]
    note: str | None = Field(default=None, min_length=1, max_length=2000)


class WorkflowNewRequest(WorkflowSaveRequest):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, min_length=1, max_length=2000)


class ProfileSaveRequest(AuthoringRequest):
    workflow_version_id: str = Field(min_length=1, max_length=200)
    mappings: dict[str, object]
    image_inputs: list[dict[str, object]] = Field(default_factory=list)
    parameters: list[dict[str, object]]
    note: str | None = Field(default=None, min_length=1, max_length=2000)


class ProfileNewRequest(ProfileSaveRequest):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, min_length=1, max_length=2000)


class MetadataRequest(AuthoringRequest):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, min_length=1, max_length=2000)


class ArchiveRequest(AuthoringRequest):
    archived: bool = Field(strict=True)


class GlobalWorkflowResponse(ApiModel):
    id: str
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None
    source: dict[str, object]


class GlobalWorkflowVersionResponse(ApiModel):
    id: str
    workflow_id: str
    version_number: int
    name_snapshot: str
    workflow: dict[str, object]
    content_sha256: str
    note: str | None
    created_at: datetime
    archived_at: datetime | None


class GlobalProfileResponse(ApiModel):
    id: str
    workflow_id: str
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


class GlobalProfileVersionResponse(ApiModel):
    id: str
    workflow_profile_id: str
    workflow_id: str
    workflow_version_id: str
    version_number: int
    name_snapshot: str
    profile: dict[str, object]
    content_sha256: str
    note: str | None
    created_at: datetime
    archived_at: datetime | None


class GlobalWorkflowCreatedResponse(ApiModel):
    workflow: GlobalWorkflowResponse
    version: GlobalWorkflowVersionResponse


class GlobalProfileCreatedResponse(ApiModel):
    workflow_profile: GlobalProfileResponse
    version: GlobalProfileVersionResponse


class GlobalCopyResponse(ApiModel):
    request_id: str
    workflow: GlobalWorkflowCreatedResponse
    profiles: list[GlobalProfileCreatedResponse]
    source: dict[str, object]


class ProjectCopyResponse(ApiModel):
    request_id: str
    workflow: WorkflowCreatedResponse
    profiles: list[WorkflowProfileCreatedResponse]
    source: dict[str, object]


class GlobalCatalogItem(GlobalWorkflowResponse):
    latest_version_id: str | None


class GlobalCatalogResponse(ApiModel):
    items: list[GlobalCatalogItem]
    next_cursor: str | None


class GlobalProfileMetadata(ApiModel):
    id: str
    workflow_profile_id: str
    workflow_id: str
    workflow_version_id: str
    version_number: int
    name_snapshot: str
    content_sha256: str
    created_at: datetime
    name: str
    description: str | None


class GlobalProfilesResponse(ApiModel):
    items: list[GlobalProfileMetadata]
    next_cursor: str | None


class WorkflowHistoryItem(ApiModel):
    id: str
    workflow_id: str
    version_number: int
    name_snapshot: str
    content_sha256: str
    note: str | None
    created_at: datetime
    archived_at: datetime | None


class ProfileHistoryItem(WorkflowHistoryItem):
    workflow_profile_id: str
    workflow_version_id: str


class ProfileFamilyItem(GlobalProfileResponse):
    latest_active_version_id: str | None
    latest_compatible_version_id: str | None
    latest_compatible_version: ProfileHistoryItem | None


class WorkflowHistoryResponse(ApiModel):
    items: list[WorkflowHistoryItem]
    next_cursor: str | None


class ProfileHistoryResponse(ApiModel):
    items: list[ProfileHistoryItem]
    next_cursor: str | None


class ProfileFamiliesResponse(ApiModel):
    items: list[ProfileFamilyItem]
    next_cursor: str | None


def global_library_router(
    database_path: Path,
    reads: ReadCapacity,
    service_dependency: Callable[[Request], Awaitable[BatchcraftService]],
    library_dependency: Callable[[Request], Awaitable[LibraryService]],
) -> APIRouter:
    router = APIRouter(prefix="/api/library")
    store = GlobalWorkflowStore(database_path)

    @router.get("/run-setup", response_model=RunSetupResponse)
    async def run_setup(
        service: Annotated[BatchcraftService, Depends(service_dependency)],
        library: Annotated[LibraryService, Depends(library_dependency)],
        run_id: str = Query(min_length=1),
    ) -> Response:
        def read() -> Response:
            model = RunSetupResponse.model_validate(
                service.get_historical_setup(run_id, library=library)
            )
            return Response(model.model_dump_json(), media_type="application/json")

        async with reads.claim():
            return await file_operation(read)

    @router.post("/workflows/import-run", response_model=GlobalCopyResponse)
    async def import_run(
        request: RunSetupImportRequest,
        service: Annotated[BatchcraftService, Depends(service_dependency)],
        library: Annotated[LibraryService, Depends(library_dependency)],
    ) -> Response:
        def write() -> Response:
            model = GlobalCopyResponse.model_validate(
                service.import_historical_setup(
                    HistoricalSetupImport(**request.model_dump()), library=library
                )
            )
            return Response(model.model_dump_json(), media_type="application/json")

        async with reads.claim():
            return await file_operation(write)

    @router.get("/workflows", response_model=GlobalCatalogResponse)
    async def browse(
        q: str = Query(default="", max_length=200),
        limit: int = Query(default=25, ge=1, le=50),
        cursor: str | None = Query(default=None, max_length=2048),
        include_archived: bool = False,
    ) -> GlobalCatalogResponse:
        async with reads.claim():
            return await file_operation(
                lambda: GlobalCatalogResponse.model_validate(
                    store.browse(q=q, limit=limit, cursor=cursor, include_archived=include_archived)
                )
            )

    @router.get("/workflow-versions/{version_id}", response_model=GlobalWorkflowVersionResponse)
    async def workflow_detail(version_id: str) -> GlobalWorkflowVersionResponse:
        async with reads.claim():
            return await file_operation(
                lambda: GlobalWorkflowVersionResponse.model_validate(store.get_version(version_id))
            )

    @router.get(
        "/workflow-profile-versions/{version_id}", response_model=GlobalProfileVersionResponse
    )
    async def profile_detail(version_id: str) -> GlobalProfileVersionResponse:
        async with reads.claim():
            return await file_operation(
                lambda: GlobalProfileVersionResponse.model_validate(
                    store.get_version(version_id, profile=True)
                )
            )

    @router.get("/workflow-versions/{version_id}/profiles", response_model=GlobalProfilesResponse)
    async def profiles(
        version_id: str,
        q: str = Query(default="", max_length=200),
        limit: int = Query(default=25, ge=1, le=50),
        cursor: str | None = Query(default=None, max_length=2048),
    ) -> GlobalProfilesResponse:
        async with reads.claim():
            return await file_operation(
                lambda: GlobalProfilesResponse.model_validate(
                    store.browse(q=q, limit=limit, cursor=cursor, workflow_version_id=version_id)
                )
            )

    @router.post("/workflows/import-project", response_model=GlobalCopyResponse)
    async def import_project(request: SetupCopyRequest) -> GlobalCopyResponse:
        return await file_operation(
            lambda: GlobalCopyResponse.model_validate(
                store.copy(direction="import", **request.model_dump())
            )
        )

    @router.post("/workflows/use-in-project", response_model=ProjectCopyResponse)
    async def use_in_project(request: SetupCopyRequest) -> ProjectCopyResponse:
        return await file_operation(
            lambda: ProjectCopyResponse.model_validate(
                store.copy(direction="use", **request.model_dump())
            )
        )

    @router.get("/workflows/{workflow_id}", response_model=GlobalCatalogItem)
    async def workflow_family(workflow_id: str) -> GlobalCatalogItem:
        async with reads.claim():
            return await file_operation(
                lambda: GlobalCatalogItem.model_validate(store.get_workflow(workflow_id))
            )

    @router.get("/workflows/{workflow_id}/versions", response_model=WorkflowHistoryResponse)
    async def workflow_history(
        workflow_id: str,
        q: str = Query(default="", max_length=200),
        limit: int = Query(default=25, ge=1, le=50),
        cursor: str | None = Query(default=None, max_length=2048),
        include_archived: bool = False,
    ) -> WorkflowHistoryResponse:
        async with reads.claim():
            return await file_operation(
                lambda: WorkflowHistoryResponse.model_validate(
                    store.history(
                        workflow_id,
                        kind="workflows",
                        q=q,
                        limit=limit,
                        cursor=cursor,
                        include_archived=include_archived,
                    )
                )
            )

    @router.get("/workflows/{workflow_id}/profiles", response_model=ProfileFamiliesResponse)
    async def profile_families(
        workflow_id: str,
        workflow_version_id: str | None = Query(default=None, min_length=1, max_length=200),
        q: str = Query(default="", max_length=200),
        limit: int = Query(default=25, ge=1, le=50),
        cursor: str | None = Query(default=None, max_length=2048),
        include_archived: bool = False,
    ) -> ProfileFamiliesResponse:
        async with reads.claim():
            return await file_operation(
                lambda: ProfileFamiliesResponse.model_validate(
                    store.history(
                        workflow_id,
                        kind="profiles",
                        workflow_version_id=workflow_version_id,
                        q=q,
                        limit=limit,
                        cursor=cursor,
                        include_archived=include_archived,
                    )
                )
            )

    @router.get("/workflow-profiles/{profile_id}/versions", response_model=ProfileHistoryResponse)
    async def profile_history(
        profile_id: str,
        workflow_version_id: str | None = Query(default=None, min_length=1, max_length=200),
        q: str = Query(default="", max_length=200),
        limit: int = Query(default=25, ge=1, le=50),
        cursor: str | None = Query(default=None, max_length=2048),
        include_archived: bool = False,
    ) -> ProfileHistoryResponse:
        async with reads.claim():
            return await file_operation(
                lambda: ProfileHistoryResponse.model_validate(
                    store.history(
                        profile_id,
                        kind="profile_versions",
                        workflow_version_id=workflow_version_id,
                        q=q,
                        limit=limit,
                        cursor=cursor,
                        include_archived=include_archived,
                    )
                )
            )

    @router.post("/workflows", response_model=GlobalWorkflowCreatedResponse, status_code=201)
    async def create_workflow(request: WorkflowNewRequest) -> GlobalWorkflowCreatedResponse:
        return await file_operation(
            lambda: GlobalWorkflowCreatedResponse.model_validate(
                store.save_workflow(**request.model_dump())
            )
        )

    @router.post(
        "/workflows/{workflow_id}/versions",
        response_model=GlobalWorkflowVersionResponse,
        status_code=201,
    )
    async def save_workflow(
        workflow_id: str, request: WorkflowSaveRequest
    ) -> GlobalWorkflowVersionResponse:
        return await file_operation(
            lambda: GlobalWorkflowVersionResponse.model_validate(
                store.save_workflow(workflow_id=workflow_id, **request.model_dump())
            )
        )

    @router.post(
        "/workflows/{workflow_id}/profiles",
        response_model=GlobalProfileCreatedResponse,
        status_code=201,
    )
    async def create_profile(
        workflow_id: str, request: ProfileNewRequest
    ) -> GlobalProfileCreatedResponse:
        return await file_operation(
            lambda: GlobalProfileCreatedResponse.model_validate(
                store.save_profile(workflow_id=workflow_id, **request.model_dump())
            )
        )

    @router.post(
        "/workflow-profiles/{profile_id}/versions",
        response_model=GlobalProfileVersionResponse,
        status_code=201,
    )
    async def save_profile(
        profile_id: str, request: ProfileSaveRequest
    ) -> GlobalProfileVersionResponse:
        return await file_operation(
            lambda: GlobalProfileVersionResponse.model_validate(
                store.save_profile(profile_id=profile_id, **request.model_dump())
            )
        )

    @router.patch("/workflows/{workflow_id}", response_model=GlobalWorkflowResponse)
    async def workflow_metadata(
        workflow_id: str, request: MetadataRequest
    ) -> GlobalWorkflowResponse:
        return await file_operation(
            lambda: GlobalWorkflowResponse.model_validate(
                store.update_metadata(
                    workflow_id,
                    request_id=request.request_id,
                    changes=request.model_dump(exclude={"request_id"}, exclude_unset=True),
                )
            )
        )

    @router.patch("/workflow-profiles/{profile_id}", response_model=GlobalProfileResponse)
    async def profile_metadata(profile_id: str, request: MetadataRequest) -> GlobalProfileResponse:
        return await file_operation(
            lambda: GlobalProfileResponse.model_validate(
                store.update_metadata(
                    profile_id,
                    request_id=request.request_id,
                    profile=True,
                    changes=request.model_dump(exclude={"request_id"}, exclude_unset=True),
                )
            )
        )

    @router.post("/workflows/{workflow_id}/archive", response_model=GlobalWorkflowResponse)
    async def workflow_archive(workflow_id: str, request: ArchiveRequest) -> GlobalWorkflowResponse:
        return await file_operation(
            lambda: GlobalWorkflowResponse.model_validate(
                store.set_archived(workflow_id, kind="workflow", **request.model_dump())
            )
        )

    @router.post("/workflow-profiles/{profile_id}/archive", response_model=GlobalProfileResponse)
    async def profile_archive(profile_id: str, request: ArchiveRequest) -> GlobalProfileResponse:
        return await file_operation(
            lambda: GlobalProfileResponse.model_validate(
                store.set_archived(profile_id, kind="workflow_profile", **request.model_dump())
            )
        )

    @router.post(
        "/workflow-versions/{version_id}/archive", response_model=GlobalWorkflowVersionResponse
    )
    async def workflow_version_archive(
        version_id: str, request: ArchiveRequest
    ) -> GlobalWorkflowVersionResponse:
        return await file_operation(
            lambda: GlobalWorkflowVersionResponse.model_validate(
                store.set_archived(version_id, kind="workflow_version", **request.model_dump())
            )
        )

    @router.post(
        "/workflow-profile-versions/{version_id}/archive",
        response_model=GlobalProfileVersionResponse,
    )
    async def profile_version_archive(
        version_id: str, request: ArchiveRequest
    ) -> GlobalProfileVersionResponse:
        return await file_operation(
            lambda: GlobalProfileVersionResponse.model_validate(
                store.set_archived(
                    version_id, kind="workflow_profile_version", **request.model_dump()
                )
            )
        )

    return router
