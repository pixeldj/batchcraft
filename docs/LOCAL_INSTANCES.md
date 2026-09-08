# Local instances and browser testing

The everyday app, development sandbox, and automated browser tests use separate code or data roots.
Never point development or tests at an everyday database or Project directory. Git worktrees share
repository history, but not their checked-out application files, dependencies, or frontend builds.

| Instance | Browser URL | API | Data | ComfyUI |
| --- | --- | --- | --- | --- |
| Everyday | `http://127.0.0.1:8000` | Same origin | Explicit absolute root in `app.local.json` | Configured live host |
| Development | `http://127.0.0.1:5174` | `http://127.0.0.1:8001` | `<checkout>/.local/dev-data` | Simulated, no network |
| Playwright | `http://127.0.0.1:5175` | `http://127.0.0.1:8002` | New temporary root per test-server launch | Simulated, no network |

Listeners bind to loopback by default. Only the everyday app can opt into LAN access as described below;
development and test instances stay on loopback and reject the LAN option. Ports are fixed; launchers
fail on a conflict rather than selecting an unexpected port. Different browser origins and devices have
separate unsaved working sessions. Use consistent URLs; `localhost`, `127.0.0.1`, and a LAN IP have
different browser storage even when they reach the same backend.

## Everyday app

The current installer is source-based, not a standalone app bundle. Use a Git clone on macOS, `uv`
with Python 3.13 or newer, and npm with Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` for the locked
frontend dependencies. Node 24.15+ in the 24.x line is recommended.

Provision a new instance from the repository root. Create the destination parent directories first;
for these example paths they share `$HOME/ai`:

```bash
mkdir -p "$HOME/ai"
uv run --directory backend python -m tools.install_app \
  --app-path "$HOME/ai/batchcraft-app" \
  --data-root "$HOME/ai/batchcraft-data" \
  --comfyui-url "http://<generation-host>:8188"
```

The installer requires both destination paths to be absent. It creates a detached Git worktree at the
selected commit (`--revision`, default `HEAD`), installs locked dependencies, and builds the frontend.
The installed worktree shares the source repository's Git metadata. Retain that repository; this is
not an independent clone that can be copied elsewhere as a standalone installation.
Add `--lan-access` only to enable trusted-LAN access for this everyday instance. The installer writes
the choice to `app.local.json` and builds with `VITE_BATCHCRAFT_API_URL='/'` to select same-origin API
requests even with pinned older client code.
It does not commit the development worktree, copy old data, start a server, or submit GPU work. If
installation fails, it leaves the partial installation intact for inspection rather than deleting it.

When the selected revision predates the launcher, the installer copies only `app.command` and the
required Python launcher files from the development checkout. These are independent copies, not links.
It does not update launcher files already present in the selected revision, including older launchers
without LAN support.
`installation.local.json` records the application commit and bootstrap hashes. All actual application
source comes from the selected commit; uncommitted UI/backend changes are not promoted.

Start using the executable `app.command` in the installed checkout, either from Terminal or Finder:

```bash
"$HOME/ai/batchcraft-app/app.command"
```

The launcher runs one backend process and serves only the built `frontend/dist` directory at `/`.
FastAPI retains `/api` routes. There is no Vite development server or hot reload in this instance.
`app.local.json` contains `data_root`, `comfyui_base_url`, and an optional boolean `lan_access`, with no
shell expansion other than a leading `~` in the path. It must not be committed. Omitted `lan_access`
defaults to `false`, so existing configurations remain loopback-only. The frontend build uses the
browser's origin for API requests.

Installed frontend builds have no instance badge. Development and browser-test builds keep their
explicit environment labels so simulated ComfyUI remains distinguishable. The installer sets
`VITE_BATCHCRAFT_INSTANCE` to an empty string rather than inheriting a label from the shell.

### Trusted-LAN access

With a LAN-capable launcher, setting `"lan_access": true` in the installed `app.local.json` binds the
everyday app to `0.0.0.0:8000`, all IPv4 interfaces. From another device, open
`http://<this-Mac-LAN-IP>:8000`; local access at `http://127.0.0.1:8000` still works. The firewall may need
to allow inbound TCP port 8000. Set the option to `false` or omit it to restore loopback-only access.
Configuration changes require a backend restart; follow the shutdown and update process below before
changing a running installation.

