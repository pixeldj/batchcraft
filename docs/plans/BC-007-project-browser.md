# BC-007: Project-wide Run and Result browser

Status: In Progress. Bounded query foundation and visual checkpoint implemented and automated checks
passed; owner UI acceptance pending.
Backlog: [BC-007](../BACKLOG.md#bc-007-project-wide-run-and-result-browser).

Current implementation: additive `/history/runs` and `/history/results` APIs, newest/oldest keyset
pagination, basic Run filters, SQL-clipped metadata, generation-scoped bookmarks, and forward migration
0003 are implemented. The visual checkpoint adds `ProjectBrowser`,
`useProjectBrowserHistory`, `useWorkspaceNavigation`, App navigation/monitor integration, and native
inspection modals. The visual checkpoint passes 508 frontend tests, lint/typecheck/build, and twelve
desktop/mobile browser tests in each of Vite and built modes. Screenshots were reviewed; owner acceptance
is separate. Advanced provenance filters/facets, bounded
diagnostic detail browsing, generated thumbnails, and filmstrip remain upcoming; BC-007 is not Done.

## Outcome

Make historical review a visually appealing, image-first workspace. Users should be able to explore
past Results, find the experiment behind any image, and narrow their collection without losing the
Batch they are preparing or the Run they are monitoring.

Extend the existing filesystem-backed history, rebuildable SQLite projections, automatic freshness,
Run Plan, Result Details, and lightbox. Do not recreate those foundations or restore the retired
browser-session Batch Results gallery.

## Experience

Introduce three application destinations: **Batch**, **Gallery**, and **Runs**. The selected Project
provides context. Keep a compact current-Run indicator available while browsing, showing the actual
monitored Project/Batch if it differs from the draft. Gallery/Runs replace the bottom-of-page Project
History presentation, not current-Run Results.

### Gallery

- Show Results across the Project immediately, with natural aspect ratios and no forced cropping.
- Offer a compact image-size/density control and bounded Previous/Next pages rather than unbounded loading.
- Keep cards visually quiet. Reveal owning-Run context and inspection actions on hover/focus, with
  equivalent touch controls and no hover-only functionality.
- Reuse the lightbox with cross-Run keyboard navigation and clear ownership. Consider a compact
  filmstrip of already loaded images after the core interaction is reviewed.
- Restore selection, scroll, and focus on return from inspection. Store selection by stable Result
  identity, not the array index.
- Use short, reduced-motion-aware transitions. Do not rearrange images underneath an active inspection.
- Respect all appearance palettes through semantic tokens, including filters, focus, and overlays.
- Offer a contextual Filter gallery to this value action from supported provenance fields.

### Runs

- Use chronological rows with Run name/number, historical Batch, date, status, and Job/Result counts.
- Show Results navigates to Gallery filtered to that Run; View Run Plan opens frozen provenance.
- Load Run as Batch retains existing restoration restrictions and confirms replacement of unsaved work.
  It returns to Batch and requires Preview; it does not execute automatically.
- Retain Runs with no Results and non-image artifacts, unavailable execution, and degraded history.
- Keep confirmed-empty, no matches, and inaccessible/stale storage states distinct.

### Filters

Start with Run-name/notes search, newest/oldest sorting, Run/Batch identity, and execution status and
availability. Use an Add filter control and removable/editable chips instead of a permanently expanded
form. Complete the remaining BC-007 filters in the provenance checkpoint:

| Filter | Interaction |
| --- | --- |
| Run / historical Batch / source Saved Batch | Searchable historical names with stable identities |
| Status / date | Status choices, separate execution availability, date interval |
| Parameter | Key and Profile context, declared type, Base/override, typed value |
| Seed | Exact supported integer |
| Prompt | Logical Prompt and optional exact revision where ancestry is known |
| Workflow / Profile | Historical logical identities and revisions |
| Image Input | Slot key plus Asset, or Base workflow |
| Asset usage | Concrete Asset in any slot |

Search labels must describe the fields actually searched. AND combines filter dimensions; OR combines
multiple selected values within a dimension. Job predicates must match the **same Job**, not different
Jobs in one Run. Missing parameters/slots are not Base; an override equal to a Base literal is still an
override. Preserve false, zero, empty string, numeric types, and historical identities without current
library records. Facets should be bounded and derived from historical indexes, not mutable libraries.

## Delivery checkpoints

### 1. Bounded browsing foundation

- Add SQL-only paginated Project Run and Result endpoints; retain existing current-Run/detail APIs.
- Return compact metadata with exact Run/Job/artifact ownership and projected Result counts.
- Start with newest/oldest ordering, Run-name/notes search, Run/Batch, status, and availability filters.
- Normalize timestamps for ordering and keep unparseable historical dates in an explicit deterministic
  bucket rather than rejecting previously readable v1 files. Every sort has identity tie-breakers.
- Bind opaque, versioned keyset cursors to Project, query kind, filters, sort, and index generation.
- Read index state, page, and counts within one SQLite read transaction. Rotate generation and scan time
  with successful projection replacement; preserve both on failure.
- Allow old/unreconciled indexes to be read honestly with unknown scan state. GET must not scan storage.
- Reject an obsolete generation with an actionable refresh error; never combine mixed-generation pages.
- Replace projection deletion's per-Run SQL placeholders with Project-scoped deletion.
- Keep diagnostics available through existing history while a bounded diagnostic endpoint is developed.

The initial query sub-slice was additive. The visual checkpoint now switches the mounted browser to
these endpoints; old unpaginated APIs remain available for backward compatibility.

### 2. Visual workspace

- Introduce Batch/Gallery/Runs navigation and a persistent execution owner.
- Keep the authoring subtree mounted while inactive initially, preserving editor-local drafts as well
  as App-level form state. Inactive content must not receive focus; handle portaled dialogs explicitly.
- Give each gallery item Run ID, Job ID, artifact ordinal, and compact owning-Run context. Preserve API
  query order instead of sorting all Project Results as though they belonged to one Run.
- Build Gallery/Run pages against the bounded API, with lazy images and asynchronous decoding.
- Use URL query state for views/filters and Back/Forward; do not require unsupported SPA path fallback.
  A cross-Project URL must not silently replace a draft. Keep existing guarded Project switching.
- Preserve scroll, selection, and bounded page/detail caches. Show History updated rather than moving
  the collection during inspection. Discard old-generation continuations when refreshing.
- Repair modal focus containment, topmost Escape, background interaction, and focus restoration for
  shared inspection surfaces as they enter this workflow.

Owner visual review at this checkpoint precedes the complete advanced-filter UI.

Implemented checkpoint details:

- Top navigation exposes Batch/Gallery/Runs. The Batch subtree and current-Run monitor remain mounted;
  inactive authoring is hidden. Drafts and valid in-memory Preview survive review navigation, and the
  compact monitor shows the actual frozen Project/Batch. Cold loads still invalidate Preview; recovery
  v4 is unchanged.
- URL query keys are `view`, `q`, `sort`, `run`, `batch`, `status`, and `available`, with Back/Forward
  and in-memory per-view scroll restoration. URLs encode review mode/filters only, never Project
  selection or cursor pages. Project selection remains verified and guarded in Batch; an accepted
  Project switch clears review filters. Destination changes close open dialogs, including portals.
- Gallery retains one page of up to 48 Results; Runs retains up to 25 Runs. Previous/Next uses at most
  20 previous cursor bookmarks. Frozen-Run detail caching is capped at 20 entries, not all history.
  The browser no longer uses `listProjectRuns` or `getResults` for every Run. Selected Result Details
  still reads `getResults` for its selected owning Run and validates the artifact against frozen detail.
- Search covers Run names/notes, with newest/oldest order, status/availability controls, and removable
  Run/Batch chips. Runs offer Show Results, frozen Run Plan, and guarded Load Run as Batch with native
  unsaved-work confirmation. Full advanced-filter controls and historical facets are not implemented.
- Gallery uses natural-aspect lazy original images with asynchronous decoding and density controls,
  not generated thumbnails. Image selection uses Run/Job/artifact identity and navigation is limited
  to eligible images on the loaded page. A filmstrip is not implemented.
- Automatic background scans occur on review activation and publication/terminal history revisions
  while active, not filter/page/density changes or ordinary polls. Reindex Project explicitly repairs
  and adopts the refreshed first page. Empty pages automatically adopt newly discovered records.
  Refresh adopts the latest index at page one and drops old bookmarks without triggering a scan.
- An identical first page silently rebases generation/scan/continuation metadata while preserving item
  objects and image-failure state. Changed pages retain metadata with History updated pending Refresh;
  disable retained images/original links that the newly scanned bounded page cannot validate. Absence
  from that page is not deletion evidence. Failed scans retain known content with a warning. Diagnostic
  counts are shown, but diagnostic detail browsing remains upcoming.
- Shared Run Plan, Result Details, and ResultLightbox use native modal inspection via `useModalDialog`,
  with nested-dialog/topmost Escape handling, body scroll locking, and safe focus restoration. The
  browser's viewer and confirmation are native modals too. Automated verification and the imported-history
  follow-up passed; counts are recorded in BC-007. The owner has given positive checkpoint feedback;
  final acceptance of the complete backlog scope remains pending.

### 3. Provenance filters

- Extend projections with declared parameter types, explicit Base state, and typed value columns.
- Project optional Prompt ancestry, Workflow/Profile identities, hashes, and source Saved Batch identity
  from frozen snapshots. Never infer missing historical ancestry from today's libraries.
- Add required indexes and same-Job query predicates without multiplying Results through joins.
- Add bounded historical facet requests, date filters, typed controls, and filter-from-Details actions.
- Mark newly required projection enrichment incomplete until successful filesystem reconciliation;
  incomplete indexes must not return misleadingly authoritative empty filtered collections.
- Complete deterministic Run/Job ordering options without sorting by globally non-unique Run number alone.

### 4. Performance and polish

- Benchmark representative histories and large images. Page reads must scale with requested metadata,
  not trigger a filesystem Result-list request for every Run.
- Add aspect-preserving raster thumbnails in a bounded disposable filesystem cache, outside canonical
  Run directories. Key by verified source content plus rendition version/size; retain original downloads.
- Review the decoder dependency, source validation, pixel/frame/input limits, concurrency, cache budget,
  cancellation cleanup, and corruption handling before exposing thumbnail generation.
- Do not let a cache bypass missing execution/source checks or weaken safe artifact serving.
- Measure scan/lookup cost before introducing incremental indexing, watchers, or virtualization.
- Refine density, empty states, keyboard/touch use, and all-palette contrast and responsive layouts.

## Contracts and non-goals

Follow ADR 0003, ADR 0012, ADR 0015, and DEVELOPMENT's current persistence policy. Applied migration
bytes and valid v1 Project files stay unchanged; use contiguous forward migrations. SQLite history is
rebuildable, filesystem provenance remains authoritative, and no Result/thumbnail bytes enter SQLite.

Draft intent, observed execution, and historical inspection are separate state. In-app review must not
invalidate Preview or alter a Run. Cold loads still invalidate Preview under recovery v4. Do not store
Results, execution payloads, or historical membership in browser recovery. No frontend ComfyUI access.

Stars/exports stay in BC-015; Recreate Result and Exact Rerun stay in BC-006. Comparison tools, ratings,
saved filter collections, arbitrary query languages, and cross-Project concurrent drafts are not part
of this first implementation. A new routing/component framework is not assumed.

## Verification

- Backend: query boundaries, literal search, typed/Base matching, same-Job conjunction, multi-artifact
  identity, equal/offset/unknown dates, deterministic pages, malformed/mismatched/stale cursors,
  transaction consistency, failed-scan retention, migration preservation, and unchanged historical bytes.
- Frontend: view/Project/request races, draft and Preview retention, persistent execution ownership,
  cross-Run Details, loaded-page boundaries, refresh without jumping selection, and honest degraded states.
- Browser: fake-backed desktop/mobile, Vite and built same-origin, keyboard focus and nested dialogs,
  all palettes, non-overlay scrollbars, and narrow/intermediate widths. No live GPU/everyday data needed.
- Performance/security: no all-Run Result fan-out; bounded caches and queries; original artifact security
  retained; thumbnail decoder/cache tests if derivatives are introduced.
- Use DEVELOPMENT verification commands; update only BC-007 progress. Keep BC-007 In Progress until the
  full accepted scope and required automated/owner verification have succeeded.

Planning estimate: approximately 2-3 developer weeks for the core browser, or 3-5 weeks including the
complete provenance filters, secure thumbnails, visual polish, and verification. Reassess after the
bounded-query and visual checkpoints.
