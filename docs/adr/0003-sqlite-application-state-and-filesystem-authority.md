# ADR 0003: SQLite Application State and Filesystem Authority

* Status: Accepted
* Date: 2026-08-28

## Context

batchcraft currently stores durable historical generation state in the filesystem.

This includes:

* immutable Project Asset bytes and `asset.json`;
* immutable Run identity, plan, and provenance;
* `run.json`;
* canonical `manifest.json`;
* secondary `manifest.csv`;
* frozen `workflow.json`;
* frozen `workflow-profile.json`;
* mutable detailed execution state in `execution.json`;
* Result metadata;
* Result bytes under `outputs/`.

The frontend currently carries editable working state primarily in tab-scoped `sessionStorage`.

Real use now requires durable mutable application state for:

* Projects as current user-facing workspaces;
* logical Prompt libraries;
* immutable PromptVersion history;
* Variable Lists;
* saved editable Batches;
* reusable Project Workflows;
* Workflow Profile versions;
* searchable Project-wide Run and Result browsing;
* durable queue/scheduler intent;
* future cancellation requests.

A complete historical Run must remain understandable if the application database is lost.

SQLite must therefore complement the filesystem rather than replace it.

## Decision

batchcraft will introduce SQLite as the authoritative store for mutable application state and durable scheduler intent.

The filesystem remains authoritative for immutable generation provenance, Asset bytes, detailed execution state, and Result files.

SQLite will also contain rebuildable indexes derived from filesystem-owned records.

There must be no application concept for which SQLite and the filesystem are independently writable authoritative copies of the same state.

## Authority model

### SQLite-authoritative state

SQLite owns mutable application concepts that cannot necessarily be reconstructed from historical Runs:

* current Project metadata;
* logical Prompts;
* immutable PromptVersions in the active library;
* Variable Lists;
* logical Workflows;
* immutable WorkflowVersions;
* logical Workflow Profiles;
* immutable Workflow Profile versions;
* saved editable Batches;
* ordered Batch Prompt selections;
* ordered Batch Variable bindings;
* ordered Batch Reference selections;
* editable seed intent;
* durable queue order and scheduling intent;
* scheduler claims and leases;
* cancellation requests;
* future user-authored metadata such as ratings, tags, and notes when implemented.

Loss of SQLite may therefore lose mutable application state even when historical filesystem Runs remain intact.

### Filesystem-authoritative state

The filesystem remains authoritative for:

* Project Asset bytes;
* canonical `asset.json`;
* immutable Project filesystem owner binding;
* immutable Batch filesystem owner binding;
* immutable Run identity and provenance;
* Run manifests;
* frozen Run workflow snapshots;
* frozen Run Workflow Profile snapshots;
* detailed Run and Job execution state in `execution.json`;
* ComfyUI submission correlation;
* Result metadata recorded by execution state;
* Result bytes.

A complete historical Run must remain interpretable without SQLite.

### SQLite-derived state

SQLite may maintain rebuildable projections of filesystem-owned state for efficient browsing and search:

* Asset index;
* Run index;
* Run-to-Prompt index;
* Job index;
* Result index;
* execution-status projections;
* filesystem integrity/index diagnostics.

Derived indexes are disposable and must be rebuildable from filesystem truth.

They must not be required to interpret a complete historical Run.

## Project identity

A Project has:

* a stable application-generated Project ID;
* a stable filesystem key;
* mutable current display metadata in SQLite.

`project.json` remains the immutable binding between the Project ID and filesystem key.

The name stored in `project.json` is only the initial owner label. It is not the current mutable display name.

Renaming a Project updates SQLite only.

Historical Runs retain their own Project name snapshots.

### New Projects

Creating a SQLite-backed Project must establish the filesystem owner binding immediately rather than waiting for the first Run.

Project creation therefore:

1. validates the Project ID and filesystem key;
2. creates or validates the matching filesystem Project owner binding;
3. creates the SQLite Project row.

If filesystem publication succeeds but the SQLite transaction fails, the filesystem owner becomes an adoptable orphan rather than being rewritten.

### Existing Projects

Existing valid `project.json` owner bindings may be explicitly adopted into SQLite.

Adoption must preserve the existing immutable Project ID and filesystem key.

An asset-only directory without `project.json` does not contain enough information to recover a Project ID and must not be assigned one automatically.

Such directories require explicit user adoption with a user-supplied Project ID and name. batchcraft
must not infer or generate the Project ID from the directory name, assets, or Run history.

## Batch identity

A saved Batch is mutable SQLite application state.

A published Run is an immutable filesystem execution specification.

These concepts remain separate:

```text
Saved Batch
  mutable intent
      |
      | Preview / compile / publish
      v
Run
  immutable provenance
```

A Batch has:

* a stable Batch ID;
* a stable filesystem key;
* mutable name and editable contents in SQLite.

