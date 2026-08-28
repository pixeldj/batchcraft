# Application API

## Scope

The first application boundary exposes the production compiler, Run filesystem store, execution state, sequential executor, and ComfyUI adapter through FastAPI.

The API is a local single-user development boundary. The first React frontend consumes it, and the browser never communicates directly with ComfyUI. The API does not add SQLite, authentication, a global scheduler, restart recovery, or cancellation.

## Local Startup

From `backend/`:

```bash
BATCHCRAFT_PROJECTS_ROOT="/path/to/projects" \
BATCHCRAFT_COMFYUI_BASE_URL="http://<windows-host>:8188" \
uv run batchcraft-api
```

The OpenAPI document is available at `/docs` while the server is running.

## Configuration

Configuration is read centrally from environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BATCHCRAFT_PROJECTS_ROOT` | `data/projects` | Project and Run filesystem root |
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
POST /api/batches/preview
POST /api/runs
GET  /api/runs/{run_id}
POST /api/runs/{run_id}/execute
GET  /api/runs/{run_id}/execution
GET  /api/runs/{run_id}/results
GET  /api/runs/{run_id}/results/{job_ordinal}/{artifact_ordinal}
```

`POST /api/batches/preview` and `POST /api/runs` accept the same complete Batch request shape. The request carries Project and Batch identity, one PromptVersion, Variable List bindings, Reference Asset IDs, explicit seed input, the API-format workflow, and its Workflow Profile mapping.

Preview calls the production Batch compiler and returns every resolved Job in deterministic order. Run creation compiles the request again, validates the Workflow Profile against the workflow, resolves existing Project assets, and publishes through `RunFilesystemStore`.

## Batch Persistence

This slice does not create a mutable Batch file format. The Batch request is ephemeral; a successfully published Run contains the durable frozen plan and provenance. Mutable Batch persistence remains part of the later SQLite application-state milestone.

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

Defined cases include invalid requests and Batches, invalid Workflow Profile mappings, missing Project assets, missing Runs or Results, active or ineligible execution, Run publication failure, invalid durable Run data, and unexpected internal errors. Python stack traces are logged server-side rather than returned to clients.
