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
- submitting Random seed intent and retaining Preview's exact materialized request for Run creation;
- compiled-job preview;
- Run progress visualization;
- Project history browsing and explicit reindex requests;
- Results Viewer;
- user actions such as rerun, pause, cancel, and selection.

The frontend must not communicate directly with ComfyUI.

### Backend

The backend owns:

- domain rules;
- persistence;
- prompt resolution;
- Random seed materialization for Preview;
- Batch compilation;
- Run creation;
- Job scheduling;
- ComfyUI communication;
- file upload/download;
- Run manifests;
- result ingestion;
- filesystem integrity;
- owned-v1 Project import and rebuildable historical projections.

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

Saved Batch definitions are durably persisted in SQLite with a monotonic `revision`. The browser also
retains one strict working-session recovery v4 record in `localStorage`. That record contains editable
Batch intent plus stable Project, Saved Batch, historical source Run, and current Run identity pointers.
It contains no Preview, execution, Job, Result, or frozen Run response. Linked Workflow/Profile JSON is
reconstructed by version ID; detached JSON remains editable draft state. Every cold load requires a new
Preview. Current Results reads backend-authoritative Run and Result data for the observed Run. The
Project History UI reads rebuildable SQLite projections derived from the Project filesystem and does
not require browser-held Run IDs. There is no Batch Results session gallery or restoration of older
Run IDs from browser storage.
Preview and Run creation use the same complete Batch request snapshot plus the required `batch_snapshot`
object. The frontend sends Random repetition
intent to Preview. The backend computes the complete non-seed expansion, materializes one unique seed per
Job, and returns the concrete ordered assignments. The frontend retains those assignments for Run
creation; the pure compiler never generates randomness. Successful Run publication freezes the durable execution plan and
provenance into `batchcraft.manifest` v1 with Batch snapshot v1. SQLite owns current Project metadata, the immutable-version Prompt,
Workflow, and Workflow Profile libraries, mutable Saved Batches, durable Run cancellation intent, and
non-authoritative historical projections. The Project filesystem remains authoritative for historical
provenance, execution outcomes, Asset bytes, and Result bytes.

Recovery retains key `batchcraft.working-session-recovery.v4` and schema v4. The existing strict reader
still requires `session_run_ids` to be an array of unique non-empty strings containing `current_run_id`
when non-null, including in older valid v4 records. The field is deprecated wire compatibility only:
it is not restored, exposed as public runtime `sessionRunIds`, or used for gallery membership or
prefetch. New writes contain `[]` when there is no current Run and `[current_run_id]` otherwise. Draft,
source-Run, Project, and Saved Batch recovery state remain intact. This cleanup requires no SQLite,
filesystem-format, or API DTO changes. ADR 0010 records the narrow amendment.

Historical Batch reconstruction is read-only until the user explicitly imports detached resources. The
backend classifies exact links and identity conflicts against SQLite while the frontend retains frozen
content as an unsaved draft. Preview and Run creation continue through the normal compiler boundary; no
historical execution bypass exists. Explicit copy imports use deterministic operation identities so an
ambiguous retry returns the same mutable resource. Draft-only historical import resolutions survive
browser recovery, including a Workflow copy completed before its dependent Profile copy.

Editable draft identity and the observed Run monitor are independent.
On startup and foreground re-entry, the frontend may discover the one process-local active Run from the
backend task registry. That Run takes monitor precedence over a different browser pointer; there is no
session gallery to retain the displaced pointer. Older Runs remain accessible through Project History.
Draft mismatch or transient Project/network failure never erases a recoverable pointer. Run and execution state hydrate before
Results, and transient startup reads use bounded retry with stale-response cancellation.

Thumbnail presentation omits visible `Verified` badges and `Job` captions while preserving info-popup
provenance, accessible descriptions, and lightbox labels. Integrity classification and strict Result
retrieval remain backend responsibilities; unavailable-artifact placeholders remain in the frontend.
Removing Batch Results does not remove current-Run cancellation or historical Run Plan/Result Details.

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

FastAPI starts a retained `asyncio.Task` for an accepted Run and returns immediately. The local-process registry permits at most one active Run, rejects duplicate or concurrent starts, observes task errors, and cancels tasks during shutdown. Start admission and discard-before-start use the same registry lock: discard cannot race execution start and independently requires absent or exactly pristine initial state with no active task for that Run. Discard writes terminal `cancelled` execution state without deleting the Run or changing frozen provenance.

Each active task also owns an in-process cancellation control initialized from SQLite. Durable `after_current_job` or `detach` request insertion and the short `preparing -> submitting` admission transition share one lock. A request therefore either wins before submission admission or observes that the current Job was already admitted; the lock is never held across the ComfyUI HTTP submission. After persisting `detach`, the registry targets only the owned local `asyncio.Task` with cancellation to wake an in-flight await. The executor recognizes that wake-up only when the same control reports durable detach intent, writes an honest blocked state, and leaves ordinary task cancellation to propagate. It preserves known submission evidence and Results, leaves later Jobs pending, and never interrupts ComfyUI or clears its queue. SQLite owns cancellation intent, while `batchcraft.execution` v1 in `execution.json` owns the resulting Run and Job outcomes. The registry is not durable scheduler state, and a restarted API refuses automatic recovery of non-created execution state. All prerelease execution formats are unsupported.

Execution API read models expose whether the current process still owns a live task. This ephemeral fact
is separate from durable Run status and remote ComfyUI state. A browser may use loss of local ownership
to stop stale polling and release workspace controls, but must not rewrite the Run, claim remote
cancellation, retry, or resubmit its Jobs.

