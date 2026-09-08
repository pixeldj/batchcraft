# Application API

## Scope

The first application boundary exposes the production compiler, Run filesystem store, execution state, sequential executor, and ComfyUI adapter through FastAPI.

The API is a local single-user development boundary. The first React frontend consumes it, and the
browser never communicates directly with ComfyUI. SQLite owns current Project metadata, Prompt,
Workflow, and Workflow Profile libraries, Saved Batches, durable Run cancellation intent, and rebuildable
historical projections. Project filesystem records remain authoritative for historical provenance,
execution outcomes, Assets, and Results.
Authentication, a global scheduler, executor restart recovery, and remote ComfyUI interruption remain
deferred. Stop-after-current cancellation and local `Stop waiting` detach are supported.

## Local Startup

These manual commands start only the API with a real ComfyUI client. They do not launch Vite or isolate
data automatically, and execution requests can submit GPU work. For fake-backed development and agent
browser checks, use `./dev.command` via [`LOCAL_INSTANCES.md`](LOCAL_INSTANCES.md) instead.

From `backend/`, with separate explicit data paths:

```bash
BATCHCRAFT_PROJECTS_ROOT="/path/to/projects" \
BATCHCRAFT_DATABASE_PATH="/path/to/batchcraft.sqlite3" \
BATCHCRAFT_COMFYUI_BASE_URL="http://<windows-host>:8188" \
uv run batchcraft-api
```

The OpenAPI document is available at `/docs` while the server is running.
The API-only default is `127.0.0.1:8000`. To pair it with the checked-in Vite development configuration,
set `BATCHCRAFT_SERVER_PORT=8001` and `BATCHCRAFT_FRONTEND_ORIGIN=http://127.0.0.1:5174`.
Do not start a second instance on a port or data root already in use.

## Configuration

For direct `batchcraft-api` startup, configuration is read centrally from environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BATCHCRAFT_DATA_ROOT` | `data` | Default root for application data |
| `BATCHCRAFT_DATABASE_PATH` | `<data-root>/batchcraft.sqlite3` | SQLite application-state database |
| `BATCHCRAFT_PROJECTS_ROOT` | `<data-root>/projects` | Project and Run filesystem root; independently configurable |
| `BATCHCRAFT_COMFYUI_BASE_URL` | `http://127.0.0.1:8188` | Backend-owned ComfyUI endpoint |
| `BATCHCRAFT_COMFYUI_TIMEOUT` | `30` | ComfyUI HTTP inactivity/transport-phase timeout in seconds, not a whole-response deadline |
| `BATCHCRAFT_COMFYUI_MAX_JSON_RESPONSE_BYTES` | `8388608` (8 MiB) | Positive integer cap per ComfyUI JSON/error response body |
| `BATCHCRAFT_COMFYUI_MAX_ARTIFACT_BYTES` | `268435456` (256 MiB) | Positive integer cap per successful ComfyUI artifact response body |
| `BATCHCRAFT_COMFYUI_MAX_WEBSOCKET_MESSAGE_BYTES` | `4194304` (4 MiB) | Positive integer cap per ComfyUI WebSocket message |
| `BATCHCRAFT_WEBSOCKET_TIMEOUT` | `21600` | Advisory WebSocket observation bound |
| `BATCHCRAFT_HISTORY_TIMEOUT` | `21600` | Authoritative history reconciliation bound |
| `BATCHCRAFT_HISTORY_POLL_INTERVAL` | `1` | History polling interval in seconds |
| `BATCHCRAFT_FRONTEND_ORIGIN` | `http://localhost:5173` | Allowed local development CORS origin |
| `BATCHCRAFT_SERVER_HOST` | `127.0.0.1` | API bind host |
| `BATCHCRAFT_SERVER_PORT` | `8000` | API bind port |
| `BATCHCRAFT_MAX_JOBS` | `10000` | Positive materialization budget for new Job plans and Saved Batch parameter validation |
| `BATCHCRAFT_MAX_PROMPT_BYTES` | `1048576` (1 MiB) | Positive integer cap per new resolved prompt, measured in raw UTF-8 |
| `BATCHCRAFT_MAX_RESOLVED_TEXT_BYTES` | `33554432` (32 MiB) | Positive integer aggregate resolved-text cap across a new plan |
| `BATCHCRAFT_MAX_REQUEST_BYTES` | `67108864` | Positive total request-body budget, including multipart overhead |
| `BATCHCRAFT_MAX_INFLIGHT_REQUEST_BODIES` | `4` | Positive per-process capacity for requests retaining admitted bodies |
| `BATCHCRAFT_REQUEST_BODY_TIMEOUT` | `120` | Positive finite deadline in seconds for receiving and spooling a body |

