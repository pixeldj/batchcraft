# Run File Format

## Purpose

Published batchcraft Runs must remain understandable and re-indexable without depending on the SQLite database.

The filesystem format is therefore part of the product contract, not an implementation detail.

## Project Layout

The v1 layout is:

```text
projects/
└── <stable-project-key>/
    ├── project.json
    ├── assets/
    │   ├── .staging/
    │   └── sha256/
    │       └── ab/
    │           └── <full-sha256>/
    │               ├── asset.json
    │               └── content
    └── batches/
        └── <stable-batch-key>/
            ├── batch.json
            ├── .allocations/
            ├── .staging/
            ├── run-001/
            │   ├── run.json
            │   ├── manifest.json
             │   ├── manifest.csv
             │   ├── workflow.json
             │   ├── workflow-profile.json
             │   ├── execution.json
             │   └── outputs/
            │       ├── 000001-01.png
            │       ├── 000002-01.png
            │       └── ...
            ├── run-002/
            └── run-003/
```

Project and Batch paths use stable, path-safe filesystem keys rather than editable display names. Renaming a Project or Batch does not move historical paths. Stable internal IDs remain distinct from both filesystem keys and display names. `project.json` and `batch.json` bind each filesystem key to its stable internal ID so the same path cannot later be reused for another entity.

Names in owner identity files are the labels present when those files were first created. Each Run snapshots the Project and Batch labels current at its own creation time.

The incrementing Run directory identifies each execution within its Batch path. `run.json` and `manifest.json` retain the stable internal Run ID.

## Run Directory Naming

Use a deterministic incrementing scheme:

```text
run-001
run-002
run-003
```

Rerunning never overwrites an existing Run directory.

Run creation claims the first available number through an atomic directory creation under `.allocations/`; it does not calculate a maximum and assume the next number is free. The reservation is removed after publication or a safely handled failure. Concurrent local creators therefore receive distinct numbers while preserving human readability.

## `run.json`

Stores Run-level metadata.

The v1 creation schema is:

```json
{
  "format_version": 1,
  "run_id": "...",
  "run_number": 3,
  "status": "created",
  "created_at": "...",
  "project": {
    "project_id": "...",
    "filesystem_key": "project_...",
    "name": "Portrait experiments"
  },
  "batch": {
    "batch_id": "...",
    "filesystem_key": "batch_...",
    "name": "Portrait prompt test"
  },
  "workflow_sha256": "...",
  "workflow_profile_sha256": "...",
  "job_count": 48
}
```

`run.json` records the initial published state and is not rewritten by execution. Advancing runtime state lives in `execution.json`.

## `workflow.json`

Contains the imported base ComfyUI API-format workflow snapshot used to compile this Run.

This is immutable once successful Run creation completes.

The file uses canonical JSON encoding. Its SHA-256 is recorded in Run and Job provenance.

## `workflow-profile.json`

Contains the Workflow Profile metadata and friendly-input-to-node-input mappings snapshotted for the Run. This file is immutable once successful Run creation completes.

Together, `workflow.json`, `workflow-profile.json`, and the per-Job values in `manifest.json` describe the concrete workflow mutations required for replay.

The file uses canonical JSON encoding. Its SHA-256 is recorded separately from the base workflow hash.

## `manifest.json`

The JSON manifest is the canonical machine-readable execution description.

The v1 manifest contains:

- Run ID, number, creation timestamp, and Project/Batch identity snapshots;
- PromptVersion ID and Prompt Template text available from `CompiledRunPlan`;
- compiler warnings;
- workflow and Workflow Profile snapshot paths and hashes;
- stable Job ID and compiler ordinal;
- resolved variables;
- resolved final prompt;
- Reference Asset ID, original filename, MIME type, byte size, Project-relative content path, creation timestamp, and SHA-256;
- seed;
- per-Job workflow and Workflow Profile hashes.

Nested structures are allowed here.

`manifest.json` is authoritative for exact replay. The v1 creation manifest contains immutable plan and provenance only. Job execution status, ComfyUI prompt IDs, errors, Results, exposed parameter sweeps, and output naming are added only when their owning milestones define a separated, versioned representation.

## `manifest.csv`

The CSV manifest is a human-friendly tabular representation intended for:

- inspection;
- spreadsheet analysis;
- portability;
- future convenient import workflows;
- simple external tooling.

The v1 columns are:

```text
job_ordinal
job_id
prompt_version_id
prompt_template
resolved_prompt
resolved_variables_json
reference_asset_id
reference_original_filename
reference_sha256
seed
workflow_sha256
workflow_profile_sha256
```

For structures that do not map naturally to flat columns, encode compact JSON in a column rather than losing information.

`manifest.json` remains canonical if CSV representation becomes lossy or awkward.

A standalone CSV file is not sufficient for guaranteed exact replay. Exact replay uses `manifest.json` together with the snapshotted base workflow, Workflow Profile mapping, and referenced Project assets.

## `execution.json`

`execution.json` is the versioned mutable execution record. It is reconstructable without SQLite and remains separate from generation-significant data in `manifest.json`.

The v1 shape is:

```json
{
  "format_version": 1,
  "run_id": "...",
  "status": "running",
  "started_at": "...",
  "completed_at": null,
  "current_job_ordinal": 1,
  "error": null,
  "diagnostics": [],
  "jobs": [
    {
      "job_id": "...",
      "ordinal": 1,
      "status": "submitted",
      "client_id": "...",
      "submission_disposition": "accepted",
      "submission_http_status": 200,
      "submission_response": {"prompt_id": "..."},
      "prompt_id": "...",
      "started_at": "...",
      "completed_at": null,
      "error": null,
      "diagnostics": [],
      "history_status": null,
      "results": []
    }
  ]
}
```

