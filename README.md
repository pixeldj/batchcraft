# batchcraft

**batchcraft** is a local-first experiment and batch orchestration application for ComfyUI.

It is intended for workflows where prompts, reference images, seeds, and other parameters change frequently and where manually queueing every combination in ComfyUI becomes cumbersome.

ComfyUI remains the workflow editor and generation engine. batchcraft sits above it to provide reusable prompts and variables, reference libraries, Batch compilation, queue orchestration, reproducible Runs, and visual result review.

## Status

Early design / architecture phase.

The current priority is to validate the remote ComfyUI integration boundary before scaffolding the full frontend and backend.

## Initial Deployment Model

```text
Mac
────────────────────────────────────────
Browser
   |
   v
batchcraft frontend
React + TypeScript
   |
   v
batchcraft backend
Python + FastAPI
   |
   +---- SQLite
   +---- project filesystem
   +---- prompt resolver
   +---- Batch compiler
   +---- scheduler
   +---- ComfyUI client
              |
              | HTTP + WebSocket over LAN
              v
Windows workstation
────────────────────────────────────────
ComfyUI
   |
   v
GPU / models / custom nodes
```

The browser does not communicate directly with ComfyUI. The backend owns the remote execution boundary.

## Core Model

```text
Project
├── Workflow Profiles
├── Prompt Templates
├── Variable Lists
├── Reference Assets / Collections
└── Batches
     └── Runs
          └── Jobs
               └── Results
```

Important semantics:

- **Batch**: editable experiment definition.
- **Run**: execution with a compiled plan that freezes at successful Run creation, before scheduling.
- **Job**: one fully resolved ComfyUI execution.
- **Result**: one artifact produced by a Job and ingested into the local project filesystem. A Job may produce multiple Results.

## Prompt Variables

Prompt Templates use simple named placeholders:

```text
A cinematic photo of {{animal}} in {{location}}.
```

Values are stored separately as structured Variable Lists. A Batch binds placeholders to selected values and determines expansion behavior.

For example:

```text
animal   = [cat, dog, bird]
location = [park, forest]
```

with both bindings set to `all` produces six explicit prompt variants before execution.

batchcraft does not rely on ComfyUI dynamic-prompt nodes for its core batching behavior.

## Reproducibility

A Run is compiled before execution into explicit Jobs. Its plan and provenance freeze before scheduling, while execution status, timestamps, ComfyUI IDs, errors, and Results may advance. A Job must not depend on mutable UI state, implicit folder iteration, unresolved prompt placeholders, or random choices made later inside ComfyUI.

Completed Runs are saved in self-describing filesystem artifacts so historical experiments remain understandable and can be re-indexed if the local SQLite database is unavailable. Reproducibility preserves the execution specification and provenance; it does not promise byte-identical pixels across changes to ComfyUI, models, custom nodes, or GPU behavior.

A typical Run will eventually resemble:

```text
projects/
└── <stable-project-key>/
    └── batches/
        └── <stable-batch-key>/
            └── run-001/
                ├── run.json
                ├── manifest.json
                ├── manifest.csv
                ├── workflow.json
                ├── workflow-profile.json
                └── outputs/
                    ├── 000001-01.png
                    └── 000002-01.png
```

Filesystem keys and internal IDs remain stable when editable Project or Batch display names change.

## Documentation

Project design documentation lives under [`docs/`](docs/):

- [`PRODUCT.md`](docs/PRODUCT.md)
- [`ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`DATA_MODEL.md`](docs/DATA_MODEL.md)
- [`PROMPT_VARIABLES.md`](docs/PROMPT_VARIABLES.md)
- [`BATCH_COMPILER.md`](docs/BATCH_COMPILER.md)
- [`COMFYUI_INTEGRATION.md`](docs/COMFYUI_INTEGRATION.md)
- [`FILE_FORMAT.md`](docs/FILE_FORMAT.md)
- [`DEVELOPMENT.md`](docs/DEVELOPMENT.md)
- [`adr/`](docs/adr/)

Coding agents must also read [`AGENTS.md`](AGENTS.md).

## Development Approach

The project will be built in narrow vertical slices.

The first technical milestone is a disposable ComfyUI integration spike that proves a Mac-hosted client can:

1. reach the remote ComfyUI instance;
2. upload a reference image;
3. modify a known API-format workflow;
4. submit it;
5. observe execution;
6. retrieve the generated result to the Mac.

After that boundary is proven, the first application slice will connect prompt-variable resolution, Batch compilation, remote execution, local result storage, and a minimal Results Viewer.

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for working conventions.
