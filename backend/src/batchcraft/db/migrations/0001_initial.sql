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

CREATE TABLE batch (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
    filesystem_key TEXT NOT NULL CHECK (length(trim(filesystem_key)) > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT CHECK (description IS NULL OR length(trim(description)) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    seed_mode TEXT NOT NULL CHECK (seed_mode IN ('fixed', 'explicit', 'random')),
    seed_values_json TEXT NOT NULL CHECK (
        json_valid(seed_values_json) AND json_type(seed_values_json) = 'array'
    ),
    random_seed_count INTEGER CHECK (random_seed_count IS NULL OR random_seed_count >= 1),
    selected_workflow_version_id TEXT,
    selected_workflow_profile_id TEXT,
    selected_workflow_profile_version_id TEXT,
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    archived_at TEXT CHECK (archived_at IS NULL OR length(trim(archived_at)) > 0),
    CHECK (
        (seed_mode IN ('fixed', 'explicit') AND random_seed_count IS NULL)
        OR (seed_mode = 'random' AND random_seed_count IS NOT NULL)
    ),
    CHECK (
        (seed_mode = 'fixed' AND json_array_length(seed_values_json) = 1)
        OR (seed_mode = 'explicit' AND json_array_length(seed_values_json) >= 1)
        OR (seed_mode = 'random' AND json_array_length(seed_values_json) = 0)
    ),
    CHECK (
        selected_workflow_profile_version_id IS NULL
        OR selected_workflow_profile_id IS NOT NULL
    ),
    FOREIGN KEY (project_id) REFERENCES project(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (selected_workflow_version_id) REFERENCES workflow_version(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (selected_workflow_profile_id) REFERENCES workflow_profile(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (selected_workflow_profile_version_id) REFERENCES workflow_profile_version(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    UNIQUE (project_id, filesystem_key)
) STRICT;

CREATE INDEX batch_project_idx ON batch (project_id, archived_at, created_at, id);
CREATE INDEX batch_workflow_version_idx ON batch (selected_workflow_version_id);
CREATE INDEX batch_workflow_profile_idx ON batch (selected_workflow_profile_id);
CREATE INDEX batch_workflow_profile_version_idx ON batch (selected_workflow_profile_version_id);

CREATE TRIGGER batch_identity_immutable
BEFORE UPDATE ON batch
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.filesystem_key IS NOT OLD.filesystem_key
BEGIN
    SELECT RAISE(ABORT, 'batch identity and filesystem key are immutable');
END;

CREATE TABLE batch_prompt_selection (
    batch_id TEXT NOT NULL CHECK (length(trim(batch_id)) > 0),
    position INTEGER NOT NULL CHECK (position >= 1),
    prompt_version_id TEXT NOT NULL CHECK (length(trim(prompt_version_id)) > 0),
    PRIMARY KEY (batch_id, position),
    FOREIGN KEY (batch_id) REFERENCES batch(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    FOREIGN KEY (prompt_version_id) REFERENCES prompt_version(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX batch_prompt_selection_version_idx
    ON batch_prompt_selection (prompt_version_id, batch_id);

CREATE TABLE batch_variable_binding (
    batch_id TEXT NOT NULL CHECK (length(trim(batch_id)) > 0),
    position INTEGER NOT NULL CHECK (position >= 1),
    placeholder TEXT NOT NULL,
    values_json TEXT NOT NULL CHECK (
        json_valid(values_json) AND json_type(values_json) = 'array'
    ),
    PRIMARY KEY (batch_id, position),
    FOREIGN KEY (batch_id) REFERENCES batch(id) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE TABLE batch_image_binding (
    batch_id TEXT NOT NULL CHECK (length(trim(batch_id)) > 0),
    position INTEGER NOT NULL CHECK (position >= 1),
    slot_key TEXT NOT NULL CHECK (
        slot_key GLOB '[a-z]*'
        AND slot_key NOT GLOB '*[^a-z0-9_]*'
        AND slot_key NOT GLOB '*__*'
        AND substr(slot_key, -1) != '_'
    ),
    PRIMARY KEY (batch_id, position),
    UNIQUE (batch_id, slot_key),
    FOREIGN KEY (batch_id) REFERENCES batch(id) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE TABLE batch_image_binding_value (
    batch_id TEXT NOT NULL,
    binding_position INTEGER NOT NULL CHECK (binding_position >= 1),
    value_position INTEGER NOT NULL CHECK (value_position >= 1),
    asset_id TEXT CHECK (asset_id IS NULL OR length(trim(asset_id)) > 0),
    PRIMARY KEY (batch_id, binding_position, value_position),
    FOREIGN KEY (batch_id, binding_position) REFERENCES batch_image_binding(batch_id, position)
        ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE TABLE batch_parameter_binding (
    batch_id TEXT NOT NULL CHECK (length(trim(batch_id)) > 0),
    position INTEGER NOT NULL CHECK (position >= 1),
    parameter_key TEXT NOT NULL CHECK (
        parameter_key GLOB '[a-z]*'
        AND parameter_key NOT GLOB '*[^a-z0-9_]*'
        AND parameter_key NOT GLOB '*__*'
        AND substr(parameter_key, -1) != '_'
    ),
    PRIMARY KEY (batch_id, position),
    UNIQUE (batch_id, parameter_key),
    FOREIGN KEY (batch_id) REFERENCES batch(id) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE TABLE batch_parameter_binding_value (
    batch_id TEXT NOT NULL,
    binding_position INTEGER NOT NULL CHECK (binding_position >= 1),
    value_position INTEGER NOT NULL CHECK (value_position = 1),
    value_json TEXT NOT NULL CHECK (
        json_valid(value_json)
        AND json_type(value_json) IN ('null', 'text', 'integer', 'real', 'true', 'false')
    ),
    PRIMARY KEY (batch_id, binding_position, value_position),
    FOREIGN KEY (batch_id, binding_position)
        REFERENCES batch_parameter_binding(batch_id, position)
        ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;
