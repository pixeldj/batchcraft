# ADR 0016: Global Workflow Library With Project-Owned Copies

- Status: Accepted
- Scope: BC-026; implementation verified and accepted by the owner.
- Release: v1.2.0.

## Context

Workflow and Workflow Profile libraries currently belong to Projects. A new Project cannot select a
reusable setup without recreating it. The owner wants a library above Projects, but explicitly wants
independent copies in Projects, not shared live references. Only setups used in Runs need to survive
Project-folder import. Import to Library should also accept historical frozen setups.

## Decision

Add application-owned Workflow, WorkflowVersion, Workflow Profile, and ProfileVersion records in
separate tables in the existing SQLite database through a contiguous forward migration. Do not create
a synthetic Project or make Project ownership optional in existing resources. The global catalog is
mutable library state, not historical authority, and is included in whole-data backups.

Global Profiles belong to a global Workflow family, and each ProfileVersion targets one exact version
of that family. Reuse existing Workflow/Profile validation and canonical payload contracts. Immutable
version rows remain immutable; logical metadata and archive state are distinct from version content.

Use in this Project creates ordinary Project-owned copies with new logical/version identities before
they can be selected by a Saved Batch. Import to Library creates global copies, rather than changing
ownership of the source. A new copied family starts at local version 1; source revision numbers, when
retained, are provenance and do not invent destination history. Repeated explicit imports do not merge
families merely because their JSON or names match. Future revision adoption must be reviewed explicitly.

Workflow-plus-selected-Profile copies are atomic within one SQLite transaction. A stable operation ID
and request fingerprint make retries return the same copy, or fail on incompatible request reuse.
Source data is read authoritatively by the backend from exact version IDs or frozen Run snapshots, not
trusted from client-supplied historical JSON. Source edits, archival, or loss cannot mutate copies.

Browse globally without a Project. Applying a setup requires the selected, verified destination Project
and normal draft/Preview guards. Catalog browsing/import alone preserves drafts, Preview, execution
monitoring, and historical browsing state. The frontend never calls ComfyUI directly.

## Portability

ADR 0012 remains unchanged: v1 Project folders are historical experiment archives. Existing Runs freeze
the Workflow and Profile they used, so an imported Project can recover that setup without the global
catalog. Unused library resources are not exported. Do not add a Project resource directory, rewrite
old Run files, or broaden v1 import into restoration of all unused mutable resources.

## Consequences

Historical checkpoint: the first slice provided separate global tables via migration 0005,
six library API routes, Project-source import, atomic receipt-backed Project copies, and application-wide
browsing with explicit guarded application. That UI inspected the most recent active exact global
WorkflowVersion and selected compatible Profile details, not full global Workflow version history.
At that checkpoint, direct global JSON authoring, frozen Run import, revision-management surfaces and
archive endpoints were queued.

Current authoring checkpoint: global create/append, logical metadata, archive/unarchive, bounded
Profile-family and revision History reads are implemented. Migration 0006 adds a separate authoring
receipt table and indexes without changing applied 0005. Each mutation atomically stores its request
ID, canonical operation/target/payload and response; exact retries replay, incompatible reuse conflicts
with 409. These receipts do not change the copy-receipt namespace or Project persistence contract.

Project and global authoring reuse one dialog/mapper while retaining separate ownership semantics.
Global New Workflow saves once, then opens the prefilled `${name}-profile` mapper; cancelling or failing
the Profile stage does not undo or recreate the Workflow. Edit/Save appends internal immutable revisions;
History exposes version numbers and technical identity and restores old content by append. Metadata
names/descriptions and logical/version archive state do not rewrite old snapshots or hashes. Names
remain reserved through archival, and no hard delete is exposed. Profile families needing review remain
discoverable; exact target relationships are never silently reassigned. Global operations do not alter
Project Batch/Preview state, independent copies, or frozen Runs.

Frozen Run Plan/Result Details Import to Library is implemented. A separate immutable setup GET verifies
registered Project ownership and frozen file/hash integrity without requiring Assets, outputs or reading
execution state. The import POST accepts Run identity, reviewed names and optional raw-source hash
preconditions, never authoritative client JSON or paths. It creates exactly one new global Workflow and
Profile at local version 1, preserving the base setup rather than Job overrides. Recorded ancestry and
raw source hashes remain separate from destination canonical identity/name envelopes and hashes;
unknown optional ancestry is not invented. There are no intermediate Project resources.

Historical import reuses migration 0005 copy receipts: lookup before source I/O permits replay after
source loss, and recheck under `BEGIN IMMEDIATE` prevents concurrent duplication. Pair and receipt
commit atomically; migration 0006 authoring receipts remain independent. No migration, dependency or
v1 format change is introduced. An App-owned single-operation cache supports dialog retry without
becoming Recovery v4 state or a general catalog cache. Import never applies to Batch; opening Workflow
Library after success is explicit navigation. BC-026 is Done after implementation verification and
explicit owner acceptance. This does not change Accepted status or the v1 portability contract.
The owner authorized v1.2.0 publication and the everyday installation update;
see [release notes](../V1_2_RELEASE_NOTES.md).
Workflow images are deferred optional upcoming work, not a v1.2.0 completion gate.

- Global and Project copies intentionally diverge. There is no automatic upgrade or synchronization.
- The first slice can import existing Project setups before adding historical sources or catalog editors.
- Bounded metadata lists and exact-version detail reads avoid downloading every Workflow while browsing.
- Global library loss is recovered from a whole-data backup or explicit imports from retained sources;
  Project-folder import does not restore unrelated global entries.
- No new compiler model or Run format is required. `/object_info`, media inputs, and other Workflow
  improvements remain separate scope decisions, not implicit requirements of this ownership change.
