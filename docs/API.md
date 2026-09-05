# Application API

## Scope

The first application boundary exposes the production compiler, Run filesystem store, execution state, sequential executor, and ComfyUI adapter through FastAPI.

The API is a local single-user development boundary. The first React frontend consumes it, and the
browser never communicates directly with ComfyUI. SQLite owns current Project metadata, Prompt,
Workflow, and Workflow Profile libraries, Saved Batches, durable Run cancellation intent, and rebuildable
historical projections. Project filesystem records remain authoritative for historical provenance,
execution outcomes, Assets, and Results.
Authentication, a global scheduler, executor restart recovery, force-stopping local waiting, and remote
ComfyUI interruption remain deferred. Stop-after-current cancellation is available at the backend boundary.

## Local Startup

From `backend/`:

```bash
BATCHCRAFT_PROJECTS_ROOT="/path/to/projects" \
BATCHCRAFT_DATABASE_PATH="/path/to/batchcraft.sqlite3" \
BATCHCRAFT_COMFYUI_BASE_URL="http://<windows-host>:8188" \
uv run batchcraft-api
```

The OpenAPI document is available at `/docs` while the server is running.

## Configuration

For direct `batchcraft-api` startup, configuration is read centrally from environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BATCHCRAFT_DATA_ROOT` | `data` | Default root for application data |
| `BATCHCRAFT_DATABASE_PATH` | `<data-root>/batchcraft.sqlite3` | SQLite application-state database |
| `BATCHCRAFT_PROJECTS_ROOT` | `<data-root>/projects` | Project and Run filesystem root; independently configurable |
| `BATCHCRAFT_COMFYUI_BASE_URL` | `http://127.0.0.1:8188` | Backend-owned ComfyUI endpoint |
| `BATCHCRAFT_COMFYUI_TIMEOUT` | `30` | ComfyUI HTTP timeout in seconds |
| `BATCHCRAFT_WEBSOCKET_TIMEOUT` | `21600` | Advisory WebSocket observation bound |
| `BATCHCRAFT_HISTORY_TIMEOUT` | `21600` | Authoritative history reconciliation bound |
| `BATCHCRAFT_HISTORY_POLL_INTERVAL` | `1` | History polling interval in seconds |
| `BATCHCRAFT_FRONTEND_ORIGIN` | `http://localhost:5173` | Allowed local development CORS origin |
| `BATCHCRAFT_SERVER_HOST` | `127.0.0.1` | API bind host |
| `BATCHCRAFT_SERVER_PORT` | `8000` | API bind port |

The real ComfyUI host is never committed to repository configuration.

The frontend API client defaults to an empty base URL for same-origin requests. The checked-in
`.env.development` explicitly selects `http://127.0.0.1:8001`; the everyday installer builds with
`VITE_BATCHCRAFT_API_URL='/'` to select same-origin requests even in pinned older client code. Set
`VITE_BATCHCRAFT_API_URL` at build time to use another API address. For cross-origin requests, the
frontend's browser origin must match `BATCHCRAFT_FRONTEND_ORIGIN`.

The isolated launchers use explicit settings rather than inherited data and host overrides; see
[`LOCAL_INSTANCES.md`](LOCAL_INSTANCES.md). Their `settings_for(..., lan_access: bool = False)` option
allows only the everyday app to bind `0.0.0.0:8000`, all IPv4 interfaces. The everyday `app.local.json`
accepts optional boolean `lan_access`, defaulting to `false` when omitted. Development and test remain
loopback-only and reject LAN access. Same-origin everyday requests need no additional CORS origin;
no wildcard CORS or authentication is added. Enable this only on a trusted LAN: anyone who can reach
the app can read and modify data and start GPU Jobs. Do not port-forward it or expose it to the internet.

## Endpoints

