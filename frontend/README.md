# batchcraft frontend

The frontend is the first browser workflow for importing Reference Assets and binding them to named Image Inputs,
selecting and configuring a saved or new Saved Batch, previewing its compiled Jobs, creating durable
Runs, watching Job state, viewing the current Run's Results, and browsing filesystem-indexed Project
History. The frontend communicates only with the batchcraft FastAPI application.

The browser stores one strict working-session recovery v4 record under
`batchcraft.working-session-recovery.v4` in `localStorage`. It contains editable Batch intent, selected
Project and Saved Batch pointers, historical source Run identity, and current Run ID. The key and schema
remain v4. The deprecated wire field `session_run_ids` stays required and strictly validated: an array of
unique non-empty strings that includes `current_run_id` when non-null. Existing valid v4 records may
contain older Run IDs, but the reader does not restore or use that array. New writes store `[]` when
`current_run_id` is null and `[current_run_id]` otherwise. Explicit historical-to-copy resolution IDs make partial detached-resource imports
resumable after a refresh. Linked Workflow/Profile JSON is reconstructed by immutable version ID;
detached JSON remains draft state.
Unsupported or malformed records start a clean working session. Refreshing or reopening a tab restores
the draft and independently discovers any Run owned by the current backend process. Run and execution
state load before Results, and transient startup failures receive bounded retries. Draft identity never
by itself hides or erases a valid observed Run. Result metadata and bytes are never stored as browser
truth. Preview is never restored as valid; the user must compile the recovered
draft again. Older browser recovery formats are discarded rather than migrated.

The selected ProfileVersion defines zero or more ordered, named Image Inputs. Each slot selects one or
more ordered Base workflow and Reference Asset alternatives. Profile changes reconcile bindings by
stable slot key, preserve matching selections, add new slots as Base workflow, and remove bindings for
deleted slots. Missing Reference Assets remain visible and block Preview until repaired.

The selected ProfileVersion also defines ordered Parameters targeting literal workflow inputs. An
independent Parameter selects one or more ordered Base workflow or typed string, integer, float, or
boolean alternatives. Integer and float Parameters may instead preserve a decimal-text Range with
Start, End, Step, and independent Base inclusion. The backend materializes Range intent before the
existing compiler. Two or more Parameters may instead form a named Preset whose explicit rows each count
as one compiler alternative. Profile changes preserve same-key, same-type bindings and Presets; an
incompatible Preset dissolves to independent Base bindings. Every concrete Job still contains one scalar
or Base workflow choice per Parameter.

Preview and Result Details render every concrete Job slot and Parameter by its frozen label and resolved
value, plus selected Preset row provenance. Run Plan also shows all frozen Batch alternatives and Preset
rows. Each Image Input slot, independent Parameter, and Preset row axis multiplies Job count.

Generated image cards render at their intrinsic aspect ratio without a fixed preview frame. Reference
Asset cards retain a uniform contained thumbnail frame, so neither generated nor input images are
cropped. Thumbnail cards omit visible `Verified` badges and `Job` captions. The info button still opens
Result Details; accessible descriptions and lightbox labels retain Job/artifact identity. Integrity
validation, missing/corrupt-artifact placeholders, and image-load failure handling remain unchanged.
The current Results section shows the observed current Run, independently of editable draft identity.
Project History provides older Runs and their Results. There is no accumulated Batch Results section,
session gallery membership, or startup prefetch of historical IDs from browser recovery.

The Project selector lists active SQLite Projects and exposes compact create and adoption flows.
An owned v1 Project already copied directly under the configured Projects root can be imported by its
filesystem key. Ownerless-folder adoption remains a separate operation because it creates an owner
identity. The Project History section reads rebuildable backend projections, groups Runs by Batch, and
opens frozen Run Plan and Result Details without browser-held Run IDs or execution controls.
Project IDs and filesystem keys are not editable after selection. A saved draft reconnects only when
both values exactly match an active Project. Until that check succeeds, Prompt and Asset library
requests remain unscoped. Switching Project is unavailable while a Run is active and requires
confirmation when Project-scoped selections would be cleared.

The seed editor supports Fixed, Explicit list, and Random intent. Random accepts 1 through 100
repetitions per non-seed configuration. Backend Preview assigns one unique seed per final Job within
`0..2^53-1`. Run creation reuses that exact inspected request. A
successful Random Run creation consumes its Preview; a failed creation retains it for retry. Fixed
and Explicit Previews remain reusable for repeated Runs.

`Load Run as Batch` restores frozen editable intent with linked, detached, or conflicting historical
resources. Detached resources require explicit import or relinking before saving a Saved Batch.
A fresh Preview of restored Random intent generates fresh seeds, not historical assignments.
Exact Rerun is a separate operation deferred beyond v1.

The prompt editor selects from the current Project's persistent Prompt library and stores an ordered
list of exact PromptVersion snapshots. The working selection may be empty, but Preview requires at
least one PromptVersion. It supports logical Prompt creation and rename,
immutable version creation, lazy history, older active version selection, and explicit detached-state
warnings. Add, Remove, Move up, and Move down controls make the outermost Batch dimension explicit.
Preview identifies each Job's source PromptVersion. The Batch selection may be saved as a SQLite
Saved Batch or remain working-session state; the Prompt library is persistent.

