# batchcraft Agent Instructions

## Product

**batchcraft** is a local-first experiment and batch orchestration application for ComfyUI.

It is not a replacement for ComfyUI's workflow editor. ComfyUI owns workflow construction and generation. batchcraft owns prompt management, reference management, experiment compilation, scheduling, reproducibility, run history, and result review.

Read the project documentation before making substantial changes:

- `docs/PRODUCT.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/PROMPT_VARIABLES.md`
- `docs/BATCH_COMPILER.md`
- `docs/COMFYUI_INTEGRATION.md`
- `docs/FILE_FORMAT.md`
- `docs/DEVELOPMENT.md`
- `docs/BACKLOG.md` when planning feature work
- relevant records under `docs/adr/`

When documentation and implementation disagree, do not silently choose one. Identify the discrepancy and resolve it deliberately.

When feature work matches an existing backlog entry, reference its stable ID and update only that entry. Mark it `Done` only after required verification succeeds. Keep backlog maintenance scoped so it does not create unrelated documentation churn.

## Product Terminology

Use these terms consistently:

- **Project** — top-level workspace for related experiments.
- **Workflow Profile** — imported ComfyUI API workflow plus friendly mappings to selected workflow inputs.
- **Prompt Template** — versioned reusable prompt text that may contain `{{placeholder}}` references.
- **Variable List** — reusable ordered values that can be bound to a placeholder.
- **Reference Asset** — an input file, initially an image.
- **Reference Collection** — reusable grouping of Reference Assets.
- **Image Input Slot** — ordered, named Workflow Profile target bound by stable slot key to one or more ordered Reference Asset or Base workflow alternatives.
- **Batch** — mutable experiment definition.
- **Run** — execution whose compiled plan and provenance freeze at successful Run creation.
- **Job** — one completely resolved ComfyUI execution.
- **Result** — one artifact produced by a Job. A Job may produce multiple Results.

Do not casually introduce synonyms for these domain concepts.

## Core Invariants

These are architectural requirements, not implementation suggestions:

1. A Batch is mutable.
2. A Run plan and its provenance freeze when successful Run creation completes, before scheduling begins.
3. Execution state is mutable while a Run executes. Status, timestamps, ComfyUI IDs, errors, and Results may advance without changing the frozen plan.
4. A Job is fully resolved before it reaches the scheduler.
5. No unresolved `{{placeholder}}` may be submitted to ComfyUI.
6. Random or sampled values, if supported later, must be resolved and stored before execution.
7. Editing a Prompt Template, Variable List, Reference Collection, Workflow Profile, or Batch must never alter an existing Run plan.
8. Rerunning creates a new Run rather than modifying the original.
9. Completed Run artifacts must contain enough information to understand and re-index the Run without SQLite.
10. SQLite is an application index/state store, not the sole historical source of truth.
11. The filesystem Run must be published before SQLite indexes it. A complete filesystem Run must be recoverable when SQLite state is missing.
12. batchcraft owns the logical queue; core behavior must not rely on self-requeueing ComfyUI nodes.
13. An ambiguous ComfyUI submission failure must be reconciled rather than blindly retried.
14. The frontend must not communicate directly with ComfyUI. ComfyUI integration belongs behind the backend client/service boundary.
15. ComfyUI remains the workflow editor. Do not build a competing node editor into batchcraft.
16. Preview and execution must use the same compiler/resolver logic.
17. Completed Run directories must never be silently rewritten.
18. Reproducibility means preserving a replayable execution specification and provenance, not guaranteeing byte-identical pixels.

If a requested implementation conflicts with an invariant, stop and explain the conflict before proceeding.

## Planned Architecture

The initial architecture is:

- frontend: React + TypeScript;
- backend: Python + FastAPI;
- mutable application state: SQLite;
- historical Run artifacts: filesystem-backed JSON, CSV, workflow snapshots, and downloaded outputs;
- ComfyUI: remote HTTP/WebSocket execution engine, initially on a Windows workstation on the same LAN as the Mac running batchcraft.

Treat this as the current architecture unless an ADR explicitly changes it.

## Engineering Principles

- Prefer simple implementations over speculative abstractions.
- Build narrow vertical slices that exercise real behavior end to end.
- Do not add a dependency without a concrete need and a brief explanation.
- Keep domain logic independent of FastAPI, React, SQLite, and ComfyUI wherever practical.
- Isolate ComfyUI-specific node mutation and protocol behavior inside the ComfyUI integration layer.
- Use deterministic behavior for prompt resolution, Batch compilation, Job ordering, and output naming.
- Keep stable internal IDs and filesystem identities separate from editable display names.
- Validate at boundaries and fail with actionable errors rather than silently guessing.
- Preserve local-first operation. Do not introduce required cloud services without an explicit architectural decision.
- Avoid premature plugin systems, generic workflow engines, distributed queues, authentication systems, or multi-user architecture.
- Do not implement speculative roadmap features while completing a narrower task.

