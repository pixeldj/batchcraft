# ADR 0012: V1 Filesystem Portability and Recovery Contract

- **Status:** Proposed
- **Date:** 2026-09-02
- **Decision scope:** batchcraft v1 filesystem, import, recovery, and post-v1 compatibility policy

## Context

batchcraft deliberately separates mutable application state from immutable historical experiment provenance.

SQLite owns mutable application concepts such as Projects' current metadata, Prompt/PromptVersion libraries, Workflow/WorkflowProfile libraries, Saved Batches, and execution-control or scheduler intent.

The Project filesystem owns durable historical experiment artifacts such as Project Asset bytes and metadata, immutable Run provenance, frozen Workflow/Profile snapshots, detailed execution state, Result metadata, and Result bytes.

During prerelease development, the SQLite baseline and several durable file schemas have been replaced freely. Development databases have routinely been deleted after updates. This is acceptable before v1, but it exposes an important product requirement: historical Runs must remain useful even when the SQLite database that originally created them no longer exists.

A current symptom is that importing an existing Project directory into a fresh database can leave browser or application state referring to Workflow/Profile IDs that are no longer present in SQLite. The Project folder may still contain the exact frozen workflow and profile used by historical Runs, but the application does not yet reconstruct a complete usable historical workspace from those filesystem artifacts.

Before declaring v1, batchcraft needs a tested portability contract:

> A copied batchcraft Project directory must be importable into a fresh batchcraft instance with an empty SQLite database, and its historical experiments must remain inspectable and reusable without requiring the original application's mutable library state.

This ADR defines the intended v1 contract. The completed V1-001 audit in
`docs/V1_RECOVERY_AUDIT.md` verifies what the current filesystem contains and records the gaps that
must close before the formats are frozen. The audit supports this decision, but current behavior does
not yet satisfy it.

### Current implementation findings

This subsection records the implementation state when the ADR was proposed. The BC-020 progress note
below records later work without rewriting that historical statement.

The prerelease implementation already provides a strong historical Run record:

- Project, Batch, Asset, Run, manifest, Batch snapshot, and execution records are versioned;
- `manifest.json`, the embedded Batch snapshot, frozen workflow files, Project Assets, and
  `execution.json` preserve most data needed to inspect and replay a modern Run;
- Run loading validates identity relationships, paths, hashes, the concrete Job plan, Batch snapshot
  recompilation, and referenced Asset bytes without consulting SQLite;
- SQLite remains the authority for mutable libraries and cancellation intent, while the Project
  filesystem remains the authority for historical Run provenance and execution outcomes.

BC-019 establishes the candidate-v1 record contracts:

- canonical Project, Batch, Asset, Run, manifest, Batch snapshot, and execution records have explicit,
  independently managed v1 identities;
- standalone canonical JSON records carry producer batchcraft version metadata;
- raw workflow and Workflow Profile payloads remain directly usable and are identified by strict,
  hash-bound v1 manifest descriptors;
- the emitted secondary CSV has an independent v1 identity and producer column but is optional during
  normal published-Run loading;
- each Job freezes an output prefix bound to its Run and Job identity;
- `backend/tests/fixtures/v1_project/` locks emitted bytes for a complete modern record set.

The implementation still does not provide the complete v1 recovery workflow:

- Project adoption registers owner metadata but does not import or index historical content;
- there is no Project-wide validated Run discovery or rebuildable Run/Job/Result index;
- the frontend can recover only Run IDs retained in browser working-session storage;
- there is no `Load Run as Batch` operation or detached historical resource model;
- no automated cross-instance acceptance test proves recovery from a copied Project directory.

These are release gaps, not exceptions to the proposed contract.

### BC-020 implementation progress

BC-020 now imports an owned v1 Project by safe immediate-child filesystem key, keeps ownerless adoption
as a separate explicit identity mutation, scans filesystem history without rewriting it, and atomically
replaces rebuildable Project history projections in SQLite. The API and frontend browse imported Runs
without browser-held Run IDs. They expose verified/degraded Run classification, explicit unavailable
execution, diagnostics, and verified/missing/corrupt Result integrity.

