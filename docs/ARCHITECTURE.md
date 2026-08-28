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
- reference selection;
- Workflow Profile configuration;
- Batch construction;
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

Mutable Batch definitions are not durably persisted in this slice. The browser may retain a
best-effort working draft and ordered Run identities in tab-scoped `sessionStorage`, but it must
compile that restored draft again before Run creation. The Run identities rebuild a Batch-scoped
working-session Results gallery from backend-authoritative Run and Result data; they are not a
Project-wide history index. Preview and Run creation use the same complete Batch request snapshot,
while successful Run publication freezes the durable execution plan and provenance. SQLite remains
the intended later home for mutable Batch and searchable application state.

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

FastAPI starts a retained `asyncio.Task` for an accepted Run and returns immediately. The local-process registry permits at most one active Run, rejects duplicate or concurrent starts, observes task errors, and cancels tasks during shutdown. It is not durable scheduler state: `execution.json` remains authoritative, and a restarted API refuses automatic recovery of non-created execution state.

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
PromptVersion -> prompt variables -> reference bindings -> seeds -> parameter sweeps
```

The rightmost dimension varies fastest. Every dimension preserves user selection order. v1 supports one PromptVersion mapped to one friendly prompt input; multiple workflow prompt or text slots are deferred.

No prompt expansion should occur inside ComfyUI for core batchcraft functionality.

## Workflow Profile Boundary

A Workflow Profile stores:

- an API-format ComfyUI workflow snapshot or version reference;
- friendly exposed input definitions;
- mappings from those inputs to node IDs and input fields;
- metadata describing required input types.

A Run stores both the imported base API workflow and a separate snapshot of the Workflow Profile mappings used to compile it. Per-Job resolved friendly values remain in the canonical JSON manifest.

Example mapping:

```json
{
  "prompt": {
    "node_id": "104",
    "input": "text",
    "type": "string"
  },
  "reference_image": {
    "node_id": "221",
    "input": "image",
    "type": "image"
  }
}
```

Jobs refer to friendly exposed fields. ComfyUI-specific node mutation happens inside the workflow adapter.

## Persistence Strategy

### SQLite

SQLite stores searchable, mutable application state such as:

- projects;
- Prompt Templates and versions;
- Variable Lists;
- reference metadata;
- Workflow Profiles;
- Batch definitions;
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
- Workflow Profile mapping snapshot;
- immutable Project asset identities and hashes;
- downloaded outputs.

For completed Runs, the filesystem artifacts must contain enough information to reconstruct meaningful history and rebuild the SQLite index. Exact replay also requires the referenced immutable Project assets unless a self-contained export has copied them.

### Publication order

Run creation publishes a complete filesystem Run before adding its SQLite index records. The scheduler cannot submit Jobs until publication and indexing both succeed.

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
