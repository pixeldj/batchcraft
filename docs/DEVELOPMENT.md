# Development Guide

## Purpose

This document defines the expected development workflow for **batchcraft**.

The project has entered production application development. The backend has a thin FastAPI boundary,
the first React browser workflow is implemented, and SQLite provides migrations, Projects, the
immutable-version Prompt, Workflow, and Workflow Profile libraries, Saved Batches, and named Image
Input slots.

## Supported Development Environment

Initial development target:

- development host: macOS;
- shell: normal macOS terminal environment;
- Python tooling: `uv` with Python 3.13 or newer;
- Node tooling: Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` with npm for the locked dependencies;
- generation host: ComfyUI on a Windows workstation reachable over the local LAN;
- source control: Git.

Do not make the production architecture depend on a particular terminal, IDE, or coding-agent harness.

Recommend Node 24.15+ in the 24.x line. The current everyday installer requires a Git clone and existing
destination parent directories, and creates a linked worktree rather than a standalone app bundle.
See `LOCAL_INSTANCES.md` for setup and the isolated fake-backed development launcher.

## Coding Agents

The repository is intended to work well with tools such as Pi and OpenCode.

Before substantial work, agents must read:

1. `AGENTS.md`;
2. relevant documents under `docs/`;
3. relevant ADRs;
4. existing implementation and tests in the affected area.

Agents should plan before implementing non-trivial features and should avoid broad opportunistic refactors while completing a focused task.

## Persistence policy

For concurrent everyday use and development, follow [`LOCAL_INSTANCES.md`](LOCAL_INSTANCES.md).
`./dev.command` uses isolated persistent sandbox data and simulated ComfyUI. Playwright owns temporary
test data and separate ports; neither launcher inherits the everyday database or generation host.

Treat user SQLite databases and valid candidate-v1 Project files as durable local data. Keep applied SQL
migration files byte-stable and make user-database schema changes only through the next contiguous
forward migration. Unsupported migration history, durable record versions, and malformed data fail
closed. The application must not silently delete, reset, or rewrite user databases or Project files.

Historical SQLite tables are non-authoritative projections and may be replaced atomically from
filesystem truth. Temporary file-backed test databases remain disposable. Browser working-session
recovery is versioned convenience state; unsupported or malformed records may reset to an empty session.
ADR 0012 remains Proposed until the full cross-instance release gate passes.
BC-025 tracks public v1 release hardening and that still-unpassed gate in
`V1_CROSS_INSTANCE_ACCEPTANCE.md`. Exact Rerun is deferred beyond v1.

The API resolves only trusted configured storage roots at `Settings` construction, including macOS
`/var` aliases used by `tools.runtime`'s `TemporaryDirectory`. Filesystem helpers expect canonical
anchors and reject symlinks within the store; never fix a failed artifact read by resolving that
untrusted artifact pathname. Regression tests must include the runtime's unresolved temporary-root
convention, since pytest's `tmp_path` is already canonical on macOS. This normalization changes no
registered filesystem key or durable relative path.

Read admission tests must exercise browser-sized bursts, not just overload rejection. Bulk reads allow
four active requests and eight FIFO waiters; execution-detail polling independently allows two active
requests and four waiters. Both queues have a five-second acquisition deadline. Waiters allocate no
artifact tempfile or read worker. Preserve cancellation/grant race tests and active-slot retention until
stream cleanup finishes. The opt-in `tests/api/check_artifact_browser.py` also checks six simultaneous
real PNG downloads without retries against the fake-backed built frontend; it uses temporary data and
refuses an occupied test port, so run it separately from other browser suites.

## Repository Shape

The production Python package now lives under `backend/`. The remaining source layout is intentionally not frozen before its implementation requires it:

```text
batchcraft/
├── AGENTS.md
├── README.md
├── docs/
├── prompts/
├── frontend/
├── backend/
├── spikes/
└── tests/                  # only if useful outside component-specific tests
```

Do not create directories merely to match this diagram. Add them when a real implementation requires them.

## Development Phases

The phase notes below record the formats and policies in force at each milestone. Their old baseline
replacement and reset instructions are historical, not permission to reset current user data. The
persistence policy above and `FILE_FORMAT.md` supersede those instructions and version numbers.

### Phase 0: design foundation

Completed.

Goals:

- document product scope;
- define domain semantics;
- define prompt-variable behavior;
- define Batch compilation;
- define durable Run artifacts;
- record initial architecture decisions.

### Phase 1: ComfyUI integration spike

Completed. The disposable spike remains under `spikes/comfyui-client/` and must not become production integration code.

The disposable client lives under:

```text
spikes/comfyui-client/
```

The spike proved the actual Mac-to-Windows network and ComfyUI API assumptions before production integration code was designed.

Acceptance criteria are defined in `docs/COMFYUI_INTEGRATION.md` and included:

- connectivity check;
- input image upload;
- workflow mutation;
- prompt submission;
- prompt ID capture;
- execution monitoring;
- result/history retrieval;
- output download to the Mac.

The spike is exploratory code. Do not grow it into the production backend by accident.

### Phase 1.5: pure domain compiler

Completed.

Production code under `backend/` contains immutable domain inputs, logical compiled-plan outputs, validation, prompt resolution, deterministic expansion, and compiler previews.

The compiler intentionally excludes Run/Job execution identity, timestamps, persistence, filesystem operations, frameworks, networking, scheduling, and ComfyUI integration.

### Phase 1.75: Run filesystem store

Completed.

Convert a `CompiledRunPlan` into a durable Run representation without introducing SQLite, scheduling, FastAPI, React, or production ComfyUI integration.

This phase should establish:

- Run and Job execution identity;
- stable internal filesystem identities independent of editable display names;
- canonical `manifest.json`;
- secondary `manifest.csv`, emitted during publication but optional during later loading;
- base workflow and Workflow Profile snapshots;
- immutable content-addressed Project assets;
- staging and atomic Run publication;
- persisted Run reconstruction without SQLite.

Filesystem persistence remains straightforward and specific to the documented batchcraft Run format. No generalized repository or storage abstraction was introduced.

### Phase 1.9: production ComfyUI adapter

Completed.

Production code under `backend/src/batchcraft/comfyui/` contains pure Workflow Profile mapping plus typed async operations for system information, input upload, prompt submission, prompt-correlated WebSocket events, history reconciliation, output discovery, and artifact download.

This boundary intentionally excludes scheduling, retries, mutable execution-state persistence, Run filesystem mutation, FastAPI, React, and SQLite. Ordinary tests use mocked transports and do not require a live GPU host.

### Phase 1.95: sequential Run execution

Completed.

Production code under `backend/src/batchcraft/execution/` persists `batchcraft.execution` v1 mutable state, executes one published Run with queue depth one, falls back from advisory WebSocket failure to bounded history reconciliation, and writes deterministic Results under the Run's `outputs/` directory. All prerelease execution formats are intentionally unsupported; there are no compatibility loaders.

This layer accepts a narrow cancellation-control boundary for submission admission and stop checkpoints, but excludes cancellation-intent persistence itself. It also excludes global Run selection, concurrent execution, priorities, retries, automatic recovery, SQLite, FastAPI, React, and result review UI. Normal tests use a deterministic ComfyUI fake.

### Phase 2: first vertical application slice

Completed for the backend application boundary. Without React or SQLite, the current API checks ComfyUI status, accepts a complete ephemeral Batch snapshot, previews deterministic Jobs, creates a frozen Run, durably discards a pristine unstarted Run, starts queue-depth-1 execution, exposes execution polling, and serves persisted Result metadata and files.

Do not build the full prompt library, advanced search, elaborate ratings, multi-server scheduling, or other roadmap features before this path works reliably.

The slice accepts an ephemeral complete Batch request for preview and Run creation. It does not define another durable Batch format before SQLite. Run lookup narrowly scans complete published Run directories, and long-running execution uses retained in-process tasks while `execution.json` remains authoritative. Start and discard tests exercise the shared registry lock, exact pristine-state eligibility, restart durability, terminal cancellation, and preservation of frozen Run files.

### Phase 2.1: first React workflow

Completed.

Production code under `frontend/` provides one screen for ComfyUI status, ephemeral Batch editing,
Project image import and backend-compiled Job preview,
durable Run creation, repeated terminal Run creation, execution start and polling, non-cropping
Result rendering, and originally a tab-scoped Batch Results gallery across session Runs. The scoped
Results cleanup retires that gallery in favor of current Results and Project History; see the current
Frontend Conventions below. The browser uses only
the FastAPI endpoints documented in `docs/API.md`.

Batch editing includes an ordered repeatable list of immutable PromptVersion snapshots. The current
Project's persistent Prompt library opens as a searchable modal workspace with exact template previews,
direct Prompt creation, lazy version history, immutable revision creation, and exact-revision
duplication into a new logical Prompt. Inspecting, searching, creating a revision, and duplicating do not
change the Batch selection. Explicit additions, removals, and ordering changes invalidate Preview; exact
library reconciliation does not. The browser session restoration stores library linkage and exact
immutable snapshots without UI keys. Named Image Input binding and browser session v10 supersede the
original picker and session shape in Phase 2.4.

PromptVersion API responses derive ordered placeholder names with the same parser used by compilation.
The frontend combines those lists in selected PromptVersion order and offers one explicit action for
missing Variable Bindings. Derived placeholder metadata is neither SQLite state nor browser-session
authority. Saved Batch loads and recovered drafts remain unchanged until the user creates the missing
zero-value bindings.

This phase does not add durable editable Batch persistence, Reference Collections, asset deletion,
Run history, recovery, cancellation, retries, ratings, advanced filtering, or visual Workflow
Profile mapping.

### Phase 2.2: SQLite foundation, Projects, and Prompt library

Completed. Production code under `backend/src/batchcraft/db/` uses stdlib `sqlite3`,
one connection per operation, explicit checksummed SQL migrations, and feature-specific Project and
Prompt stores. FastAPI migrates before serving requests. Project creation publishes `project.json`
before SQLite insertion, and explicit adoption recovers valid owner bindings or binds an explicitly
selected ownerless asset directory using a user-supplied Project ID and name.

The frontend consumes the Project-scoped library without changing the compiler contract. It preserves
ordered concrete PromptVersion snapshots, loads history lazily, and keeps unavailable or unverifiable
snapshots detached instead of silently substituting another version. This phase does not persist
Batches, index filesystem Runs or Assets, or add scheduler state.

### Phase 2.3: Workflow and Workflow Profile libraries

Completed. SQLite stores Project-scoped logical Workflows and Workflow Profiles plus immutable,
canonical, hashed versions. Each ProfileVersion targets one exact WorkflowVersion and contains a
Run-compatible profile snapshot. Preview and Run creation still receive complete effective snapshots;
library IDs never replace frozen Run provenance.

At this phase the frontend session schema was version 10. It used the Saved Batch selector, preserved exact
Workflow/Profile snapshots alongside optional library linkage, stores canonical Variable Bindings,
ordered named Image Input bindings, and the `batch_snapshot` required by Preview and Run creation. The selector lists active SQLite
Saved Batches keyed to the verified Project; selection loads the Batch's stored prompt, variable,
image, seed, and workflow intent. Manual Batch identity fields are no longer editable. Deliberately selecting an
incompatible WorkflowVersion clears the effective Profile snapshot and blocks Preview until a
compatible ProfileVersion is selected. The logical Profile remains selected and visible. The visual
Profile mapper derives nodes and inputs from the selected immutable API-format WorkflowVersion, keeps
the generated Profile JSON as its source of truth, and exposes raw JSON read-only. It can prefill the
latest active prior mappings for review, retain valid targets, and mark missing targets before creating
a new immutable version under the same logical Profile. Switching back restores an existing compatible
version. Unavailable or integrity-mismatched library records detach without rewriting their exact
snapshots.

The Batch editor presents the selected Workflow and compatible Profile as one compact `Workflow Setup`.
Exact Workflow and Profile revision selection remains available under `History`; newer library revisions
are shown as context and never replace a Saved Batch selection automatically. `Edit Workflow` and
`Edit Profile` append immutable revisions, and saving a Workflow revision opens the existing Profile
mappings for review against the new target. `Duplicate Workflow` copies the exact selected
WorkflowVersion into v1 of a new logical Workflow and can copy the exact selected ProfileVersion
mappings into v1 of a new logical Profile. Suggested Workflow and Profile names are editable and
collision-safe. If optional Profile copying fails validation, the new Workflow remains selected and the
visual Profile mapper opens with the copied mappings for repair.

### Phase 2.4: Named Image Input Slots Pass 2A

Completed. ProfileVersions keep the three required core mappings and add an ordered `image_inputs`
array with zero or more `{key, label, node_id, input_name}` entries. The Profile Builder supports add,
remove, move up, move down, editable labels, and target repair. It derives each stable key from the
first label. Batch editing reconciles ordered bindings from the selected Profile. Preview, Run Plan,
and Result Details display the named slots.

Batch/API/Saved Batch bindings use ordered `{slot_key, values:[asset_id|null]}` entries. At this phase,
Pass 2A required one effective value per Profile slot, and `null` preserved the Base workflow value. The
compiler stores ordered `resolved_image_inputs` on every Job without adding an image dimension. The
executor uploads selected slots in deterministic Profile order and the adapter maps them through
Profile metadata. Multi-value and Cartesian semantics were deferred at this phase and completed in
Phase 2.5; zipped, row-linked, and collection-link semantics remain deferred.

This change establishes manifest v6, Batch snapshot v3, and browser session v10. Run v1, execution v2,
and asset v1 remain current. The consolidated `0001_initial.sql` baseline was replaced. Existing
development databases, old Runs, and old browser drafts are unsupported. Recreate the database
manually after inspecting local data; batchcraft never deletes or rewrites it automatically.

### Phase 2.5: Named Image Input Slots Pass 2B

Completed. Every Profile Image Input slot accepts one or more ordered Project Asset or Base workflow
alternatives. Slots form independent Cartesian dimensions between prompt variables and seeds. The
rightmost slot and then seeds vary fastest. Each compiled Job and executor input remains fully resolved
to one `asset_id | null` per slot.

At completion of this phase, manifest v6, Batch snapshot v3, browser session v10, and the SQLite schema remained current
because their arrays and normalized value rows already represent ordered alternatives. No database or
browser-state reset was required. Zipped, linked, random, collection, and file/video semantics remain
deferred. Fixed generic parameters were completed in Phase 2.6.

### Phase 2.6: Generic Workflow Parameters Pass 3A

Completed end to end. Workflow Profiles require an ordered `parameters` array with stable keys,
literal targets, and string, integer, float, or boolean types. Executable Batches require one typed
scalar or Base workflow value per parameter. Parameters are copied into every Job without changing
Cartesian expansion, and the executor forwards only concrete overrides.

The Profile Builder infers compatible types from literal workflow values and preserves copied definitions
for repair. The Batch editor provides Base/Override controls with strict typed request construction.
Preview, Run Plan, and Result Details display resolved values. Browser sessions use v11.

This change establishes manifest v7 and Batch snapshot v4. Run v1 and execution v2 remain current.
The consolidated `0001_initial.sql` baseline was replaced with normalized Saved Batch parameter rows.
Existing development databases and Runs are unsupported and must be inspected and recreated manually;
batchcraft never deletes or rewrites them automatically. Browser v10 drafts reset automatically.
Parameter sweeps remain deferred.

### Phase 2.7: Generic Workflow Parameters Pass 3B-1

Completed end to end. Every Profile parameter now accepts one or more ordered, unique typed scalar or
Base workflow alternatives. Parameters form independent Cartesian dimensions in Profile order between
Image Input slots and seeds. Every compiled Job, executor input, manifest Job, and Result provenance
record remains fully resolved to one scalar or Base state per parameter.

The Batch editor supports adding, removing, and reordering typed alternatives while toggling Base
workflow independently. Profile reconciliation preserves same-key, same-type alternatives. Run Plan
shows frozen Batch alternatives and concrete Job choices; Result Details shows human labels and resolved
values without concatenating technical keys. Browser sessions use v12.

Manifest v7 and Batch snapshot v4 remain current because their binding arrays already represent ordered
alternatives and Job records already represent scalar choices. The consolidated `0001_initial.sql`
baseline now permits multiple ordered parameter-value rows. Existing Pass 3A development databases have
unsupported migration history and must be inspected and recreated manually; batchcraft never deletes
or rewrites them automatically. Browser v11 drafts reset automatically. Numeric ranges, enums,
`/object_info`, LoRA discovery, and linked or zipped parameter dimensions remain deferred.

### Phase 2.8: Generic Workflow Parameters Pass 3B-2

Completed end to end. Integer and float parameter bindings may preserve numeric Range intent with exact
decimal-text Start, End, Step, and independent Base workflow inclusion. One backend domain materializer
uses scaled-integer arithmetic to emit explicit typed values before the existing Pass 3B-1 compiler.
Start is included, End appears only when reached exactly, descending ranges require negative Step, and
each Range is limited to 10,000 numeric values. Compiled Jobs, executor state, workflow preparation,
manifest Jobs, and Results remain scalar-only.

Saved Batches reopen in their original Values or Range mode. Run Plan shows compact frozen Range intent
while concrete Jobs and Result Details show exact scalar values. The Batch Parameters editor reuses
`ConfigurationSection`; collapse state is local UI state and neither changes Batch semantics nor
invalidates Preview. Tab-scoped browser session v13 was the current refresh-only format for this phase.

This change establishes Batch snapshot v5 and replaces the consolidated SQLite baseline with
mode-aware parameter intent storage. Manifest v7, CSV, Run v1, and execution v2 remain current. Existing
development databases, snapshot-v4 Runs, and browser v12 drafts are unsupported; databases must be
inspected and recreated manually, while browser drafts reset automatically. Enums, random parameter
values, linked or zipped dimensions, `/object_info`, and LoRA discovery remain deferred.

### Phase 2.9: Durable working-session recovery

Working-session recovery v1 replaces tab-scoped browser session v13. One strict localStorage record
stores editable Batch intent, the selected Project and optional Saved Batch revision pointer, the current
Run ID, and ordered unique session Run IDs. Linked Workflow/Profile JSON is reconstructed from stable
version IDs; detached JSON remains draft state. Old sessionStorage data is not read or migrated.

Every cold load starts with Preview invalid. Run, execution, and Result state is fetched from FastAPI.
Running Runs enter the normal polling hook without another execution start. Missing or cross-identity
Run pointers are pruned independently. This phase adds no backend endpoint, SQLite migration, Run index,
Project-wide history, or executor restart recovery.

This phase describes the original recovery implementation. The Results cleanup amendment to ADR 0010
retires session gallery membership while retaining the strict v4 reader and independent current-Run
monitor recovery. It supersedes the gallery restoration and identity-pruning behavior described here.

### Phase 2.10: Stop after current Job

The backend/core portion of BC-003A is implemented. SQLite stores idempotent `after_current_job`
intent, the application layer serializes durable request acknowledgement against Job submission
admission, and execution format v1 records the resulting Run and Job outcomes. The executor stops
before another submission when possible, otherwise lets the already admitted Job reach an honest
terminal or blocked state and ingests successful Results before cancelling the remaining unsubmitted
Jobs. It never interrupts ComfyUI or clears its queue.

FastAPI exposes `POST /api/runs/{run_id}/cancel` and merges SQLite request metadata with filesystem
execution outcome in Run and execution read models. The execution package remains independent of
SQLite. The frontend confirms the action, reconciles ambiguous responses through execution polling,
shows durable request and stopping states, restores them after a cold load, preserves Result review, and
unlocks editing only after a terminal outcome. Automated verification and live owner acceptance are
complete. This pass does not add executor restart recovery, retries, a durable scheduler, or remote
interruption.

### Phase 2.11: Named Runs and human-readable Run folders

BC-017 adds optional immutable Run name and notes provenance. Published Run directories now use
`NNN-<slug>`, with deterministic ASCII slugging and `run` as the unnamed fallback. Run ID remains the
true identity; discovery narrows candidates by directory convention, lookup matches persisted Run ID,
and loading verifies the directory against the frozen filesystem key.

This change historically established `run.json` v2 and manifest v8. Batch snapshot v5, execution v3,
and browser working-session recovery v1 were current at that phase. Existing development `run-NNN` directories,
`run.json` v1, and manifest v7 Runs are unsupported and must be inspected and recreated manually when
needed. batchcraft does not migrate, rename, rewrite, or delete them automatically.

### Phase 2.12: Linked Parameter Sets / Presets

BC-001 adds Batch-owned named Presets that replace two or more independent parameter bindings with one
ordered row dimension. The compiler inserts a linked set at its earliest Profile member, skips later
members as independent axes, and emits complete scalar/Base parameters plus selected-row provenance.
The executor and ComfyUI adapter remain unchanged and receive scalar overrides only.

This change historically established Batch snapshot v6, manifest v9, CSV resolved-set provenance,
browser working-session recovery v2, and normalized linked-set tables in the consolidated SQLite baseline.
`run.json` v2 and execution v3 were current at that phase. Existing databases, snapshot-v5/manifest-v8 development
Runs, and recovery v1 drafts are unsupported. They require manual inspection and recreation when needed;
batchcraft never migrates, rewrites, or deletes them automatically.

### Phase 2.13: V1 format consolidation

BC-019 resets the canonical Project filesystem records to independently named candidate-v1 formats.
Project, Batch, Asset, Run, manifest, Batch snapshot, execution, raw snapshot descriptor, and CSV
contracts each begin at format version 1. Canonical batchcraft JSON records include producer application
metadata; raw workflow payloads remain directly usable and are identified by hash-bound manifest
descriptors. Each Job freezes a generated output prefix bound to Run and Job identity. The emitted-byte
fixture under `backend/tests/fixtures/v1_project/` locks the complete current record set. This phase does
not add import, historical indexing, detached resources, or the cross-instance release gate.

### Phase 2.14: Project import and historical reindex

BC-020 is complete. The backend imports an owned v1 Project by path-safe immediate-child filesystem key,
scans Project/Batch owners, Assets, Runs, execution, and Results without changing Project files, and
atomically replaces one Project's rebuildable historical projection. Ownerless adoption remains a
separate explicit identity mutation.

Valid Runs are indexed as verified or degraded. Invalid Runs are isolated with diagnostics. Missing or
invalid execution is explicit and unavailable; missing or corrupt Result bytes retain metadata and an
integrity status but cannot be downloaded. Historical readers strictly validate metadata while
tolerating unavailable output bytes; execution mutations and downloads keep full storage and byte
validation. The frontend imports owned candidates, reindexes Projects, groups history by Batch, opens
frozen Run Plans and Result Details,
and displays execution availability and Result integrity without browser-held Run IDs.

BC-021 is complete. Editable `Load Run as Batch`, detached-resource classification, exact relinking,
explicit server-sourced historical import, and an automated clean-instance reconstruction/Preview/new-Run
path are implemented. The complete realistic fixture, repeat-fresh-instance proof, and live ComfyUI
acceptance step remain release-level checks for ADR 0012.

## Python Conventions

Use `uv` for Python environment and dependency management unless an ADR changes the decision.

General expectations:

- target a currently supported Python release;
- add type annotations to application/domain code;
- keep pure domain logic independent of FastAPI and SQLite where practical;
- prefer explicit data structures over loosely shaped dictionaries at domain boundaries;
- use clear exceptions/errors with actionable context;
- do not hide network or filesystem failures.

The production Python package uses pytest, Ruff, and mypy. From `backend/`, run:

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

pytest covers behavior, Ruff owns formatting and linting, and mypy checks the typed domain boundary. Add another tool only when it covers a distinct need.

### Distribution notice checks

From the checkout root, after installing locked development dependencies:

```bash
npm --prefix frontend run build
uv run --offline --no-sync --directory backend python -m tools.check_distribution
```

The checker builds wheel and sdist artifacts in a temporary directory, verifies GPL-3.0-only metadata
and the complete license bytes, and rejects unexpected package inputs. `backend/LICENSE` is a checked
copy of the root license so the backend sdist can build independently; tests reject copy drift.

Frontend builds emit `LICENSE`, `THIRD-PARTY-NOTICES.json`, and `BUILD-TOOL-NOTICES.json`. Vite's native
license output covers the bundled React, React DOM, and Scheduler packages; separate complete installed
tool notices cover injected Vite/Rolldown helpers. New bundled dependencies require review rather than
silently shipping without notices. `npm --prefix frontend run check:distribution` checks actual output,
negative notice cases, and a disposable source-map build. Normal builds do not emit source maps.

CI runs the backend artifact tests and frontend distribution checks. These checks require a Git checkout,
installed dependencies, and the root license; they are not application runtime requirements. They verify
these artifacts' contents, not GPL corresponding-source delivery or a complete bundled Python/browser/OS
distribution. Runtime Python dependencies are declared, not vendored into the wheel. Review notices and
source obligations separately if packaging those components later.

### Local API

These are manual API-only commands with a real ComfyUI client, not the fake-backed development
launcher. They do not start Vite; execution requests can submit GPU work. For agent browser work use
`./dev.command` as documented in `LOCAL_INSTANCES.md` instead.
From `backend/`, start the API with explicit separate storage and ComfyUI configuration:

```bash
BATCHCRAFT_PROJECTS_ROOT="/path/to/projects" \
BATCHCRAFT_DATABASE_PATH="/path/to/batchcraft.sqlite3" \
BATCHCRAFT_COMFYUI_BASE_URL="http://<windows-host>:8188" \
uv run batchcraft-api
```

The default bind address is `127.0.0.1:8000`; `BATCHCRAFT_SERVER_HOST` and `BATCHCRAFT_SERVER_PORT` override it. See `docs/API.md` for all application settings and endpoint behavior.

SQL migrations live under `backend/src/batchcraft/db/migrations/`. `0001_initial.sql` is now a preserved
user-data baseline. BC-020 adds `0002_historical_projections.sql` as the first forward migration. Never
change applied migration bytes. Add only the next contiguous `NNNN_name.sql`; ordered discovery,
checksums, and transactional application reject gaps, changed history, and newer unknown databases.
Test migration behavior and preservation of existing rows against file-backed temporary databases rather
than only `:memory:`. Those test databases may be recreated; user databases may not.

Cancellation changes require tests for durable and idempotent intent, both request/admission race
orderings, cancellation during local preparation, successful current-Job Result ingestion, failure and
blocked precedence, succeeded-prefix/cancelled-suffix validation, absence of ComfyUI interrupt or queue
operations, read-model reconstruction, and rejection of non-v1 execution records plus v1 round-trip behavior.

## Frontend Conventions

The frontend under `frontend/` uses React, strict TypeScript, Vite, npm, native `fetch`, and plain
CSS. Vitest, jsdom, and React Testing Library cover user-visible behavior at a mocked API boundary.
ESLint checks TypeScript and React Hooks rules. No router, component framework, data-fetching
library, or client state library is installed.

Keep API access in `src/api/`, feature components in `src/features/`, and small shared controls in
`src/components/`. Treat HTTP responses as typed contracts. Keep Batch compilation, validation,
execution transitions, and Result provenance on the backend.

Browser working-session recovery is a pointer/cache, not runtime authority. Store the strict recovery
v4 record under `batchcraft.working-session-recovery.v4` in localStorage. It may contain semantic form
values, selected Project and Saved Batch pointers, a historical source Run ID for detached-resource
imports, explicit validated historical-to-copy resolution IDs, and current Run ID. Retain the v4 key and
schema and strictly validate the deprecated required wire field `session_run_ids` in existing records:
it must be an array of unique non-empty strings and include `current_run_id` when non-null. Do not restore
or use those IDs, expose public runtime `sessionRunIds`, or prefetch historical Runs from them. New
writes store only `[]` when `current_run_id` is null or `[current_run_id]` otherwise. The record must not
contain Preview, execution, Job, Result, frozen Run response, or materialized Random seed data. Detached
Workflow/Profile JSON remains in the record even when historical version IDs exist. Reconnect a saved
Project only by exact Project ID and filesystem-key match. Keep Project-scoped Prompt and Asset requests
blank until that verification succeeds. Treat editable draft identity and observed Run identity
independently. Discover the process-local active Run on startup and foreground re-entry; it takes monitor
precedence over a different persisted pointer. A frozen Project or Batch mismatch does not prevent Run
monitoring or pointer retention. Hydrate Run and execution state before Results, retry only transient
startup failures with bounded backoff, and clear a
pointer only after definitive missing or invalid Run evidence. Require a fresh compiler Preview after every cold load. Switching
Project starts a fresh Batch identity and clears Project-scoped Prompt, Workflow/Profile, Image Input,
and Parameter selections under the existing navigation guards. Draft reconciliation must not erase a
recoverable observed Run. Semantic edits invalidate Preview; presentation-only collapse changes do not.

The scoped Results cleanup removes Batch Results, all session-gallery runtime state, and its historical
prefetch effects. Keep current Results and Project History, including on-demand frozen Run detail and
source-Run reads needed for detached-resource recovery. Thumbnail cards omit visible `Verified` badges
and `Job` captions; keep the info popup, accessible descriptions, lightbox labels, integrity validation,
unavailable-artifact placeholders, and image-load failure handling. Cancellation behavior is unchanged.
This cleanup changes no SQLite schema, filesystem format, or backend API DTO.

Regression checks cover absence of Batch Results and
visible card labels, retained detail/lightbox accessibility and unavailable placeholders, strict reading
of older valid v4 records without gallery fetches, malformed-record rejection, minimal new wire writes,
independent current/active Run restoration, cancellation, and historical detail. Run the frontend checks
below and fake-backed browser verification from `LOCAL_INSTANCES.md`.

Execution responses distinguish durable status from the ephemeral active-task ownership of the current
API process. A restored `running` Run without an active task remains historically unchanged, but the UI
stops polling it, hides impossible cancellation actions, and permits a fresh Preview and replacement
Run. Saving mutable Batch intent remains available during active execution because the current Run is
already frozen; Project and Batch navigation remain locked only while local execution control is active.
Active-Run discovery is task-registry visibility only, not durable scheduler or ComfyUI authority, and a
backend restart returning no active task does not erase a known submitted Run pointer.

The selected Profile drives the named Image Input editor. It renders slots in Profile order and lets
each choose ordered Project Asset alternatives plus an independent Base workflow alternative. Profile
changes reconcile by stable slot key, preserve complete matching value order, add new slots as Base
workflow, and remove deleted slots. Missing assets remain visible and block Preview until repaired. Any
binding change invalidates Preview.

The selected Profile also drives the generic parameter editor. It renders independent parameters in
Profile order with ordered Values or numeric Range intent and lets users replace two or more independent
bindings with one explicit row-based Preset. Range input remains decimal text and the
frontend uses exact BigInt arithmetic only to validate and display count; it never emits generated Range
values. Profile changes preserve a Preset only when every member key and type remains compatible; an
incompatible set dissolves to independent Base bindings rather than reinterpreting rows. Any semantic
Values, Range, or Preset change invalidates Preview. Collapsing the section is local UI state and does not.
Job count, authoritative Range materialization, and concrete expansion remain backend responsibilities.
Creating a Preset copies selected members' saved Values alternatives into explicit rows by index, uses the
longest member list as row count, and fills missing cells with Base workflow. Active Range members use
their retained Values draft; the frontend does not materialize the Range. Preset cells continue showing
the frozen Base value beside an override. `Add Parameter` routes through Workflow Setup: it edits the
selected compatible Profile, creates one when the Workflow has no Profiles, or focuses the chooser when
multiple existing Profiles require an explicit selection.

Random seed intent remains editable frontend and Batch snapshot state as
`{ mode: "random", random_seed_count: N }`. Preview sends that intent without concrete values. The
backend first computes the complete non-seed expansion, then uses `secrets.randbelow` to materialize one
unique seed per final Job within `0..2^53-1`. Preview returns those concrete assignments in deterministic
Job order. The frontend retains that exact materialized request for Run creation and publication retry,
then consumes it only after successful publication. A later Preview, historical `Load Run as Batch`, or
cold recovery starts from editable intent and requests fresh Random assignments. Fixed and Explicit
behavior is unchanged.

PromptVersion is the compiler's first dimension. The frontend preserves PromptVersion request order
and displays backend-returned PromptVersion identity in Preview. It does not calculate prompt products
or infer provenance from resolved prompt text. Prompt library refresh and logical Prompt rename must
never replace a selected immutable snapshot. Archived or missing selections detach while retaining
their exact stored identity, name snapshot, and text; known cross-Project selections block Preview.

Workflow and Workflow Profile selectors follow the same snapshot rule. Logical metadata changes do
not invalidate Preview, while selecting another immutable version does. Linked selections must belong
to the verified Project and target the exact selected WorkflowVersion. Detached snapshots with
unavailable or integrity-mismatched library linkage remain usable after backend workflow/Profile
validation.

From `frontend/`, install and run the development server:

```bash
npm ci
npm run dev
```

Vite serves `http://127.0.0.1:5174`. Its development API defaults to `http://127.0.0.1:8001`, with an
explicit override from `VITE_BATCHCRAFT_API_URL`. Use `./dev.command` for matched ports, origin, isolated
data, and fake ComfyUI. A manually launched backend must set `BATCHCRAFT_SERVER_PORT=8001` and
`BATCHCRAFT_FRONTEND_ORIGIN=http://127.0.0.1:5174`. Port 8000 belongs to the separate everyday app.

