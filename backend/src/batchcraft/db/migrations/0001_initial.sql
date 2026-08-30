CREATE TABLE project (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    filesystem_key TEXT NOT NULL UNIQUE CHECK (length(trim(filesystem_key)) > 0),
    name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
    description TEXT CHECK (description IS NULL OR length(trim(description)) > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    archived_at TEXT CHECK (archived_at IS NULL OR length(trim(archived_at)) > 0)
) STRICT;

CREATE TABLE prompt (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT CHECK (description IS NULL OR length(trim(description)) > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    archived_at TEXT CHECK (archived_at IS NULL OR length(trim(archived_at)) > 0),
    UNIQUE (project_id, name),
    FOREIGN KEY (project_id) REFERENCES project(id) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE INDEX prompt_project_idx ON prompt (project_id, archived_at, name);

CREATE TABLE prompt_version (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    prompt_id TEXT NOT NULL CHECK (length(trim(prompt_id)) > 0),
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot)) > 0),
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    note TEXT CHECK (note IS NULL OR length(trim(note)) > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    archived_at TEXT CHECK (archived_at IS NULL OR length(trim(archived_at)) > 0),
    UNIQUE (prompt_id, version_number),
    FOREIGN KEY (prompt_id) REFERENCES prompt(id) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE INDEX prompt_version_prompt_idx
    ON prompt_version (prompt_id, archived_at, version_number DESC);

CREATE TRIGGER prompt_version_immutable
BEFORE UPDATE ON prompt_version
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
    OR NEW.prompt_id IS NOT OLD.prompt_id
    OR NEW.version_number IS NOT OLD.version_number
    OR NEW.name_snapshot IS NOT OLD.name_snapshot
    OR NEW.text IS NOT OLD.text
    OR NEW.note IS NOT OLD.note
    OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'prompt_version is immutable except for archived_at');
END;
