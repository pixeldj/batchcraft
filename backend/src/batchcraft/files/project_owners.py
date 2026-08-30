import os
import stat
from pathlib import Path
from uuid import uuid4

from batchcraft.files._io import (
    ensure_directory,
    fsync_directory,
    is_safe_filesystem_key,
    read_json_object,
    write_json,
)
from batchcraft.files.models import AdoptableProject, ProjectIdentity

PROJECT_OWNER_FORMAT_VERSION = 1


class ProjectOwnerError(ValueError):
    """A Project filesystem owner cannot be safely published or read."""


class ProjectOwnerMissingError(ProjectOwnerError):
    """An existing Project directory has no owner binding."""


class ProjectOwnerDiscoveryError(ProjectOwnerError):
    """The configured Projects root cannot be enumerated safely."""


class ProjectOwnerStore:
    def __init__(self, projects_path: Path) -> None:
        self.projects_path = projects_path

    def publish(self, project: ProjectIdentity) -> ProjectIdentity:
        """Create the owner binding if absent and return the immutable stored identity."""
        _validate_identity(project)
        project_path = self.projects_path / project.filesystem_key
        owner_path = project_path / "project.json"

        try:
            _reject_symlink(project_path, "Project directory")
            ensure_directory(project_path)
            _require_real_directory(project_path)
            _reject_symlink(owner_path, "Project owner file")

            temporary_path = project_path / f".{owner_path.name}.{uuid4()}.tmp"
            try:
                write_json(
                    temporary_path,
                    {
                        "format_version": PROJECT_OWNER_FORMAT_VERSION,
                        "project_id": project.id,
                        "filesystem_key": project.filesystem_key,
                        "name": project.name,
                    },
                )
                _require_real_directory(project_path)
                try:
                    os.link(temporary_path, owner_path)
                    fsync_directory(project_path)
                except FileExistsError:
                    pass
            finally:
                temporary_path.unlink(missing_ok=True)

            existing = self.read(project.filesystem_key)
        except (OSError, ValueError) as error:
            if isinstance(error, ProjectOwnerError):
                raise
            raise ProjectOwnerError(
                f"failed to publish Project owner {project.filesystem_key!r}: {error}"
            ) from error

        if existing.id != project.id:
            raise ProjectOwnerError(
                f"Project filesystem key {project.filesystem_key!r} belongs to another ID"
            )
        return existing

    def create(self, project: ProjectIdentity) -> ProjectIdentity:
        """Publish a new owner without claiming a pre-existing Project directory."""
        _validate_identity(project)
        ensure_directory(self.projects_path)
        project_path = self.projects_path / project.filesystem_key
        try:
            project_path.mkdir()
            fsync_directory(self.projects_path)
        except FileExistsError as error:
            raise ProjectOwnerError(
                f"Project directory {project.filesystem_key!r} already exists; "
                "adopt its owner explicitly"
            ) from error
        except OSError as error:
            raise ProjectOwnerError(
                f"failed to create Project directory {project.filesystem_key!r}: {error}"
            ) from error
        try:
            return self.publish(project)
        except BaseException:
            try:
                project_path.rmdir()
                fsync_directory(self.projects_path)
            except OSError:
                pass
            raise

    def adopt_ownerless(self, project: ProjectIdentity) -> ProjectIdentity:
        """Publish an owner into an explicitly selected existing ownerless directory."""
        _validate_identity(project)
        project_path = self.projects_path / project.filesystem_key
        owner_path = project_path / "project.json"
        _require_real_directory(project_path)
        _reject_symlink(owner_path, "Project owner file")
        if owner_path.exists():
            raise ProjectOwnerError(
                f"Project directory {project.filesystem_key!r} already has an owner file"
            )
        return self.publish(project)

    def read(self, filesystem_key: str) -> ProjectIdentity:
        """Read an existing owner binding by filesystem key for explicit adoption."""
        if not is_safe_filesystem_key(filesystem_key):
            raise ProjectOwnerError(f"Project filesystem key is not path-safe: {filesystem_key!r}")

        project_path = self.projects_path / filesystem_key
        owner_path = project_path / "project.json"
        try:
            _require_real_directory(project_path)
            _reject_symlink(owner_path, "Project owner file")
            if not owner_path.is_file():
                if owner_path.exists():
                    raise ProjectOwnerError(f"Project owner file is unsafe: {owner_path}")
                raise ProjectOwnerMissingError(
                    f"Project directory {filesystem_key!r} has no project.json owner file"
                )
            data = read_json_object(owner_path)
        except (OSError, ValueError) as error:
            if isinstance(error, ProjectOwnerError):
                raise
            raise ProjectOwnerError(f"invalid Project owner file {owner_path}: {error}") from error

        if type(data.get("format_version")) is not int or (
            data["format_version"] != PROJECT_OWNER_FORMAT_VERSION
        ):
            raise ProjectOwnerError(f"unsupported Project owner format in {owner_path}")
        project_id = _required_string(data, "project_id", owner_path)
        _validate_project_id(project_id)
        stored_key = _required_string(data, "filesystem_key", owner_path)
        name = _required_string(data, "name", owner_path)
        if not is_safe_filesystem_key(stored_key):
            raise ProjectOwnerError(
                f"Project owner file has an unsafe filesystem key: {stored_key!r}"
            )
        if stored_key != filesystem_key:
            raise ProjectOwnerError("Project owner file has a mismatched key")
        return ProjectIdentity(id=project_id, filesystem_key=stored_key, name=name)

    def discover(self) -> tuple[AdoptableProject, ...]:
        """List valid immediate Project directories without modifying or traversing them."""
        if self.projects_path.is_symlink():
            raise ProjectOwnerDiscoveryError("Projects root must not be a symlink")
        try:
            entries = tuple(self.projects_path.iterdir())
        except FileNotFoundError:
            return ()
        except OSError as error:
            raise ProjectOwnerDiscoveryError("failed to enumerate Projects root") from error

        candidates: list[AdoptableProject] = []
        for entry in entries:
            if not is_safe_filesystem_key(entry.name):
                continue
            try:
                entry_status = entry.lstat()
            except OSError:
                continue
            if not stat.S_ISDIR(entry_status.st_mode):
                continue

            owner_path = entry / "project.json"
            try:
                owner_status = owner_path.lstat()
            except FileNotFoundError:
                candidates.append(
                    AdoptableProject(
                        filesystem_key=entry.name,
                        owner_state="ownerless",
                        project_id=None,
                        initial_name=None,
                    )
                )
                continue
            except OSError:
                continue
            if not stat.S_ISREG(owner_status.st_mode):
                continue

            try:
                owner = self.read(entry.name)
            except ProjectOwnerError:
                continue
            candidates.append(
                AdoptableProject(
                    filesystem_key=entry.name,
                    owner_state="owned",
                    project_id=owner.id,
                    initial_name=owner.name,
                )
            )
        return tuple(sorted(candidates, key=lambda candidate: candidate.filesystem_key))


