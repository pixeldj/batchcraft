# V1 filesystem recovery audit

## Purpose

This document records the V1-001 audit of batchcraft's current persistence behavior. It compares the
prerelease implementation with the proposed portability contract in ADR 0012.

The audit is descriptive. It does not freeze current schemas or claim that Project portability is
complete. ADR 0012 remains Proposed until the format, import, reconstruction, and cross-instance work
passes its release gates.

## Audit conclusion

A modern published Run contains enough immutable plan and provenance data to be understood and
recompiled without its original SQLite library. The Project filesystem also retains referenced Asset
bytes and detailed execution and Result state.

That data is not yet exposed as a complete recovery workflow. A fresh instance can adopt a Project
owner, but it cannot import and browse all historical Runs, rebuild historical indexes, or reconstruct
editable Batch intent with missing library records represented as detached resources.

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
                |-- manifest.csv
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
| Historical Run/Job/Result search indexes | Not implemented | Future indexes must be disposable projections rebuilt from filesystem truth. |

This split matches ADR 0003. Recovery must not turn historical snapshots into mutable library history
without an explicit user operation.

## Format inventory

| Record | Current prerelease version | Explicit format identity | Reader behavior |
| --- | ---: | --- | --- |
| `project.json` | 1 | No | Rejects unsupported versions and unsafe or mismatched filesystem keys. |
| `batch.json` | 1 | No | Rejects unsupported versions and invalid owner data. |
| `asset.json` | 1 | No | Validates metadata, stored path, byte size, and SHA-256. |
| `run.json` | 2 | No | Rejects unsupported versions and checks identity against manifest and path. |
| `manifest.json` | 9 | No | Canonical plan and provenance record; unsupported versions fail closed. |
| Embedded Batch snapshot | 6 | No | Strict schema; loader recompiles and compares the concrete plan. |
| `execution.json` | 3 | No | Strict mutable state machine with Result path, size, and hash validation. |
| `manifest.csv` | Tied to manifest v9 | No | Secondary export; not parsed during normal published Run loading. |
| `workflow.json` | None | No | Hash-bound frozen ComfyUI API workflow JSON. |
| `workflow-profile.json` | None | No | Hash-bound frozen mapping JSON validated with the workflow. |
| Browser working session | 2 | Key names the format | Unsupported or malformed records reset to an empty session. |
| SQLite baseline | Migration 0001 | Migration filename and history row | Checksum-validated, contiguous migration runner. |

The current `0001_initial.sql` checksum is
`8441adf452ba918a4dff1ce0f65e40ce62ad52ea9efe0304b4343bbfc5a27617`.

The unrelated prerelease version numbers reflect development history. BC-019 will define clean v1
format identities and reset applicable durable Project schemas to version 1 before release. The audit
does not change readers or persisted files.

## Current adoption and discovery behavior

Project discovery enumerates immediate, path-safe directories under the configured Projects root. It
reports valid `project.json` owners and ownerless directories. It does not traverse Assets, Batches, or
Runs.

Project adoption reads or creates `project.json`, checks a supplied ID against the stored owner, and
creates one Project row in SQLite. It does not:

- validate the complete Project tree;
- adopt Batch owners;
- import Saved Batch definitions;
- enumerate or validate published Runs;
- read execution state or Results;
- create Run, Job, Result, parameter, or Asset usage indexes;
- reconstruct Prompt, Workflow, or Workflow Profile libraries.

The application can load a Run by known `run_id`. That lookup scans paths matching
`*/batches/*/*-*`, reads each `run.json`, rejects duplicate IDs, and fully validates the one matching
Run. This is a lookup mechanism, not Project history import. The frontend knows historical Run IDs only
from the current browser working-session record.

## Run recovery coverage

### Preserved editable intent

Batch snapshot v6 preserves:

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

Current gaps in the records or their public projections are:

- no producer `batchcraft_version` on durable records;
- no explicit format name on durable JSON records;
- no independent version for frozen workflow records or CSV;
- no editable output naming configuration in Batch snapshot v6;
- no single Project-level catalog of published Runs, so recovery requires bounded filesystem scanning;
- cancellation intent remains SQLite-only until it becomes an outcome in `execution.json`;
- current HTTP and frontend views do not expose every stored diagnostic and provenance field uniformly.

Output naming is not currently editable product behavior. BC-019 must either add it to the v1 Batch
snapshot when such behavior is introduced or remove the stale conceptual field from `DATA_MODEL.md`.

## Validation coverage

Current loaders already enforce much of the required trust boundary:

- path-safe Project, Batch, and Run filesystem keys;
- non-symlink owner and output paths at key boundaries;
- Project, Batch, and Run identity consistency across path and records;
- required Run files and output directory;
- supported exact format versions;
- frozen workflow and Workflow Profile SHA-256 values;
- Workflow/Profile mapping validity;
- ordered unique Prompt, slot, parameter, Job, and Linked Parameter Set identities;
- one-based contiguous Job ordering;
- complete typed scalar Job resolution;
- Batch snapshot recompilation to the exact manifest plan;
- referenced Asset and Result path, size, and hash integrity.

The import contract still needs a Project-level validation coordinator. One bad Run should be reported
as degraded without hiding unrelated valid Runs, except when Project or Batch ownership itself is
ambiguous or unsafe.

## Required degraded-state policy

BC-020 must classify discovered content rather than silently skipping it:

| Condition | Required v1 behavior |
| --- | --- |
| Unsafe Project path or conflicting Project owner identity | Reject Project import. |
| Unsafe or conflicting Batch owner identity | Isolate that Batch and report the conflict. |
| Unsupported or malformed Run record | Isolate that Run and continue with other valid Runs. |
| Missing or corrupt referenced Asset | Keep the Run discoverable as degraded; block replay that needs the Asset. |
| Missing or corrupt Result file | Keep Run and Result metadata discoverable as degraded; do not serve unverified bytes. |
| Missing `execution.json` | Treat the Run as created and unexecuted, using the existing initial-state rule. |
| Duplicate Run ID | Report an identity conflict; do not choose one silently. |
| Missing mutable library record | Load the frozen resource as detached historical data. |
| Same stable library identity with different immutable content | Report a relinking conflict; never link silently. |

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
- `backend/src/batchcraft/application/library.py`;
- `backend/src/batchcraft/application/service.py`;
- `backend/src/batchcraft/db/migrations/`;
- `frontend/src/features/session/workingSessionRecovery.ts`;
- filesystem and API tests under `backend/tests/`;
- frontend recovery, Run Plan, and Result Details tests under `frontend/src/`.

## Exit condition

V1-001 is complete when this audit, ADR 0012, the cross-instance acceptance contract, and the mapped
backlog gates agree. The v1 portability contract itself remains unproven until BC-019, BC-020, and
BC-021 pass.