```text
GET  /api/health
GET  /api/comfyui/status
GET  /api/projects
POST /api/projects
POST /api/projects/adopt
POST /api/projects/import
GET  /api/projects/adoptable
GET  /api/projects/{project_id}
POST /api/projects/{project_id}/reindex
GET  /api/projects/{project_id}/runs
PATCH /api/projects/{project_id}
POST /api/projects/{project_id}/archive
GET  /api/projects/{project_id}/prompts
POST /api/projects/{project_id}/prompts
GET  /api/prompts/{prompt_id}
PATCH /api/prompts/{prompt_id}
POST /api/prompts/{prompt_id}/archive
GET  /api/prompts/{prompt_id}/versions
POST /api/prompts/{prompt_id}/versions
GET  /api/prompt-versions/{version_id}
POST /api/prompt-versions/{version_id}/archive
POST /api/prompt-versions/{version_id}/restore
GET  /api/projects/{project_id}/workflows
POST /api/projects/{project_id}/workflows
GET  /api/workflows/{workflow_id}
PATCH /api/workflows/{workflow_id}
POST /api/workflows/{workflow_id}/archive
GET  /api/workflows/{workflow_id}/versions
POST /api/workflows/{workflow_id}/versions
GET  /api/workflow-versions/{version_id}
POST /api/workflow-versions/{version_id}/archive
GET  /api/workflows/{workflow_id}/profiles
POST /api/workflows/{workflow_id}/profiles
GET  /api/workflow-profiles/{profile_id}
PATCH /api/workflow-profiles/{profile_id}
POST /api/workflow-profiles/{profile_id}/archive
GET  /api/workflow-profiles/{profile_id}/versions
POST /api/workflow-profiles/{profile_id}/versions
GET  /api/workflow-profile-versions/{version_id}
POST /api/workflow-profile-versions/{version_id}/archive
GET  /api/projects/{project_key}/assets
POST /api/projects/{project_key}/assets
GET  /api/projects/{project_key}/assets/{asset_id}/content
GET  /api/projects/{project_id}/batches
POST /api/projects/{project_id}/batches
GET  /api/projects/{project_id}/batches/adoptable
POST /api/projects/{project_id}/batches/adopt
GET  /api/batches/{batch_id}
PATCH /api/batches/{batch_id}
POST /api/batches/{batch_id}/archive
POST /api/batches/preview
POST /api/runs
GET  /api/runs/{run_id}
GET  /api/runs/{run_id}/batch-reconstruction
POST /api/runs/{run_id}/batch-reconstruction/prompt-versions/{position}/import-copy
POST /api/runs/{run_id}/batch-reconstruction/workflow-version/import-copy
POST /api/runs/{run_id}/batch-reconstruction/workflow-profile-version/import-copy
POST /api/runs/{run_id}/execute
GET  /api/executions/active
POST /api/runs/{run_id}/discard
POST /api/runs/{run_id}/cancel
GET  /api/runs/{run_id}/execution
GET  /api/runs/{run_id}/results
GET  /api/runs/{run_id}/results/{job_ordinal}/{artifact_ordinal}
```

The API applies the current SQL migrations and any future contiguous migrations before
accepting requests. Startup fails on migration errors, unsupported migration history, gaps, or changed
checksums. It never deletes or rewrites an unsupported database automatically. Request handlers run
each synchronous SQLite store operation through a worker thread rather than blocking the event loop.
`0001_initial.sql` is the preserved user-data baseline. `0002_historical_projections.sql` adds rebuildable
historical tables without replacing existing user data. Applied migration bytes are immutable; future
user-database changes add the next contiguous migration. Temporary test databases may be recreated.

## Projects And Prompts

Project creation publishes the immutable `project.json` owner binding before inserting current
metadata into SQLite. If the insert fails, the owner remains available for explicit adoption through
`POST /api/projects/adopt`. Adoption preserves a valid existing owner. An ownerless asset directory
requires an explicit adoption request containing a user-supplied Project ID and name; batchcraft does
not infer or generate that identity from the directory, assets, or history. Only that action creates
its stable owner binding. Normal creation refuses to claim a pre-existing ownerless directory.
Project rename and description changes update SQLite without rewriting the owner file or historical
Runs.

`POST /api/projects/import` is distinct from adoption. It accepts only `{ "filesystem_key": "..." }`,
requires an existing valid `batchcraft.project` v1 owner in an immediate non-symlink directory under the
configured Projects root, and uses that owner ID and initial name. It never infers or creates identity.
The response reports Project ID/key/name plus discovered Batch, Asset, Run, and diagnostic counts.
Identity conflicts return `409 project_import_conflict`; unsafe, missing, malformed, or ownerless Projects
return `422 project_import_failed` without partial projection replacement.

