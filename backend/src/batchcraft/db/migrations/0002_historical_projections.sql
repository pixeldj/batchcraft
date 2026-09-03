CREATE TABLE historical_asset (
    project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL CHECK (length(trim(asset_id)) > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    original_filename TEXT NOT NULL,
    mime_type TEXT,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    stored_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    integrity_status TEXT NOT NULL CHECK (integrity_status IN ('verified', 'missing', 'corrupt')),
    PRIMARY KEY (project_id, asset_id),
    UNIQUE (project_id, sha256)
) STRICT;

CREATE TABLE historical_batch (
    project_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    filesystem_key TEXT NOT NULL,
    name TEXT NOT NULL,
    integrity_status TEXT NOT NULL CHECK (integrity_status IN ('verified', 'invalid')),
    PRIMARY KEY (project_id, batch_id),
    UNIQUE (project_id, filesystem_key)
) STRICT;

CREATE TABLE historical_run (
    run_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    batch_filesystem_key TEXT NOT NULL,
    batch_name TEXT NOT NULL,
    run_number INTEGER NOT NULL CHECK (run_number >= 1),
    filesystem_key TEXT NOT NULL,
    name TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    job_count INTEGER NOT NULL CHECK (job_count >= 0),
    execution_available INTEGER NOT NULL CHECK (execution_available IN (0, 1)),
    execution_status TEXT,
    started_at TEXT,
    completed_at TEXT,
    integrity_status TEXT NOT NULL CHECK (integrity_status IN ('verified', 'degraded')),
    replayable INTEGER NOT NULL CHECK (replayable IN (0, 1)),
    UNIQUE (project_id, batch_id, filesystem_key),
    UNIQUE (project_id, relative_path)
) STRICT;

CREATE INDEX historical_run_project_idx
    ON historical_run (project_id, created_at DESC, run_number DESC, run_id);

CREATE TABLE historical_job (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    prompt_version_id TEXT NOT NULL,
    resolved_prompt TEXT NOT NULL,
    resolved_variables_json TEXT NOT NULL CHECK (json_valid(resolved_variables_json)),
    resolved_parameter_sets_json TEXT NOT NULL CHECK (json_valid(resolved_parameter_sets_json)),
    seed INTEGER NOT NULL,
    output_prefix TEXT NOT NULL,
    execution_status TEXT,
    prompt_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
    PRIMARY KEY (run_id, job_id),
    UNIQUE (run_id, ordinal)
) STRICT;

CREATE TABLE historical_resolved_parameter (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 1),
    parameter_key TEXT NOT NULL,
    parameter_label TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    PRIMARY KEY (run_id, job_id, position),
    UNIQUE (run_id, job_id, parameter_key)
) STRICT;

CREATE TABLE historical_image_input (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 1),
    slot_key TEXT NOT NULL,
    slot_label TEXT NOT NULL,
    asset_id TEXT,
    PRIMARY KEY (run_id, job_id, position),
    UNIQUE (run_id, job_id, slot_key)
) STRICT;

CREATE TABLE historical_asset_use (
    project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    slot_key TEXT NOT NULL,
    PRIMARY KEY (run_id, job_id, slot_key)
) STRICT;

CREATE INDEX historical_asset_use_project_idx
    ON historical_asset_use (project_id, asset_id, run_id);

CREATE TABLE historical_result (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    job_ordinal INTEGER NOT NULL CHECK (job_ordinal >= 1),
    artifact_ordinal INTEGER NOT NULL CHECK (artifact_ordinal >= 1),
    producing_node_id TEXT NOT NULL,
    output_name TEXT NOT NULL,
    remote_filename TEXT NOT NULL,
    remote_subfolder TEXT NOT NULL,
    remote_type TEXT NOT NULL,
    local_path TEXT NOT NULL,
    content_type TEXT,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    integrity_status TEXT NOT NULL CHECK (integrity_status IN ('verified', 'missing', 'corrupt')),
    PRIMARY KEY (run_id, job_id, artifact_ordinal),
    UNIQUE (run_id, job_ordinal, artifact_ordinal)
) STRICT;

CREATE TABLE historical_diagnostic (
    project_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 1),
    scope TEXT NOT NULL CHECK (scope IN ('project', 'asset', 'batch', 'run', 'execution', 'result')),
    filesystem_key TEXT,
    entity_id TEXT,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    PRIMARY KEY (project_id, position)
) STRICT;

CREATE INDEX historical_diagnostic_project_idx
    ON historical_diagnostic (project_id, position);
