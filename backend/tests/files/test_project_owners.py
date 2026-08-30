import json
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from batchcraft.files import (
    AdoptableProject,
    ProjectIdentity,
    ProjectOwnerDiscoveryError,
    ProjectOwnerError,
    ProjectOwnerStore,
)

PROJECT = ProjectIdentity(id="project-id", filesystem_key="project_key", name="Initial name")


def test_publish_writes_canonical_owner_and_read_returns_initial_identity(tmp_path: Path) -> None:
    store = ProjectOwnerStore(tmp_path / "projects")

    published = store.publish(PROJECT)
    renamed = store.publish(
        ProjectIdentity(
            id=PROJECT.id,
            filesystem_key=PROJECT.filesystem_key,
            name="Current name",
        )
    )

    owner_path = tmp_path / "projects" / "project_key" / "project.json"
    data = {
        "filesystem_key": "project_key",
        "format_version": 1,
        "name": "Initial name",
        "project_id": "project-id",
    }
    assert (
        owner_path.read_bytes()
        == (json.dumps(data, separators=(",", ":"), sort_keys=True) + "\n").encode()
    )
    assert published == PROJECT
    assert renamed == PROJECT
    assert store.read("project_key") == PROJECT


def test_create_refuses_to_claim_an_existing_ownerless_directory(tmp_path: Path) -> None:
    projects_path = tmp_path / "projects"
    (projects_path / PROJECT.filesystem_key / "assets").mkdir(parents=True)

    with pytest.raises(ProjectOwnerError, match="adopt its owner explicitly"):
        ProjectOwnerStore(projects_path).create(PROJECT)

    assert not (projects_path / PROJECT.filesystem_key / "project.json").exists()
    assert ProjectOwnerStore(projects_path).adopt_ownerless(PROJECT) == PROJECT
    assert ProjectOwnerStore(projects_path).read(PROJECT.filesystem_key) == PROJECT


def test_publish_is_create_if_absent_under_concurrency(tmp_path: Path) -> None:
    store = ProjectOwnerStore(tmp_path / "projects")

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = tuple(executor.map(store.publish, (PROJECT, PROJECT)))

    assert results == (PROJECT, PROJECT)
    assert store.read(PROJECT.filesystem_key) == PROJECT


@pytest.mark.parametrize(
    ("project", "message"),
    (
        (ProjectIdentity(id="", filesystem_key="key", name="Name"), "ID must not be empty"),
        (ProjectIdentity(id=" ", filesystem_key="key", name="Name"), "ID must not be empty"),
        (ProjectIdentity(id="bad/id", filesystem_key="key", name="Name"), "not route-safe"),
        (ProjectIdentity(id="id", filesystem_key="key", name=""), "name must not be empty"),
        (ProjectIdentity(id="id", filesystem_key="key", name=" "), "name must not be empty"),
        (ProjectIdentity(id="id", filesystem_key="../key", name="Name"), "not path-safe"),
    ),
)
def test_publish_rejects_invalid_identity(
    tmp_path: Path, project: ProjectIdentity, message: str
) -> None:
    with pytest.raises(ProjectOwnerError, match=message):
        ProjectOwnerStore(tmp_path / "projects").publish(project)


def test_read_rejects_unsafe_key_without_leaving_projects_root(tmp_path: Path) -> None:
    with pytest.raises(ProjectOwnerError, match="not path-safe"):
        ProjectOwnerStore(tmp_path / "projects").read("../outside")