`GET /api/projects/adoptable` performs a read-only scan of immediate directories under the configured
Projects root. It returns valid owner bindings with their Project ID and initial name, plus ownerless
directories with both fields set to `null`. The response is ordered by filesystem key. It omits files,
symlinks, unsafe names, malformed owners, and any candidate whose key is already registered in SQLite.
An owned candidate is also omitted when its Project ID is registered under another key. Active and
archived SQLite Projects apply to both filters. Discovery does not inspect assets or Runs and does not
create the Projects root, owner files, or SQLite rows.

Creating a Prompt atomically creates PromptVersion 1. Prompt names and descriptions are mutable;
PromptVersion text, name snapshot, note, version number, and creation timestamp are immutable.
Saving text creates the next monotonic version. Archiving hides records from lists by default, and
restoring an older version creates a new version with the current Prompt name snapshot. Add
`include_archived=true` to Project, Prompt, or PromptVersion list requests when archived records are
needed.

Every Prompt library version response includes `placeholders`, an ordered list derived from immutable
template text by the compiler's authoritative parser. Names preserve first occurrence, exact case, and
omit repeats. Malformed templates return an empty assistance list; Preview and Run compilation remain
the final validation authority and report the malformed syntax.

`GET /api/projects/{project_id}/prompts` returns each Prompt with `latest_active_version`. This field
contains the complete highest-numbered non-archived PromptVersion, including its `name_snapshot`, or
`null` when every version is archived. The Prompt's `include_archived` filter is independent: an
archived Prompt included by that option can still have a non-archived latest version. Direct Prompt
responses do not include this list-only field.

## Workflows And Profiles

Creating a Workflow atomically creates WorkflowVersion 1 from validated API-format JSON. Workflow
names and descriptions are mutable; version JSON, hash, parent identities, name snapshot, note,
version number, and creation time are immutable. Explicit duplicate saves allocate another monotonic
version. `GET /api/projects/{project_id}/workflows` includes the latest non-archived version.

A Workflow Profile belongs to one Workflow and Project. Creating a Profile atomically creates its
first immutable ProfileVersion against one exact WorkflowVersion. Create and version requests accept a
`mappings` object, an `image_inputs` array, and a required `parameters` array. Version responses return
a complete Run-compatible `profile` snapshot with `id`, `name`, `mappings`, `image_inputs`, and
`parameters`, plus `content_sha256` and all
parent identities. A target from another logical Workflow is
rejected. Filtering `GET /api/workflows/{workflow_id}/profiles` by `workflow_version_id` retains every
logical Profile for the Workflow and exposes its latest compatible version as
`latest_compatible_version`, or `null` when no version targets that WorkflowVersion. A client can use
an earlier ProfileVersion's mappings to create a new immutable version under the same logical Profile;
the API validates those mappings against the new target WorkflowVersion.

The current core mapping contract requires exactly `prompt`, `seed`, and `output_prefix`. Unknown
mapping names are rejected. Every mapping names a node ID, input name, and expected value type, must
target an input on the exact WorkflowVersion, and must not target a ComfyUI connection array.

`image_inputs` is ordered and may be empty. Each entry has exactly `key`, `label`, `node_id`, and
`input_name`. Keys use readable lowercase ASCII snake case, start with a letter, and are unique within
the Profile. Image inputs must target distinct literal inputs and cannot reuse core mapping targets.
Each parameter entry has exactly `key`, `label`, `node_id`, `input_name`, and `value_type`. Supported
types are `string`, `integer`, `float`, and `boolean`. The target must hold a compatible literal base
value. Core mappings, Image Input slots, and parameters cannot share targets.

Archive operations set archive timestamps through `POST .../archive`; they do not delete historical
versions. Canonical JSON and stored hashes are checked when versions are read.

`POST /api/batches/preview` and `POST /api/runs` accept the same complete Batch request shape plus a
required `batch_snapshot` v1 object containing `format: "batchcraft.batch-snapshot"`,
`format_version: 1`, and the full editable Saved Batch state. The request carries
Project and Batch identity, an ordered `prompt_versions` array with stable ID, frozen name, and
template text, canonical variable bindings shaped as `{ "placeholder": string, "values": string[] }`,
ordered image bindings shaped as `{ "slot_key": string, "values": [asset_id | null] }`, seed input,
ordered independent parameter bindings using the discriminated `values` or `range` shapes documented
below, ordered `linked_parameter_sets`, the
API-format workflow, and its Workflow Profile snapshot. The singular `prompt_version` field is not
accepted.
The `batch_snapshot` records editable seed intent. Random intent is
`{ "mode": "random", "values": [], "random_seed_count": N }`; it does not store Preview seeds.

