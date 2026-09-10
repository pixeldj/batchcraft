-- Authoring IDs are independent of the shipped setup-copy receipt namespace.
CREATE TABLE global_workflow_authoring_receipt (
    request_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER global_authoring_receipt_immutable BEFORE UPDATE ON global_workflow_authoring_receipt
BEGIN SELECT RAISE(ABORT, 'authoring receipt is immutable'); END;
CREATE INDEX global_profile_families ON global_workflow_profile
    (workflow_id, created_at, id);
CREATE INDEX global_workflow_history ON global_workflow_version
    (workflow_id, created_at, id);
CREATE INDEX global_profile_history ON global_workflow_profile_version
    (workflow_profile_id, created_at, id);
