from collections.abc import Callable, Mapping, Sequence
from uuid import uuid4

from batchcraft.db import (
    ProjectRecord,
    ProjectStore,
    ProjectValidationError,
    PromptListRecord,
    PromptRecord,
    PromptStore,
    PromptVersionRecord,
    SavedBatchConflictError,
    SavedBatchDefinition,
    SavedBatchDetailRecord,
    SavedBatchListRecord,
    SavedBatchStore,
    WorkflowListRecord,
    WorkflowProfileListRecord,
    WorkflowProfileRecord,
    WorkflowProfileStore,
    WorkflowProfileVersionRecord,
    WorkflowRecord,
    WorkflowStore,
    WorkflowVersionRecord,
)
from batchcraft.files import (
    AdoptableBatch,
    AdoptableProject,
    BatchIdentity,
    BatchOwnerDiscoveryError,
    BatchOwnerError,
    BatchOwnerMissingError,
    BatchOwnerStore,
    ProjectIdentity,
    ProjectOwnerDiscoveryError,
    ProjectOwnerError,
    ProjectOwnerMissingError,
    ProjectOwnerStore,
    is_safe_filesystem_key,
)

from .errors import (
    HistoricalResourceImportError,
    ProjectAdoptionError,
    ProjectDiscoveryError,
    ProjectPublicationError,
    SavedBatchAdoptionError,
    SavedBatchDiscoveryError,
    SavedBatchOwnershipError,
    SavedBatchPublicationError,
    SavedBatchRevisionConflictError,
)


