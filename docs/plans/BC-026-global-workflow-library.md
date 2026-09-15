# BC-026: Global Workflow Library

Status: In Progress. Target release: v1.2.0 after the agreed Workflow updates are complete and verified.
Application version remains 1.1.0 during this implementation pass; no release or deployment is implied.

Backlog: [BC-026](../BACKLOG.md#bc-026-global-workflow-library-and-project-copies).
Decision: [ADR 0016](../adr/0016-global-workflow-library-project-copies.md).

## Target user flow

This is the complete acceptance target, not a claim that every step is implemented in the first slice.

1. Open Workflow Library without first choosing a Project.
2. Find a reusable Workflow and inspect its exact versions and compatible Profiles.
3. Add to Project opens naming and exact-Profile review, then copies the chosen setup into a selected,
   verified Project. Apply to Batch is a separate guarded action with normal Preview invalidation.
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
- Cancelling the JSON file picker leaves the authoring dialog and draft intact. Only cancel events
  targeted at the dialog itself dismiss it. A successfully loaded file prefills a blank visible Name
  from its filename without the trailing `.json` (case-insensitive); existing names and names updated
  during the read are retained. Invalid files do not alter the name or JSON draft.
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

### Prior authoring verification

Final authoring checkpoint verification passed: **861 frontend tests**, **1466 backend tests**, and
**26 desktop/mobile browser tests in each of Vite and built modes**, against temporary fake-backed data.
Lint, formatting, type checks, builds, and diff checks passed. Browser coverage exercises Project-free
creation and Profile handoff, validation repair, immutable history, independent copies, successful Jobs,
native focus, dirty Escape, and independently scrolling forms at 320px. Applied migration bytes remain
unchanged. Vite reports a non-fatal approximately 539 kB minified chunk warning. The historical
782/1433/22 results above remain first-slice evidence; no live-GPU or owner acceptance is claimed here.

## Frontend layout and interaction follow-up

This narrow follow-up builds on implemented authoring, not a new backend feature or completion of BC-026.
`LibrarySearch.tsx`, `LibraryMenu.tsx`, and `ReadonlyProfileSummary.tsx` support the existing
`GlobalWorkflowLibrary.tsx` and `GlobalWorkflowDetail.tsx` surfaces. Backend APIs, SQLite, architecture,
domain models, durable formats and dependencies are unchanged.

- Journey: choose a Workflow, inspect/select a Profile, then Add to Project. One primary Add action lives
  in the detail footer, not a browser-wide floating bar. It opens the existing review with editable names,
  exact revision choices and 0-50 Profiles. Explicit opening choices and restored receipts take priority;
  a pristine review may default one eligible exact Profile under the bounded rules below.
  This does not change Project-source Import to Library selection behavior.
- Confirm copy persists independent Project resources. Apply to Batch remains a separate explicit action
  with replacement confirmation and Project/draft/execution guards. Browsing, search, inspection,
  authoring, copying and cancelled apply do not change Batch intent or invalidate Preview.
- The library header and row text are left-aligned. The desktop sidebar is 272px (`17rem`) with a vertical
  divider. Workflow entries own a bounded `min(55dvh, 32rem)` scroll scope, reduced to
  `min(40dvh, 32rem)` on mobile; Profile entries own `min(40dvh, 24rem)`. Search, paging, selected Profile
  detail and the Add footer are outside those list scroll scopes. Mobile stacks the sidebar above detail.
- Edit stays visible as a secondary row action. Rename / description, History and Archive/Unarchive live
  in keyboard-operable popover menus. Exact revision indicators are small context rather than primary
  actions. The selected Profile shows formatted core mapping node names, ordered named Image Inputs and
  typed parameter definitions; technical target IDs and raw JSON remain available through disclosures.
- Workflow, Profile and History search use a 300ms debounce with immediate Enter submission. Committed
  query changes reset paging; scope/query/navigation changes cancel pending search work and stale reads.
  Manual Refresh returns lists to their first page while retaining exact Workflow/Profile selection,
  rather than silently adopting latest revisions.
- Summary reads use two workers over at most the current 20-row Profile-family page and retain a positive
  cache of at most 20 exact ProfileVersions. Failed summaries display unavailable state; manual Refresh
  retries each failed summary once for the refreshed page while retaining successful cache entries.
  Lists request 20 rows, pagers retain at most 20 Previous bookmarks, and Next has no 20-page forward cap.
  These are frontend bounds, not new API contracts; legacy Project-source lists remain unpaginated.
- Only `RESTORED_DRAFT_MESSAGE` is hidden outside Batch. Navigation does not clear or dismiss its state;
  other recovery/storage warnings remain unchanged. Existing themes, application navigation/header,
  Batch and Prompt behavior are preserved. Library actions use scoped classes rather than the shared
  `.action-row` styling that caused the layout conflict; checkbox `width: auto` is scoped to the library
  and its dialogs, not a global form reset.

### Layout verification checkpoint

Verification passed: **884 frontend tests**, typecheck, lint, build, and **30 desktop/mobile browser
tests in each of Vite and built modes**. After the final narrow-row action-alignment rule, four focused
layout/browser cases per mode passed again. No backend code or data formats changed.

Dark Synthwave before/after screenshots were captured and visually inspected at 1440px, 1024px and
390px. Checked empty/one-entry/paginated libraries, long names, multiple/no/incompatible Profiles,
archived entries, actual ordered mapping summaries, simulated loading/error states, historical selection
through Refresh, destination selection, 0/1/multiple copies and the 50-selection limit, explicit Batch
application, recovery-notice scoping, keyboard menus, and existing authoring dialogs. Final list-scroll
checks confirm bounded internal scrolling, stationary list controls, an unclipped last-row menu, and
no sidebar-driven blank gap above Add to Project. Theme sources, fonts and palette tokens are unchanged.

Summary request accounting verifies two concurrent workers, cached successful summaries, and only one
retry for a failed summary on Refresh. The approximately 547 kB minified chunk warning remains non-fatal;
no threshold was relaxed. Owner acceptance of this cleanup and overall BC-026 completion remain separate.

## Add-to-Project dialog cleanup

This frontend interaction follow-up uses the current `SetupReview` rather than introducing another copy
flow. Only its global-to-Project branch changes; Project-source Import to Library keeps its direction
and legacy dialog. No backend, API, SQLite, v1 format, architecture, dependency, synchronization, or
Saved Batch/snapshot semantics change is included. BC-026 remains In Progress, targeting a future
v1.2.0; the application version remains 1.1.0. Workflow images and historical Run import are outside
this cleanup.

### Presentation and selection

- The compact title is Add workflow to Project. Show the destination Project name captured when opening
  the review and a Workflow name summary. Start from the original name, not an automatic copy suffix;
  never strip a legitimate `copy` from an existing name. Rename reveals and focuses the input; hiding
  it retains the current draft value and shows the proposed name in the summary.
- Include Profiles hides the count only for a known-complete one-family collection; otherwise show
  `N selected`, not an available total or routine N/50 label. Show up-to-50 guidance only at 45 or more
  selections; the maximum remains 50. After the initial read, zero choices show the quiet note
  `Only Workflow will be added`. Workflow-only eligibility is unchanged.
- User-approved opening default: a restored receipt, including `profiles: []`, restores its exact choices.
  Otherwise a caller-provided preferred exact Profile or explicit selection intent settles the decision;
  parent Clear carries an explicit no-default boolean (`selectionSupplied`), not an inferred empty list.
  Only a brand-new review with no prior choice may default once: the unfiltered first page must have
  `next_cursor: null`, cover all families, and have resolved eligibility metadata for every family, with
  exactly one active compatible eligible family. Select that metadata's exact version ID. Other known
  incompatible families do not prevent this default. One filtered row, an incomplete page or unresolved
  metadata is insufficient; do not fetch all pages or add an API to infer uniqueness.
- Any explicit choice or draft interaction settles the default before a late response can overwrite it.
  Once settled, Refresh, search and paging never default again. A failed initial discovery can be retried
  while still pristine; it is not evidence of an empty collection. Project-source Import to Library's
  direction and initial multiple-Profile selection remain unchanged.
- Replace the upper menu whose only action was Refresh with a direct quiet Refresh SVG button using
  existing styles and no icon library. Retain rows during refresh loading/error, disable repeated refresh
  requests, and retain bounded page/selected metadata rather than accumulating the catalog.
- Profile rows use a vertically centered checkbox/name label, with the menu outside that label and a
  subtle border. Align Rename values with row content and keep its explanatory note quiet.
- Show search when the unfiltered first page has more than five rows, pagination exists, or a query is
  active. Once needed, keep search available within the review. Use bounded page reads, never load the
  whole library or infer its available total. Pagers contain only Previous and Next controls; existing
  20-row reads and sliding Previous bookmarks remain unchanged.
- Show Review all selected Profiles only when selected exact IDs are absent from the current page/query
  rows. Its expanded view shows all selected proposed names. Keep all selections and proposed names in
  the choice array, keyed by exact version IDs, independently of visible rows, paging, search and rename
  visibility.
- Row menus expose Inspect mappings, Rename (disabled for unselected rows), and Choose revision. Use
  actual Profile-family History and fetch the chosen exact ID, not copy lineage or an automatic latest
  replacement. Check the exact Workflow target and archive state before committing the choice. Workflow
  JSON remains secondary technical inspection.
- Manual and default checkbox choices pin exact IDs just like revision choices. Validate the chosen
  exact snapshots, not a different latest metadata revision. An unavailable or incompatible selection
  blocks a new copy with Retry/Remove recovery; never substitute another revision. An unchanged existing
  receipt can still be retried/recovered, including backend receipt replay after the source is gone,
  with its original draft guard retained.

### Validation and operation identity

- Backend 409 `library_conflict` is generic: Workflow and Profile identity/name conflicts share the same
  error identity and provide no field target. Reveal the Workflow rename and every selected Profile
  rename, expanding selected review when choices are hidden. Do not claim to identify the culprit.
- Local selected-Profile validation can identify blank, over-200-character and duplicate fields. Compare
  duplicate proposed names exactly and case-sensitively; this is not a new backend naming policy.
- Preserve the existing payload: Workflow `name.trim() || null`, with raw Profile names untouched.
  Rename visibility is presentation state, not `fieldsChanged`; hiding/reopening fields must not reset
  the request ID. Unchanged retries reuse the receipt/request identity, and the synchronous write-ref
  guard prevents duplicate-click submissions before a render updates the pending state.

### Completion and closing

- Success closes the modal and leaves one parent-owned Added result, retaining the response, source
  Workflow family ID, captured destination Project name, returned names and original draft guard.
  Apply to Batch is explicit and uses the existing App callback and replacement confirmation, honoring
  Project, draft and execution flags. One returned Profile is automatically chosen for that later action;
  multiple Profiles require selection, and zero permits Workflow-only application. Copy never applies
  to Batch automatically or changes synchronization/backend Saved Batch/snapshot semantics.
- The body scrolls between a stable header and footer. Cancel and Add to Project are the footer actions,
  with only one primary button. Pending labels are Stop waiting and Adding...; closing stops browser
  waiting only, not the server transaction, and retains the receipt for an unchanged retry.
- Escape closes the open menu first, then the inspection/revision subview, then the main dialog. Closing
  or switching a subview aborts pending revision reads; late responses cannot overwrite another
  inspection or selected IDs. A known invalid revision continues to block Add after closing its subview
  until explicitly resolved, including accepting the previous compatible selection.
- Unsubmitted rename edits and modal-local deselection are not durable browser state. Closing an unsent
  modal does not persist that local deselection into the next opening. Explicit parent intent and restored
  receipts, including `profiles: []`, remain authoritative exceptions; this adds no unsaved-change guard
  or general persistence guarantee. The inline Added/pending-apply panel is not persisted across reloads;
  completed copies remain in the Project
  library. Browser working-session Recovery v4 is unchanged.

### Verification checkpoint

Prior cleanup verification passed: **911 frontend unit tests**, typecheck, lint, build, and **42 desktop/mobile
browser tests in each of Vite and built modes** after the Escape and pending-read fixes. Twelve targeted
desktop/mobile cases passed again with the final screenshots. No backend code changed.

The preserved baseline has 30 before screenshots. Final-after captures include 108 screenshots at
1440px, 1024px and 390px across both browser projects. Actual visual review covered the common
one-Profile state (approximately 459px tall on desktop), many Profiles and hidden selections, long names
and Rename fields, a real naming conflict, simulated loading failure, pending/recovered copy, and
Workflow-only eligibility. Header/footer remain reachable while the body scrolls. Theme sources and
fonts are unchanged. Keyboard checks cover menus, nested Escape, focus restoration and stale revision
reads without lost rename drafts or changed selections.

The existing non-fatal Vite chunk warning remains at approximately 556 kB. Generic backend conflict
responses still cannot identify a naming field, so the UI exposes names without assigning false blame.
Owner acceptance and overall BC-026 completion remain separate; no live ComfyUI or installation work
was performed.

Latest interaction follow-up verification:
**938 frontend unit tests**, typecheck, lint and production build passed; **46 desktop/mobile E2E tests
passed in each of Vite and built modes**. The approximately 560 kB chunk warning remains non-fatal. Visual
inspection at 1440px, 1024px and 390px covered single/multiple Profiles, long names, deliberate unchecked
selection, refresh failure, keyboard behavior and reachable footer actions. Main verification and
representative screenshot review also passed; this is not new human owner acceptance. No backend,
schema, format, release or installed-app changes are part of this pass.

## Remaining scope

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
