# batchcraft

**batchcraft** is a local-first experiment and batch orchestration application for ComfyUI.

It is intended for workflows where prompts, named image inputs, seeds, and other parameters change frequently and where manually queueing every combination in ComfyUI becomes cumbersome.

ComfyUI remains the workflow editor and generation engine. batchcraft sits above it to provide reusable prompts and variables, reference libraries, Batch compilation, queue orchestration, reproducible Runs, and visual result review.

> [!NOTE]
> AI was used to assist in coding this.
> Feel free to use/fork. I plan to continue working on this until it's in a somewhat stable condition.
> If you submit an issue/PR I will happily take a look, but no guarantees!
> Thanks for checking it out.

## Status

This source tree targets **v1.1.0**, source-only on macOS. See the
[v1.1.0 release notes](docs/V1_1_RELEASE_NOTES.md) for changes since v1.0.0 and upgrade precautions.
The [v1.1.0 GitHub Release page](https://github.com/pixeldj/batchcraft/releases/tag/v1.1.0)
is the publication point for release notes and source downloads.
The original [v1 cross-instance portability gate](docs/V1_CROSS_INSTANCE_ACCEPTANCE.md) passed with
owner-reported candidate acceptance, and ADR 0012 is Accepted. BC-025 in
[BACKLOG.md](docs/BACKLOG.md) preserves the historical v1.0.0 publication evidence.
Automated browser coverage is Chromium at desktop and mobile viewport sizes; this is not Safari or
Windows application acceptance.

The disposable remote ComfyUI spike, deterministic Batch compiler, Run filesystem store, production
ComfyUI adapter, sequential Run executor, FastAPI application boundary, and first React workflow are
complete. Owned v1 Projects can be imported from the configured Projects root and their historical
indexes rebuilt from filesystem truth.

The browser now supports ComfyUI status, SQLite-backed Project selection with create and explicit
filesystem adoption, Project image import and Profile-driven named Image Input binding,
Project-scoped Prompt, Workflow, and Workflow Profile libraries with immutable version history,
SQLite-backed Saved Batches with the Saved Batch selector, visual Workflow Profile building, ordered multi-prompt Batch
editing, deterministic Job preview, durable Run creation,
background execution start, Job progress, uncropped Result viewing, backend Random seed
materialization, and repeated Run creation. Random assigns one unique seed per final Job within
`0..2^53-1`; Run creation uses the exact assignments inspected in Preview.
Result review uses current-Run Results and Project-wide Gallery/Runs views with bounded pages of
48 Results or 25 Runs, Run-name/notes search, newest/oldest sorting, and typed historical provenance
filters. Job-level predicates must match the same Job, including each Result's producing Job.
Switching review views preserves the Batch draft, valid in-memory Preview, and execution monitoring.
History reads the index first, then reconciles on review activation and local Run publication/completion;
changed nonempty pages offer Refresh without moving the current inspection. Reindex Project remains
an explicit repair action. Image-first cards retain Job and integrity metadata in Result Details,
with Filter Gallery actions in both historical and current-Run Details and bounded history diagnostics.
Settings offers System, Light, or Dark appearance with nine curated palettes, stored per browser origin.
Explicit seeds accept inclusive ascending or descending shorthand such as `5-10` or `10-5`, mixed with
comma/newline-separated values. New frontend authoring is capped at 10,000 Explicit seeds before
expansion; Saved Batches and Run snapshots still store ordinary numeric arrays.
Frozen Run Plan inspection and explicit unavailable execution state remain available. The backend includes
mutable Project metadata, distinct ownerless adoption, immutable-version libraries, durable Saved Batches, and
rebuildable historical projections. `Load Run as Batch` restores editable intent, with detached-resource
relinking and explicit import; Random intent requests fresh seeds on Preview. Exact Rerun is deferred
beyond v1. Generated thumbnails, richer historical filter combinations, a global scheduler, and automatic
backend recovery remain deferred. Stop-after-current and local `Stop waiting` detach are supported;
neither interrupts ComfyUI.

## Install From Source (macOS)

v1.1.0 is source-only on macOS, not a standalone app bundle. Prerequisites: Git,
[`uv`](https://docs.astral.sh/uv/getting-started/installation/) with Python 3.13 or newer,
and Node.js with npm satisfying `^22.22.2 || ^24.15.0 || >=26.0.0`.
Node 24.15 or newer in the 24.x line is recommended for the locked frontend dependencies.

ComfyUI must be installed separately; see its [installation guide](https://docs.comfy.org/installation/overview).
batchcraft does not install GPUs, models, or custom nodes. Replace the URL below with the ComfyUI
engine's base URL reachable from this Mac, such as `http://<generation-host>:8188`, not batchcraft's URL.
Use the published `v1.1.0` tag for `--revision`; the command below targets that release.

```bash
git clone https://github.com/pixeldj/batchcraft.git
cd batchcraft
mkdir -p "$HOME/ai"
uv run --directory backend python -m tools.install_app \
  --app-path "$HOME/ai/batchcraft-app" \
  --data-root "$HOME/ai/batchcraft-data" \
  --comfyui-url "http://<generation-host>:8188" \
  --revision v1.1.0
```

`--revision` is optional and defaults to the source clone's `HEAD`, which is not a release guarantee.
Both destination paths must be absent. The installer creates a separate, commit-pinned Git worktree,
installs locked dependencies, builds the frontend, and creates a separate data root for SQLite and
Projects. Retain the source clone and its Git metadata: the installed worktree depends on them.

Double-click `app.command` in the installed `batchcraft-app` folder, or run:

```bash
"$HOME/ai/batchcraft-app/app.command"
```

Open `http://127.0.0.1:8000`. Access is loopback-only by default. Add `--lan-access` during installation
only for a trusted LAN: there is no authentication, and anyone who can reach the app can read or modify
data and start GPU Jobs. Do not expose it to the internet.

There are no automatic updates, and the installer does not reuse existing destinations. Before updating
an existing installation, finish active Runs, stop its backend, and back up the **entire data root**,
including SQLite and any sidecars plus Projects. v1.1.0 preserves the v1 filesystem formats but includes
forward SQLite migrations `0003_history_browsing` and `0004_history_provenance`. Returning to older code
after migration requires a deliberate restore of the matching whole-data backup, not just a Git revision
change. Follow [updating and backing up](docs/LOCAL_INSTANCES.md#updating-and-backing-up).

From the source checkout, after stopping daily and test backends, maintenance commands can refresh an
independent live-test candidate or update daily to a stable release:

```bash
uv run --directory backend python -m tools.refresh_test
uv run --directory backend python -m tools.update_daily --fetch
```

Test refresh defaults to committed `HEAD`, excludes uncommitted changes, replaces only validated test
folders, and copies daily data without modifying it. The candidate retains the live ComfyUI host; it is
not the fake-backed development sandbox. Daily updates accept only stable version tags, refuse downgrades,
and take a full data backup before changing code. Both require confirmation and leave servers stopped;
there is no automatic rollback. See [maintenance details and failure recovery](docs/LOCAL_INSTANCES.md#refresh-a-live-test-candidate).

### Development Sandbox

For fake-backed development without GPU work, install dependencies from the source repository root,
then launch:

```bash
uv sync --frozen --directory backend
npm ci --prefix frontend
./dev.command
```

See [`LOCAL_INSTANCES.md`](docs/LOCAL_INSTANCES.md) for instance isolation, shutdown, and browser testing.

## Run The API

For an everyday installation with optional trusted-LAN access, separate from this development checkout,
or browser testing with fake ComfyUI, see [`docs/LOCAL_INSTANCES.md`](docs/LOCAL_INSTANCES.md). The development launcher is
`./dev.command`; it uses its own data and does not submit GPU work. The commands below are the lower-level
API-only setup using a real ComfyUI client, not the isolated fake launcher. Starting it does not itself
submit a Job, but execution requests can submit GPU work. Use separate explicit data paths and avoid
ports already occupied by another instance.

From `backend/`:

```bash
BATCHCRAFT_PROJECTS_ROOT="/path/to/projects" \
BATCHCRAFT_DATABASE_PATH="/path/to/batchcraft.sqlite3" \
BATCHCRAFT_COMFYUI_BASE_URL="http://<windows-host>:8188" \
BATCHCRAFT_SERVER_PORT=8001 \
BATCHCRAFT_FRONTEND_ORIGIN="http://127.0.0.1:5174" \
uv run batchcraft-api
```

See [`docs/API.md`](docs/API.md) for configuration, endpoints, and current limitations.

## Run The Frontend

With the API running, use a second terminal from `frontend/`:

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:5174`. The development frontend defaults to the API at `http://127.0.0.1:8001`;
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

Variable Lists provide reusable authoring values. A Batch binding copies an ordered value list for one
placeholder; it does not retain Variable List identity or a separate expansion mode.

For example:

```text
animal   = [cat, dog, bird]
location = [park, forest]
```

These bindings produce six explicit prompt variants before execution. One value contributes one
variant, while multiple values form an ordered Cartesian dimension.

batchcraft does not rely on ComfyUI dynamic-prompt nodes for its core batching behavior.

## Named Image Inputs

A ProfileVersion defines zero or more ordered Image Input Slots with stable keys, editable labels, and
exact ComfyUI node/input targets. A Batch selects one or more ordered Reference Asset or Base workflow
alternatives for each slot.
Base workflow is stored as `null`, so execution performs no upload or mutation for that slot.

Each Image Input slot is an independent Cartesian dimension represented by the ordered `values` array
in its binding. Zipped, row-linked, and collection-link semantics remain deferred.

## Reproducibility

A Run is compiled before execution into explicit Jobs. Its plan and provenance freeze before scheduling, while execution status, timestamps, ComfyUI IDs, errors, and Results may advance. A Job must not depend on mutable UI state, implicit folder iteration, unresolved prompt placeholders, or random choices made later inside ComfyUI.

Completed Runs are saved in self-describing filesystem artifacts so historical experiments remain understandable and can be re-indexed if the local SQLite database is unavailable. Reproducibility preserves the execution specification and provenance; it does not promise byte-identical pixels across changes to ComfyUI, models, custom nodes, or GPU behavior.

A published Run uses this layout, with `execution.json` absent until execution state is written:

```text
projects/
└── <stable-project-key>/
    └── batches/
        └── <stable-batch-key>/
            └── 001-run/
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

Production code now includes pure prompt-variable resolution, deterministic Batch compilation, named
Image Input Slots, content-addressed Project assets, atomic durable Run publication, isolated ComfyUI
HTTP/WebSocket operations, sequential Run execution, SQLite-backed Projects, Prompts, Workflows,
Workflow Profiles, and Saved Batches, a thin FastAPI boundary under `backend/`, and the first browser
workflow under `frontend/`.

Project-wide Gallery/Runs browsing and typed provenance filtering are implemented. Later application
slices may add Exact Rerun, richer filter combinations, scheduler selection, and deeper Result review.

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for working conventions.

## License

batchcraft is licensed under GNU GPL version 3 only (`GPL-3.0-only`). See [`LICENSE`](LICENSE).
