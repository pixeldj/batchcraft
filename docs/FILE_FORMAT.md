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

Contains the Workflow Profile metadata, required core mappings, ordered named Image Input targets, and
ordered typed generic parameters snapshotted for the Run. The `image_inputs` and `parameters` arrays may
be empty. Parameter entries contain `key`, `label`, `node_id`, `input_name`, and `value_type`. This file
is immutable once successful Run creation completes.

Together, `workflow.json`, `workflow-profile.json`, and the per-Job values in `manifest.json` describe the concrete workflow mutations required for replay.

The file uses canonical JSON encoding. Its SHA-256 is recorded separately from the base workflow hash.

## `manifest.json`

The JSON manifest is the canonical machine-readable execution description.

The current manifest has `format_version: 7` and contains:

- Run ID, number, creation timestamp, and Project/Batch identity snapshots;
- ordered PromptVersion snapshots containing ID, name, and exact Prompt Template text;
- compiler warnings;
- workflow and Workflow Profile snapshot paths and hashes;
- stable Job ID and compiler ordinal;
- each Job's source PromptVersion ID;
- resolved variables;
- resolved final prompt;
- ordered Profile Image Input slots with frozen key, label, node ID, and input name;
- each Job's ordered `resolved_image_inputs`, with slot key, frozen label, and either `null` or complete
  Reference Asset provenance;
- ordered Profile parameter definitions and each Job's ordered typed `resolved_parameters`;
- seed;
- per-Job workflow and Workflow Profile hashes.

Nested structures are allowed here.

`manifest.json` is authoritative for exact replay. The v7 creation manifest contains immutable plan and
provenance only. Job execution status, ComfyUI prompt IDs, errors, and Results remain in the separated
versioned execution representation.

Every Job contains `resolved_image_inputs` in Profile order. Each entry is shaped as:

```json
{
  "slot_key": "identity",
  "slot_label": "Identity",
  "asset": null
}
```

`asset` is the complete Reference Asset object when selected or explicit JSON `null` for Base
workflow. A `null` asset means execution performs no upload and does not mutate that slot's target.
The top-level `image_input_slots` array freezes each slot's `slot_key`, `slot_label`, `node_id`, and
`input_name`.

The top-level `parameters` array freezes each generic parameter's key, label, target, and value type.
Every Job contains ordered `resolved_parameters` entries shaped as
`{ "parameter_key": string, "value": scalar | null }`. `null` preserves the Base workflow value.
Every entry remains scalar because parameter alternatives are resolved during compilation, before the
Job reaches execution.

Manifest v7 requires a top-level `batch_snapshot` object with `snapshot_version: 5`. It stores variable
bindings canonically as `{ "placeholder": string, "values": string[] }`. Zero values may
appear in mutable Saved Batch drafts but a successfully compiled Run cannot use a zero-value binding.
An empty string is one concrete value. New writes reject exact duplicate values, including duplicate
empty strings.
The snapshot stores ordered image bindings as `{ "slot_key": string, "values": [asset_id | null] }`.
Each Profile slot requires one or more ordered, unique alternatives. Every slot is an independent
Cartesian compiler dimension, while each concrete manifest Job stores only its one resolved choice.
Base workflow is `null` and appears first when included.
The snapshot stores parameter editable intent. Explicit bindings use
`{ "parameter_key": string, "mode": "values", "values": [scalar | null, ...] }`. Numeric Range
bindings use `{ "parameter_key": string, "mode": "range", "include_base": boolean,
"range": { "start": string, "end": string, "step": string } }`. Range decimal text remains frozen for
editable provenance. Loading rematerializes it through the authoritative backend function and requires
the result to reconstruct the exact scalar Job plan. Each concrete manifest Job still stores only one
resolved scalar or Base workflow choice.
Snapshots may also preserve optional human-readable Workflow and Profile names plus immutable version
numbers. These labels support historical UI inspection and are not required for replay.

Manifest v1-v6 and snapshot v1-v4 are unsupported. The loader rejects them and never rewrites Run files.

## `manifest.csv`

