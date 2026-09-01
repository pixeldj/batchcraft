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
- Python tooling: `uv`;
- Node tooling: Node.js `^20.19.0` or `>=22.12.0` with npm;
- generation host: ComfyUI on a Windows workstation reachable over the local LAN;
- source control: Git.

Do not make the production architecture depend on a particular terminal, IDE, or coding-agent harness.

## Coding Agents

The repository is intended to work well with tools such as Pi and OpenCode.

Before substantial work, agents must read:

1. `AGENTS.md`;
2. relevant documents under `docs/`;
3. relevant ADRs;
4. existing implementation and tests in the affected area.

Agents should plan before implementing non-trivial features and should avoid broad opportunistic refactors while completing a focused task.

## Pre-release Persistence Policy

batchcraft has no released persistence compatibility contract yet. Unless a task explicitly requires
one, support only the current SQLite schema, Run manifest and snapshot, execution state, API payload,
and browser-session formats. Unsupported persisted data fails closed; an unsupported or malformed
browser session starts from clean working state. The application must not silently delete or rewrite
local databases or Run directories.

Keep explicit format versions, the SQLite migration runner, and current-version rejection tests. When
the baseline changes, update the version, operational documentation, and current-format tests together.
Add a compatibility path only for a concrete released-data or external-consumer requirement.

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
- secondary `manifest.csv`;
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

Production code under `backend/src/batchcraft/execution/` persists execution format v2 mutable state, executes one published Run with queue depth one, falls back from advisory WebSocket failure to bounded history reconciliation, and writes deterministic Results under the Run's `outputs/` directory. Execution v1 is intentionally unsupported; there is no v1 loader.

This layer excludes global Run selection, concurrent execution, priorities, retries, automatic recovery, SQLite, FastAPI, React, and result review UI. Normal tests use a deterministic ComfyUI fake.

### Phase 2: first vertical application slice

Completed for the backend application boundary. Without React or SQLite, the current API checks ComfyUI status, accepts a complete ephemeral Batch snapshot, previews deterministic Jobs, creates a frozen Run, durably discards a pristine unstarted Run, starts queue-depth-1 execution, exposes execution polling, and serves persisted Result metadata and files.

Do not build the full prompt library, advanced search, elaborate ratings, multi-server scheduling, or other roadmap features before this path works reliably.

The slice accepts an ephemeral complete Batch request for preview and Run creation. It does not define another durable Batch format before SQLite. Run lookup narrowly scans complete published Run directories, and long-running execution uses retained in-process tasks while `execution.json` remains authoritative. Start and discard tests exercise the shared registry lock, exact pristine-state eligibility, restart durability, terminal cancellation, and preservation of frozen Run files.

### Phase 2.1: first React workflow

Completed.

Production code under `frontend/` provides one screen for ComfyUI status, ephemeral Batch editing,
Project image import and backend-compiled Job preview,
durable Run creation, repeated terminal Run creation, execution start and polling, non-cropping
Result rendering, and a tab-scoped Batch Results gallery across session Runs. The browser uses only
the FastAPI endpoints documented in `docs/API.md`.

Batch editing includes an ordered repeatable list of immutable PromptVersion snapshots. The current
Project's persistent Prompt library supplies new selections, version history, immutable version
creation, and mutable logical Prompt names. Snapshot additions, removals, version changes, and ordering
changes invalidate Preview; logical renames and exact library reconciliation do not. The browser
session restoration stores library linkage and exact immutable snapshots without UI keys. Named Image
Input binding and browser session v10 supersede the original picker and session shape in Phase 2.4.

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

### Local API

From `backend/`, start the local API with explicit storage and ComfyUI configuration:

```bash
BATCHCRAFT_PROJECTS_ROOT="/path/to/projects" \
BATCHCRAFT_DATABASE_PATH="/path/to/batchcraft.sqlite3" \
BATCHCRAFT_COMFYUI_BASE_URL="http://<windows-host>:8188" \
uv run batchcraft-api
```

The default bind address is `127.0.0.1:8000`; `BATCHCRAFT_SERVER_HOST` and `BATCHCRAFT_SERVER_PORT` override it. See `docs/API.md` for all application settings and endpoint behavior.

SQL migrations live under `backend/src/batchcraft/db/migrations/`. The current pre-release schema is
one consolidated `0001_initial.sql` baseline. Generic Workflow Parameters Pass 3A replaced the prior
consolidated 0001 bytes and schema with normalized parameter binding storage; Pass 3B-1 replaced those
bytes again to permit multiple positive parameter value positions; Pass 3B-2 replaced them again with
Values/Range mode and decimal Range columns. Any database created from an earlier baseline has
unsupported migration history and must be recreated manually. The application fails
startup and never erases it. The migration runner, ordered discovery,
checksums, and transactional application remain the forward-change mechanism. Once preserving a
baseline is required, add only the next contiguous `NNNN_name.sql` file and do
not change applied migration bytes. Test migration behavior against file-backed temporary databases
rather than only `:memory:`.

