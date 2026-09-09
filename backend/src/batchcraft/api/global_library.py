"""Additive BC-026 HTTP contracts; Project copy results retain existing DTOs."""

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Query
from pydantic import Field

from batchcraft.api.artifacts import ReadCapacity, file_operation
from batchcraft.api.schemas import ApiModel, WorkflowCreatedResponse, WorkflowProfileCreatedResponse
from batchcraft.db.global_workflows import GlobalWorkflowStore


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


def global_library_router(database_path: Path, reads: ReadCapacity) -> APIRouter:
    router = APIRouter(prefix="/api/library")
    store = GlobalWorkflowStore(database_path)

    @router.get("/workflows", response_model=GlobalCatalogResponse)
    async def browse(
        q: str = Query(default="", max_length=200),
        limit: int = Query(default=25, ge=1, le=50),
        cursor: str | None = Query(default=None, max_length=2048),
    ) -> GlobalCatalogResponse:
        async with reads.claim():
            return await file_operation(
                lambda: GlobalCatalogResponse.model_validate(
                    store.browse(q=q, limit=limit, cursor=cursor)
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

    return router
