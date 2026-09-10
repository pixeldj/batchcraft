"""Global catalog and atomic, independent setup copies. No filesystem or ComfyUI I/O."""

import base64
import json
import sqlite3
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast
from uuid import uuid4

from batchcraft.comfyui import validate_workflow_profile
from batchcraft.comfyui.errors import WorkflowPreparationError
from batchcraft.db.connection import open_connection
from batchcraft.db.workflows import (
    WorkflowConflictError,
    WorkflowValidationError,
    WorkflowVersionNotFoundError,
    _canonical,
    _canonical_profile,
    _canonical_workflow,
    _verified_json_object,
)


class GlobalWorkflowStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def browse(
        self,
        *,
        q: str = "",
        limit: int = 25,
        cursor: str | None = None,
        workflow_version_id: str | None = None,
        include_archived: bool = False,
    ) -> dict[str, Any]:
        _validate_utf8(q, workflow_version_id)
        if len(q) > 200 or type(limit) is not int or not 1 <= limit <= 50:
            raise WorkflowValidationError("q is limited to 200 characters; limit must be 1..50")
        binding = [
            "catalog" if workflow_version_id is None else "copy_profiles",
            q,
            limit,
            workflow_version_id,
            include_archived,
        ]
        after = _cursor_after(cursor, binding)
        with closing(open_connection(self.database_path)) as connection:
            connection.row_factory = sqlite3.Row
            if workflow_version_id is None:
                rows = connection.execute(
                    """SELECT w.*, (SELECT id FROM global_workflow_version v
                       WHERE v.workflow_id=w.id AND v.archived_at IS NULL
                       ORDER BY version_number DESC LIMIT 1) AS latest_version_id
                       FROM global_workflow w WHERE (? OR w.archived_at IS NULL)
                       AND (instr(lower(w.name), lower(?)) > 0
                            OR instr(lower(coalesce(w.description,'')), lower(?)) > 0)
                       AND (w.created_at,w.id) > (?,?)
                       ORDER BY w.created_at,w.id LIMIT ?""",
                    (include_archived, q, q, *after, limit + 1),
                ).fetchall()
            else:
                if (
                    connection.execute(
                        "SELECT 1 FROM global_workflow_version WHERE id=?", (workflow_version_id,)
                    ).fetchone()
                    is None
                ):
                    raise WorkflowVersionNotFoundError("Global WorkflowVersion not found")
                rows = connection.execute(
                    """SELECT v.id, v.workflow_profile_id, v.workflow_id, v.workflow_version_id,
                       v.version_number, v.name_snapshot, v.content_sha256, v.created_at,
                       p.name, p.description FROM global_workflow_profile_version v
                       JOIN global_workflow_profile p ON p.id=v.workflow_profile_id
                       WHERE v.workflow_version_id=? AND v.archived_at IS NULL
                       AND p.archived_at IS NULL AND instr(lower(p.name),lower(?)) > 0
                       AND (v.created_at,v.id) > (?,?)
                       ORDER BY v.created_at,v.id LIMIT ?""",
                    (workflow_version_id, q, *after, limit + 1),
                ).fetchall()
        items = [dict(row) for row in rows[:limit]]
        if workflow_version_id is None:
            for item in items:
                item["source"] = json.loads(item.pop("source_json"))
        return _page(items, len(rows) > limit, binding)

    def get_version(self, version_id: str, *, profile: bool = False) -> dict[str, Any]:
        with closing(open_connection(self.database_path)) as connection:
            connection.row_factory = sqlite3.Row
            return _version(connection, "global_", version_id, profile=profile)

    def create_version(
        self,
        workflow_id: str,
        workflow: dict[str, object],
        *,
        note: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        # Existing in-process callers predate HTTP authoring operation IDs.
        return self.save_workflow(
            request_id=str(uuid4()) if request_id is None else request_id,
            workflow_id=workflow_id,
            workflow=workflow,
            note=note,
        )

    def _author(
        self,
        request_id: str,
        operation: str,
        target: str | None,
        payload: dict[str, Any],
        write: Callable[[sqlite3.Connection, str], dict[str, Any]],
    ) -> dict[str, Any]:
        _text(request_id, "request_id", 200)
        if target is not None:
            _text(target, "target ID", 200)
        _json_utf8(payload)
        try:
            request_json, _ = _canonical({"operation": operation, "target": target, **payload})
        except (ValueError, TypeError, RecursionError) as error:
            raise WorkflowValidationError("Authoring request must contain valid JSON") from error
        with closing(open_connection(self.database_path)) as connection:
            connection.row_factory = sqlite3.Row
            try:
                connection.execute("BEGIN IMMEDIATE")
                receipt = connection.execute(
                    "SELECT * FROM global_workflow_authoring_receipt WHERE request_id=?",
                    (request_id,),
                ).fetchone()
                if receipt is not None:
                    if receipt["request_json"] != request_json:
                        raise WorkflowConflictError(
                            "request_id already used with a different authoring request"
                        )
                    connection.rollback()
                    return cast(dict[str, Any], json.loads(receipt["response_json"]))
                timestamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
                result = write(connection, timestamp)
                _insert(
                    connection,
                    "global_workflow_authoring_receipt",
                    dict(
                        request_id=request_id,
                        request_json=request_json,
                        response_json=_canonical(result)[0],
                        created_at=timestamp,
                    ),
                )
                connection.commit()
                return result
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise WorkflowConflictError(
                    "Authoring conflicts with an existing name or identity; review names "
                    "(including archived entries) and retry with a new request_id"
                ) from error
            except BaseException:
                connection.rollback()
                raise

    def save_workflow(
        self,
        *,
        request_id: str,
        workflow: dict[str, object],
        workflow_id: str | None = None,
        name: str | None = None,
        description: str | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        """Create a family or append content to an exact family, never replace a snapshot."""

        def write(c: sqlite3.Connection, timestamp: str) -> dict[str, Any]:
            _text(note, "note", 2000, optional=True)
            canonical, digest = _canonical_workflow(workflow)
            if workflow_id is None:
                _text(name, "name", 200)
                _text(description, "description", 2000, optional=True)
                root: dict[str, Any] = dict(
                    id=str(uuid4()),
                    name=name,
                    description=description,
                    source_json=_canonical({"scope": "library"})[0],
                    created_at=timestamp,
                    updated_at=timestamp,
                    archived_at=None,
                )
                _insert(c, "global_workflow", root)
                root = _family(c, root["id"])
            else:
                if name is not None or description is not None:
                    raise WorkflowValidationError(
                        "Use metadata update to rename or describe a Workflow"
                    )
                root = _family(c, workflow_id)
            _active(root)
            version = _append(c, root, canonical, digest, note, timestamp)
            return {"workflow": root, "version": version} if workflow_id is None else version

        return self._author(
            request_id,
            "create_workflow" if workflow_id is None else "append_workflow",
            workflow_id,
            dict(workflow=workflow, name=name, description=description, note=note),
            write,
        )

    def save_profile(
        self,
        *,
        request_id: str,
        workflow_version_id: str,
        mappings: dict[str, object],
        image_inputs: list[dict[str, object]],
        parameters: list[dict[str, object]],
        workflow_id: str | None = None,
        profile_id: str | None = None,
        name: str | None = None,
        description: str | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        def write(c: sqlite3.Connection, timestamp: str) -> dict[str, Any]:
            _text(workflow_version_id, "WorkflowVersion ID", 200)
            _text(note, "note", 2000, optional=True)
            if (workflow_id is None) == (profile_id is None):
                raise WorkflowValidationError(
                    "Choose a Workflow for creation or a Profile for editing"
                )
            if profile_id is None:
                _text(name, "name", 200)
                _text(description, "description", 2000, optional=True)
                root: dict[str, Any] = dict(
                    id=str(uuid4()),
                    workflow_id=workflow_id,
                    name=name,
                    description=description,
                    created_at=timestamp,
                    updated_at=timestamp,
                    archived_at=None,
                )
            else:
                if name is not None or description is not None:
                    raise WorkflowValidationError(
                        "Use metadata update to rename or describe a Profile"
                    )
                root = _family(c, profile_id, profile=True)
            _active(root)
            _active(_family(c, root["workflow_id"]))
            target = _version(c, "global_", workflow_version_id)
            if target["workflow_id"] != root["workflow_id"]:
                raise WorkflowValidationError(
                    "Target WorkflowVersion must belong to the Profile's Workflow family"
                )
            _active(target)
            canonical, digest = _canonical_profile(
                root["id"], root["name"], mappings, image_inputs, parameters, target["workflow"]
            )
            if profile_id is None:
                _insert(c, "global_workflow_profile", root)
            version = _append(
                c, root, canonical, digest, note, timestamp, workflow_version_id=workflow_version_id
            )
            return {"workflow_profile": root, "version": version} if profile_id is None else version

        return self._author(
            request_id,
            "create_profile" if profile_id is None else "append_profile",
            profile_id or workflow_id,
            dict(
                workflow_id=workflow_id,
                profile_id=profile_id,
                workflow_version_id=workflow_version_id,
                mappings=mappings,
                image_inputs=image_inputs,
                parameters=parameters,
                name=name,
                description=description,
                note=note,
            ),
            write,
        )

    def update_metadata(
        self,
        row_id: str,
        *,
        request_id: str,
        changes: dict[str, Any],
        profile: bool = False,
    ) -> dict[str, Any]:
        def write(c: sqlite3.Connection, timestamp: str) -> dict[str, Any]:
            if not changes or changes.keys() - {"name", "description"}:
                raise WorkflowValidationError("Provide name and/or description")
            for key, value in changes.items():
                _text(value, key, 200 if key == "name" else 2000, optional=key == "description")
            root = _family(c, row_id, profile=profile)
            root.update(changes)
            table = "global_workflow_profile" if profile else "global_workflow"
            c.execute(
                f"UPDATE {table} SET name=?, description=?, updated_at=? WHERE id=?",
                (root["name"], root["description"], timestamp, row_id),
            )
            return _family(c, row_id, profile=profile)

        return self._author(
            request_id,
            "profile_metadata" if profile else "workflow_metadata",
            row_id,
            {"changes": changes},
            write,
        )

    def set_archived(
        self,
        row_id: str,
        *,
        request_id: str,
        archived: bool,
        kind: Literal[
            "workflow", "workflow_profile", "workflow_version", "workflow_profile_version"
        ],
    ) -> dict[str, Any]:
        def write(c: sqlite3.Connection, timestamp: str) -> dict[str, Any]:
            if type(archived) is not bool or kind not in (
                "workflow",
                "workflow_profile",
                "workflow_version",
                "workflow_profile_version",
            ):
                raise WorkflowValidationError(
                    "Choose a valid archive kind and boolean archived value"
                )
            table = "global_" + kind
            version = kind.endswith("_version")
            row = c.execute(f"SELECT id FROM {table} WHERE id=?", (row_id,)).fetchone()
            if row is None:
                raise WorkflowVersionNotFoundError("Global library entry not found")
            assignment = "" if version else ", updated_at=?"
            c.execute(
                f"UPDATE {table} SET archived_at=?{assignment} WHERE id=?",
                (timestamp if archived else None, *([] if version else [timestamp]), row_id),
            )
            if version:
                return _version(c, "global_", row_id, profile=kind == "workflow_profile_version")
            return _family(c, row_id, profile=kind == "workflow_profile")

        return self._author(request_id, "archive_" + kind, row_id, {"archived": archived}, write)

    def get_workflow(self, workflow_id: str) -> dict[str, Any]:
        _text(workflow_id, "Workflow ID", 200)
        with closing(open_connection(self.database_path)) as c:
            c.row_factory = sqlite3.Row
            c.execute("BEGIN")
            root = _family(c, workflow_id)
            latest = c.execute(
                "SELECT id FROM global_workflow_version WHERE workflow_id=? AND archived_at IS NULL "
                "ORDER BY version_number DESC LIMIT 1",
                (workflow_id,),
            ).fetchone()
            return {**root, "latest_version_id": None if latest is None else latest["id"]}

    def history(
        self,
        owner_id: str,
        *,
        kind: Literal["workflows", "profiles", "profile_versions"],
        workflow_version_id: str | None = None,
        q: str = "",
        limit: int = 25,
        cursor: str | None = None,
        include_archived: bool = False,
    ) -> dict[str, Any]:
        """Bounded metadata only; Profile families survive lack of target compatibility."""
        _text(owner_id, "owner ID", 200)
        if workflow_version_id is not None:
            _text(workflow_version_id, "WorkflowVersion ID", 200)
        _validate_utf8(q)
        if len(q) > 200 or type(limit) is not int or not 1 <= limit <= 50:
            raise WorkflowValidationError("q is limited to 200 characters; limit must be 1..50")
        binding = [kind, owner_id, workflow_version_id, include_archived, q, limit]
        after = _cursor_after(cursor, binding)
        with closing(open_connection(self.database_path)) as c:
            c.row_factory = sqlite3.Row
            c.execute("BEGIN")
            root = _family(c, owner_id, profile=kind == "profile_versions")
            family_id = root["workflow_id"] if kind == "profile_versions" else owner_id
            if workflow_version_id is not None:
                target = c.execute(
                    "SELECT workflow_id FROM global_workflow_version WHERE id=?",
                    (workflow_version_id,),
                ).fetchone()
                if target is None:
                    raise WorkflowVersionNotFoundError("Target WorkflowVersion not found")
                if target["workflow_id"] != family_id:
                    raise WorkflowValidationError(
                        "Target WorkflowVersion belongs to another Workflow family"
                    )
            if kind == "profiles":
                rows = c.execute(
                    """SELECT p.*,
                    (SELECT id FROM global_workflow_profile_version v WHERE v.workflow_profile_id=p.id
                     AND v.archived_at IS NULL ORDER BY version_number DESC LIMIT 1) latest_active_version_id,
                    (SELECT id FROM global_workflow_profile_version v WHERE v.workflow_profile_id=p.id
                     AND v.archived_at IS NULL AND (? IS NULL OR v.workflow_version_id=?)
                     ORDER BY version_number DESC LIMIT 1) latest_compatible_version_id
                    FROM global_workflow_profile p WHERE workflow_id=?
                    AND (? OR archived_at IS NULL)
                    AND (instr(lower(name),lower(?))>0 OR instr(lower(coalesce(description,'')),lower(?))>0)
                    AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT ?""",
                    (
                        workflow_version_id,
                        workflow_version_id,
                        owner_id,
                        include_archived,
                        q,
                        q,
                        *after,
                        limit + 1,
                    ),
                ).fetchall()
            else:
                profile = kind == "profile_versions"
                table = "global_workflow_profile_version" if profile else "global_workflow_version"
                owner = "workflow_profile_id" if profile else "workflow_id"
                extra = ", workflow_profile_id, workflow_version_id" if profile else ""
                target_filter = "AND (? IS NULL OR workflow_version_id=?)" if profile else ""
                rows = c.execute(
                    f"""SELECT id,workflow_id,version_number,name_snapshot,content_sha256,note,
                    created_at,archived_at {extra} FROM {table} WHERE {owner}=?
                    AND (? OR archived_at IS NULL) {target_filter}
                    AND (instr(lower(name_snapshot),lower(?))>0 OR instr(lower(coalesce(note,'')),lower(?))>0)
                    AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT ?""",
                    (
                        owner_id,
                        include_archived,
                        *([workflow_version_id, workflow_version_id] if profile else []),
                        q,
                        q,
                        *after,
                        limit + 1,
                    ),
                ).fetchall()
            items = [dict(row) for row in rows[:limit]]
            if kind == "profiles":
                for item in items:
                    vid = item["latest_compatible_version_id"]
                    summary = (
                        None
                        if vid is None
                        else c.execute(
                            "SELECT id,workflow_id,workflow_profile_id,workflow_version_id,version_number,"
                            "name_snapshot,content_sha256,note,created_at,archived_at "
                            "FROM global_workflow_profile_version WHERE id=?",
                            (vid,),
                        ).fetchone()
                    )
                    item["latest_compatible_version"] = None if summary is None else dict(summary)
        return _page(items, len(rows) > limit, binding)

    def copy(
        self,
        *,
        direction: Literal["import", "use"],
        request_id: str,
        project_id: str,
        workflow_version_id: str,
        profiles: list[dict[str, Any]],
        name: str | None = None,
        description: str | None = None,
    ) -> dict[str, Any]:
        _validate_utf8(request_id, project_id, workflow_version_id, name, description)
        if not request_id.strip() or not project_id.strip() or len(profiles) > 50:
            raise WorkflowValidationError(
                "Request/Project IDs required; choose at most 50 Profiles"
            )
        ids = [p["version_id"] for p in profiles]
        for selection in profiles:
            _validate_utf8(selection["version_id"], selection.get("name"))
        if len(set(ids)) != len(ids):
            raise WorkflowValidationError("Choose each ProfileVersion only once")
        request_json, _ = _canonical(
            {
                "direction": direction,
                "project_id": project_id,
                "workflow_version_id": workflow_version_id,
                "profiles": profiles,
                "name": name,
                "description": description,
            }
        )
        with closing(open_connection(self.database_path)) as connection:
            connection.row_factory = sqlite3.Row
            try:
                connection.execute("BEGIN IMMEDIATE")
                receipt = connection.execute(
                    "SELECT * FROM global_workflow_copy_receipt WHERE request_id=?", (request_id,)
                ).fetchone()
                if receipt is not None:
                    if receipt["request_json"] != request_json:
                        raise WorkflowConflictError(
                            "request_id already used with a different copy request"
                        )
                    response = cast(dict[str, Any], json.loads(receipt["response_json"]))
                    connection.rollback()
                    return response
                project = connection.execute(
                    "SELECT * FROM project WHERE id=?", (project_id,)
                ).fetchone()
                if project is None or (direction == "use" and project["archived_at"] is not None):
                    raise WorkflowValidationError("Choose a registered, active destination Project")
                source_prefix = "" if direction == "import" else "global_"
                target_prefix = "global_" if direction == "import" else ""
                source = _version(connection, source_prefix, workflow_version_id)
                if direction == "import" and source["project_id"] != project_id:
                    raise WorkflowValidationError(
                        "Source WorkflowVersion belongs to another Project"
                    )
                source_profiles = []
                for selection in profiles:
                    p = _version(connection, source_prefix, selection["version_id"], profile=True)
                    if (
                        p["workflow_version_id"] != workflow_version_id
                        or p["workflow_id"] != source["workflow_id"]
                    ):
                        raise WorkflowValidationError(
                            "Selected Profile must target the exact source WorkflowVersion"
                        )
                    if direction == "import" and p["project_id"] != project_id:
                        raise WorkflowValidationError("Source Profile belongs to another Project")
                    if (
                        p["profile"].get("id") != p["workflow_profile_id"]
                        or p["profile"].get("name") != p["name_snapshot"]
                    ):
                        raise WorkflowValidationError(
                            "Stored Profile envelope disagrees with immutable version"
                        )
                    try:
                        validate_workflow_profile(source["workflow"], p["profile"])
                    except WorkflowPreparationError as error:
                        raise WorkflowValidationError(str(error)) from error
                    source_profiles.append(p)
                timestamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
                workflow_id, version_id = str(uuid4()), str(uuid4())
                workflow_name = source["name_snapshot"] if name is None else name
                if not workflow_name.strip() or len(workflow_name) > 200:
                    raise WorkflowValidationError(
                        "Review Workflow name: use 1..200 nonblank characters"
                    )
                if description is not None and (not description.strip() or len(description) > 2000):
                    raise WorkflowValidationError(
                        "Description must use 1..2000 nonblank characters"
                    )
                scope = {} if direction == "import" else {"project_id": project_id}
                root: dict[str, Any] = dict(
                    id=workflow_id,
                    **scope,
                    name=workflow_name,
                    description=description,
                    created_at=timestamp,
                    updated_at=timestamp,
                    archived_at=None,
                )
                ancestry = {
                    "scope": "project" if direction == "import" else "global",
                    "project_id": project_id if direction == "import" else None,
                    "workflow": _provenance(source),
                    "profiles": [_provenance(p) for p in source_profiles],
                }
                if direction == "import":
                    root["source_json"] = _canonical(ancestry)[0]
                _insert(connection, target_prefix + "workflow", root)
                if direction == "import":
                    root["source"] = json.loads(root.pop("source_json"))
                canonical, digest = _canonical_workflow(source["workflow"])
                version: dict[str, Any] = dict(
                    id=version_id,
                    workflow_id=workflow_id,
                    **scope,
                    version_number=1,
                    name_snapshot=workflow_name,
                    workflow_json=canonical,
                    content_sha256=digest,
                    note=None,
                    created_at=timestamp,
                    archived_at=None,
                )
                _insert(connection, target_prefix + "workflow_version", version)
                copied_profiles = []
                for selection, p in zip(profiles, source_profiles, strict=True):
                    profile_id, profile_version_id = str(uuid4()), str(uuid4())
                    profile_name = (
                        p["name_snapshot"] if selection.get("name") is None else selection["name"]
                    )
                    if not profile_name.strip() or len(profile_name) > 200:
                        raise WorkflowValidationError(
                            "Review Profile name: use 1..200 nonblank characters"
                        )
                    payload = p["profile"]
                    canonical, digest = _canonical_profile(
                        profile_id,
                        profile_name,
                        payload["mappings"],
                        payload["image_inputs"],
                        payload["parameters"],
                        source["workflow"],
                    )
                    profile_root = dict(
                        id=profile_id,
                        workflow_id=workflow_id,
                        **scope,
                        name=profile_name,
                        description=None,
                        created_at=timestamp,
                        updated_at=timestamp,
                        archived_at=None,
                    )
                    _insert(connection, target_prefix + "workflow_profile", profile_root)
                    pv: dict[str, Any] = dict(
                        id=profile_version_id,
                        workflow_profile_id=profile_id,
                        workflow_id=workflow_id,
                        **scope,
                        workflow_version_id=version_id,
                        version_number=1,
                        name_snapshot=profile_name,
                        profile_json=canonical,
                        content_sha256=digest,
                        note=None,
                        created_at=timestamp,
                        archived_at=None,
                    )
                    _insert(connection, target_prefix + "workflow_profile_version", pv)
                    pv["profile"] = json.loads(pv.pop("profile_json"))
                    copied_profiles.append({"workflow_profile": profile_root, "version": pv})
                version["workflow"] = json.loads(version.pop("workflow_json"))
                response = {
                    "request_id": request_id,
                    "workflow": {"workflow": root, "version": version},
                    "profiles": copied_profiles,
                    "source": ancestry,
                }
                response_json, _ = _canonical(response)
                connection.execute(
                    "INSERT INTO global_workflow_copy_receipt VALUES (?,?,?,?)",
                    (request_id, request_json, response_json, timestamp),
                )
                connection.commit()
                return response
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise WorkflowConflictError(
                    "Copy conflicts with an existing name or identity; review Workflow and Profile names "
                    "(including archived entries) and retry with a new request_id"
                ) from error
            except BaseException:
                connection.rollback()
                raise


def _family(c: sqlite3.Connection, row_id: str, *, profile: bool = False) -> dict[str, Any]:
    table = "global_workflow_profile" if profile else "global_workflow"
    row = c.execute(f"SELECT * FROM {table} WHERE id=?", (row_id,)).fetchone()
    if row is None:
        raise WorkflowVersionNotFoundError("Global Workflow/Profile family not found")
    result = dict(row)
    if not profile:
        result["source"] = json.loads(result.pop("source_json"))
    return result


def _active(row: dict[str, Any]) -> None:
    if row["archived_at"] is not None:
        raise WorkflowValidationError(
            "Workflow, Profile and target version must be active; unarchive before saving"
        )


def _append(
    c: sqlite3.Connection,
    root: dict[str, Any],
    canonical: str,
    digest: str,
    note: str | None,
    timestamp: str,
    *,
    workflow_version_id: str | None = None,
) -> dict[str, Any]:
    profile = workflow_version_id is not None
    table = "global_workflow_profile_version" if profile else "global_workflow_version"
    owner = "workflow_profile_id" if profile else "workflow_id"
    number = c.execute(
        f"SELECT coalesce(max(version_number),0)+1 FROM {table} WHERE {owner}=?", (root["id"],)
    ).fetchone()[0]
    row = dict(
        id=str(uuid4()),
        workflow_id=root["workflow_id"] if profile else root["id"],
        version_number=number,
        name_snapshot=root["name"],
        content_sha256=digest,
        note=note,
        created_at=timestamp,
        archived_at=None,
    )
    row["profile_json" if profile else "workflow_json"] = canonical
    if profile:
        row.update(workflow_profile_id=root["id"], workflow_version_id=workflow_version_id)
    _insert(c, table, row)
    return _version(c, "global_", row["id"], profile=profile)


def _text(value: object, label: str, maximum: int, *, optional: bool = False) -> None:
    if optional and value is None:
        return
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise WorkflowValidationError(f"{label} must use 1..{maximum} nonblank characters")
    _validate_utf8(value)


def _json_utf8(value: object) -> None:
    # Iterative traversal also rejects surrogates in arbitrary nested workflow payloads.
    pending = [value]
    visited: set[int] = set()
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            _validate_utf8(item)
        elif isinstance(item, (dict, list)) and id(item) not in visited:
            visited.add(id(item))
            if isinstance(item, dict):
                pending.extend(item.keys())
                pending.extend(item.values())
            else:
                pending.extend(item)


def _cursor_after(cursor: str | None, binding: list[Any]) -> list[str]:
    if cursor is None:
        return ["", ""]
    try:
        if len(cursor) > 2048:
            raise ValueError
        value = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        if not isinstance(value, dict) or set(value) != {"binding", "after"}:
            raise ValueError
        if _canonical(value["binding"])[0] != _canonical(binding)[0]:
            raise ValueError
        after = value["after"]
        if (
            not isinstance(after, list)
            or len(after) != 2
            or not all(isinstance(x, str) for x in after)
        ):
            raise ValueError
        _validate_utf8(*after)
        return cast(list[str], after)
    except (ValueError, KeyError, TypeError, RecursionError) as error:
        raise WorkflowValidationError("Invalid cursor or changed catalog query") from error


def _page(items: list[dict[str, Any]], more: bool, binding: list[Any]) -> dict[str, Any]:
    cursor = None
    if more:
        cursor = base64.urlsafe_b64encode(
            json.dumps(
                {"binding": binding, "after": [items[-1]["created_at"], items[-1]["id"]]},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        ).decode()
    return {"items": items, "next_cursor": cursor}


def _validate_utf8(*values: str | None) -> None:
    try:
        for value in values:
            if value is not None:
                value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise WorkflowValidationError("Global library text must be valid UTF-8") from error


def _insert(connection: sqlite3.Connection, table: str, values: dict[str, Any]) -> None:
    connection.execute(
        f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})",
        tuple(values.values()),
    )


def _version(
    connection: sqlite3.Connection, prefix: str, version_id: str, *, profile: bool = False
) -> dict[str, Any]:
    _validate_utf8(version_id)
    table = prefix + ("workflow_profile_version" if profile else "workflow_version")
    row = connection.execute(f"SELECT * FROM {table} WHERE id=?", (version_id,)).fetchone()
    if row is None:
        raise WorkflowVersionNotFoundError(f"Source version not found: {version_id}")
    result = dict(row)
    key = "profile" if profile else "workflow"
    result[key] = _verified_json_object(
        result.pop(key + "_json"), result["content_sha256"], table, WorkflowValidationError
    )
    return result


def _provenance(version: dict[str, Any]) -> dict[str, Any]:
    return {
        k: version[k]
        for k in (
            "id",
            "workflow_id",
            "workflow_profile_id",
            "workflow_version_id",
            "version_number",
            "content_sha256",
        )
        if k in version
    }