Use this only on a trusted LAN. There is no authentication: anyone who can reach the app can read and
modify its data and start GPU Jobs. Do not port-forward it or expose it to the internet. This option adds
neither authentication nor wildcard CORS. The built frontend and API share one origin, so LAN access
needs no additional CORS origin. Unsaved working sessions do not transfer between devices or origins;
Saved Batches and Run history remain shared through the same backend.

Host checks accept loopback names and the actual local destination IP for LAN access. Use the literal
LAN IP above, not an arbitrary DNS alias or reverse proxy. Mutation Origin checks permit the validated
same origin and the configured development frontend, but do not authenticate clients. Isolated launchers
use a 64 MiB total request-body limit and a 10,000-Job new-plan limit; inherited environment values do not
change these defaults. New plans also use 1 MiB per resolved prompt and 32 MiB aggregate resolved text.
Real ComfyUI clients default to 8 MiB JSON/error bodies, 256 MiB artifact bodies, and 4 MiB WebSocket
messages; simulated clients perform no network requests. Direct-start environment knobs and exact byte
defaults are listed once in `API.md`; they are not additional `app.local.json` fields.
Body admission permits four in-flight bodies with a 120-second receive/spool
deadline. Bulk reads allow four active requests and eight waiters; execution polling has two active
slots and four separate waiters. Read queue waits expire after five seconds. Historical artifacts have
no new size cap: downloads verify into temporary disk snapshots and stream with bounded buffers.
Up to four such snapshots can coexist, with disk usage equal to their combined sizes and no active-stream
deadline. The ComfyUI HTTP timeout is inactivity-based, not an absolute transfer deadline. See `API.md`
and ADR 0015 for accounting, exclusions, error, and cleanup behavior.

Close the terminal with Ctrl+C only after active work has finished. Closing a browser tab does not stop
the backend. Stopping the backend does not interrupt the remote ComfyUI Job, and automatic executor
restart recovery is not implemented. Do not launch multiple backend processes against the same data.
The launchers deliberately ignore inherited `BATCHCRAFT_*` data and host overrides.

When a launcher is started in the background, its log includes `Started server process [PID]`. After
confirming no active Run needs to finish, send `kill -INT <PID>` to that specific backend process.
For development this also closes the Vite child. Avoid broad process-name kills, which could stop another
instance. The launchers do not register a login service or restart themselves automatically.

### Updating and backing up

Updates are deliberate, not automatic. Agree on a checked revision, verify it in the development/test
instances, stop the everyday backend after its active Run completes, and make a consistent backup of the
entire data root. It includes both SQLite and Projects. Copying only Project folders does not preserve
mutable libraries and Saved Batches; copying only SQLite does not preserve historical artifacts.

For an offline backup, keep SQLite sidecars with the database if present; do not delete `-wal` or `-shm`
files by hand. A live database backup needs SQLite's backup API plus a coordinated filesystem snapshot.
Test migration and restore against a separate copy, never the only copy of user data.

Do not merely switch to older code after migrating a database. A rollback may require restoring the
matching backed-up database and filesystem. Before a future revision tracks the initial bootstrap files,
reconcile those local copies against `installation.local.json`; do not force-checkout over them.
Installing a separate candidate checkout is also supported. No update command currently overwrites an
existing installation.

For a future existing-build update, follow the shutdown, backup, and revision checks above, then run
this in the installed checkout's `frontend/` directory before restarting:

```bash
VITE_BATCHCRAFT_API_URL=/ VITE_BATCHCRAFT_INSTANCE='' npm run build
```

The explicit `/` also selects same-origin requests in pinned older client code. Rebuilding the frontend
does not add LAN support to an older launcher; reconcile launcher files through the same deliberate
update process before enabling `lan_access`.

## Development sandbox

Install dependencies once:

```bash
uv sync --frozen --directory backend
npm ci --prefix frontend
```

From the repository root, run `./dev.command`. This starts FastAPI and Vite together; Ctrl+C stops both.
Plain `npm run dev` also defaults to the development origin and API, not the everyday backend.
The sandbox data persists between launches, but it is separate from the old `backend/data` directory and
all everyday data. No script resets or deletes that persistent sandbox.

