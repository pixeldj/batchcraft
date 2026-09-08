# BC-007: Project-wide Run and Result browser

Status: In Progress. Bounded browsing, visual workspace, typed provenance, diagnostics, Filter Gallery
from Details, and initial SQL measurement have recorded verification. Scope is closed by the user decision
below; the functional audit and its fixes are complete. Final owner acceptance remains pending.
Backlog: [BC-007](../BACKLOG.md#bc-007-project-wide-run-and-result-browser).

Current implementation: additive `/history/runs` and `/history/results` APIs, newest/oldest keyset
pagination, basic Run filters, SQL-clipped metadata, generation-scoped bookmarks, and forward migration
0003 are implemented. The visual checkpoint added `ProjectBrowser`,
`useProjectBrowserHistory`, `useWorkspaceNavigation`, App navigation/monitor integration, and native
inspection modals. That historical visual checkpoint passed 508 frontend tests, lint/typecheck/build, and twelve
desktop/mobile browser tests in each of Vite and built modes. Screenshots were reviewed; owner acceptance
is separate. Typed JSON provenance filters, bounded historical choices, frontend `HistoryFilters`, and
forward migration 0004 are now implemented. The pass after `8b3ec48` adds bounded diagnostic browsing,
Filter Gallery from Details, and a reproducible SQL measurement script. Complete facets and the other
optional enhancements below are not completion requirements; BC-007 is not Done.

## Scope closure

The user approved removing accumulated plan extras from mandatory completion after reviewing gaps
against the original BC-007 requirements. Usage and functionality take priority: the user works mostly
over LAN and reports no slowness. Generated thumbnails and broader performance work are deferred until
a reported or measured issue justifies them. This is scope approval, not acceptance of the final UI.

The original backlog requirements remain unchanged. Their sorting alternatives are satisfied by
implemented newest/oldest ordering with deterministic Run ID ties and Job/artifact ordinal ordering;
additional dedicated Run/Job sort modes are deferred options, not missing stable ordering. The original
"Workflow and Profile version" wording is ambiguous about logical Workflow ancestry. Exact frozen
WorkflowVersion and ProfileVersion filters satisfy finding the frozen workflow for this scope; they do
not provide logical Workflow/Profile matching across revisions.

Logical Workflow/Profile across revisions, hash filters, multi-value OR, complete/conditioned facets,
filmstrip, and additional dedicated Run/Job sort modes are optional plan additions, not original
requirements. Keep these deferred options within BC-007 for scoped maintenance; no new backlog IDs,
dependencies, or implementation changes are required by this decision. Starred-state filtering remains
conditional on BC-015 as originally specified.

### Finite acceptance checklist

All six areas have implementation and checkpoint evidence below; final acceptance remains open.

- [ ] Project-wide history: every indexed Run/Result is reachable through bounded pages, including
  non-image and zero-Result history, without session-held membership or per-Run Result-list fan-out.
  Newest/oldest ordering retains deterministic Run ID ties and Job/artifact ordinal order.
- [ ] Required filters: typed parameter key/value and Base/override, seed, logical Prompt where frozen
  ancestry exists and exact PromptVersion, exact WorkflowVersion/ProfileVersion, Saved Batch/historical
  Batch, Run status/date, Image Input slot plus Asset/Base, and Asset in any slot. Job predicates match
  the same Job (the Result's own Job); missing values, false, zero, empty strings, and types stay distinct.
- [ ] Image-first inspection: lazy originals, density controls, page-local cross-Run lightbox, frozen
  Run Plan and Result Details retain correct ownership and keyboard/touch access. Filter Gallery from
  Details preserves unrelated AND predicates and reports cap errors without truncation.
- [ ] Safe degraded history: corrupt/missing Runs do not hide healthy history; unavailable execution,
  stale storage, no matches, and confirmed empty history remain distinct. Bounded diagnostics expose
  safe summaries; Refresh reads the index and Reindex Project is explicit repair.
- [ ] Historical authority: typed and Image Input indexes retain identities/order and rebuild from
  filesystem Run/execution artifacts. SQLite stores no Result bytes, absolute paths are not portable
  identity, stale projections cannot authorize unsafe originals, and frozen files/migrations remain intact.
- [ ] Workspace continuity: review preserves draft/valid in-memory Preview and execution ownership;
  URL Back/Forward restores view/filters without switching Project or persisting cursor pages. Guarded
  Project switching and cold-load Preview invalidation remain unchanged. Required regressions remain
   meaningful; confirmed audit fixes are verified before final owner sign-off.

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
- The Project image viewer has one compact toolbar: Previous, page-local image counter, Next,
  Image Details, and Close. It has no visible title row; its accessible dialog name remains.
  The uncropped image fills the available space and links to the original in a new tab. A compact
  caption retains ownership, with bounded scrolling for long names. Keyboard navigation is unchanged.

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
form. The table describes the scoped, implemented filter coverage:

| Filter | Interaction |
| --- | --- |
| Run / historical Batch / source Saved Batch | Searchable historical names with stable identities |
| Status / date | Status choices, separate execution availability, date interval |
| Parameter | Key and Profile context, declared type, Base/override, typed value |
| Seed | Exact supported integer |
| Prompt | Logical Prompt and optional exact revision where ancestry is known |
| Workflow / Profile | Exact frozen WorkflowVersion and ProfileVersion identities |
| Image Input | Slot key plus Asset, or Base workflow |
| Asset usage | Concrete Asset in any slot |

Search labels must describe the fields actually searched. Current filters combine with AND; the UI
supports one predicate per parameter key/type pair or Image Input slot and one value per identity field.
OR among multiple selected values within a dimension is optional and deferred. Job predicates match the **same Job**, not different
Jobs in one Run. Missing parameters/slots are not Base; an override equal to a Base literal is still an
override. Preserve false, zero, empty string, numeric types, and historical identities without current
library records. Implemented choices are bounded historical searches, not complete or active-filter-conditioned
facets. Logical Workflow/Profile across revisions and hash filters are optional and deferred; exact revision filters are implemented.

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
- Keep diagnostics available through the bounded diagnostic endpoint described below; the legacy
  history API remains available but is not required for diagnostic browsing.

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
  below; complete facets are optional and deferred.
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
  counts are shown, and header Diagnostics now opens the bounded dialog described below.
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

Filter Gallery from Details is now implemented through an optional `ResultDetailsDialog` callback.
Actions derive parameter Base/typed equality, seed, Prompt revision, Image Input slot Base/Asset, and
Asset-in-any-slot intent from the selected frozen Job, and Workflow/Profile revision IDs from its frozen
snapshot where available. They preserve unrelated AND predicates and replace only the matching
parameter key/type, slot, or scalar field. Merged-filter validation enforces the existing caps; failure
shows an error in Details without truncation or navigation. Success closes Details and image inspection,
clears the cursor, and changes Gallery/query together in one navigation operation. Current-Run Details
without the optional callback remains unchanged.

Standalone `HistoryDiagnostics` is wired to the ProjectBrowser header regardless of counts or filter
matches. Its native dialog reads `/history/diagnostics` in scan order, with one 25-row page and at most
20 previous bookmarks. The SQL-only API defaults to 25 rows (maximum 100); generation-bound cursors,
rows, and scan metadata share one transaction. No filesystem read or provenance enrichment is required.
Public summaries use safe approved messages and clipped historical names, not raw diagnostic prose or
paths. Explicit Refresh only GETs the first indexed page; a generation mismatch asks for Refresh rather
than mixing pages. Reindex Project closes the dialog and invokes the browser owner's explicit repair
action. Opening or paging diagnostics does not scan storage; empty diagnostics do not prove fresh health.

Optional and deferred: additional dedicated Run/Job sorts; logical Workflow/Profile across revisions
and hash filters; multi-value OR within a dimension and complete facets. Do not infer missing historical
ancestry from today's libraries or assume Run numbers are globally unique.

### 4. Performance and polish

This formerly planned checkpoint is not a BC-007 completion gate. The user approved deferring generated
thumbnails and broader performance work until a reported or measured issue warrants it. Existing
correctness, artifact security, bounded-state, accessibility, and responsive-layout regressions remain
required. If performance work is reopened, retain these constraints:

- Extend the initial synthetic SQL baseline below to representative histories, scans, HTTP, and large
  images. Avoid per-Run filesystem Result-list fan-out; current bounded output does not imply
  page-proportional SQL work.
- Add aspect-preserving raster thumbnails in a bounded disposable filesystem cache, outside canonical
  Run directories. Key by verified source content plus rendition version/size; retain original downloads.
- Review the decoder dependency, source validation, pixel/frame/input limits, concurrency, cache budget,
  cancellation cleanup, and corruption handling before exposing thumbnail generation.
- Do not let a cache bypass missing execution/source checks or weaken safe artifact serving.
- Measure scan/lookup cost before introducing incremental indexing, watchers, or virtualization.
- Target further polish to confirmed usage issues rather than an open-ended completion requirement.

Initial reproducible measurement: from `backend/`, run
`uv run python tests/db/check_history_browser.py --repeats 20 --explain`.
The script creates only its own temporary SQLite database and exercises production query functions,
with correctness checks for complete identity/order, typed same-Job predicates, choices, and diagnostics.
It uses 200 Runs, 10,000 Jobs, 20,000 Results, three parameter dimensions, and 200 diagnostics.
Guarded correctness reads reject Project filesystem and legacy-list access. There are no timing
assertions, image bytes, configured data paths, or new dependencies.

Recorded baseline: M4 Max, Python 3.14.7, SQLite 3.53.1, 20 repeats. Warm OS cache, fresh connections
per call, sequential reads; p50 is median and p95 is nearest rank.

| SQL query | p50 (ms) | p95 (ms) |
| --- | ---: | ---: |
| Newest Result page | 29.73 | 29.94 |
| Middle Result page | 35.90 | 36.94 |
| Newest Run page | 0.83 | 0.92 |
| Result parameters + seed | 10.05 | 10.18 |
| Parameter choices | 10.62 | 10.82 |
| First diagnostic page | 0.68 | 0.84 |

The SQLite file was 20.96 MiB. Peak process RSS was 63.33 MiB, including imports, seeding, and full-identity
verification, not per-page memory. These timings exclude HTTP/DTO serialization, image network/decode,
filesystem reconciliation, and concurrent writes. Query plans show temporary sorting B-trees for Results
and Project-wide choice work: bounded output is not page-proportional work or a latency guarantee.
Keep this observational baseline, not a release gate, distinct from deferred end-to-end, scan, image,
and performance/polish work. It neither proves end-to-end speed nor mandates a new dependency or cache.

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
Final owner acceptance remains pending. The functional audit found no missing original requirement
within the closed scope. It identified two bugs, now fixed: URL parsing rejects duplicate decoded JSON
keys and non-integer seed/integer-parameter tokens before they can silently change query intent, and
Diagnostics now distinguishes missing backend support from retryable read failures with restart guidance.

Functional-audit verification: 679 frontend tests, lint/typecheck and build passed. Full Vite and built
browser suites each passed 14 tests. An earlier Vite mobile execution-completion assertion timed out;
the full Vite rerun and three focused mobile repeats passed without changing timeouts or assertions.
The original timeout remains unexplained, not claimed fixed. In the captured repeats, two-Job backend
execution took about 3.1 seconds and the UI observed completion in about 4.3 seconds. Backend code is
unchanged since the recorded 1,330-test checkpoint.

Post-`8b3ec48` diagnostics/Details checkpoint verification passed: 1,330 backend tests, Ruff lint/format,
mypy and package build; 642 frontend tests, lint/typecheck and production build; and 14 real-API
desktop/mobile tests in each of Vite and built same-origin modes. Diagnostics and Details screenshots
were reviewed, including the 320px dialog layout. Earlier checkpoint evidence remains unchanged.

- Backend: query boundaries, literal search, typed/Base matching, same-Job conjunction, multi-artifact
  identity, equal/offset/unknown dates, deterministic pages, malformed/mismatched/stale cursors,
  transaction consistency, failed-scan retention, migration preservation, and unchanged historical bytes.
- Diagnostics: generation-bound paging, unenriched/unknown index state, no filesystem reads, safe
  summaries and name clipping, header access independent of counts, GET-only Refresh, and explicit repair.
- Details filters: frozen values, unrelated AND retention, same-key replacement, cap errors without
  truncation, atomic URL navigation and dialog closure, and unchanged callers without a callback.
- Frontend: view/Project/request races, draft and Preview retention, persistent execution ownership,
  cross-Run Details, loaded-page boundaries, refresh without jumping selection, and honest degraded states.
- Browser: fake-backed desktop/mobile, Vite and built same-origin, keyboard focus and nested dialogs,
  all palettes, non-overlay scrollbars, and narrow/intermediate widths. No live GPU/everyday data needed.
- Performance/security: no all-Run Result fan-out; bounded caches and queries; original artifact security
  retained; thumbnail decoder/cache tests if derivatives are introduced.
- Use DEVELOPMENT verification commands; update only BC-007 progress. Keep BC-007 In Progress until the
  full accepted scope and required automated/owner verification have succeeded.

The earlier 2-3 week core / 3-5 week expanded planning estimate included optional work and is not a
remaining-work commitment after scope closure.

## Owner acceptance

Use fake-backed development/test history per `LOCAL_INSTANCES.md`; everyday data or live ComfyUI requires
explicit authorization. These steps are pending, not evidence of final UI acceptance:

1. Browse Gallery and Runs across multiple pages in newest and oldest order; check stable Run/Job
   ownership, zero-Result Runs, and non-image history.
2. Exercise the required filters in the finite checklist, including typed Base/override and combined
   same-Job conditions; find a frozen workflow with exact Workflow/Profile version filters.
3. Inspect originals across Runs, open Run Plan and Details, and apply Filter Gallery while retaining
   unrelated filters; check keyboard/touch use and return focus on desktop and mobile.
4. Inspect degraded-history fixtures and Diagnostics; distinguish stale/unavailable from empty, use
   GET-only Refresh and explicit Reindex Project, and confirm healthy history stays usable.
5. Return to Batch with draft and valid Preview intact, check monitored ownership and URL Back/Forward,
   then confirm guarded Project changes and fresh Preview on cold load.
6. Review recorded regression evidence, audit fixes, and the intermittent browser-test caveat; record owner
   sign-off against this finite scope before marking BC-007 Done. Do not add deferred extras as gates.
