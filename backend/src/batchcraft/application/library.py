from collections.abc import Callable
from uuid import uuid4

from batchcraft.db import (
    ProjectRecord,
    ProjectStore,
    ProjectValidationError,
    PromptListRecord,
    PromptRecord,
    PromptStore,
    PromptVersionRecord,
)
from batchcraft.files import (
    AdoptableProject,
    ProjectIdentity,
    ProjectOwnerDiscoveryError,
    ProjectOwnerError,
    ProjectOwnerMissingError,
    ProjectOwnerStore,
    is_safe_filesystem_key,
)

from .errors import ProjectAdoptionError, ProjectDiscoveryError, ProjectPublicationError


class LibraryService:
    """Coordinates mutable library state with immutable Project ownership."""

    def __init__(
        self,
        *,
        project_store: ProjectStore,
        prompt_store: PromptStore,
        owner_store: ProjectOwnerStore,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._projects = project_store
        self._prompts = prompt_store
        self._owners = owner_store
        self._id_factory = id_factory or (lambda: str(uuid4()))

    def create_project(
        self, *, name: str, filesystem_key: str, description: str | None = None
    ) -> ProjectRecord:
        if not name.strip():
            raise ProjectValidationError("Project name must be a nonempty string")
        if not is_safe_filesystem_key(filesystem_key):
            raise ProjectValidationError(
                f"Project filesystem key is not path-safe: {filesystem_key!r}"
            )
        if description is not None and not description.strip():
            raise ProjectValidationError("Project description must be nonempty when provided")
        identity = ProjectIdentity(id=self._id_factory(), filesystem_key=filesystem_key, name=name)
        try:
            owner = self._owners.create(identity)
        except ProjectOwnerError as error:
            raise ProjectPublicationError(str(error)) from error
        return self._projects.create(
            name,
            filesystem_key,
            description=description,
            project_id=owner.id,
        )

    def adopt_project(
        self,
        *,
        filesystem_key: str,
        project_id: str | None = None,
        name: str | None = None,
        description: str | None = None,
    ) -> ProjectRecord:
        if name is not None and not name.strip():
            raise ProjectValidationError("Project name must be a nonempty string")
        if description is not None and not description.strip():
            raise ProjectValidationError("Project description must be nonempty when provided")
        try:
            owner = self._owners.read(filesystem_key)
        except ProjectOwnerMissingError:
            if project_id is None or not project_id.strip() or name is None or not name.strip():
                raise ProjectAdoptionError(
                    "Project ID and name are required to adopt an ownerless Project directory"
                ) from None
            try:
                owner = self._owners.adopt_ownerless(
                    ProjectIdentity(id=project_id, filesystem_key=filesystem_key, name=name)
                )
            except ProjectOwnerError as error:
                raise ProjectAdoptionError(str(error)) from error
        except ProjectOwnerError as error:
            raise ProjectAdoptionError(str(error)) from error
        if project_id is not None and project_id != owner.id:
            raise ProjectAdoptionError(
                f"Project owner ID does not match the supplied Project ID: {owner.id!r}"
            )
        return self._projects.create(
            name or owner.name,
            owner.filesystem_key,
            description=description,
            project_id=owner.id,
        )

    def list_projects(self, *, include_archived: bool = False) -> tuple[ProjectRecord, ...]:
        return self._projects.list(include_archived=include_archived)

    def list_adoptable_projects(self) -> tuple[AdoptableProject, ...]:
        registered = self._projects.list(include_archived=True)
        registered_keys = {project.filesystem_key for project in registered}
        registered_ids = {project.id for project in registered}
        try:
            candidates = self._owners.discover()
        except ProjectOwnerDiscoveryError as error:
            raise ProjectDiscoveryError("Project discovery failed") from error
        return tuple(
            candidate
            for candidate in candidates
            if candidate.filesystem_key not in registered_keys
            and (candidate.project_id is None or candidate.project_id not in registered_ids)
        )

    def get_project(self, project_id: str) -> ProjectRecord:
        return self._projects.get(project_id)

    def update_project(
        self,
        project_id: str,
        *,
        name: str | None,
        description: str | None,
        update_description: bool,
    ) -> ProjectRecord:
        return self._projects.update_metadata(
            project_id,
            name=name,
            description=description,
            update_description=update_description,
        )

    def archive_project(self, project_id: str) -> ProjectRecord:
        return self._projects.archive(project_id)

    def create_prompt(
        self,
        project_id: str,
        *,
        name: str,
        description: str | None,
        text: str,
        note: str | None,
    ) -> tuple[PromptRecord, PromptVersionRecord]:
        return self._prompts.create(project_id, name, text, description=description, note=note)

    def list_prompts(
        self, project_id: str, *, include_archived: bool = False
    ) -> tuple[PromptListRecord, ...]:
        return self._prompts.list(project_id, include_archived=include_archived)

    def get_prompt(self, prompt_id: str) -> PromptRecord:
        return self._prompts.get(prompt_id)

    def update_prompt(
        self,
        prompt_id: str,
        *,
        name: str | None,
        description: str | None,
        update_description: bool,
    ) -> PromptRecord:
        return self._prompts.update_metadata(
            prompt_id,
            name=name,
            description=description,
            update_description=update_description,
        )

    def archive_prompt(self, prompt_id: str) -> PromptRecord:
        return self._prompts.archive(prompt_id)

    def list_prompt_versions(
        self, prompt_id: str, *, include_archived: bool = False
    ) -> tuple[PromptVersionRecord, ...]:
        return self._prompts.list_versions(prompt_id, include_archived=include_archived)

    def get_prompt_version(self, version_id: str) -> PromptVersionRecord:
        return self._prompts.get_version(version_id)

    def create_prompt_version(
        self, prompt_id: str, *, text: str, note: str | None
    ) -> PromptVersionRecord:
        return self._prompts.create_version(prompt_id, text, note=note)

    def archive_prompt_version(self, version_id: str) -> PromptVersionRecord:
        return self._prompts.archive_version(version_id)

    def restore_prompt_version(self, version_id: str) -> PromptVersionRecord:
        return self._prompts.restore_version(version_id)