Vite reloads frontend edits, but this launcher does not automatically reload the Python backend.
After backend/API or migration changes, wait for active Runs to finish, stop the development instance,
and restart `./dev.command`. Existing sandbox data is retained and forward migrations run normally.
If Gallery/Runs reports that the backend lacks its browsing API, restart the backend before refreshing
the view; reindexing cannot add missing API routes to an older running process.

With development running, optionally add a sample Project, Prompt, Workflow Profile, and Saved Batch:

```bash
uv run --directory backend python -m tools.seed_demo
```

Select Project `Sandbox`, then Saved Batch `Landscape comparison`. The seeder refuses to overwrite that
Project on a second invocation. It uses only port 8001 and verifies the fake-client status first. Its
sample workflow is illustrative, not a valid generation workflow for a live ComfyUI host.

The fake client uses the real compiler, workflow preparation, executor, SQLite, and filesystem store.
It produces synthetic PNG landscapes after a short delay. It never constructs a network client.
These text markers let developers inspect fault states:

- `[sandbox:slow]`: keep a submitted Job pending for 30 seconds.
- `[sandbox:reject]`: reject a submission definitively.
- `[sandbox:unknown]`: return an ambiguous submission outcome.

Live GPU tests remain separate, explicitly configured operations. The sandbox is not a ComfyUI protocol
simulator and does not prove real custom-node or model compatibility.

## Playwright

From `frontend/`:

```bash
npm run browser:install
npm run test:e2e
npm run test:e2e:headed
BATCHCRAFT_E2E_BUILT=1 npm run test:e2e
```

The built-frontend variant builds the frontend with same-origin API requests and serves it from the
fake-backed test process at `http://localhost:8002`, without Vite. It runs the same desktop/mobile
scenarios, including Result image decoding, and catches hardcoded loopback API addresses. Run it
separately from the Vite variant because they share test port 8002. Both use temporary data, not the
everyday installation.

The test runner starts its own frontend and backend and refuses to reuse an existing server on either
test port. Each backend launch allocates a fresh temporary database and Projects root and removes only
that owned temporary root on normal shutdown. Browser contexts are isolated; test Projects have unique
names. Tests run sequentially because one backend owns at most one active Run.

The smoke tests exercise the real HTTP boundary, Saved Batch loading, Preview, Run creation, execution,
actual image decoding, lightbox, cold-tab restoration, Stop-after-current cancellation, and historical
Batch reconstruction. They run in desktop Chromium and mobile-emulated Chromium. They do not replace
Safari testing, live ComfyUI checks, or the separate v1 cross-instance release gate.

Screenshots and failure traces go to ignored `frontend/test-results/`; the HTML report goes to ignored
`frontend/playwright-report/`. Open the latter with `npx playwright show-report`. CI runs the same tests
against a fake client and retains browser artifacts for seven days. Ordinary `npm test` still runs only
the fast Vitest suite.

### Interactive agent browser

An additional artifact-security browser regression uses the built frontend, real stored HTML/SVG/PNG
Results, and temporary fake-backed data on port 8002. After building the frontend and installing its
Playwright Chromium, run from `backend/`:

```bash
PYTHONPATH=. uv run python tests/api/check_artifact_browser.py
```

Run it separately from Playwright smoke tests because it uses the same test port. It refuses an occupied
port, verifies dangerous artifacts download without execution and PNG decodes, and removes its own
temporary data. This is not a live ComfyUI check.

The project `opencode.json` registers `batchcraft-browser`, using the locally installed, locked
`@playwright/mcp` package. Quit and restart OpenCode after changing its configuration; an existing session
does not gain new tools automatically.

Start `./dev.command`, then ask the agent to inspect `http://127.0.0.1:5174`. The MCP browser is headless
and isolated from personal browser profiles. It supports accessibility snapshots, interactions, and
screenshots. Its origin allowlist includes only development and test ports. This is an accidental-access
guardrail, not a security sandbox; agents must still never navigate the everyday app or generation host
without explicit authorization. Do not use the browser extension or attach a personal Chrome session.

`npm run browser:check` from `frontend/` verifies the stdio handshake, development-page navigation, and
screenshot capture without needing an OpenCode restart. Its screenshot is `.local/browser/mcp-smoke.png`.
The MCP package currently uses a different Chromium revision from Playwright Test; `browser:install`
installs both pinned browser revisions. Re-run it after updating either dependency.
