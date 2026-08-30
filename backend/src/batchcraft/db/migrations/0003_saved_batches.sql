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
    variable_list_id TEXT NOT NULL,
    values_json TEXT NOT NULL CHECK (
        json_valid(values_json) AND json_type(values_json) = 'array'
    ),
    selected_values_json TEXT NOT NULL CHECK (
        json_valid(selected_values_json) AND json_type(selected_values_json) = 'array'
    ),
    mode TEXT NOT NULL CHECK (mode IN ('all', 'fixed')),
    fixed_value TEXT,
    PRIMARY KEY (batch_id, position),
    CHECK (
        (mode = 'all' AND fixed_value IS NULL)
        OR (mode = 'fixed' AND fixed_value IS NOT NULL)
    ),
    FOREIGN KEY (batch_id) REFERENCES batch(id) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

CREATE TABLE batch_reference_selection (
    batch_id TEXT NOT NULL CHECK (length(trim(batch_id)) > 0),
    position INTEGER NOT NULL CHECK (position >= 1),
    asset_id TEXT NOT NULL CHECK (length(trim(asset_id)) > 0),
    PRIMARY KEY (batch_id, position),
    FOREIGN KEY (batch_id) REFERENCES batch(id) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;
