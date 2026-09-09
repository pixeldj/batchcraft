# BC-026: Global Workflow Library

Status: In Progress. Target release: v1.2.0 after the agreed Workflow updates are complete and verified.
Application version remains 1.1.0 during this implementation pass; no release or deployment is implied.

Backlog: [BC-026](../BACKLOG.md#bc-026-global-workflow-library-and-project-copies).
Decision: [ADR 0016](../adr/0016-global-workflow-library-project-copies.md).

## Target user flow

This is the complete acceptance target, not a claim that every step is implemented in the first slice.

1. Open Workflow Library without first choosing a Project.
2. Find a reusable Workflow and inspect its exact versions and compatible Profiles.
3. Use in this Project copies the chosen setup into a selected, verified Project, then explicitly
   applies it to the draft with normal Preview invalidation.
4. Import to Library copies a Project setup or an exact historical Run setup into the catalog.
5. Edit copies independently. Existing Batches and Runs never follow source updates automatically.

## Current first slice

Implemented in `backend/src/batchcraft/api/global_library.py` (six routes),
`backend/src/batchcraft/db/global_workflows.py`, migration `0005_global_workflow_library.sql`, and
`frontend/src/features/batch/GlobalWorkflowLibrary.tsx`. Global records are application-owned separate
tables; Project ownership and Saved Batch references remain unchanged. Atomic copies use exact source
versions, reviewed names, up to 50 Profiles, and an application-wide request ID/receipt whose fingerprint
includes direction. Retries return the original copies; conflicts do not merge families or leave orphans.

Workflow Library is accessible with no selected Project through `view=workflows`, with `library_q`
separate from history. Import to Library currently means choosing a registered source Project without
switching the draft. Global Workflow inspection selects the most recent active exact version, and
compatible Profile details are read on selection. There is no full global Workflow history editor yet.
Global lists use 20-row metadata pages (REST maximum 50), each retaining 20 sliding Previous bookmarks;
forward paging is not capped at 20 pages. Legacy Project-source and revision pickers remain unpaginated
and can return full payloads. Browsing activates neither history nor ComfyUI generation.

Confirm copy persists first. Use copied setup then requires replacement confirmation, selecting a
Profile when several were copied (one is preselected; zero allows Workflow-only application). Only
successful application invalidates Preview. Project/draft changes and execution locks prevent stale
application without discarding persisted copies. Import, browsing, copying and cancelled apply preserve
the current Batch and valid Preview.

Historical frozen Run import, direct global JSON import, global revision-management UI/API and archive
endpoints remain queued. The store has immutable revision support but no full global history-management
surface. Existing v1 formats, applied migrations 0001-0004 and historical Run bytes remain unchanged.

### Verification checkpoint

Final first-pass verification passed: **782 frontend tests**, **1433 backend tests**, and **22 fake-backed
E2E tests each against Vite and the built frontend**, including a full rerun after the pager fix.
Frontend/backend lint, formatting, type checks, builds, and diff checks passed. Vite reports a non-fatal
approximately 515 kB minified chunk warning; no chunk threshold was relaxed. Four focused browser cases
per serving mode also passed after the final display cleanup. This is not release acceptance.

Regression coverage includes Project A -> global -> Project B -> Preview/Run with two fake Jobs,
persisted independent copies, idempotent receipts across restart/source changes, transactional rollback,
name uniqueness, exact Profile detail, malformed-cursor rejection, and unit coverage for continued
forward paging beyond 20 pages. This is not historical-import acceptance, completion of BC-026, or
authorization to bump version 1.1.0, publish v1.2.0, or update an everyday installation.

## Implementation checkpoints

### 1. Project-to-library-to-Project slice

- Add global catalog tables and retry receipts in the existing SQLite database using the next forward
  migration. Existing Project resource tables and Saved Batch foreign keys retain their contracts.
- Reuse production validation; enforce exact Profile target relationships and immutable revisions.
- Add bounded global metadata reads and exact detail reads, independent of ComfyUI or selected Project.
- Add server-sourced Project import and atomic copy into a destination Project, with explicit operation
  identity, naming review, and collision handling. Do not compose independently committed writes and
  claim they form an atomic setup copy.
- Add application-wide navigation and a small browser. History activation must explicitly recognize
  Gallery/Runs, not every destination other than Batch. Global search is separate from history filters.
- Keep draft, Preview, execution, request cancellation, and Project-switch guards intact.

### 2. Historical import and library management

- Import to Library from Run Plan/Result Details reads frozen snapshots on the backend, even if current
  Project/global library rows are absent. Missing ancestry stays explicit rather than guessed.
- Add reviewed global Workflow/Profile revision management, archive behavior, and explicit duplicate
  handling without conflating family identity with payload equality.
- Reuse version/mapping UI where appropriate; do not build a competing ComfyUI workflow editor.

### 3. Acceptance and release preparation

- Test restart durability, same-source retries, conflicting operation IDs, atomic rollback, and copies
  remaining independent after source changes/archival.
- Exercise a new Project with no setup, Project A -> global -> Project B -> Preview/Run, and imported
  historical Project -> frozen setup -> global without its original SQLite/global catalog.
- Verify bounded lists, no background mutation during browsing, late-response cancellation, desktop and
  mobile UI, and retention of drafts/valid Preview when merely viewing or importing into the catalog.
- Run normal frontend/backend checks and fake-backed browser acceptance. Do not touch everyday data or
  live ComfyUI without explicit authorization.
- Record owner acceptance and any additional agreed Workflow scope before preparing v1.2.0 metadata,
  tagged release, or installation updates. BC-009 is not silently included in this milestone.

## Non-goals

No synthetic Project, automatic cross-Project synchronization, automatic family merging by content,
export of unused libraries in Project folders, new v1 archive format, source Run mutation, cloud service,
or frontend-to-ComfyUI connection. Existing user data and applied migrations remain intact.
