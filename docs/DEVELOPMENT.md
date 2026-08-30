# Development Guide

## Purpose

This document defines the expected development workflow for **batchcraft**.

The project has entered production application development. The backend has a thin FastAPI boundary,
the first React browser workflow is implemented, and SQLite Phase 1 provides migrations, Projects,
and the Prompt library.

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

Production code under `backend/src/batchcraft/execution/` persists versioned mutable execution state, executes one published Run with queue depth one, falls back from advisory WebSocket failure to bounded history reconciliation, and writes deterministic Results under the Run's `outputs/` directory.

This layer excludes global Run selection, concurrent execution, priorities, retries, automatic recovery, SQLite, FastAPI, React, and result review UI. Normal tests use a deterministic ComfyUI fake.

### Phase 2: first vertical application slice

Completed for the backend application boundary. Without React or SQLite, the current API checks ComfyUI status, accepts a complete ephemeral Batch snapshot, previews deterministic Jobs, creates a frozen Run, starts queue-depth-1 execution, exposes execution polling, and serves persisted Result metadata and files.

Do not build the full prompt library, advanced search, elaborate ratings, multi-server scheduling, or other roadmap features before this path works reliably.

The slice accepts an ephemeral complete Batch request for preview and Run creation. It does not define another durable Batch format before SQLite. Run lookup narrowly scans complete published Run directories, and long-running execution uses retained in-process tasks while `execution.json` remains authoritative.

### Phase 2.1: first React workflow

Completed.

Production code under `frontend/` provides one screen for ComfyUI status, ephemeral Batch editing,
Project image import and collapsible ordered Reference Asset selection, backend-compiled Job preview,
durable Run creation, repeated terminal Run creation, execution start and polling, non-cropping
Result rendering, and a tab-scoped Batch Results gallery across session Runs. The browser uses only
the FastAPI endpoints documented in `docs/API.md`.

Batch editing includes an ordered repeatable list of ephemeral PromptVersions. Prompt additions,
removals, edits, and ordering changes invalidate Preview. The browser session schema stores this list
without UI keys and migrates older singular-prompt drafts; it is not a persistent Prompt library.

This phase does not add durable editable Batch persistence, Reference Collections, asset deletion,
Run history, recovery, cancellation, retries, ratings, advanced filtering, or visual Workflow
Profile mapping.

### Phase 2.2: SQLite foundation, Projects, and Prompt library

Completed for the backend. Production code under `backend/src/batchcraft/db/` uses stdlib `sqlite3`,
one connection per operation, explicit checksummed SQL migrations, and feature-specific Project and
Prompt stores. FastAPI migrates before serving requests. Project creation publishes `project.json`
before SQLite insertion, and explicit adoption recovers valid owner bindings or binds an explicitly
selected ownerless asset directory using a user-supplied Project ID and name.

This phase does not persist Batches, index filesystem Runs or Assets, add scheduler state, or wire the
browser Batch editor to the Prompt library.

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

SQL migrations live under `backend/src/batchcraft/db/migrations/`. Add only the next contiguous
`NNNN_name.sql` file; applied migration bytes are immutable because startup verifies their SHA-256
checksums. Test migration behavior against file-backed temporary databases rather than only `:memory:`.

## Frontend Conventions

The frontend under `frontend/` uses React, strict TypeScript, Vite, npm, native `fetch`, and plain
CSS. Vitest, jsdom, and React Testing Library cover user-visible behavior at a mocked API boundary.
ESLint checks TypeScript and React Hooks rules. No router, component framework, data-fetching
library, or client state library is installed.

Keep API access in `src/api/`, feature components in `src/features/`, and small shared controls in
`src/components/`. Treat HTTP responses as typed contracts. Keep Batch compilation, validation,
execution transitions, and Result provenance on the backend.

Browser `sessionStorage` is a best-effort refresh aid, not application persistence. Store semantic
form values, the current Run ID, and ordered unique Run IDs for the current Batch working session.
Restore Run, execution, and Result state from the backend, and require a fresh compiler Preview after
restoring a form draft. Never store Result metadata or bytes as browser truth. Changing stable Project
or Batch identity resets the session gallery; editing prompts, references, seeds, or display names does
not.

The Reference Asset picker starts expanded with no selection and may start collapsed when a restored
selection exists. Its collapsed state renders only the selected count. Select All preserves current
selection order and appends unselected Project assets in deterministic picker order; Select None
clears the selection. Both are semantic form changes and must invalidate Preview.

Random seed intent belongs to the ephemeral frontend form, not the API domain model. Materialize it
once with Web Crypto into an explicit ordered seed list before calling Preview, retain that exact
request for Run creation, and consume the Preview only after successful Run publication. Fixed and
Explicit Previews remain reusable; a failed Random Run creation keeps its inspected request for retry.

PromptVersion is the compiler's first dimension. The frontend preserves PromptVersion request order
and displays backend-returned PromptVersion identity in Preview. It does not calculate prompt products
or infer provenance from resolved prompt text.

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
- fixed/all variable binding modes;
- Job count calculations;
- deterministic Job ordinals;
- seed policies;
- Run immutability;
- separation of frozen Run provenance from mutable execution state;
- filesystem publication before SQLite indexing;
- re-indexing complete filesystem Runs;
- manifest round-tripping;
- rerun creation;
- Workflow Profile input mapping.

A preview and an actual Run must be produced by the same underlying compiler behavior. Tests should protect this invariant.

Tests for exact rerun must verify preserved generation inputs and ordering alongside newly allocated Run/Job IDs, timestamps, prompt IDs, and output namespace.

Tests for ComfyUI submission must treat ambiguous outcomes separately from definite rejection. Automatic retries must not turn an uncertain accepted submission into duplicate work.

## Durable Format Changes

Changes to JSON/CSV Run artifacts are compatibility-sensitive.

When changing a durable format:

1. update `docs/FILE_FORMAT.md`;
2. update explicit format/schema versions when appropriate;
3. preserve old Run readability whenever practical;
4. add import/round-trip tests;
5. document migration behavior if required.

Do not infer durable format versions solely from the absence of fields.

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