`batch.json` remains the immutable Batch ID-to-filesystem-key owner binding.

The owner binding should be created or validated when a saved Batch first establishes its filesystem identity, not deferred until the first Run.

The owner-file name is the initial label only.

SQLite owns the current Batch display name.

Historical Runs retain their own Batch name snapshots.

## Prompt and PromptVersion

A `Prompt` is a logical reusable prompt.

It owns:

* stable Prompt ID;
* Project ownership;
* current mutable name;
* optional mutable description;
* timestamps;
* archive state.

A `PromptVersion` is an immutable revision of one Prompt.

It owns:

* stable PromptVersion ID;
* parent Prompt ID;
* monotonic version number;
* creation-time Prompt name snapshot;
* immutable template text;
* optional immutable change note;
* creation timestamp;
* archive state.

PromptVersions are never edited in place.

Saving changed Prompt text creates the next PromptVersion.

Version numbers:

* begin at 1;
* increase monotonically within a Prompt;
* are unique with their Prompt ID;
* are never reused.

The latest version is derived from version history rather than stored as a mutable pointer.

Users may directly select an older unarchived PromptVersion.

Restoring an old version as current creates a new PromptVersion containing the old text.

Prompts are Project-scoped in the initial implementation.

Cross-Project sharing/copying is deferred.

## PromptVersion provenance

Batches select an ordered collection of specific PromptVersions.

Runs must remain understandable after:

* Prompt rename;
* Prompt archival;
* PromptVersion archival;
* Prompt library deletion;
* SQLite loss.

Run provenance therefore remains self-contained and retains frozen PromptVersion snapshots independently of SQLite.

## Variable Lists

Variable Lists are mutable, reusable, Project-scoped SQLite entities.

Value order is semantically significant.

Values will initially be stored as a canonical ordered JSON string array rather than normalized child rows because current application operations edit and consume the list as a whole.

Saved Variable Lists reject:

* blank values;
* non-string values;
* exact duplicate values.

Every Variable List content change increments a revision number.

A saved Batch records the Variable List revision it observed.

If the underlying Variable List changes later, the Batch is considered stale and must be explicitly reviewed rather than silently compiling against changed values.

## Workflows and WorkflowVersions

Reusable ComfyUI Workflows are versioned.

A `Workflow` is a Project-scoped logical entity containing:

* stable Workflow ID;
* current name;
* description;
* timestamps;
* archive state.

A `WorkflowVersion` is immutable and contains:

* stable WorkflowVersion ID;
* parent Workflow ID;
* monotonic version number;
* Workflow name snapshot;
* canonical API-format workflow JSON;
* content SHA-256;
* optional change note;
* creation timestamp;
* archive state.

Saving changed Workflow JSON creates another WorkflowVersion.

Historical Runs continue storing their exact `workflow.json` snapshot.

## Workflow Profiles and versions

A logical Workflow Profile belongs to one logical Workflow.

A Workflow Profile version is immutable and targets one exact WorkflowVersion.

A Profile version stores the mappings from batchcraft concepts to ComfyUI node/input targets.

Examples include current core mappings:

* prompt;
* reference image;
* seed;
* output prefix.

The mapping representation must remain capable of later supporting typed generic parameters such as:

* LoRA strength;
* CFG;
* duration;
* steps;
* denoise.

A Workflow Profile version must validate against the exact WorkflowVersion it targets.

If a new WorkflowVersion changes node IDs or inputs, existing Profile versions are never modified.

A new Profile version is created and repaired against the new WorkflowVersion.

A saved Batch selects one exact Workflow Profile version, which transitively identifies its WorkflowVersion.

## Saved Batch state

SQLite owns editable saved Batch intent.

A saved Batch includes:

* Project;
* Batch identity;
* name and description;
* selected Workflow Profile version;
* ordered PromptVersion selections;
* Variable bindings;
* ordered Reference Asset selections;
* seed intent;
* revision;
* timestamps;
* archive state.

Random seed intent is stored as:

```text
mode = random
count = N
```

Fixed and Explicit modes store their configured concrete values.

Run provenance always contains materialized concrete seeds.

Random intent must never replace concrete seeds in immutable Run provenance.

## Seed range

New editable seed values must use one cross-layer range:

```text
0 through Number.MAX_SAFE_INTEGER
0 through 2^53 - 1
```

This range is exactly representable by JavaScript and safely representable by Python and SQLite INTEGER.

Frontend Random seed materialization may continue using unsigned 32-bit values.

Existing historical Runs with older values remain readable and are not destructively migrated.

## Preview and Run consistency

Preview and Run publication must preserve the existing invariant:

> A Run is created from the exact Batch specification inspected by Preview.

Future SQLite-backed saved Batches must not weaken this.

A saved Batch should use optimistic revision checking.

