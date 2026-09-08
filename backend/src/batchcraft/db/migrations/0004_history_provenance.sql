CREATE TABLE historical_provenance_state (
    project_id TEXT PRIMARY KEY,
    generation TEXT NOT NULL
) STRICT;

-- Frozen v1 revision metadata has no signed-64-bit bound; preserve decimal text.
CREATE TABLE historical_run_provenance (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    workflow_version_id TEXT,
    workflow_name TEXT,
    workflow_version_number TEXT,
    profile_version_id TEXT,
    profile_name TEXT,
    profile_version_number TEXT,
    saved_batch_id TEXT,
    saved_batch_name TEXT,
    saved_batch_revision TEXT,
    PRIMARY KEY (project_id, run_id)
) STRICT;
CREATE INDEX historical_run_provenance_filter_idx ON historical_run_provenance
    (project_id, workflow_version_id, profile_version_id, saved_batch_id, run_id);

CREATE TABLE historical_prompt_snapshot (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    prompt_version_id TEXT NOT NULL,
    prompt_id TEXT,
    name TEXT NOT NULL,
    version_number TEXT,
    PRIMARY KEY (project_id, run_id, prompt_version_id)
) STRICT;
CREATE INDEX historical_prompt_snapshot_identity_idx ON historical_prompt_snapshot
    (project_id, prompt_id, prompt_version_id, run_id);

CREATE TABLE historical_parameter_value (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    parameter_key TEXT NOT NULL,
    parameter_label TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('string', 'integer', 'float', 'boolean')),
    is_base INTEGER NOT NULL CHECK (is_base IN (0, 1)),
    string_value TEXT,
    integer_value INTEGER,
    real_value REAL,
    boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
    PRIMARY KEY (project_id, run_id, job_id, parameter_key),
    CHECK (
        (is_base = 1 AND string_value IS NULL AND integer_value IS NULL AND real_value IS NULL AND boolean_value IS NULL)
        OR (is_base = 0 AND (
            (value_type = 'string' AND string_value IS NOT NULL AND integer_value IS NULL AND real_value IS NULL AND boolean_value IS NULL)
            OR (value_type = 'integer' AND string_value IS NULL AND integer_value IS NOT NULL AND real_value IS NULL AND boolean_value IS NULL)
            OR (value_type = 'float' AND string_value IS NULL AND integer_value IS NULL AND real_value IS NOT NULL AND boolean_value IS NULL)
            OR (value_type = 'boolean' AND string_value IS NULL AND integer_value IS NULL AND real_value IS NULL AND boolean_value IS NOT NULL)
        ))
    )
) STRICT;
CREATE INDEX historical_parameter_value_choice_idx ON historical_parameter_value
    (project_id, parameter_key, value_type);
CREATE INDEX historical_job_provenance_idx ON historical_job
    (project_id, run_id, seed, prompt_version_id, job_id);
CREATE INDEX historical_image_input_provenance_idx ON historical_image_input
    (project_id, run_id, job_id, slot_key, asset_id);