def _validate_identity(project: ProjectIdentity) -> None:
    _validate_project_id(project.id)
    if not isinstance(project.name, str) or not project.name.strip():
        raise ProjectOwnerError("Project display name must not be empty")
    if not is_safe_filesystem_key(project.filesystem_key):
        raise ProjectOwnerError(
            f"Project filesystem key is not path-safe: {project.filesystem_key!r}"
        )


def _required_string(data: dict[str, object], name: str, path: Path) -> str:
    value = data.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ProjectOwnerError(f"{name} must be a non-empty string in {path}")
    return value


def _validate_project_id(project_id: object) -> None:
    if not isinstance(project_id, str) or not project_id.strip():
        raise ProjectOwnerError("Project ID must not be empty")
    if (
        project_id in {".", ".."}
        or "/" in project_id
        or "\\" in project_id
        or any(ord(character) < 32 for character in project_id)
    ):
        raise ProjectOwnerError(f"Project ID is not route-safe: {project_id!r}")


def _reject_symlink(path: Path, description: str) -> None:
    if path.is_symlink():
        raise ProjectOwnerError(f"{description} must not be a symlink: {path}")


def _require_real_directory(path: Path) -> None:
    _reject_symlink(path, "Project directory")
    if not path.is_dir():
        raise ProjectOwnerError(f"Project directory is missing or unsafe: {path}")