Historical detail uses strict read-only loaders that tolerate unavailable output bytes while preserving
recorded metadata. Execution mutations and Result download retain strict storage and byte validation.
Applied SQLite migration bytes are now preserved and BC-020 adds forward migration
`0002_historical_projections.sql`; temporary test databases and versioned browser recovery remain
disposable. BC-021 subsequently implemented editable `Load Run as Batch` and detached-resource workflows;
the full cross-instance release gate remains separate. This ADR remains Proposed.

### BC-021 implementation progress

Completed BC-021 reconstructs a validated historical Batch snapshot as an unsaved editable draft. The
backend classifies frozen Prompt, Workflow, and Workflow Profile identities as linked, detached, or conflicting
against current SQLite identity, content, archive state, Project ID, and filesystem ownership without
mutating either authority. Explicit Run-scoped import operations
reload frozen content server-side and create new mutable library copies. The frontend requires a fresh
Preview, preserves detached snapshots and explicit import resolutions through working-session recovery v4,
uses idempotent import operation identities, and uses frozen concrete seeds
for the first unedited Preview of historical Random intent.

Focused automated coverage proves a clean database can import a copied Project, reconstruct and Preview
the original plan, explicitly import detached resources, create a new Run, and leave every original Run
file hash unchanged. The complete realistic fixture, repeat-fresh-instance proof, and live ComfyUI smoke
test remain release-level checks. This ADR therefore remains Proposed.

## Decision

### 1. A v1 Project directory is a portable historical experiment archive

A valid batchcraft v1 Project directory must contain enough durable information for a fresh batchcraft instance, with an empty SQLite database, to import the Project and reconstruct its historical experiment record.

After import, the application must be able to discover and inspect valid historical Runs without requiring the original SQLite rows.

At minimum, the filesystem contract must support recovery of:

- immutable Project identity and filesystem ownership;
- Project Assets, their metadata, and content hashes;
- historical Batch ownership/grouping represented by the filesystem and Runs;
- named Run identity, ordinal, name, description/notes where supported, and immutable Run path/key;
- exact ordered Job plans;
- Prompt snapshots used by each Run;
- resolved Variable Binding values per Job;
- Image/Input Asset slot intent and resolved Job choices;
- generic Parameter intent and resolved Job values;
- deterministic numeric Range intent where captured by the Batch snapshot;
- Linked Parameter Set / preset intent where captured by the Batch snapshot;
- seed intent where captured by the Batch snapshot and concrete materialized Job seeds;
- exact frozen Workflow snapshot;
- exact frozen Workflow Profile / mapping snapshot;
- detailed Run and Job execution state;
- succeeded, failed, cancelled, blocked, and detached/uncertain outcomes supported by the current execution model;
- Result metadata, Job association, content hashes, and Result bytes;
- sufficient data to render Run Plan and Result Details without the original SQLite library.

Derived SQLite Run/Job/Result indexes may accelerate this experience, but they must be rebuildable from filesystem truth.

### 2. Portability guarantees historical experiment state, not every unused mutable library object

The Project directory is not required to recreate SQLite-only mutable resources that were never captured by a Run.

Examples that are not guaranteed portable merely because a Project folder exists:

- a Prompt that was created but never used in a Run;
- a Workflow or Profile that was never used in a Run;
- an unsaved browser draft;
- a Saved Batch that was never published into a Run snapshot;
- future ratings, tags, notes, or queue intent that exist only in SQLite unless separately exported.

This is an explicit v1 boundary.

A future whole-Project export/backup feature may package mutable library state in addition to the historical filesystem archive, but that is separate from this contract.

### 3. Modern v1 Runs must preserve both editable intent and concrete execution

Where the current Run format includes a versioned Batch snapshot, that snapshot is the source for reconstructing editable historical intent.

The Run must preserve the distinction between:

- **editable Batch intent**, such as Random seed count, numeric Range definitions, ordered Image/Input alternatives, Parameter alternatives, and Linked Parameter Set rows; and
- **concrete Job provenance**, such as the exact seed, exact resolved parameters, exact selected Assets, resolved prompt text, and exact Job order used for execution.

This enables different future operations:

- `Load Run as Batch` restores editable historical intent;
- `Recreate Result` restores one concrete Job as an editable starting point;
- `Exact Rerun` replays concrete historical execution inputs into a new Run.

Historical Runs are never modified by these operations.

### 4. Missing mutable library resources load as detached historical resources

A fresh instance may not have the Prompt, PromptVersion, Workflow, WorkflowVersion, WorkflowProfile, or ProfileVersion rows referenced by a historical Run.