## Frontend Conventions

The frontend under `frontend/` uses React, strict TypeScript, Vite, npm, native `fetch`, and plain
CSS. Vitest, jsdom, and React Testing Library cover user-visible behavior at a mocked API boundary.
ESLint checks TypeScript and React Hooks rules. No router, component framework, data-fetching
library, or client state library is installed.

Keep API access in `src/api/`, feature components in `src/features/`, and small shared controls in
`src/components/`. Treat HTTP responses as typed contracts. Keep Batch compilation, validation,
execution transitions, and Result provenance on the backend.

Browser working-session recovery is a pointer/cache, not runtime authority. Store the strict recovery
v1 record under `batchcraft.working-session-recovery.v1` in localStorage. It may contain semantic form
values, selected Project and Saved Batch pointers, current Run ID, and ordered unique Run IDs for the
current Batch working session. It must not contain Preview, execution, Job, Result, frozen Run response,
or materialized Random seed data. Reconnect a saved Project only by exact Project ID and filesystem-key
match. Keep Project-scoped Prompt and Asset requests blank until that verification succeeds. Restore
Run, execution, and Result state from the backend only when the frozen Run matches current Project and
Batch IDs plus filesystem keys. Require a fresh compiler Preview after every cold load. Switching
Project starts a fresh Batch identity and clears Project-scoped Prompt, Workflow/Profile, Image Input,
Parameter, Run, and gallery state. Changing Batch identity resets the gallery; semantic edits within the
same Batch retain it and invalidate Preview. Presentation-only collapse changes do neither.

The selected Profile drives the named Image Input editor. It renders slots in Profile order and lets
each choose ordered Project Asset alternatives plus an independent Base workflow alternative. Profile
changes reconcile by stable slot key, preserve complete matching value order, add new slots as Base
workflow, and remove deleted slots. Missing assets remain visible and block Preview until repaired. Any
binding change invalidates Preview.

The selected Profile also drives the generic parameter editor. It renders parameters in Profile order
and lets each hold ordered Values or numeric Range intent. Range input remains decimal text and the
frontend uses exact BigInt arithmetic only to validate and display count; it never emits generated Range
values. Profile changes preserve same-key drafts only when the declared type remains compatible. Any
semantic Values/Range change invalidates Preview. Collapsing the section is local UI state and does not.
Job count, authoritative Range materialization, and concrete expansion remain backend responsibilities.

Random seed intent belongs to the ephemeral frontend form, not the API domain model. Materialize it
once with Web Crypto into an explicit ordered seed list before calling Preview, retain that exact
request for Run creation, and consume the Preview only after successful Run publication. Fixed and
Explicit Previews remain reusable; a failed Random Run creation keeps its inspected request for retry.

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
npm install
npm run dev
```

Vite serves `http://localhost:5173`. The frontend uses `http://127.0.0.1:8000` by default and reads
an override from `VITE_BATCHCRAFT_API_URL`. Keep the backend's `BATCHCRAFT_FRONTEND_ORIGIN` aligned
with the Vite origin.

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
- manifest round-tripping;
- rerun creation;
- Workflow Profile core and named Image Input mapping;
- named Image Input key, order, binding, frozen provenance, deterministic upload, and Base workflow behavior.
- generic parameter key, type, alternatives, deterministic expansion, frozen provenance, scalar execution, and Base workflow behavior.

A preview and an actual Run must be produced by the same underlying compiler behavior. Tests should protect this invariant.

Tests for exact rerun must verify preserved generation inputs and ordering alongside newly allocated Run/Job IDs, timestamps, prompt IDs, and output namespace.

Tests for ComfyUI submission must treat ambiguous outcomes separately from definite rejection. Automatic retries must not turn an uncertain accepted submission into duplicate work.

## Durable Format Changes

Changes to JSON/CSV Run artifacts are version-sensitive.

When changing a durable format:

1. update `docs/FILE_FORMAT.md`;
2. update explicit format/schema versions when appropriate;
3. add current import/round-trip and unsupported-version tests;
4. state whether a compatibility path is explicitly required;
5. document any manual reset or migration behavior.

During pre-release development, old Run readability is not the default requirement. Unsupported data
must fail closed without automatic deletion or rewriting. Do not infer durable format versions solely
from the absence of fields.

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
