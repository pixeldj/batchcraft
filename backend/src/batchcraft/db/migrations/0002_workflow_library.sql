CREATE TABLE workflow (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT CHECK (description IS NULL OR length(trim(description)) > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    archived_at TEXT CHECK (archived_at IS NULL OR length(trim(archived_at)) > 0),
    UNIQUE (project_id, name),
    UNIQUE (id, project_id),
    FOREIGN KEY (project_id) REFERENCES project(id) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE INDEX workflow_project_idx ON workflow (project_id, archived_at, name);

CREATE TABLE workflow_version (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    workflow_id TEXT NOT NULL CHECK (length(trim(workflow_id)) > 0),
    project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot)) > 0),
    workflow_json TEXT NOT NULL CHECK (length(workflow_json) > 0),
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    note TEXT CHECK (note IS NULL OR length(trim(note)) > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    archived_at TEXT CHECK (archived_at IS NULL OR length(trim(archived_at)) > 0),
    UNIQUE (workflow_id, version_number),
    UNIQUE (id, project_id),
    UNIQUE (id, workflow_id),
    UNIQUE (id, workflow_id, project_id),
    FOREIGN KEY (workflow_id, project_id) REFERENCES workflow(id, project_id)
        ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE INDEX workflow_version_workflow_idx
    ON workflow_version (workflow_id, archived_at, version_number DESC);
CREATE INDEX workflow_version_project_idx ON workflow_version (project_id, id);

CREATE TRIGGER workflow_version_immutable
BEFORE UPDATE ON workflow_version
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
    OR NEW.workflow_id IS NOT OLD.workflow_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.version_number IS NOT OLD.version_number
    OR NEW.name_snapshot IS NOT OLD.name_snapshot
    OR NEW.workflow_json IS NOT OLD.workflow_json
    OR NEW.content_sha256 IS NOT OLD.content_sha256
    OR NEW.note IS NOT OLD.note
    OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'workflow_version is immutable except for archived_at');
END;

CREATE TABLE workflow_profile (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    workflow_id TEXT NOT NULL CHECK (length(trim(workflow_id)) > 0),
    project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT CHECK (description IS NULL OR length(trim(description)) > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    archived_at TEXT CHECK (archived_at IS NULL OR length(trim(archived_at)) > 0),
    UNIQUE (workflow_id, name),
    UNIQUE (id, workflow_id),
    UNIQUE (id, workflow_id, project_id),
    FOREIGN KEY (workflow_id, project_id) REFERENCES workflow(id, project_id)
        ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE INDEX workflow_profile_workflow_idx
    ON workflow_profile (workflow_id, archived_at, name);

CREATE TABLE workflow_profile_version (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    workflow_profile_id TEXT NOT NULL CHECK (length(trim(workflow_profile_id)) > 0),
    workflow_id TEXT NOT NULL CHECK (length(trim(workflow_id)) > 0),
    project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
    workflow_version_id TEXT NOT NULL CHECK (length(trim(workflow_version_id)) > 0),
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot)) > 0),
    profile_json TEXT NOT NULL CHECK (length(profile_json) > 0),
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    note TEXT CHECK (note IS NULL OR length(trim(note)) > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    archived_at TEXT CHECK (archived_at IS NULL OR length(trim(archived_at)) > 0),
    UNIQUE (workflow_profile_id, version_number),
    FOREIGN KEY (workflow_profile_id, workflow_id, project_id)
        REFERENCES workflow_profile(id, workflow_id, project_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    FOREIGN KEY (workflow_version_id, workflow_id, project_id)
        REFERENCES workflow_version(id, workflow_id, project_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX workflow_profile_version_profile_idx
    ON workflow_profile_version (workflow_profile_id, archived_at, version_number DESC);
CREATE INDEX workflow_profile_version_target_idx
    ON workflow_profile_version (workflow_version_id, archived_at, workflow_profile_id);

CREATE TRIGGER workflow_profile_version_immutable
BEFORE UPDATE ON workflow_profile_version
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
    OR NEW.workflow_profile_id IS NOT OLD.workflow_profile_id
    OR NEW.workflow_id IS NOT OLD.workflow_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.workflow_version_id IS NOT OLD.workflow_version_id
    OR NEW.version_number IS NOT OLD.version_number
    OR NEW.name_snapshot IS NOT OLD.name_snapshot
    OR NEW.profile_json IS NOT OLD.profile_json
    OR NEW.content_sha256 IS NOT OLD.content_sha256
    OR NEW.note IS NOT OLD.note
    OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'workflow_profile_version is immutable except for archived_at');
END;