Run all frontend checks from `frontend/`:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The committed npm lockfile defines dependency versions. Do not commit `.env` or `.env.local`.

## Backend/Frontend Boundary

The backend is authoritative for:

- validation;
- prompt resolution;
- Batch compilation;
- Run creation;
- Job scheduling;
- ComfyUI communication;
- durable filesystem artifacts;
- persistence.

The frontend may provide immediate UX hints, but it must not become a second implementation of domain rules.

For example, the frontend may display a Job count received from a compiler-preview endpoint; it should not maintain independent Cartesian-product logic that could disagree with actual Run creation.

## ComfyUI Integration Tests

Live ComfyUI tests must be separate from normal unit tests.

The production adapter has one standalone opt-in verification script. From `backend/`, run it only with an explicitly configured host:

```bash
COMFYUI_BASE_URL="http://<windows-host>:8188" uv run python tests/live/comfyui_verify.py
```

It defaults to the ignored root `example.png` and the known spike workflow. Override them with `COMFYUI_LIVE_IMAGE` and `COMFYUI_LIVE_WORKFLOW` when needed. Pytest does not collect this script.

The sequential executor has a separate two-Job verification. It publishes a local Run under ignored `outputs/`, executes both Jobs at queue depth one, and verifies persisted Results and unchanged provenance:

```bash
COMFYUI_BASE_URL="http://<windows-host>:8188" uv run python tests/live/execution_verify.py
```

They should:

- require explicit configuration;
- fail clearly when the remote host is unavailable;
- never be required for ordinary domain test runs;
- use known fixture workflows/assets;
- avoid destructive operations;
- record enough diagnostic information to troubleshoot protocol failures.

Local configuration such as hostnames, IP addresses, tokens, or machine paths must not be committed.

Use environment variables or ignored local configuration files when needed.

## Testing Philosophy

Test behavior and invariants rather than implementation details.

Tests must pass from a clean Git checkout, not just an existing development directory. Git does not
preserve empty directories. Fixture setup must create required empty directories, such as Run
`outputs/`, in the temporary test copy without modifying the committed fixture or user data.

High-value unit-test areas include:

- placeholder validation;
- repeated placeholders;
- undefined bindings;
- deterministic value ordering;
- Cartesian expansion;
- complete dimension ordering with the rightmost dimension varying fastest;
- zero/one/multiple canonical variable binding semantics;
- current binding round-trips and removed-field rejection;
- Job count calculations;
- deterministic Job ordinals;
- seed policies;
- Run immutability;
- separation of frozen Run provenance from mutable execution state;
- filesystem publication before SQLite indexing;
- re-indexing complete filesystem Runs;
- atomic Project projection replacement and rebuild from filesystem truth;
- verified/degraded/invalid history isolation and explicit unavailable execution;
- read-only historical detail versus strict mutation and Result download;
- Result integrity classification;
- manifest round-tripping;
- rerun creation;
- Workflow Profile core and named Image Input mapping;
- named Image Input key, order, binding, frozen provenance, deterministic upload, and Base workflow behavior;
- generic parameter key, type, alternatives, deterministic expansion, frozen provenance, scalar execution, and Base workflow behavior;
- local Base-workflow value display from current and frozen Workflow/Profile provenance, including unavailable targets and native scalar types;
- definite structured ComfyUI rejection context without changing unstructured, overridden, or ambiguous diagnostics.

