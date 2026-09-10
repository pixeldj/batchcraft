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

## Historical first slice

The first slice was implemented in `backend/src/batchcraft/api/global_library.py` (then six routes),
`backend/src/batchcraft/db/global_workflows.py`, migration `0005_global_workflow_library.sql`, and
`frontend/src/features/batch/GlobalWorkflowLibrary.tsx`. Global records are application-owned separate
tables; Project ownership and Saved Batch references remain unchanged. Atomic copies use exact source
versions, reviewed names, up to 50 Profiles, and an application-wide request ID/receipt whose fingerprint
includes direction. Retries return the original copies; conflicts do not merge families or leave orphans.

Workflow Library is accessible with no selected Project through `view=workflows`, with `library_q`
separate from history. Import to Library currently means choosing a registered source Project without
switching the draft. Global Workflow inspection selects the most recent active exact version, and
compatible Profile details are read on selection. This slice did not yet include a global History editor.
Global lists use 20-row metadata pages (REST maximum 50), each retaining 20 sliding Previous bookmarks;
forward paging is not capped at 20 pages. Legacy Project-source and revision pickers remain unpaginated
and can return full payloads. Browsing activates neither history nor ComfyUI generation.

Confirm copy persists first. Use copied setup then requires replacement confirmation, selecting a
Profile when several were copied (one is preselected; zero allows Workflow-only application). Only
successful application invalidates Preview. Project/draft changes and execution locks prevent stale
application without discarding persisted copies. Import, browsing, copying and cancelled apply preserve
the current Batch and valid Preview.

At that checkpoint, historical frozen Run import, direct global JSON authoring, revision-management
UI/API and archive endpoints were queued. The authoring scope is now implemented as described below;
historical import is still queued. Existing v1 formats and historical Run bytes remain unchanged.

### Historical verification

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

## Current authoring checkpoint

Backend and UI authoring are implemented. BC-026 remains In Progress: Import to Library from frozen
Run Plan/Result Details is still queued, and this checkpoint is not final acceptance or a v1.2.0 tag.
The application version stays 1.1.0.

- Global New Workflow has one Save action. Success saves the Workflow, then opens the shared Profile
  mapper with `${name}-profile` prefilled. Cancel keeps that Workflow; Profile errors retain the Profile
  draft, and retrying the Profile stage does not create a duplicate Workflow.
- Project and global flows reuse `WorkflowAuthoringDialog.tsx` and the existing Profile mapper. Content
  scrolls independently below a stable `h2` and above stable footer actions. Initial focus explicitly
  targets Name, Workflow JSON, or the first enabled mapper select as appropriate. Dirty close asks for
  confirmation. Project dialogs remain mounted but inactive across navigation, hiding their portals
  while preserving draft, pending file read/write state and Workflow-to-Profile stage. Global authoring
  owns draft and write identity above its active-only portal; navigation does not cancel a pending save.
- Workflow files must be JSON objects no larger than 64 MiB; paste is also supported. Saving invokes
  backend API-format validation, not ComfyUI editor-format conversion. The API request-body limit is a
  separate boundary.
- Normal actions are Edit/Save; saves append immutable internal revisions. Version numbers and technical
  revision metadata are exposed in History rather than normal catalog browsing. History can inspect
  exact content and Restore it by appending a new revision, never overwriting the selected old version.
- `GlobalWorkflowDetail.tsx` reads bounded Profile families, including those needing review. Compatibility
  is an active ProfileVersion's relationship to the exact viewed WorkflowVersion in its own family.
  Repair uses the shared mapper, preserving keys, order, types and broken selections for review.
- Logical name/description edits leave old name snapshots, Profile payloads and hashes unchanged.
  Archive/unarchive covers logical Workflows/Profiles and individual revisions; default lists/History
  exclude archived entries, names remain reserved, and no hard delete is exposed.
- Migration `0006_global_workflow_authoring.sql` adds an independent authoring receipt table and family/
  History indexes. Applied 0005 is untouched. Canonical operation, target and payload plus request ID and
  full response persist atomically with each mutation; unchanged retries replay the receipt across
  restart, conflicting reuse returns 409, and failure leaves no partial mutation/receipt.
- Global authoring, metadata/archive changes and History selections do not change Project Batch state
  or valid Preview. Copies remain independent and frozen source snapshots are not rewritten. Use copied
  setup retains explicit confirmation and Project/draft/execution guards.
- Existing copy-receipt selections hydrate once; newer exact user choices cannot be overwritten by
  reload/paging or late hydration. Cancelled/stale asynchronous Profile authoring callbacks cannot
  replace a newer draft. Authoring and copy receipt namespaces remain separate.

### Verification checkpoint

Final authoring checkpoint verification passed: **861 frontend tests**, **1466 backend tests**, and
**26 desktop/mobile browser tests in each of Vite and built modes**, against temporary fake-backed data.
Lint, formatting, type checks, builds, and diff checks passed. Browser coverage exercises Project-free
creation and Profile handoff, validation repair, immutable history, independent copies, successful Jobs,
native focus, dirty Escape, and independently scrolling forms at 320px. Applied migration bytes remain
unchanged. Vite reports a non-fatal approximately 539 kB minified chunk warning. The historical
782/1433/22 results above remain first-slice evidence; no live-GPU or owner acceptance is claimed here.

### Remaining scope

Import to Library from frozen Run Plan/Result Details must read backend-owned snapshots and work
without the original mutable Project/global rows. Complete that slice and final acceptance before
marking BC-026 Done or preparing v1.2.0. Workflow images are deferred optional upcoming work, not a
v1.2.0 completion gate. No everyday installation update is authorized.

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

### 2. Authoring and historical import

- Implemented authoring UX: reuse one Workflow/Profile authoring UI in both ownership contexts, retaining
  Project-local editing. Global New Workflow has one Save action; successful creation immediately opens
  the Profile Builder with the existing name convention pre-filled. Closing that builder keeps the
  Workflow. Failed Profile saves retain the draft and must not recreate the Workflow.
- Normal labels are Edit and Save. Saving appends immutable revisions internally, without promoting
  version numbers in normal browsing. History exposes exact versions for inspection/reuse; technical
  identity/hash details stay collapsed. Workflow images are optional deferred work, not a release gate.
- Global detail shows distinct Profile families, including Profiles whose mappings need review for the
  selected Workflow. Reuse the existing mapper for repair, preserving keys, order, types, and broken
  target selections. Global edits never change Project copies, Batch selections, or frozen Runs.
- Direct create/append operations are retry-safe through migration 0006 authoring receipts;
  migration 0005 remains byte-stable.
- Still queued: Import to Library from Run Plan/Result Details reads frozen snapshots on the backend,
  even if current Project/global library rows are absent. Missing ancestry stays explicit rather than guessed.
- Implemented reviewed global Workflow/Profile revision management, archive behavior, and explicit duplicate
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