Legal Run transitions are `created -> running -> succeeded | failed | blocked`; explicit reconciliation may move `blocked -> running | succeeded | failed`. Legal Job transitions are `pending -> preparing -> submitting`, then `submitting -> submitted | submission_unknown | failed`, and `submitted -> succeeded | failed`. Preparation may also transition directly to `failed`, while explicit reconciliation may move `submission_unknown -> submitted | failed`. `succeeded` and `failed` states are not silently rewritten.

`submitting` means the one submission attempt has started. After a restart it must not be treated as never submitted. `submission_unknown` stops automatic progression and preserves correlation data; a future explicit reconciliation may prove that it was accepted or failed, but the executor never retries it automatically. `submitted` carries a known prompt ID; if bounded history reconciliation cannot prove a terminal outcome, the Job remains submitted and the Run becomes blocked.

Every update writes canonical JSON to a unique sibling temporary file, fsyncs it, atomically replaces `execution.json`, and fsyncs the Run directory. A failed temporary write leaves the prior complete state file in place. Loading execution state verifies every recorded Result's existence, size, and SHA-256. Saving validates state transitions and append-only Result metadata, but reads and hashes only newly appended Result files.

## Outputs

Application-owned outputs live under:

```text
outputs/
```

A simple initial naming scheme is:

```text
000001-01.png
000001-02.png
000002-01.png
```

The first number is the Job ordinal and the second is the artifact ordinal within that Job. `execution.json` records each Result's producing ComfyUI node ID, output field name, remote filename/subfolder/type, local path, content type, byte size, and SHA-256.

Remote paths never control local placement. batchcraft constructs the local basename from persisted ordinals and accepts only a short alphanumeric extension from the remote basename or content type, falling back to `.bin`. Result bytes are atomically replaced into the real, non-symlinked `outputs/` directory and verified when execution state is loaded.

The manifest carries the meaningful provenance, so filenames do not need to encode the entire prompt and parameter set.

Human-readable suffixes may be added later, but path length and unsafe characters should be avoided.

## Input Provenance

A Run records the stable identity and hash of each input Reference Asset.

Reference Asset bytes live immutably in the Project's content-addressed asset store. Runs do not copy every input asset into their own directories by default.

`asset.json` has `format_version: 1` and records the asset ID, SHA-256, original filename, detected MIME type or `null`, byte size, Project-relative stored path, and creation timestamp. Bytes are stored without a filename-derived extension at `assets/sha256/<first-two-hash-characters>/<full-sha256>/content`.

Import copies and hashes bytes in one pass through Project-local staging, then publishes the complete content/metadata directory atomically. Identical content reuses the existing asset record and bytes, regardless of the later import filename. The first successful import therefore supplies the retained original-filename and MIME metadata. Different content always has a different content path.

The application must not physically remove asset content while any historical Run references it. Removing an asset from a Reference Collection or active library view does not remove those bytes. Missing or incomplete SQLite state never makes deletion safe; deletion checks must account for published filesystem Runs.

A later self-contained Run export may copy all referenced inputs into an export package. Until then, exact replay requires the immutable Project asset store in addition to the Run directory.

## Immutability

When successful Run creation completes, before scheduling begins:

- workflow snapshot is immutable;
- compiled Job plan is immutable;
- Job provenance is immutable.

Execution status fields and output/result fields may be appended or transitioned as execution proceeds.

After a Run reaches a terminal state, its provenance must not be rewritten silently.

Human review metadata such as ratings and notes may be stored separately or in explicitly mutable review files/database records.

## Import and Rerun

batchcraft should support importing `manifest.json` for exact replay. A future CSV import may provide a convenient best-effort workflow, but CSV alone does not guarantee exact replay.

The application should recognize enough metadata to:

- identify the prior Batch/Run if present locally;
- reconstruct the Job plan from authoritative JSON;
- validate required workflow/reference assets;
- create a **new** Run;
- preserve the original Run unchanged.

Exact replay preserves generation inputs, the base workflow, Workflow Profile mapping, references, variables, parameters, seeds, and Job ordering. The new Run receives new Run and Job IDs, timestamps, ComfyUI prompt IDs, and output namespace.

Modified reruns can be added later.

## Loading and Validation

Loading a published Run requires `run.json`, canonical `manifest.json`, `manifest.csv`, both snapshot files, and `outputs/`. It validates format versions, Run/Project/Batch identity consistency, one-based contiguous Job ordinals, unique Job IDs, fully resolved prompts, snapshot hashes, and every referenced Project asset's metadata, size, and content hash.

The loader reconstructs the original `CompiledRunPlan`, compiler warnings, execution identities, asset records, and both snapshots without SQLite. CSV remains secondary: it must be present in a complete v1 Run, but reformatting its line endings or quoting does not override or invalidate canonical JSON provenance.

## Schema Versioning

Every durable JSON format should include an explicit schema/format version.

Import code must not infer versions solely from missing fields.

Example:

```json
{
  "format_version": 1
}
```

Future migrations should preserve old Run readability whenever practical.

## Filesystem Publication and SQLite Indexing

Run creation writes and validates a sibling directory under the Batch's `.staging/`, then renames the complete directory to `run-NNN` on the same filesystem before future SQLite indexing. Here, complete means that every required plan and provenance file exists and validates; execution need not have started or reached a terminal state. A Run is not ready for scheduling until both publication and future indexing succeed.

Filesystem publication must be atomic within the destination filesystem. An incomplete staging directory is not a Run. If SQLite state is missing or incomplete, batchcraft can discover complete published Runs and rebuild their index records from the versioned files.

## Reproducibility Scope

The Run format preserves a replayable execution specification and provenance. It does not guarantee byte-identical pixels when ComfyUI, models, custom nodes, drivers, hardware, or other execution behavior changes.