The CSV manifest is a human-friendly tabular representation intended for:

- inspection;
- spreadsheet analysis;
- portability;
- future convenient import workflows;
- simple external tooling.

The columns emitted alongside a v7 JSON manifest are:

```text
job_ordinal
job_id
prompt_version_id
prompt_version_name
prompt_template
resolved_prompt
resolved_variables_json
resolved_image_inputs_json
resolved_parameters_json
seed
workflow_sha256
workflow_profile_sha256
```

`manifest.json`'s `format_version` identifies the CSV schema that accompanies the Run; the CSV has no
independent version field.

`resolved_image_inputs_json` contains the same ordered slot objects as the canonical Job JSON. The JSON
manifest remains authoritative, including explicit `null` asset values for Base workflow.

For structures that do not map naturally to flat columns, encode compact JSON in a column rather than losing information.

`manifest.json` remains canonical if CSV representation becomes lossy or awkward.

A standalone CSV file is not sufficient for guaranteed exact replay. Exact replay uses `manifest.json` together with the snapshotted base workflow, Workflow Profile mapping, and referenced Project assets.

## `execution.json`

`execution.json` is the versioned mutable execution record. It is reconstructable without SQLite and remains separate from generation-significant data in `manifest.json`.

Only execution format v3 is supported. Execution formats v1 and v2 are intentionally unsupported and have no compatibility loader. This version change does not alter `run.json` or `manifest.json` versions.

The v3 shape is:

```json
{
  "format_version": 3,
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

Legal Run transitions are `created -> running | cancelled`, then `running -> succeeded | failed | blocked | cancelled`; explicit reconciliation may move `blocked -> running | succeeded | failed`. Legal Job transitions are `pending -> preparing | cancelled`, `preparing -> submitting | failed | cancelled`, `submitting -> submitted | submission_unknown | failed`, and `submitted -> succeeded | failed`. Explicit reconciliation may move `submission_unknown -> submitted | failed`. `succeeded`, `failed`, and `cancelled` states are terminal and are not rewritten.

A discarded state has Run status `cancelled`, `started_at: null`, a discard-clock `completed_at`, `current_job_ordinal: null`, `error: null`, and exactly one Run diagnostic: `discarded_before_start`. Every Job must exactly match its initial pending state, with no client ID, submission disposition or response, prompt ID, timestamps, errors, diagnostics, history, or Results.

A stop-after-current state has Run status `cancelled`, non-null `started_at` and `completed_at`, `current_job_ordinal: null`, `error: null`, and exactly one Run diagnostic: `stopped_after_current_job`. Its Jobs form a succeeded prefix followed by a non-empty cancelled suffix. A cancelled Job has the Run cancellation timestamp and no submission disposition or response, prompt ID, error, diagnostics, history, or Results. The first cancelled Job may retain its local preparation `client_id` and `started_at`; later cancelled Jobs retain no preparation evidence.

A local-detach state has Run status `blocked`, non-null `started_at`, `completed_at: null`, its current Job ordinal retained, and exact Run error and diagnostic `User detached from current Job while remote completion was unconfirmed.` Earlier Jobs form a succeeded prefix and later Jobs remain pristine pending. The current Job preserves its best-known state as `preparing`, `submission_unknown`, or `submitted`, including any client ID, submission disposition and response, prompt ID, history evidence, diagnostics, and already recorded Results. Detach during `submitting` first records `submission_unknown`; it never resets possible remote work to pending. A stronger already durable success, failure, cancellation, or complete Run outcome remains authoritative.

`submitting` means the one submission attempt has started. After a restart it must not be treated as never submitted. `submission_unknown` stops automatic progression and preserves correlation data; a future explicit reconciliation may prove that it was accepted or failed, but the executor never retries it automatically. `submitted` carries a known prompt ID; if bounded history reconciliation cannot prove a terminal outcome, the Job remains submitted and the Run becomes blocked.

Stop-after-current never interrupts ComfyUI or clears its queue. If submission admission already occurred, the current Job continues through normal history reconciliation and Result ingestion. A failed current Job leaves the Run `failed`; an unresolved accepted or ambiguous submission leaves it `blocked`. If the final Job succeeds after a cancellation request, no unsubmitted suffix remains and the Run honestly finishes `succeeded`.

Local detach also never interrupts ComfyUI or clears its queue. SQLite intent is persisted before the owned local execution task is cancelled solely to wake an in-flight await. The executor converts that wake-up to the detached blocked shape only when durable detach intent is present; unrelated task cancellation does not fabricate a terminal execution outcome. A restarted application reads the blocked filesystem state and does not resume the old Run automatically.

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

A Run records the stable identity and hash of each Reference Asset selected for a named Image Input.
Every Profile slot appears in every Job. A slot with no selected asset records explicit `null`
provenance and relies on the immutable base workflow snapshot for that target's value.

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

batchcraft should support importing the current manifest v7 for exact replay. A future CSV import may provide a convenient best-effort workflow, but CSV alone does not guarantee exact replay.

The application should recognize enough metadata to:

- identify the prior Batch/Run if present locally;
- reconstruct the Job plan from authoritative JSON;
- validate required workflow snapshots and selected Image Input assets;
- create a **new** Run;
- preserve the original Run unchanged.

Exact replay preserves generation inputs, the base workflow, Workflow Profile mappings and named Image
Input metadata, selected Reference Assets, variables, parameters, seeds, and Job ordering. The new Run
receives new Run and Job IDs, timestamps, ComfyUI prompt IDs, and output namespace.

Modified reruns can be added later.

## Loading and Validation

Loading a published Run requires `run.json`, canonical manifest v7, `manifest.csv`, both snapshot
files, and `outputs/`. Manifest v7 requires a batch snapshot with `snapshot_version: 5`, a non-empty
ordered PromptVersion collection, unique PromptVersion IDs, required names, and every Job's
association with a known PromptVersion. The loader validates ordered, unique Profile slot metadata and
requires every Job to contain the same ordered slot keys. Each resolved slot must contain either a
complete Reference Asset object or explicit `null`; a missing slot or asset key is invalid.

The loader also validates Run/Project/Batch identity consistency, one-based contiguous Job ordinals,
unique Job IDs, fully resolved prompts, snapshot hashes, and every referenced Project asset's metadata,
size, and content hash. It also validates frozen parameter definitions, ordered Job keys, and each
resolved value against its declared type. The Batch snapshot must contain the same identities and Workflow/Profile
content and must recompile to the exact frozen plan. The loader reconstructs the original
`CompiledRunPlan`, compiler warnings, execution
identities, asset records, and both snapshots without SQLite. CSV remains secondary: it must be
present in a complete current Run, but reformatting its line endings or quoting does not override or
invalidate canonical JSON provenance. Unsupported versions are rejected and existing Run directories
are never rewritten.

## Schema Versioning

Every durable JSON format includes an explicit schema or format version. Import code must not infer a
version solely from missing fields.

Example:

```json
{
  "format_version": 1
}
```

The pre-release baseline supports `run.json` v1, manifest v7 with required snapshot v5, execution v3,
and `asset.json` v1. Unsupported development versions fail closed. The application does not rewrite
or delete them automatically. Version fields and migration boundaries remain so a future change can
add an explicit compatibility path when released data requires one.

## Filesystem Publication and SQLite Indexing

Run creation writes and validates a sibling directory under the Batch's `.staging/`, then renames the complete directory to `run-NNN` on the same filesystem before future SQLite indexing. Here, complete means that every required plan and provenance file exists and validates; execution need not have started or reached a terminal state. A Run is not ready for scheduling until both publication and future indexing succeed.

Filesystem publication must be atomic within the destination filesystem. An incomplete staging directory is not a Run. If SQLite state is missing or incomplete, batchcraft can discover complete published Runs and rebuild their index records from the versioned files.

## Reproducibility Scope

The Run format preserves a replayable execution specification and provenance. It does not guarantee byte-identical pixels when ComfyUI, models, custom nodes, drivers, hardware, or other execution behavior changes.
