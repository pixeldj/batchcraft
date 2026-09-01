# batchcraft Architecture

## Overview

batchcraft is a local-first web application hosted on the user's Mac and connected over the local network to ComfyUI on a Windows workstation.

```text
Mac
─────────────────────────────────────────
Browser
   |
   v
batchcraft frontend
React + TypeScript
   |
   v
batchcraft backend
FastAPI + Python
   |
   +---- SQLite
   +---- Project filesystem
   +---- Prompt Resolver
   +---- Batch Compiler
   +---- Job Scheduler
   +---- ComfyUI Client
                |
                | HTTP + WebSocket over LAN
                v
Windows workstation
─────────────────────────────────────────
ComfyUI
   |
   v
GPU / models / custom nodes
```

## Responsibility Boundaries

### Frontend

The frontend is responsible for:

- project navigation;
- prompt editing;
- Variable List management;
- named Image Input binding;
- Workflow Profile configuration;
- Batch construction;
- materializing Random seed intent into explicit values before Preview;
- compiled-job preview;
- Run progress visualization;
- Results Viewer;
- user actions such as rerun, pause, cancel, and selection.

The frontend must not communicate directly with ComfyUI.

### Backend

The backend owns:

- domain rules;
- persistence;
- prompt resolution;
- Batch compilation;
- Run creation;
- Job scheduling;
- ComfyUI communication;
- file upload/download;
- Run manifests;
- result ingestion;
- filesystem integrity.

The backend is the authoritative application API.

### ComfyUI

ComfyUI owns:

- workflow construction;
- node validation;
- model loading;
- custom nodes;
- GPU execution;
- native queue execution;
- generation artifacts before batchcraft retrieves them.

batchcraft should use normal ComfyUI API workflows rather than custom batchcraft nodes unless a future requirement cannot reasonably be implemented externally.

## Core Invariants

1. Batch is mutable.
2. A Run plan and its provenance freeze when successful Run creation completes, before scheduling begins.
3. Run execution state may advance without changing its frozen plan.
4. Job is fully resolved.
5. No unresolved prompt placeholder may reach ComfyUI.
6. A Run must be reconstructable and re-indexable from its saved artifacts.
7. Editing library content never changes a Run plan already created.
8. The logical queue belongs to batchcraft.
9. ComfyUI integration is isolated behind a client/service boundary.
10. Ambiguous ComfyUI submission failures are reconciled rather than blindly retried.
11. Completed Run directories are never silently rewritten.

## Backend Responsibilities

A reasonable initial backend module split is:

```text
backend/
└── batchcraft/
    ├── api/
    ├── application/
    ├── domain/
    ├── files/
    ├── comfyui/
    │   ├── client.py
    │   ├── workflow.py
    │   └── events.py
    └── execution/
        ├── models.py
        ├── state.py
        └── executor.py
```

This layout is illustrative, not mandatory. Avoid creating abstractions before behavior requires them.

The first application slice follows this split. `api/` owns HTTP DTOs, routes, status codes, CORS, configuration, and lifecycle. `application/` coordinates the existing production packages and provides narrow Run/asset discovery plus an in-process Run task registry. It contains no generic repository, command bus, event bus, or scheduler framework.

Saved Batch definitions are durably persisted in SQLite with a monotonic `revision`; the browser may
additionally retain a best-effort working draft and ordered Run identities in tab-scoped
`sessionStorage`, but it must compile that restored draft again before Run creation. The Run
identities rebuild a Batch-scoped working-session Results gallery from backend-authoritative Run and
Result data; they are not a Project-wide history index. Preview and Run creation use the same complete
Batch request snapshot plus the required `batch_snapshot` object. Frontend Random seed intent is
materialized before that snapshot reaches the API; the backend and pure compiler receive only concrete
Fixed or Explicit seed input. Successful Run publication freezes the durable execution plan and
provenance into manifest v7 with Batch snapshot v5. SQLite now owns current Project metadata, the immutable-version Prompt,
Workflow, and Workflow Profile libraries, and mutable Saved Batches; searchable filesystem-derived
indexes remain a later slice.

## Application Queue

batchcraft should not dump an entire large Run into ComfyUI's native queue by default.

Instead, maintain an application-level scheduler:

```text
Run
 |
 v
Pending Jobs in batchcraft
 |
 | submit up to configured queue depth
 v
ComfyUI queue
 |
 v
execution events/history
 |
 v
Result ingestion
 |
 v
submit next Job
```

Initial queue depth should be configurable, with `1` as a safe default.

The first production executor fixes queue depth at exactly `1` and executes one published Run. It submits the next Job only after history proves the prior Job succeeded and every discovered Result is durable. Global Run selection, prioritization, concurrency, retries, and automatic recovery remain outside this layer.

FastAPI starts a retained `asyncio.Task` for an accepted Run and returns immediately. The local-process registry permits at most one active Run, rejects duplicate or concurrent starts, observes task errors, and cancels tasks during shutdown. Start admission and discard-before-start use the same registry lock: discard cannot race execution start and independently requires absent or exactly pristine initial state with no active task for that Run. Discard writes terminal `cancelled` execution state without deleting the Run or changing frozen provenance. The registry is not durable scheduler state: execution format v2 in `execution.json` remains authoritative, and a restarted API refuses automatic recovery of non-created execution state. Execution v1 is intentionally unsupported.