Preview calls the production Batch compiler, validates the exact workflow/Profile pair through the
same preparation logic as Run creation, and returns every resolved Job in deterministic order. For an
unmaterialized Random request, Preview computes the final Job count and assigns one unique seed per Job
within `0..2^53-1`. The response's ordered Job seeds are the concrete assignments the client must send
back in `seeds.values` for Run creation while preserving `mode: "random"` and `random_seed_count`.
Each Preview Job includes `prompt_version_id` and `prompt_version_name`; clients do not infer source
identity from resolved text. Run creation compiles and validates the request again, resolves existing
Project assets, and publishes through `RunFilesystemStore`. `POST /api/runs` accepts optional
`run_name` and `run_description` fields in addition to the unchanged Batch request fields. These values
are creation metadata and do not participate in Preview or compilation.
The Run creation and lookup responses include immutable `run_name`, `run_description`, and
`filesystem_key` provenance. `GET /api/runs/{run_id}` additionally returns the
ordered frozen PromptVersion snapshots, each Job ordinal's PromptVersion ID association, and a
`plan` projection loaded from the published Run manifest. The plan contains compiler warnings and
every concrete Job's resolved prompt, resolved variables, ordered `resolved_image_inputs`, ordered
scalar `resolved_parameters`, selected `resolved_parameter_sets` row provenance, and
materialized seed. Each resolved image entry has `slot_key`, frozen `label`, nullable `asset_id`, and a
nullable frozen filename. The required `batch_snapshot` exposes canonical
editable intent, including optional frozen Workflow/Profile display labels and version numbers. The
Run loader supports `batchcraft.manifest` v1 with Batch snapshot v1; unsupported identities or versions
make the Run invalid rather than producing a partial response.

## Project Assets

`POST /api/projects/{project_key}/assets` accepts one or more multipart fields named `files`.
Uploads are copied into request-scoped temporary files and then imported through
`ProjectAssetStore.import_file()`. The API accepts PNG, JPEG, and WebP only when the filename
extension, declared content type, and file signature agree. Content-addressed import retains the
existing deduplication behavior: importing identical bytes returns the original Asset record.

`GET /api/projects/{project_key}/assets` returns image Asset metadata without local filesystem
paths. Results are ordered by creation time newest first, then SHA-256 ascending. Discovery validates
metadata version, identity, stored path, location, regular-file status, and byte size without hashing
every image. Invalid unrelated records are omitted; duplicate valid Asset IDs make the Project asset
data invalid.

`GET /api/projects/{project_key}/assets/{asset_id}/content` resolves only an Asset in the requested
Project, performs full size and SHA-256 verification through `ProjectAssetStore.load()`, rejects
unsafe files, and verifies the selected image signature before serving it. Arbitrary local paths are
never accepted.

A missing Project has an empty asset listing. Import requires an existing valid `batchcraft.project` v1
owner and writes `batchcraft.asset` v1 metadata bound to that Project identity. SQLite-backed Project
creation/adoption or successful Run publication creates the owner binding.

## Saved Batch Persistence

SQLite now owns mutable Saved Batches under Projects. Each Saved Batch has a stable root record with
a monotonic `revision`; concurrent conflicting saves return
`409 { "error": { "code": "saved_batch_revision_conflict" } }` rather than silently overwriting.
Structural integrity violations return `422 { "error": { "code": "saved_batch_integrity_error" } }`.

`GET /api/projects/{project_id}/batches` lists a Project's Saved Batches; `POST` creates one.
`GET /api/projects/{project_id}/batches/adoptable` scans for unregistered Batch filesystem keys, and
`POST /api/projects/{project_id}/batches/adopt` explicitly binds one. `GET /api/batches/{batch_id}`
returns a single Saved Batch; `PATCH` updates it with the client-held `revision`; and
`POST /api/batches/{batch_id}/archive` sets its archive timestamp.

