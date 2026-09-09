# ADR 0016: Global Workflow Library With Project-Owned Copies

- Status: Accepted
- Scope: BC-026; implementation is incremental.
- Release target: v1.2.0 after the agreed Workflow updates are verified.

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

Implementation checkpoint: the first slice provides separate global tables via migration 0005,
six library API routes, Project-source import, atomic receipt-backed Project copies, and application-wide
browsing with explicit guarded application. The UI inspects the most recent active exact global
WorkflowVersion and selected compatible Profile details, not full global Workflow version history.
Direct global JSON import, frozen Run import, global revision-management surfaces and archive endpoints
remain queued. This incremental implementation does not change Accepted status or the v1 portability
contract; application version remains 1.1.0 pending the remaining agreed v1.2.0 Workflow work.

- Global and Project copies intentionally diverge. There is no automatic upgrade or synchronization.
- The first slice can import existing Project setups before adding historical sources or catalog editors.
- Bounded metadata lists and exact-version detail reads avoid downloading every Workflow while browsing.
- Global library loss is recovered from a whole-data backup or explicit imports from retained sources;
  Project-folder import does not restore unrelated global entries.
- No new compiler model or Run format is required. `/object_info`, media inputs, and other Workflow
  improvements remain separate scope decisions, not implicit requirements of this ownership change.