A later implementation may use:

* explicit Batch revision;
* complete canonical Preview snapshots;
* Preview tokens.

No Run may be created by silently rereading newer mutable Batch contents after the user inspected an older Preview.

## Manifest Batch snapshot

Current manifest v3 preserves concrete compiled Jobs and Prompt snapshots but does not preserve all editable Batch intent. Manifest v3 adds explicit nullable per-Job Reference Asset provenance; v1 and v2 require a Reference Asset object.

It cannot faithfully reconstruct:

* original binding modes;
* full Variable Lists;
* unselected values;
* original Random seed intent;
* all future editable parameter-sweep intent.

Before batchcraft claims faithful `Load as Batch` restoration, a future manifest v4 will add a versioned frozen Batch intent snapshot.

Historical v1/v2 Runs remain valid.

They may be loaded as effective Batches with documented loss of original editing intent.

Exact Run replay continues to use concrete immutable Job provenance.

## Assets

Asset bytes and canonical Asset metadata remain filesystem-owned.

SQLite may contain a rebuildable Asset index for:

* Project asset browsing;
* filename search;
* MIME filtering;
* metadata lookup.

SQLite must not contain Asset bytes.

Derived Asset metadata must not become authoritative over `asset.json`.

Future user-authored metadata such as tags or ratings may be SQLite-authoritative in separate tables.

## Run, Job, and Result indexes

SQLite may maintain rebuildable indexes for Project-wide application queries.

The Run index may contain:

* Run identity;
* Project and Batch identity;
* historical name snapshots;
* Run number;
* creation time;
* Job count;
* Result count;
* execution-status projection;
* filesystem-relative location;
* index health state.

Job indexes may contain selected provenance metadata such as:

* Run ID;
* Job ID;
* ordinal;
* PromptVersion ID;
* seed;
* Reference Asset ID;
* execution-status projection;
* Result count.

Result indexes may contain:

* Run ID;
* Job ID;
* artifact ordinal;
* producing node;
* output name;
* content type;
* filename;
* filesystem-relative location;
* byte size;
* SHA-256.

Result bytes and thumbnails are never stored in SQLite.

Absolute filesystem paths should not be used as portable identity.

## Reindexing

Derived indexes must support explicit rebuilding from filesystem truth.

Reindexing must never recreate or overwrite SQLite-authoritative mutable application entities.

A rebuild may restore:

* Asset indexes;
* Run indexes;
* Prompt associations preserved by Runs;
* Job indexes;
* Result indexes.

It must not silently recreate:

* Prompt libraries;
* Variable Lists;
* saved Batches;
* Workflow libraries;
* current Project metadata;
* queue intent.

A corrupt filesystem entity must not prevent unrelated healthy entities from being indexed.

Staging and allocation directories are not published Runs.

Duplicate immutable IDs are integrity conflicts and must not be resolved by arbitrarily choosing a winner.

## Execution-state authority

Detailed execution state remains filesystem-authoritative in `execution.json`.

SQLite must not become another independently writable copy of:

* Run execution state;
* Job execution state;
* ComfyUI prompt IDs;
* submission dispositions;
* Result metadata.

SQLite may contain derived execution-status projections for query performance.

## Scheduler authority

SQLite owns future durable scheduler intent.

A queue entry is separate from an immutable Run:

```text
Run
  immutable specification

Queue entry
  mutable scheduling state
```

Scheduler state may include:

* FIFO sequence;
* queued state;
* claim state;
* worker identity;
* lease;
* cancellation request;
* scheduler diagnostics.

Initial scheduling remains one active Run globally.

A lease is only an ownership/recovery mechanism.

**Lease expiration must never be interpreted as permission to blindly resubmit an ambiguous or possibly-running ComfyUI Job.**

Restart recovery must inspect filesystem execution state and reconcile remote submission evidence before making progress.

## Cancellation

Future cancellation will initially support:

```text
Stop after current Job
```

SQLite owns cancellation intent.

`execution.json` owns the eventual execution outcome.

The application must distinguish:

* succeeded;
* failed;
* blocked;
* cancelled.

A cancellation request is not a failure.

Stopping after the current Job means batchcraft submits no subsequent Job.

It must not blindly clear the general ComfyUI queue because unrelated work may exist there.

## Database technology

The initial implementation will use Python standard-library `sqlite3`.

No ORM is introduced.

Reasons:

* SQLite-specific behavior matters;
* schema constraints should remain explicit;
* current persistence patterns are explicit rather than ORM-based;
* migrations require deliberate SQL regardless;
* dependencies should remain minimal.

Use small feature-specific stores rather than a generalized repository framework.

Connections are opened per operation.

Blocking SQLite operations from async FastAPI paths may run through synchronous service boundaries or worker threads.

A writable global connection must not be shared across the event loop and background worker threads.

## SQLite configuration