The Workflow editor selects Project-scoped immutable WorkflowVersions and exact compatible
ProfileVersions. The visual Profile mapper keeps prompt, seed, and output-prefix mappings separate from
ordered named Image Inputs and typed generic Parameters. Both collections support add, remove, move,
editable labels, stable keys, and target repair. Parameter types are inferred from compatible literal
workflow values and may be string, integer, float, or boolean. The Batch editor leaves each unlinked
parameter with ordered Values or, for numeric types, a deterministic Range, and supports explicit
row-based Presets for linked parameters. The Parameters section uses the same
collapsible Edit/Done interaction as other configuration sections; collapsing changes no form state or
Preview validity. Parameter dimensions follow Image Input slots in Profile order and precede seeds; a
Preset appears at its earliest member's Profile position.
Selecting another WorkflowVersion clears an incompatible Profile selection and
blocks Preview until a compatible version is chosen. Library reconciliation never rewrites a restored
snapshot with different content; unavailable or integrity-mismatched pairs remain detached and are
validated by the backend during Preview. ComfyUI remains the workflow editor.

Closing a tab does not cancel or restart backend execution. On reopen, the current Run is fetched from
FastAPI with its execution and Results. Running state resumes the same polling loop used after a new Run
starts. Process-local active-Run discovery takes precedence over a different stored current pointer;
there is no session gallery to retain that other Run. Project History remains the way to browse older
Runs and works with empty browser storage. Draft mismatch, transient startup failure, or an empty
active-task discovery response does not erase a recoverable current pointer. Cancellation controls,
historical Run Plan/Result Details, and source-Run loading for detached-resource recovery remain intact.

## Requirements

- Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` for the locked dependencies; recommend Node 24.15+ in the 24.x line
- npm
- a reachable batchcraft API, normally local

## Local development

Prefer `./dev.command` from the repository root after dependency setup in
[`../docs/LOCAL_INSTANCES.md`](../docs/LOCAL_INSTANCES.md). It starts the isolated fake-backed API and
Vite together. The manual commands below start only Vite and require a separately running API.

Install the locked dependencies:

```bash
npm ci
```

The API client defaults to an empty base URL for same-origin requests, not a hardcoded port 8000.
The checked-in `.env.development` explicitly selects `http://127.0.0.1:8001` for development. The everyday
installer builds with `VITE_BATCHCRAFT_API_URL='/'`, which selects same-origin requests even in pinned
older client code. Prefer the isolated launchers; for an explicit manual override, create an ignored
`.env.development.local` file:

```text
VITE_BATCHCRAFT_API_URL=http://127.0.0.1:8001
```

Start Vite:

```bash
npm run dev
```

Vite serves `http://127.0.0.1:5174` and fails if that port is occupied. The development launcher configures
the matching API origin and port. When starting the API manually, set `BATCHCRAFT_SERVER_PORT=8001` and
`BATCHCRAFT_FRONTEND_ORIGIN=http://127.0.0.1:5174` explicitly.

Only the everyday app supports opt-in trusted-LAN access; development and test stay on loopback.
See [`../docs/LOCAL_INSTANCES.md`](../docs/LOCAL_INSTANCES.md) for `lan_access`, the unauthenticated-access
warning, firewall guidance, and the stopped-instance update process. For a future existing-build update,
run `VITE_BATCHCRAFT_API_URL=/ VITE_BATCHCRAFT_INSTANCE='' npm run build` in the installed
`frontend/` directory after following that process. Unsaved working sessions are separate across browser
origins and devices, even when they use the same backend.

Production builds have no instance badge; development/test labels remain visible. Session notifications
can be dismissed without changing draft or execution state. The restored-draft reminder also clears
after a successful current Preview, but not after a failed or obsolete response. Dismissal is not
persisted: a later cold load can show a new restoration notice and still requires a new Preview.

## Checks

Real-browser checks and interactive Playwright inspection are described in
[`../docs/LOCAL_INSTANCES.md`](../docs/LOCAL_INSTANCES.md). Run `npm run browser:install` once, then
`npm run test:e2e`. This starts isolated FastAPI/Vite instances with a fake ComfyUI client; it never
reuses the everyday or development servers. `npm test` remains the Vitest suite.

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Frontend tests mock the typed API client. They do not require FastAPI or ComfyUI.

## Current limits

- Browser working-session recovery is local to one browser profile and uses last-writer-wins behavior.
- Working-session recovery is not a Saved Batch; Saved Batch persistence lives in SQLite through the
  Saved Batch selector.
- Image import currently accepts PNG, JPEG, and WebP. Each Image Input has one or more ordered
  alternatives: Base workflow and Project Assets.
- Workflow snapshots can be edited as JSON. Workflow Profile mappings use the visual mapper. ComfyUI
  remains the workflow editor.
- Current Results covers the observed Run; Project History provides the durable Project-scoped view.
- The screen has no backend executor restart recovery, execution retry, rating, or Project-history filtering.
