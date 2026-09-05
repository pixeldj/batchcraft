# V1 cross-instance recovery acceptance

## Purpose

This is the executable release gate for ADR 0012. It proves that a Project directory is a portable
historical experiment archive and that a modern historical Run can become a new editable Batch without
the original SQLite database or browser state.

BC-019 and BC-020 provide the durable records, owned-v1 import, rebuildable historical projections, and
read-only Project history needed for the first half of this scenario. BC-021 is complete: editable
reconstruction, conflict-aware detached resources, explicit historical import, and focused automated
clean-instance Preview/new-Run proof are implemented. The complete realistic fixture,
repeat-fresh-instance, and live execution proof remain release-level checks. This is still an acceptance
contract, not a passed release gate.
BC-025 tracks public v1 release hardening and completion of this gate. Exact Rerun is deferred
beyond v1 and is not required by this editable-reconstruction scenario. ADR 0012 remains Proposed.

## Current BC-020 evidence

Automated tests currently prove:

- import by safe immediate-child filesystem key into an empty file-backed SQLite database;
- unchanged Project file inventories across scanning and repeated projection replacement;
- atomic, idempotent replacement of Project historical rows and repair of a damaged projection;
- Project ownership conflict rejection without partial trusted registration;
- isolation of malformed/unsupported Runs, malformed Batch owners, unsafe paths, and duplicate Run IDs;
- degraded Runs for missing Assets or missing/corrupt Results, with preserved metadata and refused bytes;
- explicit unavailable execution and read-only frozen detail without mutable library rows;
- frontend Project history without `localStorage` Run IDs, grouped Batch/Run display, diagnostics, frozen
  Run Plan and Result Details, and no execution actions.

These tests are BC-020 evidence, not final manual cross-instance acceptance.

## Test isolation

Use two independent application data roots. Instance B must not have access to Instance A's SQLite
database, browser profile, or mutable library files.

Record these values with the test evidence:

- batchcraft application version and commit;
- operating system and filesystem type;
- Instance A and Instance B database paths;
- Instance A and Instance B Projects roots;
- copied Project owner ID and filesystem key;
- tested durable format names and versions;
- ComfyUI version and custom-node environment used for the final execution step.

The automated portion should use temporary file-backed SQLite databases and temporary Projects roots.
A live ComfyUI smoke test should cover only the final execution proof and remain separate from ordinary
unit and integration tests.

## Instance A fixture

Create one realistic Project with:

- at least two Reference Assets;
- at least two Prompt snapshots with variables, including one intentional empty-string value;
- one Workflow Profile with at least two Image Input Slots and two typed parameters;
- explicit Image Input alternatives plus Base workflow;
- one explicit parameter alternatives dimension;
- one numeric Range with exact decimal start, end, and step;
- one Linked Parameter Set with at least two labeled rows;
- Random seed intent with all concrete Job seeds frozen in the Run;
- one named Saved Batch with a description;
- one named succeeded Run with Results from more than one Job;
- one named cancelled Run with a succeeded prefix and cancelled suffix;
- one named blocked or locally detached Run preserving remote uncertainty;
- one pristine created Run without `execution.json`;
- multiple Results from one Job where the workflow supports it.

The fixture must exercise Base workflow and concrete values for Image Inputs and parameters. Job order
must be recorded independently before copying so Instance B can compare it exactly.

## Copy boundary

Stop Instance A after every filesystem write and SQLite transaction has completed. Copy only the one
Project directory to Instance B's Projects root.

Do not copy:

- the SQLite database or its sidecar files;
- browser `localStorage`, cookies, or cache;
- application process state;
- mutable Prompt, Workflow, Workflow Profile, or Saved Batch exports;
- absolute paths from Instance A;
- any manually repaired or regenerated Run file.

The copied directory must remain byte-for-byte unchanged during initial import and inspection. Record a
recursive file inventory with sizes and hashes before import, then compare it after all read-only recovery
checks.

## Instance B setup

Start Instance B with an empty SQLite database and empty browser storage. Configure only its Projects
root and normal application settings.

Before import, verify:

- no Project row uses the copied Project ID or filesystem key;
- no copied Prompt, Workflow, Workflow Profile, Saved Batch, Run, Job, or Result row exists;
- the UI has no remembered Run IDs;
- the copied Project directory is the only source of historical data.

## Import and reindex checks

Import the copied Project directory through the supported Project import operation.

The import passes when:

- `project.json` restores the same stable Project ID and filesystem key;
- every valid Batch and Run is discovered without a supplied Run ID;
- Run number, immutable filesystem key, name, description, Project identity, and Batch identity match;
- Project Asset metadata and bytes pass size and SHA-256 validation;
- Run files pass path, identity, version, hash, and plan validation;
- the pristine Run has unavailable execution in Project history, while direct Run/execution reads derive
  `created` without manufacturing `execution.json`;
- Run, Job, Result, parameter, Image Input, and Asset-use index rows can be rebuilt from filesystem data;
- repeating import and reindex is idempotent;
- no importer step rewrites immutable Run provenance;
- stale or missing mutable library IDs do not prevent historical inspection.

## Historical inspection checks

Using only Instance B APIs and UI, verify:

- all imported Runs are browsable from the Project without browser-held Run IDs;
- Run Plan renders ordered Prompt snapshots, variables, Image Inputs, parameters, Linked Parameter Set
  rows, seeds, and Job order;
- succeeded, cancelled, and blocked or detached outcomes render honestly; absent execution is unavailable
  in Project history, distinct from derived `created` state in direct detail;
- Result galleries render all verified Result records;
- Result Details shows the producing Run and Job plus complete frozen provenance;
- verified Result bytes download with the recorded size and SHA-256; recorded MIME remains inspectable,
  while HTTP MIME and disposition follow the passive-artifact serving policy in `API.md`;
- missing current Prompt, Workflow, or Workflow Profile library rows do not trigger a not-found failure
  during inspection.

The concrete Job list in Instance B must match the independently recorded Instance A list in identity,
ordinal, prompt text, resolved variables, selected Assets or Base state, resolved parameters, selected
Linked Parameter Set rows, and seed.

## Editable reconstruction checks

Choose the succeeded modern Run and invoke `Load Run as Batch`.

The reconstructed Batch passes when:

- it is a new mutable draft and the historical Run remains unchanged;
- Prompt snapshots retain exact text, order, and identity metadata;
- Variable Binding values retain exact order and empty strings;
- Image Input alternatives retain order and Base workflow placement;
- parameter Values retain native types and order;
- Range start, end, step, and Base inclusion retain exact editable intent;
- Linked Parameter Set keys, labels, member order, row order, row labels, and typed cells match;
- seed mode and Random count match the historical editable intent;
- frozen Workflow and Workflow Profile content load as detached historical resources when library rows
  are absent;
- detached resources are not inserted into mutable libraries automatically;
- Preview preserves non-seed Job order and resolved choices before any edit; Fixed and Explicit seeds
  match historical values, while Random intent generates fresh assignments;
- saving remains blocked or explicit until detached resources are deliberately imported or relinked.

Exact seed comparison applies to historical inspection above, not editable Random reconstruction.
For Random Preview, verify one unique seed per final Job within `0..2^53-1` and the original repetition
count. Fresh materialization does not guarantee that no value overlaps an earlier Run's seeds.
The new Run must freeze the exact assignments from its own Preview. Preview has no historical Run/Job
execution identities to preserve; a new Run allocates new ones.

## Relinking checks

Exercise all three identity cases:

| Case | Expected result |
| --- | --- |
| Exact stable identity exists and immutable content matches | The application may link after validation. |
| Stable identity is absent | The resource remains detached and usable for inspection and Preview. |
| Stable identity exists but immutable content differs | The application reports a conflict and does not link silently. |

An explicit import of a detached resource must create or select mutable library history without changing
the historical Run snapshot.

## New Run proof

From the reconstructed Batch:

1. Preview the unedited reconstruction and compare using the seed-mode rules above.
2. Make one deliberate edit that changes the new plan.
3. Preview again.
4. Create a new Run with new Run and Job identities and a new immutable output namespace.
5. Execute the new Run against the configured ComfyUI instance.
6. Verify the original Run directory and every original file hash remain unchanged.
7. Verify the new Run records the reconstructed or edited intent and its own concrete Job provenance.

The test must never append Results to, rename, or rewrite the historical Run.

## Degraded-content checks

Run isolated copies of the fixture with one fault introduced per copy:

| Fault | Expected result |
| --- | --- |
| One malformed Run manifest | Import reports and isolates that Run; healthy Runs remain available. |
| One missing Asset content file | The affected Run is degraded and replay is blocked; unrelated Runs remain available. |
| One corrupt Result file | Metadata remains inspectable, but the application refuses to serve the bytes. |
| Duplicate Run ID in two directories | Import reports an identity conflict and chooses neither silently. |
| Conflicting Project owner identity | Project import fails without partial trusted registration. |
| Unsupported format version | The record fails closed and is never rewritten automatically. |

Fault fixtures must not weaken normal validation or add compatibility for unsupported prerelease data.

## Pass criteria

The release gate passes only when:

- automated clean-instance import, reindex, inspection, reconstruction, relinking, idempotency, and
  degraded-content tests pass;
- the live ComfyUI smoke test creates and completes the new Run;
- the original Project archive remains unchanged during read-only recovery and the original historical
  Runs remain unchanged throughout;
- a fresh Instance B can repeat the process from the same copied Project;
- ADR 0012, `FILE_FORMAT.md`, `DEVELOPMENT.md`, API documentation, and implementation agree on every
  durable v1 format and authority boundary.

Any required use of Instance A's SQLite database, browser state, mutable libraries, or manually supplied
Run IDs fails the gate.

Current gate status: BC-020 import, reindex, inspection, idempotency, and degraded-content coverage is
implemented. Completed BC-021 covers frozen-intent reconstruction, exact/missing/conflicting resource
classification, explicit server-sourced historical import, pre-edit Preview under the seed-mode rules
above, new Run creation, and original-Run hash preservation in focused automated tests. Complete realistic-fixture coverage,
repeat-fresh Instance B proof, and the live ComfyUI smoke test remain incomplete. No final manual
cross-instance acceptance is claimed.