The real ComfyUI host is never committed to repository configuration.

`Settings` canonicalizes the trusted configured `data_root`, `database_path`, and `projects_root`
once at construction, before creating stores. Relative paths become absolute and configured aliases
such as macOS `/var` become `/private/var`. This does not move files or change registered Project
filesystem keys, stored relative artifact paths, or historical provenance. Repointing an alias after
construction does not repoint the running instance. Artifact paths inside the configured store are
never resolved to bypass validation: descriptor traversal rejects internal symlinks and parent traversal.
Low-level filesystem callers outside the API must supply a canonical trusted storage anchor too.

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

Request defenses validate Host against loopback names, the explicitly configured bind host, or, for a
wildcard LAN listener, the literal local destination IP. Arbitrary LAN DNS aliases and reverse-proxy
deployments are not supported. Forwarded Host headers are not trusted. Mutations with an Origin header
require the validated same origin or configured frontend origin; malformed, duplicate, and `null`
Origins are rejected. Requests without Origin remain available to CLI clients. This is not authentication.

Bodies are admitted before handlers run, with both declared and received byte limits. The default is
64 MiB per request, not per file; chunked and multipart uploads count toward it. At most four requests
can retain admitted bodies at once; excess body requests fail immediately with
`429 request_capacity_exceeded` and `Retry-After: 1`, without a capacity waiting queue. A lease remains
held through body consumption, handler completion, and spool cleanup. Immediately completed empty
bodies bypass this budget, including bodyless control requests; GET bodies cannot bypass admission.

Receiving and spooling have a 120-second total deadline, not an idle timer reset by progress. Expiry
returns `408 request_body_timeout` without running handlers. This is not a handler deadline or a bound
on connection count or transport buffers. Cancellation and timeout join active file operations before
closing the spool and releasing capacity; a stalled filesystem operation can delay that cleanup and
the error response. Isolated app/dev/test launchers retain the default budgets and do not inherit these
environment overrides. See ADR 0015 for the boundary and remaining limits.

Preview and Run creation pass all three configured plan limits into count-only preflight before numeric
Range allocation, prompt resolution, Job expansion, or Random assignment. Over-budget plans return
`422 invalid_batch` without publication. The service also enforces the limits during compilation.
Saved Batch writes enforce the Job budget on parameter combinations even for incomplete drafts;
Preview checks all dimensions. Existing valid Saved Batches and historical Runs remain readable after
lowering the budget. Preview runs in a worker thread.
`BATCH_COMPILER.md` defines the raw UTF-8 accounting and exclusions; it is not a process-memory cap.
`COMFYUI_INTEGRATION.md` defines identity-only HTTP encoding, response-body caps, finite WebSocket
messages, and the remaining transfer-duration limitation.

Read-only Project Run history, Run detail, Batch reconstruction, Result listing/download, and Project
Asset listing/download share four active slots and at most eight FIFO waiters per application process.
Execution-detail polling at `GET /api/runs/{run_id}/execution` has two separate active slots and at
most four FIFO waiters. A waiter has five seconds to acquire a slot. Queue overflow fails immediately;
expiration of the wait deadline fails without starting the read. Both return
`503 {"error":{"code":"read_capacity_exceeded","message":"Read capacity is busy; retry later"}}`
with `Retry-After: 1`. These fixed limits allow ordinary six-image browser bursts to complete without
requiring an image retry, while bounding larger bursts. Waiting allocates no read worker or artifact
snapshot. Cancelled and timed-out waiters leave the queue; a cancelled grant returns its reserved slot
to the next waiter. A download retains its active slot through verification, streaming, and tempfile
cleanup. The five-second deadline limits queue waiting only, not read/stream duration or historical size.
At most four verified download snapshots can occupy these bulk slots, but each may be arbitrarily
large. Temporary disk demand is their combined size, not a fixed byte quota; slow active streams can
retain both disk and capacity. No new historical artifact cap or active-stream deadline is imposed.