Saved Batch request and detail schemas expose the same canonical variable binding shape. Zero values
are allowed because Saved Batches are drafts. The empty string is a concrete value. Saved Batch writes
and executable Preview/Run requests reject exact duplicate values, including duplicate empty strings.
Requests containing removed binding fields such as `fixed_value` or `selected_values`, or parameter
bindings without the required `mode` discriminator, are invalid; the API does not normalize them.

Saved Batch request and detail schemas expose `image_bindings` entries with `slot_key` and `values`.
When a Profile is selected, Saved Batch writes require the exact Profile slot set in Profile order with
one or more ordered, unique alternatives per slot. A Profile with no slots uses an empty binding list.
Each value is either a nonblank Reference Asset ID or `null`; `null` means Base workflow, appears first
when included, and does not upload or mutate that slot for its concrete Job. Every slot is an independent
Cartesian dimension. Zipped, row-linked, and collection-link semantics are not supported.

Saved Batch request and detail schemas expose ordered independent `parameter_bindings` and
`linked_parameter_sets`. When a Profile is selected, independent bindings plus linked membership must
cover every Profile parameter exactly once. Explicit independent bindings use
`{ "parameter_key": ..., "mode": "values", "values": [...] }` and retain Pass 3B-1 validation.
Numeric Range bindings use `{ "parameter_key": ..., "mode": "range", "include_base": boolean,
"range": { "start": decimal-string, "end": decimal-string, "step": decimal-string } }`. String and
boolean parameters cannot use Range mode. Saved Batch responses preserve Range mode and exact decimal
text. Optimistic revision behavior is unchanged.

A linked set stores `set_key`, `set_label`, ordered `members`, and ordered `rows`. Each row stores an
optional `row_label` and a `values` object with exactly one typed scalar or `null` for every member.
Sets require at least two members and one row. Unknown, duplicate, overlapping, independently bound, or
missing members are invalid, as are missing/extra cells and duplicate complete value tuples. A set row
is one compiler alternative at the earliest member's Profile position.

The backend is authoritative for Range materialization. It uses exact scaled-integer progression,
supports ascending and descending ranges, includes End only when exactly reached, rejects zero or
wrong-direction steps, and limits a Range to 10,000 generated numeric values. Base workflow is prepended
after materialization when requested. The resulting explicit values enter the existing compiler; Range
objects never enter Compiled Jobs, executor state, or workflow preparation.

Executable Preview and Run requests may supply binding records in any order. Compilation resolves them
by stable key and expands Image Input and parameter dimensions in their respective Profile order.
Alternative order inside each binding is significant and preserved. Parameters follow Image Input
slots and precede seeds, so seeds vary fastest.

Random seed intent stores `mode` and `random_seed_count` in the `batch_snapshot`. Preview accepts empty
`seeds.values` and materializes the concrete per-Job list. Run creation rejects an unmaterialized Random
request and accepts only a list containing one assignment per final Job. Fixed and Explicit lists remain
ordinary fastest-varying seed dimensions reused for every non-seed configuration.

## Project history and Run lookup

`POST /api/projects/{project_id}/reindex` resolves the registered filesystem key, rescans filesystem
truth, and atomically replaces that Project's historical projection. Repeated import/reindex is
idempotent. A failed scan or transaction leaves the prior projection intact.

`GET /api/projects/{project_id}/runs` returns Runs grouped by their recorded Batch identity in the UI,
plus Project diagnostics. A Run is `verified` or `degraded`; structurally invalid Runs are excluded and
reported by diagnostic. `execution_available: false` and null execution fields explicitly represent a
missing or invalid execution record. This endpoint needs neither browser `localStorage` Run IDs nor
mutable Prompt, Workflow, Profile, or Saved Batch rows.

`GET /api/runs/{run_id}/batch-reconstruction` loads the validated historical Run without changing its
files or mutable libraries. It returns the frozen Batch snapshot plus ordered PromptVersion,
WorkflowVersion, and ProfileVersion reconciliation states. A resource is `linked` only when its stable
identity, immutable content, available parent/version metadata, active archive state, and Project ID and
filesystem ownership match SQLite exactly. A missing or archived identity is `detached`; the same
identity with different immutable content or ownership is `conflict`. A ProfileVersion cannot link unless
its exact target WorkflowVersion also links, and a WorkflowVersion conflict propagates to the dependent
ProfileVersion.

Each reconciliation state identifies the frozen `historical_version_id`, nullable exact
`linked_version_id`, and nullable linked logical `linked_resource_id`. These fields let the frontend
retain authoritative conflicts and recover logical parent identity when an older snapshot omitted it.

