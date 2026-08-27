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
- relevant records under `docs/adr/`

When documentation and implementation disagree, do not silently choose one. Identify the discrepancy and resolve it deliberately.

## Product Terminology

Use these terms consistently:

- **Project** — top-level workspace for related experiments.
- **Workflow Profile** — imported ComfyUI API workflow plus friendly mappings to selected workflow inputs.
- **Prompt Template** — versioned reusable prompt text that may contain `{{placeholder}}` references.
- **Variable List** — reusable ordered values that can be bound to a placeholder.
- **Reference Asset** — an input file, initially an image.
- **Reference Collection** — reusable grouping of Reference Assets.
- **Batch** — mutable experiment definition.
- **Run** — immutable compiled snapshot of a Batch.
- **Job** — one completely resolved ComfyUI execution.
- **Result** — one or more artifacts produced by a Job.

Do not casually introduce synonyms for these domain concepts.

## Core Invariants

These are architectural requirements, not implementation suggestions:

1. A Batch is mutable.
2. A Run is immutable after creation.
3. A Job is fully resolved before it reaches the scheduler.
4. No unresolved `{{placeholder}}` may be submitted to ComfyUI.
5. Random or sampled values, if supported later, must be resolved and stored before execution.
6. Editing a Prompt Template, Variable List, Reference Collection, Workflow Profile, or Batch must never alter an existing Run.
7. Rerunning creates a new Run rather than modifying the original.
8. Completed Run artifacts must contain enough information to understand and re-import the Run without SQLite.
9. SQLite is an application index/state store, not the sole historical source of truth.
10. batchcraft owns the logical queue; core behavior must not rely on self-requeueing ComfyUI nodes.
11. The frontend must not communicate directly with ComfyUI. ComfyUI integration belongs behind the backend client/service boundary.
12. ComfyUI remains the workflow editor. Do not build a competing node editor into batchcraft.
13. Preview and execution must use the same compiler/resolver logic.
14. Completed Run directories must never be silently rewritten.

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
- Validate at boundaries and fail with actionable errors rather than silently guessing.
- Preserve local-first operation. Do not introduce required cloud services without an explicit architectural decision.
- Avoid premature plugin systems, generic workflow engines, distributed queues, authentication systems, or multi-user architecture.
- Do not implement speculative roadmap features while completing a narrower task.

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

## Initial Development Priority

Before building the full application, prove the remote ComfyUI boundary with a small integration spike running from the Mac to the Windows ComfyUI host.

The spike should demonstrate:

1. connectivity;
2. input image upload;
3. API-workflow mutation through known mappings;
4. workflow submission;
5. prompt ID capture;
6. execution monitoring;
7. history/result inspection;
8. output download back to the Mac.

Do not let the spike grow into the production backend. Its purpose is to validate assumptions and inform the real integration layer.
