# batchcraft

**batchcraft** is a local-first experiment and batch orchestration application for ComfyUI.

It is intended for workflows where prompts, reference images, seeds, and other parameters change frequently and where manually queueing every combination in ComfyUI becomes cumbersome.

ComfyUI remains the workflow editor and generation engine. batchcraft sits above it to provide reusable prompts and variables, reference libraries, Batch compilation, queue orchestration, reproducible Runs, and visual result review.

## Status

Early production development.

The disposable remote ComfyUI spike, pure deterministic Batch compiler, Run filesystem store, production ComfyUI adapter, sequential Run executor, thin FastAPI application boundary, and first React workflow are complete.

The browser now supports ComfyUI status, ephemeral Batch editing, deterministic Job preview, durable Run creation, background execution start, Job progress, and Result viewing through the API. SQLite, durable editable Batch persistence, a global scheduler, and automatic recovery remain unimplemented.

## Run The API

From `backend/`:

```bash
BATCHCRAFT_PROJECTS_ROOT="/path/to/projects" \
BATCHCRAFT_COMFYUI_BASE_URL="http://<windows-host>:8188" \
uv run batchcraft-api
```

See [`docs/API.md`](docs/API.md) for configuration, endpoints, and current limitations.

## Run The Frontend

With the API running, use a second terminal from `frontend/`:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The frontend defaults to the API at `http://127.0.0.1:8000`;
`VITE_BATCHCRAFT_API_URL` overrides that address. See [`frontend/README.md`](frontend/README.md)
for frontend checks and first-slice limitations.

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
                ├── execution.json
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
- [`API.md`](docs/API.md)
- [`DEVELOPMENT.md`](docs/DEVELOPMENT.md)
- [`adr/`](docs/adr/)

Coding agents must also read [`AGENTS.md`](AGENTS.md).

## Development Approach

The project will be built in narrow vertical slices.

The first technical milestone was a disposable ComfyUI integration spike that proved a Mac-hosted client can:

1. reach the remote ComfyUI instance;
2. upload a reference image;
3. modify a known API-format workflow;
4. submit it;
5. observe execution;
6. retrieve the generated result to the Mac.

Production code now includes pure prompt-variable resolution, deterministic Batch compilation, content-addressed Project assets, atomic durable Run publication, isolated ComfyUI HTTP/WebSocket operations, sequential Run execution, a thin FastAPI boundary under `backend/`, and the first browser workflow under `frontend/`.

Later application slices will add SQLite-backed mutable application indexing, durable editable Batches, scheduler selection, and deeper Result review.

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for working conventions.