class LibraryService:
    """Coordinates mutable library state with immutable Project ownership."""

    def __init__(
        self,
        *,
        project_store: ProjectStore,
        prompt_store: PromptStore,
        workflow_store: WorkflowStore,
        workflow_profile_store: WorkflowProfileStore,
        saved_batch_store: SavedBatchStore,
        owner_store: ProjectOwnerStore,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._projects = project_store
        self._prompts = prompt_store
        self._workflows = workflow_store
        self._workflow_profiles = workflow_profile_store
        self._saved_batches = saved_batch_store
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

    def require_project_ownership(self, project_id: str, filesystem_key: str) -> ProjectRecord:
        project = self._projects.get(project_id)
        if project.filesystem_key != filesystem_key:
            raise HistoricalResourceImportError(
                "Historical Run Project does not match the registered Project filesystem key"
            )
        try:
            owner = self._owners.read(filesystem_key)
        except ProjectOwnerError as error:
            raise HistoricalResourceImportError(
                "Historical Run Project filesystem ownership is missing or invalid"
            ) from error
        if owner.id != project.id:
            raise HistoricalResourceImportError(
                "Historical Run Project does not match filesystem ownership"
            )
        return project

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

    def create_saved_batch(
        self,
        project_id: str,
        *,
        filesystem_key: str,
        definition: SavedBatchDefinition,
    ) -> SavedBatchDetailRecord:
        project, owners = self._batch_owner_store(project_id)
        identity = BatchIdentity(
            id=self._id_factory(), filesystem_key=filesystem_key, name=definition.name
        )
        try:
            owner = owners.create(identity)
        except BatchOwnerError as error:
            raise SavedBatchPublicationError(str(error)) from error
        return self._saved_batches.create(
            project.id, owner.filesystem_key, definition, batch_id=owner.id
        )

    def adopt_saved_batch(
        self,
        project_id: str,
        *,
        filesystem_key: str,
        definition: SavedBatchDefinition,
        batch_id: str | None = None,
    ) -> SavedBatchDetailRecord:
        project, owners = self._batch_owner_store(project_id)
        try:
            owner = owners.read(filesystem_key)
        except BatchOwnerMissingError:
            if batch_id is None or not batch_id.strip():
                raise SavedBatchAdoptionError(
                    "Saved Batch ID is required to adopt an ownerless Batch directory"
                ) from None
            try:
                owner = owners.adopt_ownerless(
                    BatchIdentity(
                        id=batch_id,
                        filesystem_key=filesystem_key,
                        name=definition.name,
                    )
                )
            except BatchOwnerError as error:
                raise SavedBatchAdoptionError(str(error)) from error
        except BatchOwnerError as error:
            raise SavedBatchAdoptionError(str(error)) from error
        if batch_id is not None and batch_id != owner.id:
            raise SavedBatchAdoptionError(
                f"Batch owner ID does not match the supplied Saved Batch ID: {owner.id!r}"
            )
        return self._saved_batches.create(
            project.id, owner.filesystem_key, definition, batch_id=owner.id
        )

    def list_saved_batches(
        self, project_id: str, *, include_archived: bool = False
    ) -> tuple[SavedBatchListRecord, ...]:
        self._projects.get(project_id)
        return self._saved_batches.list(project_id, include_archived=include_archived)

    def list_adoptable_saved_batches(self, project_id: str) -> tuple[AdoptableBatch, ...]:
        project, owners = self._batch_owner_store(project_id)
        registered_ids: set[str] = set()
        for candidate_project in self._projects.list(include_archived=True):
            registered_ids.update(
                item.id
                for item in self._saved_batches.list(candidate_project.id, include_archived=True)
            )
        registered_keys = {
            item.filesystem_key
            for item in self._saved_batches.list(project.id, include_archived=True)
        }
        try:
            candidates = owners.discover()
        except BatchOwnerDiscoveryError as error:
            raise SavedBatchDiscoveryError("Saved Batch discovery failed") from error
        return tuple(
            candidate
            for candidate in candidates
            if candidate.filesystem_key not in registered_keys
            and (candidate.batch_id is None or candidate.batch_id not in registered_ids)
        )

    def get_saved_batch(self, batch_id: str) -> SavedBatchDetailRecord:
        return self._saved_batches.get(batch_id)

    def update_saved_batch(
        self,
        batch_id: str,
        *,
        definition: SavedBatchDefinition,
        expected_revision: int,
    ) -> SavedBatchDetailRecord:
        try:
            return self._saved_batches.update(
                batch_id, definition, expected_revision=expected_revision
            )
        except SavedBatchConflictError as error:
            raise SavedBatchRevisionConflictError(str(error)) from error

    def archive_saved_batch(self, batch_id: str) -> SavedBatchDetailRecord:
        return self._saved_batches.archive(batch_id)

    def _batch_owner_store(self, project_id: str) -> tuple[ProjectRecord, BatchOwnerStore]:
        project = self._projects.get(project_id)
        try:
            owner = self._owners.read(project.filesystem_key)
        except ProjectOwnerError as error:
            raise SavedBatchOwnershipError(
                "Project filesystem ownership is missing or invalid"
            ) from error
        if owner.id != project.id:
            raise SavedBatchOwnershipError(
                "Project filesystem ownership does not match the Saved Batch Project"
            )
        return project, BatchOwnerStore(self._owners.projects_path / project.filesystem_key)

    def create_prompt(
        self,
        project_id: str,
        *,
        name: str,
        description: str | None,
        text: str,
        note: str | None,
        prompt_id: str | None = None,
        version_id: str | None = None,
    ) -> tuple[PromptRecord, PromptVersionRecord]:
        return self._prompts.create(
            project_id,
            name,
            text,
            description=description,
            note=note,
            prompt_id=prompt_id,
            version_id=version_id,
        )

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

    def create_workflow(
        self,
        project_id: str,
        *,
        name: str,
        description: str | None,
        workflow: Mapping[str, object],
        note: str | None,
        workflow_id: str | None = None,
        version_id: str | None = None,
    ) -> tuple[WorkflowRecord, WorkflowVersionRecord]:
        return self._workflows.create(
            project_id,
            name,
            workflow,
            description=description,
            note=note,
            workflow_id=workflow_id,
            version_id=version_id,
        )

    def list_workflows(
        self, project_id: str, *, include_archived: bool = False
    ) -> tuple[WorkflowListRecord, ...]:
        return self._workflows.list(project_id, include_archived=include_archived)

    def get_workflow(self, workflow_id: str) -> WorkflowRecord:
        return self._workflows.get(workflow_id)

    def update_workflow(
        self,
        workflow_id: str,
        *,
        name: str | None,
        description: str | None,
        update_description: bool,
    ) -> WorkflowRecord:
        return self._workflows.update_metadata(
            workflow_id,
            name=name,
            description=description,
            update_description=update_description,
        )

    def archive_workflow(self, workflow_id: str) -> WorkflowRecord:
        return self._workflows.archive(workflow_id)

    def list_workflow_versions(
        self, workflow_id: str, *, include_archived: bool = False
    ) -> tuple[WorkflowVersionRecord, ...]:
        return self._workflows.list_versions(workflow_id, include_archived=include_archived)

    def get_workflow_version(self, version_id: str) -> WorkflowVersionRecord:
        return self._workflows.get_version(version_id)

    def create_workflow_version(
        self,
        workflow_id: str,
        *,
        workflow: Mapping[str, object],
        note: str | None,
    ) -> WorkflowVersionRecord:
        return self._workflows.create_version(workflow_id, workflow, note=note)

    def archive_workflow_version(self, version_id: str) -> WorkflowVersionRecord:
        return self._workflows.archive_version(version_id)

    def create_workflow_profile(
        self,
        workflow_id: str,
        *,
        name: str,
        description: str | None,
        workflow_version_id: str,
        mappings: Mapping[str, object],
        image_inputs: Sequence[object],
        parameters: Sequence[object],
        note: str | None,
        profile_id: str | None = None,
        version_id: str | None = None,
    ) -> tuple[WorkflowProfileRecord, WorkflowProfileVersionRecord]:
        return self._workflow_profiles.create(
            workflow_id,
            name,
            workflow_version_id,
            mappings,
            image_inputs,
            parameters,
            description=description,
            note=note,
            profile_id=profile_id,
            version_id=version_id,
        )

    def list_workflow_profiles(
        self,
        workflow_id: str,
        *,
        workflow_version_id: str | None = None,
        include_archived: bool = False,
    ) -> tuple[WorkflowProfileListRecord, ...]:
        return self._workflow_profiles.list(
            workflow_id,
            workflow_version_id=workflow_version_id,
            include_archived=include_archived,
        )

    def get_workflow_profile(self, profile_id: str) -> WorkflowProfileRecord:
        return self._workflow_profiles.get(profile_id)

    def update_workflow_profile(
        self,
        profile_id: str,
        *,
        name: str | None,
        description: str | None,
        update_description: bool,
    ) -> WorkflowProfileRecord:
        return self._workflow_profiles.update_metadata(
            profile_id,
            name=name,
            description=description,
            update_description=update_description,
        )

    def archive_workflow_profile(self, profile_id: str) -> WorkflowProfileRecord:
        return self._workflow_profiles.archive(profile_id)

    def list_workflow_profile_versions(
        self, profile_id: str, *, include_archived: bool = False
    ) -> tuple[WorkflowProfileVersionRecord, ...]:
        return self._workflow_profiles.list_versions(profile_id, include_archived=include_archived)

    def get_workflow_profile_version(self, version_id: str) -> WorkflowProfileVersionRecord:
        return self._workflow_profiles.get_version(version_id)

    def create_workflow_profile_version(
        self,
        profile_id: str,
        *,
        workflow_version_id: str,
        mappings: Mapping[str, object],
        image_inputs: Sequence[object],
        parameters: Sequence[object],
        note: str | None,
    ) -> WorkflowProfileVersionRecord:
        return self._workflow_profiles.create_version(
            profile_id, workflow_version_id, mappings, image_inputs, parameters, note=note
        )

    def archive_workflow_profile_version(self, version_id: str) -> WorkflowProfileVersionRecord:
        return self._workflow_profiles.archive_version(version_id)