These reads and their JSON serialization use the asyncio executor rather than the shared AnyIO
worker pool. Service/library dependencies and execution task-registry reads stay on the event loop.
Health, active-execution discovery, and mutation/control routes do not acquire a read slot or join a
read queue; execution polling never joins the bulk queue. This is not a general latency
guarantee: persisted parsing still does full validation, unrelated work can use worker capacity, and
this policy does not make all mutation or compilation work nonblocking. Run creation, Project Asset
import, and cancellation validation use joined file workers for their filesystem work. Cancellation
joins an active file operation before releasing its slot or closing its tempfile, without blocking the
event loop.

The Project browser uses bounded Run/Result history pages rather than the legacy unpaginated Run list
and per-Run Result-list fan-out. Selected Result Details still fetches the selected owning Run's Result
list; current-Run monitoring/detail reads remain separate. The frontend HTTP client retries only GET
responses carrying
`503 read_capacity_exceeded`, at most twice, with abortable delays of 1-5 seconds based on Retry-After.
Other errors and all mutations are not retried by this policy. Ordinary image bursts use the backend's
bounded wait queue; image elements do not gain an automatic retry loop. Sustained overload can still
surface an error or unavailable image, rather than retrying indefinitely.

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
GET  /api/projects/{project_id}/history/runs
GET  /api/projects/{project_id}/history/results
GET  /api/projects/{project_id}/history/choices
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
Project, performs full size and SHA-256 verification into an owned disk snapshot, rejects
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
truth, and atomically replaces that Project's historical projection. It requires the same registered
Project ID and filesystem key; it cannot create registration or import another Project. Repeated
import/reindex is idempotent. A failed scan or transaction leaves the prior projection intact.

Per-Project locks serialize the entire scan-and-replace cycle across explicit import, registered
reindex, and Run publication refresh. Ownership, safe paths, and directory identities are rechecked
before replacement. A changed owner/directory, failed enumeration, unsafe root, or missing `batches/`
root with previously indexed history rejects reconciliation rather than replacing history with empty
rows. A new Project without batches remains valid empty history. Individually malformed Runs remain
isolated with diagnostics. This is not an atomic transaction against arbitrary external filesystem
writers; they can still race a final check. Run creation, import, and reindex workers remain owned until
completion even if the request is cancelled. Published Runs are never rolled back by cancellation or
an indexing failure; indexing failure emits a safe warning and can be repaired on the next refresh.

The frontend reads indexed history on Gallery/Runs activation, then calls reindex in the background and
checks a bounded first page. Run creation and observed terminal execution revisions, including discard
and durable detach, prompt another check for the frozen Run's Project while its review is active.
Ordinary polls, filter/page changes, and density changes do not scan. Dispatched scans are joined before
later scans; obsolete reads cannot replace newer history. No startup-wide scan, watcher, timer, focus
refresh, or automatic import is introduced. Reindex Project remains an explicit storage repair/retry.

An identical first page silently rebases generation, scan time, and continuation metadata while keeping
item objects. An empty page adopts newly discovered records automatically, even with an existing
generation. Explicit Reindex Project adopts the refreshed first page after a successful scan and read;
it does not require a separate Refresh. A background change to a nonempty page retains its metadata with `History updated` pending explicit Refresh,
which reads the latest index from page one and discards old bookmarks without itself scanning storage.
Images and original links are disabled if the newly scanned page cannot validate their retained
identity, availability, integrity, and artifact metadata. Absence from that bounded page is not proof of
deletion. Failed reads/scans retain known content with stale/unavailable warnings; unavailable execution
is not proof of zero Results. Overlapping older requests cannot restore images early. These UI checks
never rewrite historical artifacts.

