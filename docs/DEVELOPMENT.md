# Development Guide

## Purpose

This document defines the expected development workflow for **batchcraft**.

The project has entered production domain development. The full frontend and backend application remain unscaffolded.

## Supported Development Environment

Initial development target:

- development host: macOS;
- shell: normal macOS terminal environment;
- Python tooling: `uv`;
- Node tooling: to be selected when frontend scaffolding begins;
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

### Phase 2: first vertical application slice

After the pure compiler foundation is established, build the smallest application path that proves the architecture end to end:

1. connect to ComfyUI;
2. select/import a known Workflow Profile;
3. enter a Prompt Template;
4. bind one or more Variable Lists;
5. select reference images;
6. preview the resolved Job count;
7. create a Run with frozen plan and provenance;
8. execute Jobs through the batchcraft scheduler;
9. persist manifests and outputs;
10. display a basic Results Viewer.

Do not build the full prompt library, advanced search, elaborate ratings, multi-server scheduling, or other roadmap features before this path works reliably.

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

## Frontend Conventions

The planned frontend is React + TypeScript.

When scaffolding begins:

- enable strict TypeScript;
- keep API/data access out of presentational components;
- treat server responses as typed contracts;
- keep Batch compilation and other authoritative business logic on the backend;
- do not duplicate compiler logic in the frontend for previews;
- design image-heavy screens for responsive thumbnail/grid workflows;
- prioritize clarity and fast experiment construction over decorative complexity.

The exact package manager, build tool, component system, formatter, and test stack should be selected deliberately during frontend scaffolding and documented here.

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
