# batchcraft frontend

The frontend is the first browser workflow for importing Reference Assets and binding them to named Image Inputs,
selecting and configuring a saved or new Saved Batch, previewing its compiled Jobs, creating durable
Runs, watching Job state, viewing the current Run's Results, reviewing accumulated Batch Results from
this browser working session, and browsing filesystem-indexed Project history. It communicates only
with the batchcraft FastAPI application.

The browser stores one strict working-session recovery v2 record under
`batchcraft.working-session-recovery.v2` in `localStorage`. It contains editable Batch intent, selected
Project and Saved Batch pointers, current Run ID, and ordered unique session Run IDs. Linked
Workflow/Profile JSON is reconstructed by immutable version ID; detached JSON remains draft state.
Unsupported or malformed records start a clean working session. Refreshing or reopening a tab restores
the draft, then reloads Run, execution, and Result data from FastAPI. Result metadata and bytes are never
stored as browser truth. Preview is never restored as valid; the user must compile the recovered draft
again. Old sessionStorage v13 data is discarded rather than migrated.

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
cropped. The current Results section shows the active Run. The separate Batch Results section
accumulates Runs for the current stable Project/Batch identity in session order and restores them once
from FastAPI after refresh. Run restoration requires the stored Run to match the selected Project and
Batch. Changing the Project resets Project-scoped PromptVersion and Image Input selections plus
the gallery; changing Batch identity resets the gallery. Prompt, image, seed, and display-name
edits retain it.

The Project selector lists active SQLite Projects and exposes compact create and adoption flows.
An owned v1 Project already copied directly under the configured Projects root can be imported by its
filesystem key. Ownerless-folder adoption remains a separate operation because it creates an owner
identity. The Project History section reads rebuildable backend projections, groups Runs by Batch, and
opens frozen Run Plan and Result Details without browser-held Run IDs or execution controls.
Project IDs and filesystem keys are not editable after selection. A saved draft reconnects only when
both values exactly match an active Project. Until that check succeeds, Prompt and Asset library
requests remain unscoped. Switching Project is unavailable while a Run is active and requires
confirmation when Project-scoped selections would be cleared.

The seed editor supports Fixed, Explicit list, and frontend-only Random intent. Random accepts a count
from 1 through 100 and uses Web Crypto to materialize unsigned 32-bit values into the backend's
explicit seed contract when Preview runs. Run creation reuses that exact inspected request. A
successful Random Run creation consumes its Preview; a failed creation retains it for retry. Fixed
and Explicit Previews remain reusable for repeated Runs.

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
starts. The ordered stored Run IDs rebuild only the prior working-session gallery; they do not query or
control Project history. Project history is loaded independently for the selected Project and works
with empty browser storage.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- npm
- the batchcraft API running locally

## Local development

Install the locked dependencies:

```bash
npm install
```

The frontend defaults to `http://127.0.0.1:8000`. To use another API address, create an ignored
`.env.local` file:

```text
VITE_BATCHCRAFT_API_URL=http://127.0.0.1:8000
```

Start Vite:

```bash
npm run dev
```

Vite serves `http://localhost:5173`, which matches the backend's default
`BATCHCRAFT_FRONTEND_ORIGIN` setting. If the Vite origin changes, configure the backend origin to
match it.

## Checks

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
- Batch Results remain a browser-session gallery; the separate Project History section provides the
  durable Project-scoped view.
- The screen has no backend executor restart recovery, retry, rating, or Project-history filtering.