That absence must not make the Run unreadable.

Import/recovery must use the frozen Run snapshots as historical truth.

When reconnecting historical snapshots to the current mutable library:

- if the exact stable identity exists and immutable content matches, the application may link to it;
- if the library record is absent, the resource remains a detached historical snapshot;
- if the same identity exists with different immutable content, treat it as an identity conflict and never link silently;
- importing detached snapshots into the mutable library must be an explicit user action.

Filesystem import must not silently manufacture mutable library history.

### 5. SQLite remains authoritative for mutable application state

This ADR does not make the filesystem authoritative for current mutable libraries.

SQLite remains authoritative for current mutable application concepts such as:

- Project display metadata beyond immutable owner binding;
- Prompt and PromptVersion libraries;
- Workflow and WorkflowVersion libraries;
- Workflow Profile and ProfileVersion libraries;
- Saved Batches;
- future Variable Lists;
- queue/scheduler intent;
- cancellation/control intent where defined by ADR 0003;
- future user annotations such as stars, ratings, tags, and notes.

The filesystem remains authoritative for immutable historical provenance, Asset/Result bytes, and detailed execution truth.

Derived SQLite indexes over historical filesystem data are disposable and rebuildable.

### 6. Import is identity-aware and non-destructive

A Project importer must recognize a batchcraft Project by its durable owner metadata and versioned filesystem structure.

It must not infer Project identity merely from a folder name.

Import/reindex must:

- validate owner identity;
- validate format identifiers and versions;
- validate safe relative paths;
- validate required files;
- validate hashes and sizes where recorded;
- validate Run/Batch/Project identity relationships;
- refuse silent identity conflicts;
- isolate an invalid/degraded Run rather than making one bad Run prevent recovery of all valid Runs when possible;
- never rewrite historical Run provenance merely to make it fit the current database.

The exact implementation may copy or adopt an existing Project directory, but validation must occur before the application treats it as trusted historical state.

### 7. V1 durable filesystem schemas reset to format version 1 exactly once

BC-019 consolidates the current prerelease durable schemas and resets them to clean candidate-v1 format numbers.

Each durable schema has an explicit format identity and independent format version:

    {
      "format": "batchcraft.manifest",
      "format_version": 1
    }

The implemented candidate-v1 formats are:

- `batchcraft.project`;
- `batchcraft.batch`;
- `batchcraft.asset`;
- `batchcraft.run`;
- `batchcraft.manifest`;
- `batchcraft.batch-snapshot`;
- `batchcraft.execution`;
- `batchcraft.workflow-snapshot`;
- `batchcraft.workflow-profile-snapshot`;
- `batchcraft.manifest-csv`.

Obsolete prerelease readers and compatibility branches may be removed before v1.

Pre-v1 development Runs may become unsupported.

### 8. File format versions do not mechanically track application releases

`format_version` answers:

> How do I parse this durable record?

The batchcraft application version answers:

> Which version of batchcraft produced this record?

These are separate concerns.

Standalone canonical JSON records record the producer application version, for example:

    {
      "format": "batchcraft.manifest",
      "format_version": 1,
      "created_by": {
        "batchcraft_version": "1.0.0"
      }
    }

batchcraft 1.1, 1.2, or 2.0 may continue writing manifest format 1 if that schema has not changed.

If one durable schema changes after v1, only that schema's format version needs to increment.
CSV rows use a flat `batchcraft_version` column. The embedded Batch snapshot and raw payload descriptors
inherit producer context from manifest v1. Mutable `execution.json` producer metadata identifies the
writer of its current representation and may change on a later valid state write.

### 9. Browser recovery format is not part of the portable Project contract

Browser `localStorage` working-session recovery is convenience state, not historical Project truth.

It may be reset or versioned independently.

A fresh-instance Project import must work with empty browser storage.

The importer must not require stale browser IDs to reconstruct historical Runs.

### 10. V1 freezes the compatibility policy

Before v1:

- development SQLite databases may be discarded;
- the baseline migration may be rewritten;
- prerelease durable schemas may be replaced;
- prerelease Runs may be unsupported.

At the v1 boundary:

- the SQLite baseline becomes the v1 baseline;
- future SQLite schema changes use forward migrations rather than rewriting the baseline;
- valid v1 Project folders become user data that must not be casually invalidated;
- durable filesystem schema versions increment only when their contracts change;
- backward readers or explicit migration/import handling become deliberate engineering work.