## Pre-release Persistence Policy

For pre-release persistence changes, follow `docs/DEVELOPMENT.md`'s Pre-release Persistence Policy. Unless explicitly requested, support only the current database, Run, execution, and browser-session formats. Retain explicit versioning and migration machinery, fail closed on unsupported data, and never delete local data automatically.

## Testing Expectations

Business rules require tests.

At minimum, add or update tests for changes involving:

- placeholder parsing and validation;
- Variable List binding;
- prompt resolution;
- deterministic Cartesian expansion;
- Batch-to-Run compilation;
- Job ordering;
- seed handling;
- manifest serialization/import;
- workflow input mapping;
- Run immutability;
- rerun behavior.

Do not weaken, skip, or delete a meaningful test merely to make a change pass.

Integration behavior against ComfyUI should be separated from unit tests and clearly marked so ordinary test runs do not require a live GPU host.

## Development Workflow

For substantial tasks:

1. Read `AGENTS.md` and the relevant project docs.
2. Inspect the existing implementation and tests before proposing changes.
3. State a concise plan and identify assumptions or unresolved decisions.
4. Make the smallest coherent implementation that satisfies the task.
5. Add or update tests.
6. Run the relevant checks described in `docs/DEVELOPMENT.md`.
7. Inspect `git diff` and `git status` before declaring completion.
8. Update documentation when product behavior, durable formats, architecture, or developer workflow changes.
9. Create or update an ADR for significant architectural decisions.

## Git and Repository Safety

- Do not modify unrelated files.
- Do not rewrite Git history unless explicitly requested.
- Do not force-push.
- Do not delete user data or local project artifacts.
- Do not commit secrets, API keys, generated outputs, local databases, or machine-specific configuration.
- Prefer small, coherent commits at known-good checkpoints.

## Documentation Rules

Update documentation when changing:

- domain terminology or invariants;
- durable file formats;
- prompt-variable behavior;
- Batch compilation behavior;
- ComfyUI protocol assumptions;
- application responsibility boundaries;
- required development commands or dependencies.

Significant architectural decisions belong in `docs/adr/`.

Implementation plans for larger features may be stored under `docs/plans/`.

## Current Development Priority

The disposable remote ComfyUI spike has succeeded and remains isolated under `spikes/`.

The pure deterministic Batch compiler is implemented under `backend/`.

The Run filesystem store is implemented under `backend/`, including execution identity, canonical manifests, workflow and Workflow Profile snapshots, content-addressed Project assets, loading, and atomic filesystem publication.

The production ComfyUI adapter is implemented under `backend/`, including pure Workflow Profile core,
named Image Input, and typed scalar parameter mapping plus typed async HTTP/WebSocket operations. It
does not own scheduling, retries, execution-state persistence, or Run filesystem mutation.

The sequential Run executor is implemented under `backend/`, including versioned mutable execution state, queue-depth-1 Job orchestration, history reconciliation, and Result ingestion. It executes one published Run against one ComfyUI client and does not provide global scheduling or automatic recovery.

The first FastAPI application boundary is implemented under `backend/`. It exposes SQLite-backed
Project, Prompt, Workflow, Workflow Profile, and Saved Batch operations; Project Asset import; ComfyUI
status; Batch preview; durable Run creation and filesystem lookup; in-process background execution;
execution polling; and safe Result retrieval through narrow application services.

The first React frontend is implemented under `frontend/`. It provides one browser screen for ComfyUI
status, Project and library management, Saved Batch editing, Workflow Profile building, Profile-driven
named Image Input binding, deterministic Job preview, durable Run creation, execution polling, and
Result rendering. It uses the FastAPI application as its only backend boundary.

Generic Workflow Parameters Pass 3B-2 is implemented end to end. ProfileVersions store ordered typed
`{key,label,node_id,input_name,value_type}` parameter definitions beside core mappings and Image Input
slots. Editable Batch/API/Saved Batch bindings use either ordered explicit typed alternatives or a
numeric Range intent with decimal-text Start, End, Step, and independent Base inclusion. One backend
scaled-integer materializer resolves Range intent to explicit values before the existing compiler.
Unlinked parameters remain independent Cartesian dimensions; Batch-owned Linked Parameter Sets may
replace two or more parameters with one ordered row dimension at the earliest member's Profile position.
Every Job and Result provenance record still carries one resolved scalar or Base state per Profile
parameter. Manifest v9, Batch snapshot v6, browser working-session recovery v2, and the replacement
consolidated SQLite 0001 baseline are current. Recovery v2 stores editable intent and stable backend
identity pointers in localStorage, always invalidates Preview on cold load, and reconstructs execution
and Results from FastAPI. Enums, `/object_info`, LoRA discovery, random parameter values, linked Image
Inputs, Project-wide Run history, and backend executor restart recovery remain deferred. Keep
frontend HTTP types and UI state separate from backend compiler, filesystem, ComfyUI, execution, and
persistence rules.