Benefits:

- pause future submissions;
- cancel not-yet-submitted Jobs;
- isolate frozen Run plans from UI edits;
- maintain accurate local state;
- avoid flooding a remote ComfyUI queue;
- support future prioritization and multiple Runs.

## Prompt Resolution Boundary

Prompt Templates use named placeholders such as:

```text
A photo of {{animal}} in {{location}}.
```

Structured Variable Lists provide values.

Within Batch compilation, the Prompt Resolver produces explicit resolved prompt variants.

The Batch Compiler then combines dimensions in this order:

```text
PromptVersion -> prompt variables -> Image Input slots -> parameters -> seeds
```

PromptVersion is the first Batch dimension. Selected PromptVersions preserve user order, and each is
templated independently against the bindings it references. The rightmost dimension varies fastest.
Each compiled Job still resolves to one final prompt string mapped to one friendly workflow prompt
input. Every Profile Image Input slot and generic parameter is an independent ordered Cartesian
dimension, while every compiled Job contains one resolved value per slot and parameter. Parameter axes
follow Profile order, and seeds remain the fastest-varying dimension. Editable numeric Range intent is
materialized into explicit parameter alternatives before this compiler boundary. Multiple workflow
prompt or text slots are deferred.

No prompt expansion should occur inside ComfyUI for core batchcraft functionality.

## Workflow Profile Boundary

A logical Workflow Profile belongs to one Project-scoped Workflow. Its immutable versions each target
one exact immutable WorkflowVersion and store a complete `{id, name, mappings, image_inputs, parameters}` snapshot. Changing a
WorkflowVersion never edits or retargets an existing ProfileVersion.

Logical Profiles remain discoverable when the selected WorkflowVersion has no compatible
ProfileVersion. The frontend derives a visual node/input catalog from the selected immutable API-format
WorkflowVersion and writes the Profile JSON contract; it does not introduce a second mapper
state or infer workflow intent at execution time. Connected inputs are visible but unavailable as
writable targets. Raw generated Profile JSON is an advanced read-only view.

The frontend may prefill mappings from the latest active prior version into a review editor for a new
version under the same logical Profile. Valid mappings remain selected, missing nodes or inputs are
marked for repair, and no ProfileVersion is persisted until the user submits the reviewed mapping.
A Workflow Profile snapshot stores:

- friendly exposed input definitions;
- mappings from those inputs to node IDs and input fields;
- an ordered array of named image inputs and their exact workflow targets;
- an ordered array of typed generic parameters and their exact literal workflow targets.

The separately selected WorkflowVersion supplies the complete immutable API-format ComfyUI workflow.
The current Profile contract requires core `prompt`, `seed`, and `output_prefix` mappings. It also
requires an `image_inputs` array, which may contain zero or more ordered entries shaped as
`{key, label, node_id, input_name}`. Keys use lowercase readable snake case, start with a letter, and
are unique. The Profile Builder derives a key from the first label and keeps it stable through later
label edits.
The required `parameters` array may also be empty. Each entry has `key`, `label`, `node_id`,
`input_name`, and `value_type`. Supported types are `string`, `integer`, `float`, and `boolean`.
Core mappings, Image Input slots, and generic parameters share one writable-target uniqueness rule.

A Workflow/Profile pair may be the active selection on a mutable Saved Batch; that mutable selection
state does not change how the immutable version snapshots are stored or validated.

A Run stores both the imported base API workflow and a separate snapshot of the Workflow Profile
mappings used to compile it. Per-Job resolved friendly values remain in the canonical JSON manifest.

Example mapping:

```json
{
  "mappings": {
    "prompt": {"node_id": "104", "input_name": "text", "value_type": "string"},
    "seed": {"node_id": "114", "input_name": "seed", "value_type": "integer"},
    "output_prefix": {
      "node_id": "309",
      "input_name": "filename_prefix",
      "value_type": "string"
    }
  },
  "image_inputs": [
    {"key": "identity", "label": "Identity", "node_id": "221", "input_name": "image"},
    {"key": "pose", "label": "Pose", "node_id": "225", "input_name": "image"}
  ],
  "parameters": [
    {"key": "cfg", "label": "CFG", "node_id": "114", "input_name": "cfg", "value_type": "float"},
    {"key": "steps", "label": "Steps", "node_id": "114", "input_name": "steps", "value_type": "integer"}
  ]
}
```

Jobs refer to friendly exposed fields. ComfyUI-specific node mutation happens inside the workflow adapter.

Batch/API/Saved Batch image bindings are entries shaped as
`{"slot_key": "identity", "values": [null, "asset-a", "asset-b"]}`. Every Profile slot requires one
or more ordered, unique alternatives and forms an independent Cartesian dimension. JSON `null` means
Base workflow, so the executor performs no upload and the adapter leaves that target unchanged for that
concrete Job.