The repository should document this policy clearly in `AGENTS.md` and relevant persistence documentation when v1 is frozen.

### 11. Cross-instance recovery is a v1 release gate

The v1 filesystem contract is not considered proven until the following acceptance scenario succeeds.

#### Instance A

Create a realistic Project containing:

- Project Assets;
- Prompt library resources;
- Workflow/Profile resources;
- a Saved Batch;
- named Runs;
- a succeeded Run;
- a cancelled Run;
- a blocked/detached Run where supported;
- Results from multiple Jobs;
- Variables;
- Image/Input alternatives;
- generic Parameters;
- numeric Ranges;
- Linked Parameter Sets;
- concrete seeds.

Then stop batchcraft and copy only the Project directory.

#### Instance B

Start a fresh batchcraft instance with:

- empty SQLite;
- empty browser recovery state;
- no copied mutable library database.

Import the copied Project directory.

Verify:

- Project identity is recovered;
- Assets validate;
- historical Batches/Runs are discoverable;
- named Runs retain their identity and display information;
- Run Plans render;
- Job order is exact;
- Results render and download;
- Result Details render complete provenance;
- succeeded/cancelled/blocked execution outcomes are preserved;
- no stale SQLite-only Workflow/Profile/Prompt ID prevents inspection;
- derived Run/Job/Result indexes can be rebuilt.

Then choose a modern historical Run and:

- reconstruct editable Batch intent from its frozen Batch snapshot;
- represent missing library objects as detached historical resources;
- Preview the reconstructed Batch;
- create a new Run;
- execute the new Run successfully.

Passing this test establishes the v1 Project portability contract.

## Consequences

### Benefits

- Completed experiment history survives SQLite loss or replacement.
- Projects can move between batchcraft installations.
- Filesystem backups remain independently valuable.
- Derived indexes can be rebuilt rather than treated as irreplaceable truth.
- Search/filter features can rely on normalized SQLite projections without making SQLite the only copy of provenance.
- `Load Run as Batch`, `Recreate Result`, and `Exact Rerun` can be grounded in frozen historical data.
- v1 creates a clear point after which user persistence compatibility matters.

### Costs

- Durable schemas require stronger validation and tests.
- Run snapshots duplicate some library information intentionally.
- Import/reindex must handle degraded and conflicting historical data carefully.
- Post-v1 filesystem and database changes require explicit compatibility work.
- Mutable library state that was never captured by a Run still requires separate backup/export if full workspace portability is desired.

## Non-goals

This ADR does not promise:

- recovery of every unused SQLite-only library object;
- automatic recreation of mutable Prompt/Workflow/Profile history;
- byte-identical image reproduction across changed models, nodes, runtimes, or hardware;
- automatic executor continuation after a backend or ComfyUI restart;
- support for arbitrary pre-v1 development formats;
- Project-wide filtering/search UX itself;
- whole-Project mutable-state backup/export.

## Follow-up work

The intended release sequence is:

1. **V1-001 — Filesystem Recovery Audit & Contract**
   - inventory current durable artifacts;
   - verify authority and recovery coverage;
   - identify gaps before freezing schemas;
   - finalize this ADR.

2. **V1-002 — V1 Format Consolidation**
   - implemented by BC-019: audit gaps resolved at the record level;
   - current durable schema versions reset independently to 1;
   - obsolete prerelease compatibility removed;
   - format identity and producer metadata added;
   - strict corruption tests and an emitted-byte round-trip Project fixture added.

3. **V1-003 — Project Import & Historical Reindex**
   - fresh database Project import;
   - filesystem validation;
   - rebuild historical Run/Job/Result projections;
   - make imported history browsable.

4. **V1-004 — Load Run as Batch & Cross-Instance Acceptance**
   - reconstruct editable intent;
   - support detached historical resources;
   - pass the clean-instance release-gate scenario.

The corresponding stable backlog items are BC-018 through BC-021. BC-020 coordinates with BC-007's
broader Project-wide browser work, and BC-021 supplies the portability-specific part of BC-006's
historical reuse work.

Only after these phases pass should batchcraft declare the Project persistence contract v1 and begin treating valid v1 persisted data as compatibility-sensitive user data.
