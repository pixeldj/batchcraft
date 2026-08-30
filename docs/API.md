# Application API

## Scope

The first application boundary exposes the production compiler, Run filesystem store, execution state, sequential executor, and ComfyUI adapter through FastAPI.

The API is a local single-user development boundary. The first React frontend consumes it, and the browser never communicates directly with ComfyUI. SQLite owns current Project metadata and the Prompt library. Authentication, a global scheduler, restart recovery, and cancellation remain deferred.

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
GET  /api/projects/{project_key}/assets
POST /api/projects/{project_key}/assets
GET  /api/projects/{project_key}/assets/{asset_id}/content
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

`POST /api/batches/preview` and `POST /api/runs` accept the same complete Batch request shape. The
request carries Project and Batch identity, an ordered non-empty `prompt_versions` array with stable
ID, frozen name, and template text, Variable List bindings, an ordered `references` array, concrete
seed input, the API-format workflow, and its Workflow Profile mapping. `references` may be empty; in
that case each compiled Job returns `reference_asset_id: null` and execution retains the base
workflow's mapped reference-image input. The singular `prompt_version` field is not accepted.

Preview calls the production Batch compiler and returns every resolved Job in deterministic order.
Each Preview Job includes `prompt_version_id` and `prompt_version_name`; clients do not infer source
identity from resolved text. Run creation compiles the request again, validates the Workflow Profile
against the workflow, resolves existing Project assets, and publishes through `RunFilesystemStore`.
The compact Run creation response is unchanged. `GET /api/runs/{run_id}` additionally returns the
ordered frozen PromptVersion snapshots and each Job ordinal's PromptVersion ID association.

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

## Batch Persistence

This slice does not create a mutable Batch file format. The frontend keeps a versioned, best-effort
working draft, current Run ID, and ordered unique session Run IDs in browser `sessionStorage` so a
refresh in the same tab can restore the current workflow and its Batch working-session gallery. It
does not persist Preview output, execution state, Result metadata, or Result bytes. The browser
reloads Run, execution, and Result data through the API because backend data remains authoritative.

The session Run list is scoped to the stable Project and Batch IDs plus their filesystem keys. A
change to any of those identity fields resets the accumulated gallery; prompt, reference, seed, and
display-name edits retain it. The gallery is not durable Project-wide Run history and does not add a
Run query endpoint.

Run creation uses the exact complete Batch request stored with the visible successful Preview. Any
form edit invalidates that Preview pair. The frontend's Random seed intent is materialized with Web
Crypto into an explicit ordered seed list before Preview, so the API and compiler remain deterministic.
A successful Run creation consumes a Random Preview and requires fresh materialization before another
Run; failed creation retains it for retry. Fixed and Explicit Previews remain reusable after a terminal
Run. Durable mutable Batch persistence remains part of the later SQLite application-state milestone.

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
ineligible execution, asset or Run publication failure, invalid durable Run data, and unexpected
internal errors. Python stack traces are logged server-side rather than returned to clients.