def test_read_rejects_ownerless_asset_only_directory_without_inventing_identity(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "projects" / "asset_only"
    (project_path / "assets").mkdir(parents=True)

    with pytest.raises(ProjectOwnerError, match="has no project.json owner file"):
        ProjectOwnerStore(tmp_path / "projects").read("asset_only")

    assert not (project_path / "project.json").exists()


@pytest.mark.parametrize(
    ("owner", "message"),
    (
        ({"format_version": 2}, "unsupported Project owner format"),
        (
            {
                "format_version": 1,
                "project_id": "project-id",
                "filesystem_key": "other_key",
                "name": "Name",
            },
            "mismatched key",
        ),
        (
            {
                "format_version": 1,
                "project_id": "",
                "filesystem_key": "project_key",
                "name": "Name",
            },
            "project_id must be a non-empty string",
        ),
        (
            {
                "format_version": 1,
                "project_id": "bad/id",
                "filesystem_key": "project_key",
                "name": "Name",
            },
            "not route-safe",
        ),
        (
            {
                "format_version": 1,
                "project_id": "project-id",
                "filesystem_key": "project_key",
                "name": "",
            },
            "name must be a non-empty string",
        ),
    ),
)
def test_read_rejects_invalid_existing_owner(
    tmp_path: Path, owner: dict[str, object], message: str
) -> None:
    owner_path = tmp_path / "projects" / "project_key" / "project.json"
    owner_path.parent.mkdir(parents=True)
    owner_path.write_text(json.dumps(owner))

    with pytest.raises(ProjectOwnerError, match=message):
        ProjectOwnerStore(tmp_path / "projects").read("project_key")


def test_publish_rejects_existing_owner_for_another_project(tmp_path: Path) -> None:
    store = ProjectOwnerStore(tmp_path / "projects")
    store.publish(PROJECT)

    with pytest.raises(ProjectOwnerError, match="belongs to another ID"):
        store.publish(
            ProjectIdentity(id="another-id", filesystem_key="project_key", name="Another")
        )


def test_read_rejects_malformed_json(tmp_path: Path) -> None:
    owner_path = tmp_path / "projects" / "project_key" / "project.json"
    owner_path.parent.mkdir(parents=True)
    owner_path.write_text("not json")

    with pytest.raises(ProjectOwnerError, match="invalid Project owner file"):
        ProjectOwnerStore(tmp_path / "projects").read("project_key")


@pytest.mark.parametrize("symlink_target", ("project", "owner"))
def test_read_rejects_symlinked_project_directory_or_owner_file(
    tmp_path: Path, symlink_target: str
) -> None:
    projects_path = tmp_path / "projects"
    projects_path.mkdir()
    external = tmp_path / "external"
    external.mkdir()
    if symlink_target == "project":
        (projects_path / "project_key").symlink_to(external, target_is_directory=True)
    else:
        project_path = projects_path / "project_key"
        project_path.mkdir()
        external_owner = external / "project.json"
        external_owner.write_text("{}")
        (project_path / "project.json").symlink_to(external_owner)

    with pytest.raises(ProjectOwnerError, match="must not be a symlink"):
        ProjectOwnerStore(projects_path).read("project_key")


def test_discover_returns_only_safe_owned_and_ownerless_immediate_directories(
    tmp_path: Path,
) -> None:
    projects_path = tmp_path / "projects"
    store = ProjectOwnerStore(projects_path)
    store.publish(ProjectIdentity(id="owned-id", filesystem_key="z_owned", name="Initial"))
    (projects_path / "a_ownerless" / "assets").mkdir(parents=True)
    malformed_owner = projects_path / "malformed" / "project.json"
    malformed_owner.parent.mkdir()
    malformed_owner.write_text("not json")
    (projects_path / "ordinary-file").write_text("ignored")
    (projects_path / "unsafe name").mkdir()
    external = tmp_path / "external"
    external.mkdir()
    (projects_path / "linked").symlink_to(external, target_is_directory=True)
    external_owner = external / "owner.json"
    external_owner.write_text("{}")
    symlinked_owner = projects_path / "symlinked_owner"
    symlinked_owner.mkdir()
    (symlinked_owner / "project.json").symlink_to(external_owner)

    before = sorted(path.relative_to(projects_path) for path in projects_path.rglob("*"))
    candidates = store.discover()

    assert candidates == (
        AdoptableProject(
            filesystem_key="a_ownerless",
            owner_state="ownerless",
            project_id=None,
            initial_name=None,
        ),
        AdoptableProject(
            filesystem_key="z_owned",
            owner_state="owned",
            project_id="owned-id",
            initial_name="Initial",
        ),
    )
    assert sorted(path.relative_to(projects_path) for path in projects_path.rglob("*")) == before


def test_discover_absent_root_is_empty_without_creating_it(tmp_path: Path) -> None:
    projects_path = tmp_path / "missing"

    assert ProjectOwnerStore(projects_path).discover() == ()
    assert not projects_path.exists()


def test_discover_reports_root_enumeration_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects_path = tmp_path / "projects"
    projects_path.mkdir()
    real_iterdir = Path.iterdir

    def fail_target(path: Path) -> Iterator[Path]:
        if path == projects_path:
            raise PermissionError("private path detail")
        return real_iterdir(path)

    monkeypatch.setattr(Path, "iterdir", fail_target)

    with pytest.raises(ProjectOwnerDiscoveryError, match="failed to enumerate Projects root"):
        ProjectOwnerStore(projects_path).discover()
