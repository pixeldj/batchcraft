"""Global catalog and atomic, independent setup copies. No filesystem or ComfyUI I/O."""

import base64
import json
import sqlite3
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
    _optional_note,
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
    ) -> dict[str, Any]:
        _validate_utf8(q, workflow_version_id)
        if len(q) > 200 or not 1 <= limit <= 50:
            raise WorkflowValidationError("q is limited to 200 characters; limit must be 1..50")
        binding = [q, limit, workflow_version_id]
        after = ["", ""]
        if cursor is not None:
            try:
                if len(cursor) > 2048:
                    raise ValueError
                decoded = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
                if decoded["binding"] != binding:
                    raise ValueError
                after = decoded["after"]
                if (
                    not isinstance(after, list)
                    or len(after) != 2
                    or not all(isinstance(v, str) for v in after)
                ):
                    raise ValueError
                _validate_utf8(*after)
            except (ValueError, KeyError, TypeError) as error:
                raise WorkflowValidationError("Invalid cursor or changed catalog query") from error
        with closing(open_connection(self.database_path)) as connection:
            connection.row_factory = sqlite3.Row
            if workflow_version_id is None:
                rows = connection.execute(
                    """SELECT w.*, (SELECT id FROM global_workflow_version v
                       WHERE v.workflow_id=w.id AND v.archived_at IS NULL
                       ORDER BY version_number DESC LIMIT 1) AS latest_version_id
                       FROM global_workflow w WHERE w.archived_at IS NULL
                       AND (instr(lower(w.name), lower(?)) > 0
                            OR instr(lower(coalesce(w.description,'')), lower(?)) > 0)
                       AND (w.created_at,w.id) > (?,?)
                       ORDER BY w.created_at,w.id LIMIT ?""",
                    (q, q, *after, limit + 1),
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
        next_cursor = None
        if len(rows) > limit:
            last = items[-1]
            next_cursor = base64.urlsafe_b64encode(
                json.dumps(
                    {"binding": binding, "after": [last["created_at"], last["id"]]},
                    ensure_ascii=False,
                ).encode()
            ).decode()
        return {"items": items, "next_cursor": next_cursor}

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
    ) -> dict[str, Any]:
        """Append a reviewed immutable revision; catalog revision editing has no HTTP route yet."""
        _validate_utf8(workflow_id, note)
        _optional_note(note, "Global WorkflowVersion", WorkflowValidationError)
        canonical, digest = _canonical_workflow(workflow)
        with closing(open_connection(self.database_path)) as connection:
            connection.row_factory = sqlite3.Row
            try:
                connection.execute("BEGIN IMMEDIATE")
                root = connection.execute(
                    "SELECT * FROM global_workflow WHERE id=?", (workflow_id,)
                ).fetchone()
                if root is None:
                    raise WorkflowVersionNotFoundError("Global Workflow not found")
                if root["archived_at"] is not None:
                    raise WorkflowValidationError("Global Workflow must be active")
                version_number = connection.execute(
                    "SELECT coalesce(max(version_number),0)+1 FROM global_workflow_version WHERE workflow_id=?",
                    (workflow_id,),
                ).fetchone()[0]
                version_id = str(uuid4())
                _insert(
                    connection,
                    "global_workflow_version",
                    dict(
                        id=version_id,
                        workflow_id=workflow_id,
                        version_number=version_number,
                        name_snapshot=root["name"],
                        workflow_json=canonical,
                        content_sha256=digest,
                        note=note,
                        created_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                        archived_at=None,
                    ),
                )
                result = _version(connection, "global_", version_id)
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise

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
