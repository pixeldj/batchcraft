CREATE TABLE historical_projection_state (
    project_id TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    scanned_at TEXT NOT NULL
) STRICT;

-- Registered by open_connection: exact microseconds, naive ISO values mean UTC,
-- unknown timestamps remain NULL. These match history_query.py keyset tuples.
CREATE INDEX historical_run_oldest_idx ON historical_run (
    project_id,
    history_timestamp_us(created_at) IS NULL,
    coalesce(history_timestamp_us(created_at), 0),
    run_id
);

CREATE INDEX historical_run_newest_idx ON historical_run (
    project_id,
    history_timestamp_us(created_at) IS NULL,
    coalesce(-history_timestamp_us(created_at), 0),
    run_id
);

CREATE INDEX historical_result_project_idx
    ON historical_result (project_id, run_id, job_ordinal, artifact_ordinal);
CREATE INDEX historical_job_project_idx ON historical_job (project_id);
CREATE INDEX historical_resolved_parameter_project_idx ON historical_resolved_parameter (project_id);
CREATE INDEX historical_image_input_project_idx ON historical_image_input (project_id);