A preview and an actual Run must be produced by the same underlying compiler behavior. Tests should protect this invariant.

When Exact Rerun is implemented after v1, its tests must verify preserved generation inputs and ordering
alongside newly allocated Run/Job IDs, timestamps, prompt IDs, and output namespace.

Tests for ComfyUI submission must treat ambiguous outcomes separately from definite rejection. Automatic retries must not turn an uncertain accepted submission into duplicate work.

## Durable Format Changes

Changes to JSON/CSV Run artifacts are version-sensitive.

When changing a durable format:

1. update `docs/FILE_FORMAT.md`;
2. update its explicit format identity and independently managed schema version when appropriate;
3. define producer metadata and any raw-payload or secondary-artifact descriptors;
4. add current round-trip, exact-shape, unsupported-version, hash, path, and owner-chain tests;
5. update the committed golden fixture and inspect its emitted bytes;
6. state whether a compatibility path is explicitly required;
7. document compatibility and migration behavior.

Superseded prerelease formats remain unsupported, but valid candidate-v1 Project files are durable user
data under the persistence policy above. Unsupported data must fail closed without automatic deletion
or rewriting. Do not infer durable format versions solely from the absence of fields.

## Architecture Changes

Create an ADR when a change meaningfully affects areas such as:

- frontend/backend framework choice;
- persistence model;
- Run immutability;
- historical artifact ownership;
- browser-to-ComfyUI communication boundary;
- scheduling ownership;
- prompt-variable semantics;
- a required external service;
- a major packaging/deployment model.

Small implementation choices do not need ADRs.

## Git Workflow

Prefer short-lived branches or focused commits depending on the development workflow in use.

Before committing or reporting completion:

```bash
git status
git diff
```

Then run all checks relevant to the files changed.

Commit messages should describe the coherent behavior or decision added, for example:

```text
Document initial batchcraft architecture
Add deterministic prompt variable resolver
Add ComfyUI integration spike
Persist immutable run manifests
```

Avoid mixing unrelated refactors and feature work in the same commit.

## Secrets and Local Data

Never commit:

- secrets or API keys;
- local `.env` files;
- SQLite working databases;
- generated project output directories;
- reference libraries containing user data unless intentionally added as test fixtures;
- machine-specific ComfyUI paths;
- large model/generated files.

Small, deliberately chosen fixtures may be committed when they are required for tests and licensing/privacy allows it.

## Definition of Done

For a normal implementation task, completion means:

- requested behavior is implemented;
- relevant tests exist and pass;
- relevant lint/type/build checks pass;
- user-facing/domain errors are actionable;
- no unrelated files were modified;
- `git diff` was reviewed;
- documentation was updated if behavior, architecture, formats, or developer workflow changed.

For exploratory spikes, document what was proven, what failed, and what production design assumptions should change as a result.
