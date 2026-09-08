# BC-007: Project-wide Run and Result browser

Status: In Progress. Bounded browsing, visual workspace, and typed-provenance checkpoint implemented;
reported automated evidence is recorded below. Final owner acceptance remains pending.
Backlog: [BC-007](../BACKLOG.md#bc-007-project-wide-run-and-result-browser).

Current implementation: additive `/history/runs` and `/history/results` APIs, newest/oldest keyset
pagination, basic Run filters, SQL-clipped metadata, generation-scoped bookmarks, and forward migration
0003 are implemented. The visual checkpoint added `ProjectBrowser`,
`useProjectBrowserHistory`, `useWorkspaceNavigation`, App navigation/monitor integration, and native
inspection modals. That historical visual checkpoint passed 508 frontend tests, lint/typecheck/build, and twelve
desktop/mobile browser tests in each of Vite and built modes. Screenshots were reviewed; owner acceptance
is separate. Typed JSON provenance filters, bounded historical choices, frontend `HistoryFilters`, and
forward migration 0004 are now implemented. This is not complete faceting: filter-from-Details,
additional Run/Job sorts, logical Workflow/Profile and hash filters, multi-value OR, bounded diagnostic
detail browsing, generated thumbnails, filmstrip, and performance work remain; BC-007 is not Done.

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
form. The table describes the intended scope; current coverage and remaining work are distinguished below:

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

Search labels must describe the fields actually searched. Current filters combine with AND; the UI
supports one predicate per parameter key/type pair or Image Input slot and one value per identity field.
OR among multiple selected values within a dimension is planned, not implemented. Job predicates match the **same Job**, not different
Jobs in one Run. Missing parameters/slots are not Base; an override equal to a Base literal is still an
override. Preserve false, zero, empty string, numeric types, and historical identities without current
library records. Implemented choices are bounded historical searches, not complete or active-filter-conditioned
facets. Logical Workflow/Profile and hash filters remain planned; exact revision filters are implemented.

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

Owner feedback on this checkpoint was positive; final acceptance is separate from automated verification.

Implemented checkpoint details:

- Top navigation exposes Batch/Gallery/Runs. The Batch subtree and current-Run monitor remain mounted;
  inactive authoring is hidden. Drafts and valid in-memory Preview survive review navigation, and the
  compact monitor shows the actual frozen Project/Batch. Cold loads still invalidate Preview; recovery
  v4 is unchanged.
- URL query keys are `view`, `q`, `sort`, `run`, `batch`, `status`, `available`, and now JSON `filters`, with Back/Forward
  and in-memory per-view scroll restoration. URLs encode review mode/filters only, never Project
  selection or cursor pages. Project selection remains verified and guarded in Batch; an accepted
  Project switch clears review filters. Destination changes close open dialogs, including portals.
- Gallery retains one page of up to 48 Results; Runs retains up to 25 Runs. Previous/Next uses at most
  20 previous cursor bookmarks. Frozen-Run detail caching is capped at 20 entries, not all history.
  The browser no longer uses `listProjectRuns` or `getResults` for every Run. Selected Result Details
  still reads `getResults` for its selected owning Run and validates the artifact against frozen detail.
- Search covers Run names/notes, with newest/oldest order, status/availability controls, and removable
  Run/Batch chips. Runs offer Show Results, frozen Run Plan, and guarded Load Run as Batch with native
  unsaved-work confirmation. Typed advanced controls and historical choices are implemented as described
  below; complete facets remain unfinished.
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

Implemented:

- `history_filters` parses strict JSON `filters` (at most 16,384 characters), rejecting unknown fields,
  duplicate object keys, invalid shapes/types, unsafe integers, nonfinite floats, and invalid date bounds.
  Up to 8 parameter predicates and 4 Image Input predicates are accepted. Seed is `0..2^53-1`;
  parameter integer equality is bounded by absolute value `2^53-1`.
- Filters cover typed parameter equality/Base/Any override, seed, logical Prompt where frozen ancestry
  exists, exact Prompt/Workflow/Profile version IDs, source Saved Batch, Asset usage, Image Input
  slot plus Asset/Base, and inclusive-from/exclusive-before Run creation instants. Dates normalize to
  UTC; offset-free timestamps and date-only inputs mean UTC. Unknown dates do not match date bounds.
- All predicates use AND. Run queries require one qualifying Job; Result queries bind predicates to
  that Result's own Job, without multiplying artifacts. Missing parameters/slots are not Base, and
  `false`, `0`, empty strings, declared numeric types, and overrides equal to Base remain distinct.
- `history_choices` serves `/history/choices` for parameter, Prompt/revision, Workflow/Profile revision,
  Saved Batch, historical Batch, Image Input slot, and Asset identities. It reads only historical SQLite
  projections in a generation-consistent transaction. `q` is a literal Unicode-casefolded label/identity
  search of at most 200 characters, including available revision suffixes; limit is 1-50 (default 30).
  Labels/details are clipped to 256 characters, identities remain exact, and `has_more` requires
  narrowing search rather than cursor pagination. These are not conditioned facets or facet counts.
- Migration `0004_history_provenance` adds typed parameter rows, frozen Prompt/Run provenance, indexes,
  and generation-bound enrichment state. Historical revision metadata uses decimal TEXT to preserve
  valid v1 revisions beyond signed-64-bit integers. Applied migrations 0001-0003 and v1 files are unchanged.
- Nonempty advanced filters and all choices return `409 history_reindex_required` until enrichment
  matches the current generation. Successful reconciliation publishes both atomically; failed scans
  preserve prior state. Basic old-index browsing still works. GET requests never scan or repair history.
- Frontend `HistoryFilters` supplies Add filter, native typed editing, removable/editable chips,
  debounced bounded choice search, historical labels, and explicit reindex/retry guidance. It retains
  one predicate per parameter key/type pair or slot, replacing the existing predicate when edited.
  JSON `filters` round-trips through URL Back/Forward; invalid advanced URL intent shows an explicit
  error and blocks browsing until cleared. Project guards, drafts, Preview, and recovery v4 stay unchanged.

Remaining: filter-from-Details actions; additional deterministic Run/Job sorts; logical Workflow/Profile
and hash filters; multi-value OR within a dimension and complete facets. Do not infer missing historical
ancestry from today's libraries or assume Run numbers are globally unique.

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

Typed-provenance checkpoint verification passed: 1,326 backend tests, Ruff lint/format, mypy, and package
build; 618 frontend tests, lint/typecheck and production build; and 14 real-API desktop/mobile tests in
each of Vite and built same-origin modes. Narrow-screen screenshots were reviewed and a header overlap
was fixed with a tools-row bounding-box regression. Earlier checkpoint counts remain historical.
Final scope/owner acceptance is still pending.

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
