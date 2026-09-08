"""Public diagnostics are a bounded vocabulary, never arbitrary exception text.

This does not redact user provenance or rewrite durable records. Unknown legacy
diagnostics are summarized at the response boundary, not guessed to be secret-free.
"""

import builtins
import errno
import hashlib
import re
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).parent


def safe_exception(error: BaseException, *, run_id: str | None = None) -> str:
    """Keep bounded debugging context without formatting exception values or source lines."""
    summaries: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen and len(summaries) < 4:
        seen.add(id(current))
        category = next(
            kind.__name__
            for kind in type(current).__mro__
            if vars(builtins).get(kind.__name__) is kind
        )
        reason = ""
        if isinstance(current, OSError):
            reason = {
                errno.EACCES: " permission_denied",
                errno.EPERM: " permission_denied",
                errno.ENOSPC: " storage_full",
                errno.EDQUOT: " storage_quota_exceeded",
                errno.EROFS: " read_only_storage",
                errno.ENOENT: " file_not_found",
                errno.EIO: " storage_io_error",
            }.get(current.errno if type(current.errno) is int else 0, " operating_system_error")
        locations: list[str] = []
        trace = current.__traceback__
        while trace is not None:
            try:
                relative = Path(trace.tb_frame.f_code.co_filename).relative_to(_PACKAGE_ROOT)
            except ValueError:
                pass
            else:
                if ".." not in relative.parts:
                    locations.append(f"batchcraft/{relative.as_posix()}:{trace.tb_lineno}")
            trace = trace.tb_next
        summaries.append(f"{category}{reason} at {', '.join(locations[-4:]) or 'external'}")
        current = current.__cause__ or (
            None if current.__suppress_context__ else current.__context__
        )
    correlation = (
        ""
        if run_id is None
        else f"run=sha256:{hashlib.sha256(run_id.encode('utf-8', 'surrogatepass')).hexdigest()[:16]} "
    )
    return correlation + " caused by ".join(summaries)


_SAFE_MESSAGES = frozenset(
    {
        "cannot connect to ComfyUI",
        "discarded_before_start",
        "stopped_after_current_job",
        "User detached from current Job while remote completion was unconfirmed.",
        "history reconciliation timed out",
        "prompt contains malformed placeholder delimiters",
        "fixed seed input must contain exactly one seed",
        "explicit seed input must contain at least one seed",
        "Batch must contain at least one PromptVersion",
        "PromptVersion ID must not be empty",
        "Target Workflow and WorkflowVersion must both be active",
        "Target WorkflowVersion must belong to the historical Run Project and exactly "
        "match its frozen Workflow",
        "Historical Prompt import request IDs are occupied by incoherent library records",
    }
)

# These full grammars contain only application literals and bounded numeric context.
_SAFE_NUMERIC = re.compile(
    r"(?:ComfyUI (?:system information|input upload|history lookup) failed with HTTP [1-5][0-9]{2}"
    r"|Historical PromptVersion position [0-9]{1,9} is outside the available range 0\.\.[0-9]{1,9}"
    r"|Historical PromptVersion at position [0-9]{1,9} has empty text and cannot be imported as a mutable Prompt"
    r"|(?:Batch|Saved Batch parameter validation) expands beyond the maximum of [0-9]{1,9} Jobs)"
)


def public_diagnostic(value: str | None, fallback: str) -> str | None:
    if value is None:
        return None
    if len(value) <= 256 and (value in _SAFE_MESSAGES or _SAFE_NUMERIC.fullmatch(value)):
        return value
    return fallback