`GET /api/projects/{project_id}/runs` retains the unpaginated Run list and Project diagnostics for
backward compatibility, but the mounted browser no longer uses it. A Run is `verified` or `degraded`;
structurally invalid Runs are excluded and
reported by diagnostic. `execution_available: false` and null execution fields explicitly represent a
missing or invalid execution record. This endpoint needs neither browser `localStorage` Run IDs nor
mutable Prompt, Workflow, Profile, or Saved Batch rows.

### Bounded historical browsing (BC-007)

The BC-007 browser supplies bounded Gallery/Runs pages with typed provenance filters:

- `GET /api/projects/{project_id}/history/runs`
- `GET /api/projects/{project_id}/history/results`

Both require a registered Project (otherwise `404 project_not_found`). They read only SQLite's last
committed projection: no filesystem scan, per-Run Result listing, compiler expansion, or original-byte
hashing occurs in a browse request. The browser now uses these endpoints; the old unpaginated APIs are
retained for backward compatibility, not used to build Project-wide pages. Existing strict artifact
downloads remain authoritative. Selected Result Details still uses `GET /api/runs/{run_id}/results`
for the selected Run only, alongside its frozen Run detail, to match Job/artifact ordinals and hash.

The UI requests 48 Results or 25 Runs per page, replaces rather than appends pages, retains at most 20
previous cursor bookmarks, and caps its frozen-Run detail cache at 20 entries. Images are lazy-loaded,
asynchronously decoded originals, not generated thumbnails. UI URL keys `view`, `q`, `sort`, `run`,
`batch`, `status`, `available`, and JSON `filters` encode review mode and filters; identity/status keys
map to the API parameters below. Add filter opens typed controls with editable/removable chips.
Invalid advanced URL filters show an explicit error and block browsing until cleared rather than
silently showing an unfiltered collection. URL navigation never selects a Project or persists a cursor.
The selected verified Project and existing guarded Project switching remain authoritative. Complete
facets, filter-from-Details actions, additional Run/Job sorts, diagnostic detail browsing, thumbnails,
and filmstrip remain unfinished; BC-007 is In Progress (see its entry for checkpoint evidence).

Common query parameters:

| Parameter | Contract |
| --- | --- |
| `limit` | Integer 1-100; default 50 |
| `cursor` | Opaque continuation returned by the same endpoint; at most 8,192 characters |
| `sort` | `newest` (default) or `oldest` |
| `q` | At most 200 characters; literal substring of full frozen Run name or description |
| `run_id`, `batch_id` | Optional exact historical identities, not mutable names |
| `execution_status` | `created`, `running`, `succeeded`, `failed`, `blocked`, or `cancelled` |
| `execution_available` | Optional boolean; distinct from execution status |
| `filters` | Optional JSON object, at most 16,384 characters; typed provenance predicates below |

Filters combine with AND. Text search uses SQLite's ASCII case folding; `%`, `_`, and quotes are literal
text, not wildcards or query syntax. Empty `q` means no text filter. Unknown query parameters, invalid
limits/sorts/statuses, and malformed cursors are rejected.

`filters` accepts only these fields; unknown fields, duplicate JSON object keys, malformed shapes, and
invalid typed values are rejected with `422 invalid_history_query` (query-schema bounds also return 422):

| Field | Contract |
| --- | --- |
| `prompt_id`, `prompt_version_id` | Exact logical Prompt identity where frozen ancestry exists, or exact PromptVersion identity |
| `workflow_version_id`, `profile_version_id`, `saved_batch_id` | Exact frozen WorkflowVersion, ProfileVersion, or source Saved Batch identity |
| `asset_id` | Exact Asset used by the Job in any Image Input slot |
| `seed` | JSON integer in `0..9007199254740991`; no string or boolean coercion |
| `created_from`, `created_before` | Valid bounded ISO date/timestamp strings; inclusive lower and exclusive upper Run-creation bounds, compared in UTC; lower must precede upper |
| `parameters` | At most 8 objects: `key`, `value_type`, `mode`, and `value` only for `equals` |
| `image_inputs` | At most 4 objects: `slot_key`, `mode` (`base` or `asset`), and `asset_id` only for `asset` |