The three `/import-copy` operations are explicit mutable actions. They reload frozen content from the
Run server-side and create new logical resources with version 1; request bodies never supply replacement
Prompt, Workflow, or Profile JSON. Prompt import identifies the frozen ordered entry by zero-based
`position`. Workflow Profile import requires a `workflow_version_id` that belongs to the Run Project and
exactly matches the frozen Workflow. Empty historical Prompt text remains inspectable and previewable but
cannot be imported into the current mutable Prompt library. Archived Workflow or WorkflowVersion targets
cannot receive an imported historical ProfileVersion. New resources preserve the frozen display name
when it is available. A genuine uniqueness collision uses `Name (imported)`, then
`Name (imported 2)`, and so on; Profile name collisions are scoped to the target Workflow.

Every import-copy request requires a nonempty `import_request_id`. The backend derives deterministic UUID
identities from the Project ID, Run ID, resource kind, Prompt position when applicable, and request ID.
Replaying the same request returns its existing logical resource and version 1 after checking frozen
content, Project ownership, active identities, parent/version relations, and the Profile's WorkflowVersion
target. Later logical name or description changes do not invalidate replay. Reusing a request ID whose
derived identities are occupied by unrelated or incoherent rows returns HTTP 409 with
`historical_resource_import_conflict`. A different request ID creates a deliberately distinct copy.

Direct Run lookup scans the documented hierarchy:

```text
<projects-root>/*/batches/*/*-*
```

Candidates are constrained to the configured root. Read-only `GET /api/runs/{run_id}`,
`GET /api/runs/{run_id}/execution`, and `GET /api/runs/{run_id}/results` use historical loaders so a valid
frozen plan and recorded Result metadata remain inspectable when output bytes are unavailable. They still
reject malformed immutable provenance or execution records.

Mutation endpoints and Result download use strict loading. Execute, cancel, and discard require strict
Run/execution storage; `GET /api/runs/{run_id}/results/{job_ordinal}/{artifact_ordinal}` also verifies the
selected regular file's path, size, and SHA-256 before serving it.

## Execution Tasks

`POST /api/runs/{run_id}/execute` returns `202 Accepted` after retaining an in-process `asyncio.Task`. The task invokes the existing queue-depth-1 executor. SQLite is authoritative only for durable cancellation request intent; all authoritative execution outcomes remain in `batchcraft.execution` v1 `execution.json`.

`GET /api/executions/active` returns `{"run_id": "..."}` for the one live Run task owned by the
current FastAPI process, or `{"run_id": null}`. This is process-local task-registry discovery for browser
monitor reconnection. It is not persisted scheduler state, does not report remote ComfyUI activity, and
does not provide executor restart recovery.

`POST /api/runs/{run_id}/discard` durably marks a Run that has never started as `cancelled` and returns the existing execution response shape with `200 OK`. The Run directory and frozen provenance remain available through Run lookup and Run Plan inspection. Discard records `completed_at`, leaves `started_at`, `current_job_ordinal`, and `error` null, preserves every Job as pristine `pending`, and records the stable Run diagnostic `discarded_before_start`. Repeated discard is idempotent.

The task registry:

- permits at most one active Run task in the API process and rejects duplicate or concurrent starts;
- observes and logs task exceptions;
- removes completed task references;
- cancels and observes active tasks during API shutdown.

Start admission and discard are serialized by the same task-registry lock, so a Run cannot start and be discarded concurrently. Discard independently verifies that no task for the Run is active and that execution state is either absent or exactly the initial state derived from the frozen Run. It rejects any progression or submission evidence, including modified pending state, with `409 run_discard_not_eligible`.

`POST /api/runs/{run_id}/cancel` accepts exactly:

```json
{"mode":"after_current_job"}
```

The endpoint returns `202 Accepted` with `run_id`, `mode`, nullable `requested_at`, `created`, and
`state`. A new request is eligible only while the Run has an active task in this API process. The
request is inserted durably before the in-process cancellation flag is exposed. Repeated requests are
idempotent, preserve the original timestamp, and return `created: false`. Missing Runs return
`404 run_not_found`; inactive or terminal `succeeded`, `failed`, or `blocked` Runs without an existing
intent return `409 run_cancellation_not_eligible`; persistence failures return
`500 run_cancellation_store_failed`. A Run already cancelled by discard returns a cancelled projection
without creating SQLite intent.

