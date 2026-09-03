# V1 filesystem recovery audit

## Purpose

This document records the V1-001 audit of batchcraft's current persistence behavior. It compares the
prerelease implementation with the proposed portability contract in ADR 0012.

The audit is descriptive. BC-019 closed the record-level format gaps, and BC-020 added owned-v1 Project
import, historical reindex, and Project history inspection. BC-021 completed editable reconstruction and
detached-resource relinking/import; final cross-instance release validation remains open.
ADR 0012 therefore remains Proposed.

## Audit conclusion

A modern published Run contains enough immutable plan and provenance data to be understood and
recompiled without its original SQLite library. The Project filesystem also retains referenced Asset
bytes and detailed execution and Result state.

That data is now exposed for owned-v1 import, historical inspection, and editable Batch reconstruction.
A fresh instance can import by filesystem key, browse valid and degraded Runs, rebuild historical indexes,
and load frozen intent with missing library records represented as detached resources.

The v1 contract is therefore feasible with the current authority split, but not yet satisfied.

## Current Project tree

```text
<projects-root>/
`-- <project-key>/
    |-- project.json
    |-- assets/
    |   |-- .staging/
    |   `-- sha256/
    |       `-- <hash-prefix>/
    |           `-- <sha256>/
    |               |-- asset.json
    |               `-- content
    `-- batches/
        `-- <batch-key>/
            |-- batch.json
            |-- .allocations/
            |-- .staging/
            `-- <NNN-run-key>/
                |-- run.json
                |-- manifest.json
                |-- manifest.csv          optional secondary artifact when loading
                |-- workflow.json
                |-- workflow-profile.json
                |-- execution.json        optional until execution state is written
                `-- outputs/
                    `-- <result files>
```

Staging and allocation directories are publication machinery, not historical records. A published Run
directory is the historical unit. Referenced input bytes remain in the Project Asset store rather than
being copied into every Run.

## Authority by data class

| Data | Current authority | Recovery consequence |
| --- | --- | --- |
| Project current name, description, archive state | SQLite | Owner metadata alone does not restore all current Project metadata. |
| Project immutable owner binding | `project.json` | A copied Project retains its stable ID and filesystem key. |
| Prompt and PromptVersion library | SQLite | Only Prompt snapshots captured by Runs are portable under this contract. |
| Workflow and WorkflowVersion library | SQLite | A Run's frozen workflow remains available even if the library row is absent. |
| Workflow Profile and ProfileVersion library | SQLite | A Run's frozen profile remains available even if the library row is absent. |
| Saved Batch | SQLite | A Saved Batch that never produced a Run is outside the historical portability contract. |
| Batch immutable owner binding | `batch.json` | The filesystem retains Batch grouping and stable identity. |
| Reference Asset metadata and bytes | `asset.json` and `content` | Historical input bytes survive SQLite loss and can be hash-validated. |
| Immutable Run plan and provenance | `run.json`, `manifest.json`, frozen workflow files | Historical interpretation and exact concrete replay do not depend on mutable libraries. |
| Detailed execution outcome and Results | `execution.json` and `outputs/` | Terminal execution facts and Result bytes survive SQLite loss. |
| Cancellation and scheduler intent | SQLite | Intent that has not become an execution outcome is not historical filesystem truth. |
| Browser working session | `localStorage` | It is a convenience cache and cannot be required for Project import. |
| Historical Project/Batch/Asset/Run/Job/Result projections | SQLite, derived from Project files | Non-authoritative rows are atomically replaceable from filesystem truth. |

This split matches ADR 0003. Recovery must not turn historical snapshots into mutable library history
without an explicit user operation.

## Format inventory

| Record | Candidate v1 format | Version | Reader behavior |
| --- | ---: | --- | --- |
| `project.json` | `batchcraft.project` | 1 | Strict owner identity, producer, path, and shape validation. |
| `batch.json` | `batchcraft.batch` | 1 | Strict owner identity and Project owner-chain validation. |
| `asset.json` | `batchcraft.asset` | 1 | Validates producer, Project owner, metadata, stored path, byte size, and SHA-256. |
| `run.json` | `batchcraft.run` | 1 | Checks identity against manifest, owner chain, and exact Project layout. |
| `manifest.json` | `batchcraft.manifest` | 1 | Canonical strict plan and provenance record; unsupported versions fail closed. |
| Embedded Batch snapshot | `batchcraft.batch-snapshot` | 1 | Strict schema; loader recompiles and compares the concrete plan. |
| `execution.json` | `batchcraft.execution` | 1 | Strict mutable state machine with Result path, size, and hash validation. |
| `manifest.csv` | `batchcraft.manifest-csv` | 1 | Emitted secondary export; not parsed during normal published Run loading. |
| `workflow.json` descriptor | `batchcraft.workflow-snapshot` | 1 | Identifies the raw, hash-bound ComfyUI API workflow payload. |
| `workflow-profile.json` descriptor | `batchcraft.workflow-profile-snapshot` | 1 | Identifies the raw, hash-bound Profile payload validated with the workflow. |
| Browser working session | 4 | Key names the format | Unsupported or malformed records reset to an empty session. |
| SQLite schema | Migrations 0001 and 0002 | Migration filenames and history rows | Checksummed, contiguous, forward-only migration runner. |