Batch/API/Saved Batch parameter bindings use
`{"parameter_key":"cfg","mode":"values","values":[null,7.0,7.5]}` or numeric Range intent shaped as
`{"parameter_key":"cfg","mode":"range","include_base":true,"range":{"start":"3.0","end":"7.0","step":"0.5"}}`.
One backend domain materializer converts Range intent through exact scaled-integer arithmetic into the
same ordered explicit alternatives before compilation. Every parameter forms an independent Cartesian
dimension in Profile order. Each compiled Job carries one resolved scalar or Base state per parameter.

## Saved Batch vs Run Boundary

Saved Batches are mutable SQLite intent; Runs are immutable filesystem provenance. The explicit
boundary between them is Preview. A Saved Batch may hold an incomplete editable state. Preview and
Run creation consume complete effective snapshots plus the `batch_snapshot`; Run publication freezes
the plan and provenance into manifest v7 with Batch snapshot v5. Editing a Saved Batch after Run creation never alters the
existing Run.

## Persistence Strategy

### SQLite

SQLite currently stores:

- projects;
- logical Prompts and immutable PromptVersions;
- logical Workflows and immutable WorkflowVersions;
- logical Workflow Profiles and immutable ProfileVersions tied to exact WorkflowVersions;
- mutable Saved Batches with ordered prompt, variable, named image, and typed parameter-alternative bindings.

Later migrations may add:

- Variable Lists;
- reference metadata;
- Run index/status;
- Job index/status;
- Result index;
- ratings and UI metadata.

### Filesystem

The filesystem stores durable Run artifacts and binaries:

- JSON manifest;
- CSV manifest;
- Run metadata;
- workflow snapshot;
- Workflow Profile core mapping and named Image Input snapshot;
- immutable Project asset identities and hashes;
- downloaded outputs.

For completed Runs, the filesystem artifacts must contain enough information to reconstruct meaningful history and rebuild the SQLite index. Exact replay also requires the referenced immutable Project assets unless a self-contained export has copied them.

### Publication order

Run creation currently publishes a complete filesystem Run before execution; Phase 1 does not add a
SQLite Run index. When that derived index is implemented, indexing must follow filesystem publication,
and the scheduler must not submit Jobs until both steps succeed.

If SQLite state is lost or incomplete, batchcraft can scan complete filesystem Runs and re-index them. Incomplete staging data is not a valid Run and must not be scheduled or presented as one.

## Identity and Display Names

Domain entities use stable internal IDs. Filesystem paths use stable, path-safe identities that do not change when a user edits a display name.

Display names remain editable labels. Renaming a Project, Batch, Prompt Template, Variable List, Reference Collection, or Workflow Profile must not move historical Run directories or change references stored in existing Runs.

## Local-First Behavior

The initial product requires no external cloud service.

All batchcraft state resides on the Mac.

The Windows workstation is an execution target rather than the permanent archive.

Downloaded outputs under the batchcraft project directory are the application-owned copies.

## Network Model

Initial assumptions:

- batchcraft backend runs on the Mac;
- ComfyUI runs on a trusted LAN workstation;
- the backend is configured with a ComfyUI base URL;
- ComfyUI is reachable from the Mac;
- Windows Firewall should scope ComfyUI access to the trusted LAN or specific Mac where practical.

Do not design the initial application as if the ComfyUI endpoint is safely exposed to the public Internet.

## Failure Model

The scheduler must distinguish at least:

```text
pending
submission_unknown
submitted
running
succeeded
failed
cancelled
```

`submission_unknown` means the submission outcome was ambiguous and requires reconciliation. It is not a signal to retry.

The first executor uses `created`, `running`, `succeeded`, `failed`, and `blocked` for Run state. Job state uses `pending`, `preparing`, `submitting`, `submitted`, `submission_unknown`, `succeeded`, and `failed`. `submitting` is persisted before the network call so a crash during submission is never confused with a Job that was never submitted. A history timeout leaves an accepted Job in `submitted` with its prompt ID and blocks the Run. Blocked and unknown-submission states stop automatic execution but permit a future explicit reconciliation transition without weakening immutable succeeded/failed states.

A backend restart should eventually be able to reconcile submitted/running Jobs against ComfyUI history.

Graceful recovery may be limited in the first vertical slice, but Run and Job states must be explicit enough to add reconciliation without redesigning the data model.

A timeout or disconnect during submission is not proof that ComfyUI rejected the Job. The scheduler must record the uncertain state and reconcile it through available prompt IDs, queue data, history, and output metadata. It must not blindly submit the Job again.

## Technology Defaults

Initial preferred stack:

- Frontend: React + TypeScript
- Backend: Python + FastAPI
- Database: SQLite
- HTTP client: `httpx`
- Python project management: `uv`

These are implementation defaults, not product requirements.

## Architectural Decision Records

Significant decisions should be captured under `docs/adr/`.

Examples:

- why Run plans freeze before scheduling;
- why prompt expansion occurs in batchcraft;
- why completed Run history is filesystem-recoverable;
- why the browser does not communicate directly with ComfyUI.
