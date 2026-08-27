# Run File Format

## Purpose

Completed batchcraft Runs must remain understandable and re-importable without depending exclusively on the SQLite database.

The filesystem format is therefore part of the product contract, not an implementation detail.

## Project Layout

A proposed layout is:

```text
projects/
└── krea-character-testing/
    ├── project.json
    ├── references/
    └── batches/
        └── portrait-prompt-test/
            ├── run-001/
            │   ├── run.json
            │   ├── manifest.json
            │   ├── manifest.csv
            │   ├── workflow.json
            │   └── outputs/
            │       ├── 000001.png
            │       ├── 000002.png
            │       └── ...
            ├── run-002/
            └── run-003/
```

A Batch name identifies the experiment. The incrementing Run directory identifies each immutable execution.

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
  "run_number": 3,
  "status": "succeeded",
  "created_at": "...",
  "started_at": "...",
  "completed_at": "...",
  "workflow_hash": "...",
  "job_count": 48
}
```

The exact schema should be versioned.

## `workflow.json`

Contains the ComfyUI API-format workflow snapshot used by this Run.

This is immutable once the Run begins.

A workflow hash should also be recorded in Run and Job metadata.

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

## `manifest.csv`

The CSV manifest is a human-friendly tabular representation intended for:

- inspection;
- spreadsheet analysis;
- portability;
- drag/drop re-import;
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

## Outputs

Application-owned outputs live under:

```text
outputs/
```

A simple initial naming scheme is:

```text
000001.png
000002.png
000003.png
```

The manifest carries the meaningful provenance, so filenames do not need to encode the entire prompt and parameter set.

Human-readable suffixes may be added later, but path length and unsafe characters should be avoided.

## Input Provenance

A Run must record the identity and hash of each input Reference Asset.

Whether the Run directory physically copies every reference image is a policy decision.

Initial options:

1. copy input assets into the Run for maximum portability; or
2. store stable project-relative paths plus hashes.

For the first implementation, project-relative references plus content hashes are acceptable if project deletion/movement semantics are clearly defined.

A later "export portable Run" feature could package all inputs and outputs together.

## Immutability

Once a Run begins:

- workflow snapshot is immutable;
- compiled Job plan is immutable;
- Job provenance is immutable.

Execution status fields and output/result fields may be appended or transitioned as execution proceeds.

After a Run reaches a terminal state, its provenance must not be rewritten silently.

Human review metadata such as ratings and notes may be stored separately or in explicitly mutable review files/database records.

## Import and Rerun

batchcraft should eventually support dropping `manifest.json` or `manifest.csv` into the application.

The application should recognize enough metadata to:

- identify the prior Batch/Run if present locally;
- reconstruct the Job plan;
- validate required workflow/reference assets;
- create a **new** Run;
- preserve the original Run unchanged.

Exact replay is the initial target.

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