Identity fields are nonempty strings; parameter/slot keys follow the stable-key grammar. Parameter
`value_type` is `string`, `integer`, `float`, or `boolean`; `mode` is `equals`, `base`, or `override`
(Any override). Equals requires the declared scalar type: integers have absolute value at most
`9007199254740991`, floats accept finite JSON numbers, booleans do not count as numbers, and empty
strings are concrete values. Base/override modes must omit `value`. Image Asset mode requires a
nonblank Asset ID. Date-only and offset-free timestamps mean UTC, not browser local time; an upper
date excludes that day. Unknown historical dates do not match date bounds.

Every predicate combines with AND. Run browsing requires one Job satisfying all Job predicates;
Result browsing requires the Result's own Job to satisfy them. Parameters, seed, Prompt, Image Inputs,
and Asset usage cannot be satisfied by different Jobs in the same Run. A missing parameter/slot is not
Base; an override equal to the workflow's Base literal remains an override. `false`, `0`, and `""`
remain distinct typed overrides. The UI permits one predicate per parameter key/type pair and one per
Image Input slot, with one value per identity field. API array predicates also use AND, not OR.
Multi-value OR within a dimension is planned, not implemented. Logical Workflow/Profile and hash
filters are not exposed; exact revision filters do not imply those broader capabilities.

`GET /api/projects/{project_id}/history/choices` supplies bounded historical selection lists, not
complete or active-filter-conditioned facets. Required `kind` is `parameter`, `prompt`, `prompt_version`,
`workflow_version`, `profile_version`, `saved_batch`, `batch`, `image_slot`, or `asset`. Optional `q`
is at most 200 characters and performs literal Unicode-casefolded substring search over historical
display labels (including available revision suffixes) and identities. `limit` is 1-50, default 30.
The response contains `project_id`, `generation`, `items`, and `has_more`; items contain exact `value`,
`label`, nullable `value_type`, and nullable `detail`. Labels/details are clipped to 256 characters;
identities are not clipped. Choices group by identity/type and sort deterministically by folded label
and identity/type. They have no continuation cursor or facet counts: narrow `q` when `has_more` is true.
The UI debounces choice search, displays at most 30 choices, and retains bounded historical labels for
chips. Names, revisions, parameter types, slots, and Asset filenames come from historical projections,
not today's mutable libraries; unavailable labels fall back to identities where applicable.

Migration `0004_history_provenance` adds typed parameter rows, frozen Prompt/Run provenance, and a
generation-bound enrichment marker. Nonempty advanced filters and all choices require enrichment for
the current projection generation; otherwise they return `409 history_reindex_required`, not an
authoritative empty collection. Successful import/reindex atomically publishes enrichment and generation;
failure preserves the prior index. Basic browsing still works on old unenriched indexes. These GETs
never scan or repair storage. Frozen revision metadata is stored as decimal TEXT because valid v1
revisions can exceed SQLite's signed-64-bit integer range. Applied migrations 0001-0003 and v1 Project
bytes remain unchanged; this is a rebuildable index extension, not a durable-format change.

Pages contain `project_id`, nullable `generation` and `scanned_at`, `items`, `next_cursor`, and `has_more`.
Run items contain `run` plus projected `result_count`. Result items contain compact `run` context,
exact `job_id`, `job_ordinal`, `artifact_ordinal`, filename excerpt/truncation flag, MIME, size, hash,
projected integrity, and optional download URL. Stable Result identity is Run ID + Job ID + artifact
ordinal, not filename or ordinal alone. Result counts count indexed artifacts, including degraded
ones; zero is not proof that unavailable execution metadata never contained Results.