The task registry exposes its current active Run ID for browser monitor discovery. This query is
process-local and disappears on backend restart; it is not a scheduler lease and makes no claim about a
previously submitted ComfyUI Job. A known browser pointer remains inspectable after that loss of local
ownership and is not erased merely because discovery returns no active task.

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
input. Every Profile Image Input slot and unlinked generic parameter is an independent ordered Cartesian
dimension. A Linked Parameter Set replaces its members with one row dimension at the earliest member's
Profile position. Every compiled Job contains one resolved value per slot and parameter. Parameter axes
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

A Run stores both the raw imported base API workflow and a separate raw snapshot of the Workflow Profile
mappings used to compile it. Strict v1 manifest descriptors identify their payload formats, fixed paths,
and hashes without wrapping or altering those directly usable payloads. Per-Job resolved friendly values
remain in the canonical JSON manifest.

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

Independent Batch/API/Saved Batch parameter bindings use
`{"parameter_key":"cfg","mode":"values","values":[null,7.0,7.5]}` or numeric Range intent shaped as
`{"parameter_key":"cfg","mode":"range","include_base":true,"range":{"start":"3.0","end":"7.0","step":"0.5"}}`.
One backend domain materializer converts Range intent through exact scaled-integer arithmetic into the
same ordered explicit alternatives before compilation. A Batch may instead cover two or more Profile
parameters with one Linked Parameter Set containing explicit typed rows. The compiler inserts that row
dimension at its earliest member in Profile order and skips the remaining members as independent axes.
Each compiled Job still carries one resolved scalar or Base state per Profile parameter.

## Saved Batch vs Run Boundary

Saved Batches are mutable SQLite intent; Runs are immutable filesystem provenance. The explicit
boundary between them is Preview. A Saved Batch may hold an incomplete editable state. Preview and
Run creation consume complete effective snapshots plus the `batch_snapshot`; Run publication freezes
the plan and provenance into manifest v1 with Batch snapshot v1. Editing a Saved Batch after Run creation never alters the
existing Run.

## Persistence Strategy

### SQLite

SQLite currently stores:

- projects;
- logical Prompts and immutable PromptVersions;
- logical Workflows and immutable WorkflowVersions;
- logical Workflow Profiles and immutable ProfileVersions tied to exact WorkflowVersions;
- mutable Saved Batches with ordered prompt, variable, named image, independent parameter bindings, and
  Linked Parameter Set rows;
- durable Run cancellation requests keyed by Run ID and mode: `after_current_job` and `detach`;
- rebuildable Project, Batch, Asset, Run, Job, parameter, Image Input, Asset-use, Result, and diagnostic
  historical projections.

Later migrations may add:

- Variable Lists;
- reference metadata;
- ratings and UI metadata.

### Filesystem

The filesystem stores durable Run artifacts and binaries:

- JSON manifest;
- optional secondary CSV manifest;
- Run metadata;
- workflow snapshot;
- Workflow Profile core mapping and named Image Input snapshot;
- strict v1 descriptors for raw snapshots and CSV;
- a fixed per-Job output prefix bound to Run and Job identity;
- immutable Project asset identities and hashes;
- downloaded outputs.

For published Runs, the filesystem artifacts contain enough information to reconstruct meaningful
history and rebuild SQLite historical projections. Exact replay also requires the referenced immutable
Project assets unless a self-contained export has copied them.

### Import and historical reads

Owned-v1 import accepts only a path-safe filesystem key naming an immediate, non-symlink Project
directory under the configured Projects root. It reads the existing `project.json` identity and does not
infer identity from a folder name. Ownerless adoption is a separate explicit mutation that requires a
user-supplied Project ID and name before it writes `project.json`.

The scanner classifies a structurally valid Run as `verified` or `degraded`; an invalid Run is omitted
from trusted projections and reported as a diagnostic. Missing or invalid `execution.json` is reported
as execution unavailable rather than fabricated as a durable outcome. Historical read-only loaders
strictly validate metadata while preserving it when output bytes are missing. Execution, cancellation,
discard, and Result download use strict content loaders and reject missing, corrupt, or unsafe required
content.

### Publication order

Run creation publishes a complete filesystem Run before execution, then best-effort refreshes the
Project's historical projection. Projection failure does not invalidate the authoritative published Run;
an explicit reindex repairs the projection.

Import and reindex scan filesystem truth, then atomically replace one Project's complete historical
projection. A failed scan or transaction leaves the prior projection intact. Incomplete staging data is
not a valid Run and must not be scheduled or presented as one.

## Identity and Display Names

Domain entities use stable internal IDs. Project and Batch filesystem paths use stable, path-safe
identities that do not change when a user edits a display name. A Run freezes its optional name,
optional description, and `NNN-<slug>` filesystem key at creation while retaining its Run ID as the
true identity.

Display names remain editable labels. Renaming a Project, Batch, Prompt Template, Variable List, Reference Collection, or Workflow Profile must not move historical Run directories or change references stored in existing Runs.
Historical Run directories are likewise never renamed; future mutable annotations must remain separate
from the frozen creation name and filesystem key.

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

The first executor uses `created`, `running`, `succeeded`, `failed`, `blocked`, and `cancelled` for Run state. Job state uses `pending`, `preparing`, `submitting`, `submitted`, `submission_unknown`, `succeeded`, `failed`, and `cancelled`. `submitting` is persisted before the network call so a crash during submission is never confused with a Job that was never submitted. A history timeout leaves an accepted Job in `submitted` with its prompt ID and blocks the Run. Blocked and unknown-submission states stop automatic execution but permit a future explicit reconciliation transition without weakening immutable succeeded/failed states. Local Job `cancelled` is restricted to work with no submission evidence and does not claim remote cancellation.

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
