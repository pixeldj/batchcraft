# Application API

## Scope

The first application boundary exposes the production compiler, Run filesystem store, execution state, sequential executor, and ComfyUI adapter through FastAPI.

The API is a local single-user development boundary. The first React frontend consumes it, and the browser never communicates directly with ComfyUI. SQLite owns current Project metadata plus the Prompt, Workflow, and Workflow Profile libraries. Authentication, a global scheduler, restart recovery, and cancellation remain deferred.

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

Configuration is read centrally from environment variables:

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

The Vite frontend defaults to this API at `http://127.0.0.1:8000`. Set
`VITE_BATCHCRAFT_API_URL` in the frontend environment to use another API address. Its origin must
match `BATCHCRAFT_FRONTEND_ORIGIN` for browser API requests.

## Endpoints

```text
GET  /api/health
GET  /api/comfyui/status
GET  /api/projects
POST /api/projects
POST /api/projects/adopt
GET  /api/projects/adoptable
GET  /api/projects/{project_id}
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
POST /api/runs/{run_id}/execute
GET  /api/runs/{run_id}/execution
GET  /api/runs/{run_id}/results
GET  /api/runs/{run_id}/results/{job_ordinal}/{artifact_ordinal}
```

The API applies all bundled SQL migrations before accepting requests. Startup fails on migration
errors, newer database schemas, gaps, or changed checksums. Request handlers run each synchronous
SQLite store operation through a worker thread rather than blocking the event loop.

## Projects And Prompts

Project creation publishes the immutable `project.json` owner binding before inserting current
metadata into SQLite. If the insert fails, the owner remains available for explicit adoption through
`POST /api/projects/adopt`. Adoption preserves a valid existing owner. An ownerless asset directory
requires an explicit adoption request containing a user-supplied Project ID and name; batchcraft does
not infer or generate that identity from the directory, assets, or history. Only that action creates
its stable owner binding. Normal creation refuses to claim a pre-existing ownerless directory.
Project rename and description changes update SQLite without rewriting the owner file or historical
Runs.

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
first immutable ProfileVersion against one exact WorkflowVersion. Create requests accept a `mappings`
object. Version responses return a complete Run-compatible `profile` snapshot with `id`, `name`, and
`mappings`, plus `content_sha256` and all parent identities. A target from another logical Workflow is
rejected. Filtering `GET /api/workflows/{workflow_id}/profiles` by `workflow_version_id` retains every
logical Profile for the Workflow and exposes its latest compatible version as
`latest_compatible_version`, or `null` when no version targets that WorkflowVersion. A client can use
an earlier ProfileVersion's mappings to create a new immutable version under the same logical Profile;
the API validates those mappings against the new target WorkflowVersion.

Archive operations set archive timestamps through `POST .../archive`; they do not delete historical
versions. Canonical JSON and stored hashes are checked when versions are read.

`POST /api/batches/preview` and `POST /api/runs` accept the same complete Batch request shape plus a
required `batch_snapshot` object containing the full editable Saved Batch state. The request carries
Project and Batch identity, an ordered `prompt_versions` array with stable ID, frozen name, and
template text, Variable List bindings, an ordered `references` array, seed input, the API-format
workflow, and its Workflow Profile mapping. The singular `prompt_version` field is not accepted.
The `batch_snapshot` records the editable intent; concrete seed lists may still be materialized from
a Random seed intent that stores only `mode` and `count`.

Preview calls the production Batch compiler, validates the exact workflow/Profile pair through the
same preparation logic as Run creation, and returns every resolved Job in deterministic order.
Each Preview Job includes `prompt_version_id` and `prompt_version_name`; clients do not infer source
identity from resolved text. Run creation compiles and validates the request again, resolves existing
Project assets, and publishes through `RunFilesystemStore`.
The compact Run creation response is unchanged. `GET /api/runs/{run_id}` additionally returns the
ordered frozen PromptVersion snapshots, each Job ordinal's PromptVersion ID association, and a
`plan` projection loaded from the published Run manifest. The plan contains compiler warnings and
every concrete Job's resolved prompt, resolved variables, Reference Asset identity and frozen
filename when selected, and materialized seed. A nullable `batch_snapshot` exposes manifest v4
editable intent, including optional frozen Workflow/Profile display labels and version numbers.
Runs loaded from manifest v1-v3 return `batch_snapshot: null` while retaining their concrete plan.

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

A missing Project has an empty asset listing. Import may create its content-addressed asset
hierarchy, but it does not manufacture `project.json`; SQLite-backed Project creation/adoption or
successful Run publication binds a Project filesystem key to Project identity.

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

Random seed intent stores `mode` and `count` in the `batch_snapshot`; the frontend materializes the
concrete ordered seed list before Preview or Run creation.

## Run Lookup

There is no SQLite Run index yet. The application service scans only the documented hierarchy:

```text
<projects-root>/*/batches/*/run-*
```

Candidates are constrained to the configured root. The filesystem layer reads only the stable Run ID from safe `run.json` identity metadata during discovery, and only matching candidate paths receive full `RunFilesystemStore.load_run()` validation. Corrupt unrelated Runs therefore do not block lookup. This narrow scan is temporary application glue, not a generic repository abstraction.

## Execution Tasks

`POST /api/runs/{run_id}/execute` returns `202 Accepted` after retaining an in-process `asyncio.Task`. The task invokes the existing queue-depth-1 executor and all authoritative execution state remains in `execution.json`.

The task registry:

- permits at most one active Run task in the API process and rejects duplicate or concurrent starts;
- observes and logs task exceptions;
- removes completed task references;
- cancels and observes active tasks during API shutdown.

An execution request is accepted only when `execution.json` does not yet exist. The API does not resume, retry, or reconcile partial, blocked, failed, or succeeded Runs. A process restart loses only the in-memory task reference; persisted nonterminal state remains visible and requires a future explicit recovery mechanism.

A refreshed browser may reconnect to a Run already executing in the same backend process. It reads
the existing state and resumes polling without calling the execution-start endpoint. This is UI
reconnection, not backend execution recovery.

## Results

Result listing follows persisted Job and artifact order. Application queries validate execution-state schema, identities, invariants, Result metadata paths, and output-directory safety without hashing every Result file. File retrieval accepts integer Job and artifact ordinals, resolves only a matching `ResultRecord`, and validates that selected file's regular-file status, size, and SHA-256 before returning it. Arbitrary filesystem paths are never accepted.

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
ineligible execution, Saved Batch revision conflicts, Saved Batch integrity violations, missing or
invalid Saved Batches, asset or Run publication failure, invalid durable Run data, and unexpected
internal errors. Python stack traces are logged server-side rather than returned to clients.
