# Run File Format

## Purpose

Completed batchcraft Runs must remain understandable and re-indexable without depending on the SQLite database.

The filesystem format is therefore part of the product contract, not an implementation detail.

## Project Layout

A proposed layout is:

```text
projects/
└── <stable-project-key>/
    ├── project.json
    ├── assets/
    │   └── sha256/
    └── batches/
        └── <stable-batch-key>/
            ├── run-001/
            │   ├── run.json
            │   ├── manifest.json
            │   ├── manifest.csv
            │   ├── workflow.json
            │   ├── workflow-profile.json
            │   └── outputs/
            │       ├── 000001-01.png
            │       ├── 000002-01.png
            │       └── ...
            ├── run-002/
            └── run-003/
```

Project and Batch paths use stable, path-safe filesystem keys rather than editable display names. Renaming a Project or Batch does not move historical paths. Stable internal IDs remain distinct from both filesystem keys and display names.

The incrementing Run directory identifies each execution within its Batch path. `run.json` and `manifest.json` retain the stable internal Run ID.

## Run Directory Naming

Use a deterministic incrementing scheme:

```text
run-001
run-002
run-003
```

Rerunning never overwrites an existing Run directory.

If concurrent Run creation later requires stronger guarantees, allocation must remain collision-safe while preserving human readability.

## `run.json`

Stores Run-level metadata.

Example concepts:

```json
{
  "format_version": 1,
  "run_id": "...",
  "batch_id": "...",
  "batch_name": "portrait-prompt-test",
  "batch_filesystem_key": "batch_...",
  "run_number": 3,
  "status": "succeeded",
  "created_at": "...",
  "started_at": "...",
  "completed_at": "...",
  "workflow_hash": "...",
  "job_count": 48
}
```

The exact schema should be versioned. Run-level status and timestamps are execution state and may advance while the Run executes. The compiled plan and provenance do not change after successful Run creation.

## `workflow.json`

Contains the imported base ComfyUI API-format workflow snapshot used to compile this Run.

This is immutable once successful Run creation completes.

A workflow hash should also be recorded in Run and Job metadata.

## `workflow-profile.json`

Contains the Workflow Profile metadata and friendly-input-to-node-input mappings snapshotted for the Run. This file is immutable once successful Run creation completes.

Together, `workflow.json`, `workflow-profile.json`, and the per-Job values in `manifest.json` describe the concrete workflow mutations required for replay.

## `manifest.json`

The JSON manifest is the canonical machine-readable execution description.

It should contain all information necessary to understand every Job, including:

- Job ID and ordinal;
- source Prompt Template/version snapshot;
- resolved variables;
- resolved final prompt;
- reference asset identity, path, and hash;
- seed;
- exposed workflow parameter values;
- workflow hash;
- ComfyUI prompt ID when submitted;
- Job status and timestamps;
- output file metadata.

Nested structures are allowed here.

`manifest.json` is authoritative for exact replay. It distinguishes immutable Job plan and provenance fields from execution fields that may advance, including status, timestamps, ComfyUI prompt IDs, errors, and Results.

## `manifest.csv`

The CSV manifest is a human-friendly tabular representation intended for:

- inspection;
- spreadsheet analysis;
- portability;
- future convenient import workflows;
- simple external tooling.

Likely columns include:

```text
job_ordinal
job_id
status
prompt_name
prompt_version
prompt_template
resolved_prompt
resolved_variables_json
reference_filename
reference_sha256
seed
workflow_profile
workflow_hash
comfy_prompt_id
output_files
started_at
completed_at
error
```

For structures that do not map naturally to flat columns, encode compact JSON in a column rather than losing information.

`manifest.json` remains canonical if CSV representation becomes lossy or awkward.

A standalone CSV file is not sufficient for guaranteed exact replay. Exact replay uses `manifest.json` together with the snapshotted base workflow, Workflow Profile mapping, and referenced Project assets.

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

The first number is the Job ordinal and the second is the artifact ordinal within that Job. The manifest records the producing ComfyUI node ID and remote output metadata, including filename, subfolder, and type.

The manifest carries the meaningful provenance, so filenames do not need to encode the entire prompt and parameter set.

Human-readable suffixes may be added later, but path length and unsafe characters should be avoided.

## Input Provenance

A Run records the stable identity and hash of each input Reference Asset.

Reference Asset bytes live immutably in the Project's content-addressed asset store. Runs do not copy every input asset into their own directories by default.

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

Run creation writes and validates a staging directory, then publishes the complete Run directory on the filesystem before SQLite indexes it. Here, complete means that every required plan and provenance file exists and validates; execution need not have started or reached a terminal state. A Run is not ready for scheduling until both publication and indexing succeed.

Filesystem publication must be atomic within the destination filesystem. An incomplete staging directory is not a Run. If SQLite state is missing or incomplete, batchcraft can discover complete published Runs and rebuild their index records from the versioned files.

## Reproducibility Scope

The Run format preserves a replayable execution specification and provenance. It does not guarantee byte-identical pixels when ComfyUI, models, custom nodes, drivers, hardware, or other execution behavior changes.