Every connection enables:

```text
PRAGMA foreign_keys = ON
PRAGMA busy_timeout = 5000
```

Database initialization enables:

```text
PRAGMA journal_mode = WAL
PRAGMA synchronous = FULL
```

The database is expected to live on a local filesystem.

SQLite on SMB/NFS/network filesystems is unsupported unless locking and WAL assumptions are revisited.

## Migration strategy

Schema changes use explicit ordered SQL migration files and a `schema_migration` history table.

Migrations include:

* integer version;
* stable name;
* checksum;
* application timestamp.

Startup:

1. opens/configures the database;
2. reads migration history;
3. rejects a database schema newer than the application;
4. verifies checksums of applied migrations;
5. applies pending migrations in order;
6. rolls back and fails startup if a migration fails.

There is no implicit model-to-schema synchronization.

Migrations are added only when the corresponding application phase is implemented.

The first migration must not pre-create tables for future scheduler/index/workflow features merely because they appear in the architecture plan.

## Phased schema rollout

The database schema will be introduced incrementally.

### Phase 1

* database foundation;
* migrations;
* Project;
* Project adoption/owner binding;
* Prompt;
* PromptVersion;
* small Prompt-library API.

### Phase 2

* rebuildable Asset/Run/Job/Result indexes;
* explicit reindex behavior.

### Phase 3

* Workflow;
* WorkflowVersion;
* Workflow Profile;
* Workflow Profile version;
* Variable Lists.

### Phase 4

* saved Batches and ordered child state;
* optimistic Batch revision handling;
* manifest v4 Batch intent snapshot.

### Phase 5

* durable scheduler;
* claims and leases;
* cancellation intent;
* restart reconciliation.

### Phase 6

* Project-wide gallery;
* Run inspector;
* Load-as-Batch workflows.

Each phase gets only the migrations required by that phase.

## Database location

SQLite contains cross-Project application state and must not live inside one Project.

Introduce configurable application data paths such as:

```text
BATCHCRAFT_DATA_ROOT
BATCHCRAFT_DATABASE_PATH
```

with a default conceptually equivalent to:

```text
<data-root>/batchcraft.sqlite3
```

`BATCHCRAFT_PROJECTS_ROOT` remains independently configurable.

Absolute paths are resolved at runtime for containment and safety but are not used as portable entity identity.

## Concurrency

batchcraft remains a local single-user application but FastAPI and background tasks may access SQLite concurrently.

The initial model is:

* one backend process;
* one SQLite connection per operation;
* WAL;
* short transactions;
* `BEGIN IMMEDIATE` for read-modify-write transactions requiring serialization.

Multiple Uvicorn workers are unsupported until filesystem execution-state locking and scheduler behavior are explicitly made cross-process safe.

## Archive and deletion

Reusable library entities prefer archival rather than destructive deletion where historical or saved references may exist.

Immutable versions may be hidden from new selections via archive state while remaining valid for:

* existing saved Batches;
* historical inspection;
* explicit old-version selection where supported.

Historical Runs never depend on live SQLite library records because they retain frozen provenance snapshots.

Derived index rows may be discarded and rebuilt freely.

## Backup consequences

Once SQLite is introduced, filesystem-only backups are incomplete.

SQLite-only backups are also incomplete.

A complete future backup requires:

```text
SQLite database
+
Project filesystem root
```

SQLite backup must account for WAL.

A future backup/export design is deferred.

## Consequences

### Positive

* Prompt history gains correct logical Prompt/PromptVersion semantics.
* Saved mutable Batches no longer rely on browser session state.
* Project Workflows and Profiles become reusable.
* Project-wide galleries can use fast indexes.
* Durable scheduling can survive browser refresh and eventually backend restart.
* Historical Run durability remains independent of SQLite.
* Derived indexes can be deleted and rebuilt.
* SQLite introduction does not require destructive migration of existing Runs or Assets.

### Negative

* SQLite becomes a new authoritative data source that must be backed up.
* Filesystem and database operations cannot participate in one atomic transaction.
* Project/Batch owner publication and database insertion require explicit orphan/adoption handling.
* Schema migrations become part of application lifecycle.
* Application recovery becomes more nuanced because mutable library state is not reconstructable from historical Runs.
* Scheduler recovery must reconcile filesystem execution state rather than trusting database queue state alone.

## Explicitly deferred

The initial SQLite design does not include:

* Prompt Sets;
* Reference Collections;
* tags;
* ratings;
* favorites;
* thumbnails;
* full-text search;
* generic parameter sweep tables;
* coupled/zipped parameter dimensions;
* distributed workers;
* multi-ComfyUI routing;
* authentication;
* users or teams;
* cloud synchronization;
* backup/export tables;
* notification history;
* saved searches;
* browser session state.

These features may be added when concrete product requirements justify them.