Cancellation request persistence and the short Job submission-admission transition share one
per-active-Run lock. If the request wins before admission, the prepared Job and all remaining
unsubmitted Jobs become `cancelled`. If admission already won, the current Job continues through
normal submission, history reconciliation, and Result ingestion, and no subsequent Job is submitted.
Current-Job failure still produces Run `failed`; unresolved accepted or ambiguous submission produces
Run `blocked`. If an admitted final Job succeeds, no cancelled suffix remains and the Run finishes
`succeeded`. The operation never interrupts ComfyUI, clears its queue, retries, or resubmits work.

`GET /api/runs/{run_id}/execution` returns an optional `cancellation` object, and
`GET /api/runs/{run_id}` returns the same object under `execution.cancellation`. It contains `mode`,
nullable `requested_at`, and one projection state: `stop_requested` before admission,
`stopping_after_current_job` after admission, `cancelled` when execution v1 records a cancellation
outcome, or `finished` when the request exists but execution honestly reached `succeeded`, `failed`, or
`blocked`. A discarded Run projects `cancelled` with `requested_at: null`.

Every execution response also includes ephemeral `execution_task_active`. This is `true` only while
the current API process owns a live execution task for that Run. It is not persisted and is not evidence
about whether a previously submitted remote ComfyUI Job is still running.

An execution request is accepted only when `execution.json` does not yet exist. A cancelled Run cannot execute. The API does not resume, retry, or reconcile partial, blocked, failed, or succeeded Runs. A process restart loses only the in-memory task reference; persisted nonterminal state remains visible and requires a future explicit recovery mechanism. Creating another Run remains independent and freezes a new plan without changing the earlier Run.

A refreshed browser discovers the Run already executing in the same backend process, reconciles it with
any persisted browser pointer, reads its Run and execution state, and resumes polling without calling the
execution-start endpoint. Process-local discovery takes monitor precedence over a different persisted
pointer, independently of editable draft identity. The retired Batch Results session gallery is not part
of monitor reconnection, and the browser no longer prefetches historical Runs from session IDs. Result loading is
independent and cannot delay execution-state hydration. Definitive missing or invalid Run data may clear
a pointer; draft mismatch and transient Project or network failures retain it for bounded retry and later
revalidation.

If persisted state is `running` but `execution_task_active` is false, the browser retains and displays the
known Run, stops polling, reports that local control is unavailable, and permits another immutable Run
without rewriting the earlier Run. This is UI reconnection and release of stale control, not backend
execution recovery.

## Results

Result listing follows persisted Job and artifact order and returns `integrity_status` as `verified`,
`missing`, or `corrupt`. Listing hashes each recorded Result when classifying it but preserves metadata for
unavailable bytes. The frontend renders only verified artifacts and shows an unavailable placeholder for
missing or corrupt Results. File retrieval accepts integer Job and artifact ordinals, resolves only a
matching `ResultRecord`, and validates the selected regular file's path, size, and SHA-256 before returning
it. Arbitrary filesystem paths are never accepted.

The scoped frontend cleanup retains current Results and Project History and removes Batch Results.
Thumbnail cards omit visible `Verified` badges and `Job` captions; the info popup, accessible
descriptions, lightbox labels, and unavailable-artifact placeholders remain. This presentation change
does not remove `integrity_status`, Job/artifact ordinals, or provenance from Result DTOs, and does not
weaken listing or download validation. Cancellation and historical detail endpoints are unchanged.

## Errors

API errors use:

```json
{
  "error": {
    "code": "run_not_found",
    "message": "Run was not found"
  }
}
```

Defined cases include invalid requests and Batches, Project/Prompt validation and conflicts,
Project adoption/publication failures, invalid Workflow Profile mappings, unsafe Project keys,
invalid image uploads, missing or invalid Project assets, missing Runs or Results, active or
ineligible execution, ineligible Run discard, ineligible Run cancellation, unavailable cancellation
intent storage, Saved Batch revision conflicts, Saved Batch integrity violations, missing or
invalid Saved Batches, asset or Run publication failure, invalid durable Run data, and unexpected
internal errors. Python stack traces are logged server-side rather than returned to clients.