Names are clipped at 256 characters, Run-description excerpts at 512, and timestamp display text at 64,
with `display_truncated` on Run summaries. Filename excerpts are clipped at 256 with their own flag;
oversized MIME values are omitted. SQL reads display fields with one sentinel character to detect
truncation before materializing repeated Run context. Full notes still participate in search and remain
available through existing detail reads. Exact identities are not truncated or newly restricted, so
page size and display clipping are not an absolute byte budget for historically unbounded identities.

Ordering uses normalized ISO instants at microsecond precision. Explicit offsets are normalized;
naive timestamps mean UTC. Unparseable or oversized historical timestamps remain browsable in an
unknown-date bucket after dated Runs for either direction. Run ID ascending breaks equal-instant ties;
Results then use ascending Job and artifact ordinals. There is no global uniqueness assumption on Run
number. No offset pagination is used.

Generation and page data (including Result counts and cursor bookmark resolution) share one read
transaction. Every successful full replacement updates the generation and UTC scan-completion time in
the same write transaction, even if the projected content is unchanged. Failed scans/replacements keep
both unchanged. Null scan state means the index has not yet been reconciled since the browsing
migration (or is a new empty Project), not that storage was just checked; existing rows remain readable.

Cursors bind Project, endpoint, filter values, sort, and generation. Page size may change between
requests. A bounded bookmark resolves the ordering key inside the read transaction without putting
unbounded Run IDs into the cursor. Malformed, foreign-query, or missing bookmarks yield
`422 invalid_history_query`. Generation changes yield `409 history_generation_changed`; restart without
a cursor rather than append mixed-generation pages. Cursors are not authorization or trusted file paths.

Integrity fields describe the projection at scan time, not a new verification of bytes. Missing/corrupt
artifacts, unavailable execution, and Run IDs not representable by the existing single-segment download
route have null `download_url` and an explicit `download_unavailable_reason`. Such identities remain
browsable without rewriting v1 data. Eligible URLs still use the existing strict download boundary;
stale verified index rows cannot authorize serving changed, missing, or unsafe original bytes.

Browse reads and response serialization run off the event loop under the existing bulk-read admission
budget. They neither consume execution-polling slots nor change reindex triggers. Filtering/search and
joined sorting can still inspect more rows than one page; bounded responses are not a query-time
guarantee or an incremental-index implementation.

Direct Run and execution reads differ from this history projection: if `execution.json` is absent,
they derive pristine `created` state from the frozen Run without writing a file. Invalid execution
records fail direct reads rather than being replaced with created state. Neither a missing history
record nor derived created state proves what happened remotely.

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

`POST /api/runs/{run_id}/cancel` accepts one of two modes:

```json
{"mode":"after_current_job"}
```

or:

```json
{"mode":"detach"}
```

The endpoint returns `202 Accepted` with `run_id`, `mode`, nullable `requested_at`, `created`, and
`state`. A new durable request is eligible only while the Run has an active task in this API process. The
request is inserted durably before the in-process cancellation flag is exposed. Repeated requests are
idempotent per mode, preserve the original timestamp, and return `created: false`. Missing Runs return
`404 run_not_found`; inactive nonterminal Runs and stop-after-current requests for `succeeded`, `failed`,
or `blocked` Runs without an existing intent return `409 run_cancellation_not_eligible`; persistence failures return
`500 run_cancellation_store_failed`. A Run already cancelled by discard returns a cancelled projection
without creating SQLite intent.

A detach request for an already `succeeded`, `failed`, `blocked`, or `cancelled` Run returns a no-op
projection without adding intent: `created: false`, `requested_at: null`, and `finished` or `cancelled`.
An existing same-mode intent still takes the idempotent path first.

Cancellation request persistence and the short Job submission-admission transition share one
per-active-Run lock. For `after_current_job`, if the request wins before admission, the prepared Job
and all remaining unsubmitted Jobs become `cancelled`. If admission already won, the current Job continues through
normal submission, history reconciliation, and Result ingestion, and no subsequent Job is submitted.
Current-Job failure still produces Run `failed`; unresolved accepted or ambiguous submission produces
Run `blocked`. If an admitted final Job succeeds, no cancelled suffix remains and the Run finishes
`succeeded`. The operation never interrupts ComfyUI, clears its queue, retries, or resubmits work.

