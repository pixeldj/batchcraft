CREATE TABLE global_workflow (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
    description TEXT,
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
) STRICT;
CREATE INDEX global_workflow_catalog ON global_workflow(archived_at, created_at, id);
CREATE TABLE global_workflow_version (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES global_workflow(id),
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot)) > 0),
    workflow_json TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
    note TEXT,
    created_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(workflow_id, version_number),
    UNIQUE(id, workflow_id)
) STRICT;
CREATE TABLE global_workflow_profile (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES global_workflow(id),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(workflow_id, name),
    UNIQUE(id, workflow_id)
) STRICT;
CREATE TABLE global_workflow_profile_version (
    id TEXT PRIMARY KEY,
    workflow_profile_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_version_id TEXT NOT NULL,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot)) > 0),
    profile_json TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
    note TEXT,
    created_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(workflow_profile_id, version_number),
    FOREIGN KEY(workflow_profile_id, workflow_id)
        REFERENCES global_workflow_profile(id, workflow_id),
    FOREIGN KEY(workflow_version_id, workflow_id)
        REFERENCES global_workflow_version(id, workflow_id)
) STRICT;
CREATE INDEX global_profile_target ON global_workflow_profile_version
    (workflow_version_id, archived_at, created_at, id);
CREATE TRIGGER global_workflow_version_immutable BEFORE UPDATE ON global_workflow_version
WHEN NEW.id IS NOT OLD.id OR NEW.workflow_id IS NOT OLD.workflow_id
 OR NEW.version_number IS NOT OLD.version_number OR NEW.name_snapshot IS NOT OLD.name_snapshot
 OR NEW.workflow_json IS NOT OLD.workflow_json OR NEW.content_sha256 IS NOT OLD.content_sha256
 OR NEW.note IS NOT OLD.note OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'global WorkflowVersion is immutable'); END;
CREATE TRIGGER global_profile_version_immutable BEFORE UPDATE ON global_workflow_profile_version
WHEN NEW.id IS NOT OLD.id OR NEW.workflow_id IS NOT OLD.workflow_id
 OR NEW.workflow_profile_id IS NOT OLD.workflow_profile_id
 OR NEW.workflow_version_id IS NOT OLD.workflow_version_id
 OR NEW.version_number IS NOT OLD.version_number OR NEW.name_snapshot IS NOT OLD.name_snapshot
 OR NEW.profile_json IS NOT OLD.profile_json OR NEW.content_sha256 IS NOT OLD.content_sha256
 OR NEW.note IS NOT OLD.note OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'global ProfileVersion is immutable'); END;
-- Receipts intentionally have no source foreign keys: ancestry survives source loss.
CREATE TABLE global_workflow_copy_receipt (
    request_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER global_copy_receipt_immutable BEFORE UPDATE ON global_workflow_copy_receipt
BEGIN SELECT RAISE(ABORT, 'copy receipt is immutable'); END;