_ERROR_MESSAGES = {
    "invalid_request": "Request data is invalid",
    "project_not_found": "Project was not found",
    "prompt_not_found": "Prompt was not found",
    "prompt_version_not_found": "PromptVersion was not found",
    "workflow_not_found": "Workflow was not found",
    "workflow_version_not_found": "WorkflowVersion was not found",
    "workflow_profile_not_found": "Workflow Profile was not found",
    "workflow_profile_version_not_found": "Workflow Profile version was not found",
    "saved_batch_not_found": "Saved Batch was not found",
    "project_discovery_failed": "Projects could not be discovered",
    "saved_batch_discovery_failed": "Saved Batches could not be discovered",
    "invalid_asset_data": "Project asset data is invalid",
    "asset_publication_failed": "Project assets could not be published",
    "run_not_found": "Run was not found",
    "result_not_found": "Result was not found",
    "execution_already_active": "Run execution is already active",
    "run_cancellation_not_eligible": "Run is not eligible for cancellation",
    "run_cancellation_store_failed": "Run cancellation data is unavailable",
    "run_creation_failed": "Run could not be created",
    "run_publication_failed": "Run could not be published",
    "invalid_run_data": "Durable Run data is invalid",
    "internal_error": "An unexpected error occurred",
    "invalid_library_input": "Library input is invalid; check required fields and Workflow mappings",
    "saved_batch_integrity_error": "Saved Batch bindings or ownership are invalid; reload and check selections",
    "saved_batch_revision_conflict": "Saved Batch changed since it was loaded; reload before saving",
    "invalid_workflow_profile_target": "Workflow Profile must target a version of its own Workflow",
    "library_conflict": "Library identity or name already exists; choose a different name or reload",
    "project_publication_failed": "Project could not be published; check filesystem ownership and permissions",
    "saved_batch_publication_conflict": "Saved Batch could not be published; check filesystem ownership",
    "project_adoption_failed": "Project could not be adopted; check owner identity and filesystem key",
    "project_import_conflict": "Project import conflicts with registered identity; check Project ownership",
    "project_import_failed": "Project import or reindex failed; check v1 owner records and directory permissions",
    "history_generation_changed": "History changed; restart browsing without a cursor",
    "invalid_history_query": "History query or cursor is invalid; check filters or restart without a cursor",
    "historical_resource_import_conflict": "Historical resource import conflicts with existing library records",
    "invalid_historical_resource_import": "Historical resource cannot be imported; check position and target Workflow",
    "invalid_batch": "Batch is invalid; check PromptVersion bindings, Image Inputs, parameters, and seeds",
    "invalid_workflow_profile": "Workflow Profile is invalid; check mapped literal inputs and their types",
    "project_asset_not_found": "Project Asset was not found; reselect or import the image",
    "invalid_project_key": "Project filesystem key or directory is unsafe",
    "invalid_asset_upload": "Image upload is invalid; use matching PNG, JPEG, or WebP filename, MIME, and bytes",
    "execution_not_eligible": "Run is not eligible for execution; existing execution cannot be restarted",
    "run_discard_not_eligible": "Only an unstarted Run without submission evidence can be discarded",
}


def public_error_message(code: str, message: str) -> str:
    fallback = _ERROR_MESSAGES.get(
        code, "Operation failed; check input and local application state"
    )
    if code == "invalid_batch":
        for prefix in ("duplicate PromptVersion ID:", "image bindings contain unknown slots:"):
            if message.startswith(prefix):
                return prefix.rstrip(":") + "; check Batch selections"
    return public_diagnostic(message, fallback) or fallback


HISTORY_MESSAGES = {
    "duplicate_run_id": "Run ID appears in more than one directory",
    "conflicting_asset_metadata": "Asset has conflicting historical metadata",
    "unsafe_asset_root": "Asset root is unsafe",
    "unsafe_asset_path": "Asset path contains a symlink",
    "invalid_asset_content": "Asset content failed integrity validation",
    "invalid_asset": "Asset metadata is invalid",
    "duplicate_asset_id": "Asset ID appears more than once",
    "unsafe_batches_root": "Batches root is unsafe",
    "invalid_batch_owner": "Batch owner record is invalid; check v1 identity and ownership",
    "duplicate_batch_id": "Batch ID appears more than once",
    "unsafe_run_path": "Run path is unsafe",
    "invalid_run": "Run is invalid; check v1 records, ownership, and snapshot integrity",
    "invalid_referenced_asset": "Referenced Asset is missing or failed integrity validation",
    "invalid_execution": "Execution record is invalid; remote outcome is unavailable",
    "missing_result": "Result file is missing",
    "corrupt_result": "Result file failed integrity validation",
}