The preserved `0001_initial.sql` checksum is
`8441adf452ba918a4dff1ce0f65e40ce62ad52ea9efe0304b4343bbfc5a27617`.
The `0002_historical_projections.sql` checksum is
`02a61fbddac14de0c8709c6ac71b7de93c85818d6a4b31f1f03ce6f9563ef26f`.

Each Project format is independently versioned. Canonical standalone JSON records carry
`created_by.batchcraft_version`; CSV rows carry `batchcraft_version`; the embedded Batch snapshot and raw
payload descriptors inherit producer context from manifest v1. Producer version does not control parsing.
All prerelease Project record shapes are unsupported and fail closed without rewriting persisted files.

## Current import, adoption, and discovery behavior

Project discovery enumerates immediate, path-safe directories under the configured Projects root. It
reports valid `project.json` owners and ownerless directories. It does not traverse Assets, Batches, or
Runs.

Owned-v1 import is distinct from adoption. Import accepts one path-safe filesystem key, requires an
immediate non-symlink Project directory and valid existing `project.json`, and scans without changing
filesystem bytes. Ownerless adoption separately requires a user-supplied Project ID and name and creates
the owner binding before normal mutable Project use.

Import and reindex scan Assets, Batch owners, published Runs, execution records, and Results. They then
atomically create or confirm Project registration and replace that Project's historical Batch, Asset,
Run, Job, parameter, Image Input, Asset-use, Result, and diagnostic rows. The frontend browses these rows
without browser-held Run IDs. Import does not create Saved Batches or mutable Prompt, Workflow, or
Workflow Profile history.

## Run recovery coverage

### Preserved editable intent

Batch snapshot v1 preserves:

- Project, Batch, and optional source Saved Batch identity;
- ordered Prompt snapshots with exact text and optional library identity metadata;
- ordered Variable Bindings, including intentional empty-string values;
- ordered Image Input alternatives with explicit Base workflow choices;
- typed parameter alternatives;
- numeric Range start, end, and step as exact decimal text plus Base inclusion;
- Linked Parameter Set identity, labels, member order, row order, and typed cells;
- fixed, explicit, or Random seed intent;
- frozen Workflow and Workflow Profile content plus optional library identity metadata.

The loader materializes this intent and requires it to reproduce the exact immutable Job plan. This is
strong evidence that a modern Run can support `Load Run as Batch` without reading its original mutable
library.

### Preserved concrete provenance

The canonical manifest preserves ordered Prompt snapshots, compiler warnings, slot and parameter
definitions, exact resolved prompts, resolved variables, selected Assets, Base workflow choices,
resolved typed parameters, selected Linked Parameter Set rows, concrete seeds, Job order, and frozen
workflow hashes.

`execution.json` preserves Run and Job state, submission evidence, diagnostics, Result association,
remote output metadata, safe local paths, byte sizes, content types, and hashes. Project Asset and Result
loaders validate the referenced bytes.

### Missing or incomplete recovery data

Remaining gaps in recovery workflow are:

- cancellation intent remains SQLite-only until it becomes an outcome in `execution.json`;
- final realistic cross-instance and live ComfyUI execution acceptance is not complete;
- Project history has no pagination or advanced filters.

Output naming is not currently editable product behavior. BC-019 removed that stale conceptual Batch
field and now freezes each generated `batchcraft/<run-id>/<job-id>/result` prefix as concrete Job
provenance. Any future editable naming feature must explicitly version the Batch snapshot contract.

## Validation coverage

Current loaders already enforce much of the required trust boundary:

- path-safe Project, Batch, and Run filesystem keys;
- non-symlink owner and output paths at key boundaries;
- Project, Batch, and Run identity consistency across path and records;
- required immutable Run files; strict mutation/content loading also requires the output directory;
- exact format identities, independently managed v1 versions, producer metadata, and strict shapes;
- versioned workflow, Workflow Profile, and CSV descriptors;
- frozen workflow and Workflow Profile SHA-256 values;
- Workflow/Profile mapping validity;
- ordered unique Prompt, slot, parameter, Job, and Linked Parameter Set identities;
- one-based contiguous Job ordering;
- complete typed scalar Job resolution;
- Batch snapshot recompilation to the exact manifest plan;
- referenced Asset and Result path, size, and hash integrity.
- exact per-Job output prefixes bound to Run and Job identity.

BC-020 adds the Project-level validation coordinator. It rejects unsafe or conflicting Project identity,
isolates invalid Batch/Run records, retains degraded history where trusted metadata remains available,
and keeps unrelated valid Runs visible.

## Implemented history classification

BC-020 classifies discovered content instead of silently trusting it:

- valid content enters the trusted projection; a valid Run has API integrity `verified`;
- degraded content retains trusted metadata with diagnostics and a Run integrity of `degraded`;
- invalid content is rejected at the Project boundary or isolated from trusted rows at the Batch/Run
  boundary.

| Condition | Required v1 behavior |
| --- | --- |
| Unsafe Project path or conflicting Project owner identity | Reject Project import. |
| Unsafe or conflicting Batch owner identity | Isolate that Batch and report the conflict. |
| Unsupported or malformed Run record | Isolate that Run and continue with other valid Runs. |
| Missing or corrupt referenced Asset | Keep the Run discoverable as degraded; block replay that needs the Asset. |
| Missing or corrupt Result file | Keep Run and Result metadata discoverable as degraded; do not serve unverified bytes. |
| Missing or invalid `execution.json` | Keep valid frozen Run detail and report execution unavailable; read-only detail derives an initial view when the file is absent. |
| Duplicate Run ID | Report an identity conflict; do not choose one silently. |
| Missing mutable library record | Historical inspection and Preview use frozen data; explicit import creates a new mutable copy. |
| Same stable library identity with different immutable content | Reconstruction reports a conflict and never links silently. |

## Gap allocation

| Phase | Backlog | Required result |
| --- | --- | --- |
| V1-001 Filesystem Recovery Audit & Contract | BC-018 | Audit current records, settle the proposed contract, and define the release test. |
| V1-002 V1 Format Consolidation | BC-019 | Close record-level gaps, assign explicit format identities, reset v1 versions, add producer metadata, and add fixtures. |
| V1-003 Project Import & Historical Reindex | BC-020 | Validate a copied Project, discover healthy and degraded Runs, and rebuild disposable historical indexes. |
| V1-004 Load Run as Batch & Cross-Instance Acceptance | BC-021 | Reconstruct editable intent with detached resources and pass the clean-instance release test. |

BC-020 is the portability prerequisite for the broader BC-007 browser. BC-021 implements the
portability-specific `Load Run as Batch` slice already described by BC-006. It does not include
`Recreate Result` or `Exact Rerun` unless separately scheduled.

## Evidence map

The main implementation evidence is in:

- `backend/src/batchcraft/files/project_owners.py`;
- `backend/src/batchcraft/files/batch_owners.py`;
- `backend/src/batchcraft/files/assets.py`;
- `backend/src/batchcraft/files/runs.py`;
- `backend/src/batchcraft/files/snapshots.py`;
- `backend/src/batchcraft/execution/state.py`;
- `backend/tests/fixtures/v1_project/` for emitted-byte and round-trip coverage;
- `backend/src/batchcraft/application/library.py`;
- `backend/src/batchcraft/application/service.py`;
- `backend/src/batchcraft/db/migrations/`;
- `backend/src/batchcraft/files/history.py`;
- `backend/src/batchcraft/db/history.py`;
- `backend/tests/files/test_history.py`;
- `backend/tests/api/test_history_api.py`;
- `frontend/src/features/project/ProjectHistory.tsx`;
- `frontend/src/features/project/ProjectHistory.test.tsx`;
- `frontend/src/features/session/workingSessionRecovery.ts`;
- filesystem and API tests under `backend/tests/`;
- frontend recovery, Run Plan, and Result Details tests under `frontend/src/`.

## Exit condition

V1-001 is complete. BC-019 and BC-020 provide candidate-v1 records, owned Project import, rebuildable
history, and degraded inspection. BC-021 reconstruction is complete, but the v1 portability contract
remains unproven until the complete cross-instance and live execution gate passes.