`detach` is the local `Stop waiting` action. After persisting intent, the registry cancels only its owned
local task to wake an in-flight await. The executor preserves submission evidence, known prompt IDs,
and recorded Results, writes a detached `blocked` outcome for unresolved work, and leaves later Jobs
pending. A submission interrupted locally remains uncertain, not safe to retry. Stronger already durable
outcomes remain authoritative. Detach never interrupts ComfyUI, clears its queue, retries, or resubmits.
Both request modes may coexist; detach takes precedence in the cancellation read model.

`GET /api/runs/{run_id}/execution` returns an optional `cancellation` object, and
`GET /api/runs/{run_id}` returns the same object under `execution.cancellation`. It contains `mode`,
nullable `requested_at`, and one projection state: `stop_requested` before admission,
`stopping_after_current_job` after admission, `cancelled` when execution v1 records a cancellation
outcome, or `finished` when the request exists but execution honestly reached `succeeded`, `failed`, or
`blocked`. Detach adds `detach_requested` while local waiting is ending and `detached` for its recorded
blocked outcome. A discarded Run projects `cancelled` with `requested_at: null`. If SQLite intent is
lost, the blocked filesystem diagnostic remains inspectable but does not manufacture a cancellation
request object.

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

Integrity-only listing hashes in bounded chunks. Result and Asset reads reject non-regular files without
waiting for FIFO writers. Downloads copy and hash the selected descriptor's bytes into a disk tempfile
in 256 KiB chunks before HTTP success, then stream only that snapshot in 64 KiB chunks. No pathname is
reopened to serve the original after verification. In-place changes cannot substitute unchecked bytes;
the snapshot must match recorded size and SHA-256. Tempfiles close on completion, disconnect, failure,
or cancellation, after any active file worker finishes. This requires disk space proportional to the
selected artifact and delays the first response byte until verification completes; no historical
artifact size cap is imposed. Metadata and persisted-plan materialization remain unchanged.

Result responses render inline only when the recorded MIME is PNG, JPEG, GIF, or WebP and the bytes
match that format's signature. Other artifacts, including HTML, SVG, and mismatched image MIME, download
as `application/octet-stream` attachments. All Result responses include `X-Content-Type-Options: nosniff`
and a restrictive sandbox CSP. This HTTP policy does not change recorded MIME, hashes, or historical
bytes; signature checks are not full image decoding or malware scanning.

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
internal errors. Public diagnostic messages use an approved, bounded vocabulary rather than arbitrary
exception text. Safe numeric context such as HTTP status, Job ordinal, and materialization limits is
retained. Execution diagnostic lists retain at most 16 source entries, deduplicate public summaries,
and never echo raw upstream bodies or legacy diagnostic prose. Frozen Prompt/Workflow provenance and
recorded historical bytes remain unchanged; this policy is not redaction of all application data.

For definite structured submission rejections, the response retains distinct guidance for matched Base
Image Inputs and Base parameters, with one-based Profile positions. It does not repeat labels, retained
values, or upstream error prose. Overrides, unrelated targets, and ambiguous outcomes do not receive
Base guidance.

The HTTP application boundary prevents Starlette's rethrown exceptions from reaching Uvicorn's raw
traceback formatter. Controlled failure logs retain normalized exception categories, fixed filesystem
failure reasons, and package-relative locations. Background execution failures include a short SHA-256
Run-ID fingerprint for correlation even when execution-state persistence failed. Failed streams remain
incomplete rather than being presented as successful. Access logs, startup/lifespan failures, and
independent dependency logs are outside this policy; logs still require review before sharing.

Request admission adds `400 invalid_host`, `400 invalid_content_length`, `403 invalid_origin`, and
`413 request_too_large`, plus `408 request_body_timeout` and `429 request_capacity_exceeded`.
Read queue overflow or expiry adds `503 read_capacity_exceeded`. Configured frontend origins receive
CORS headers on admission errors too.
Internal persisted submission/history evidence can still contain raw diagnostics. Response summarization
does not bound transport parsing, response sizes, or on-disk diagnostic storage.
