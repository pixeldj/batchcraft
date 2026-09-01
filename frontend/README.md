# batchcraft frontend

The frontend is the first browser workflow for importing Reference Assets and binding them to named Image Inputs,
selecting and configuring a saved or new Saved Batch, previewing its compiled Jobs, creating durable
Runs, watching Job state, viewing the current Run's Results, and reviewing accumulated Batch Results
from this browser working session. It communicates only with the batchcraft FastAPI application.

The current tab stores a versioned working draft, selected Project ID, current Run ID, and ordered
unique session Run IDs in `sessionStorage`. The current schema is version 12 and stores canonical
Variable Bindings, ordered Image Input bindings, and ordered Parameter alternatives plus the
`batch_snapshot` required by Preview and Run creation. Only a valid v12 session is restored;
unsupported or malformed data starts a clean working session. A refresh restores
the form and ordered prompt list, then reloads Run, execution, and Result data from FastAPI. Result metadata
and bytes are never stored as browser truth. Preview is never restored as valid; the user must compile
the restored draft again. Closing the tab or browser session may remove this working state.

The selected ProfileVersion defines zero or more ordered, named Image Inputs. Each slot selects one or
more ordered Base workflow and Reference Asset alternatives. Profile changes reconcile bindings by
stable slot key, preserve matching selections, add new slots as Base workflow, and remove bindings for
deleted slots. Missing Reference Assets remain visible and block Preview until repaired.

The selected ProfileVersion also defines ordered Parameters targeting literal workflow inputs. Each
Parameter independently selects one or more ordered Base workflow or typed string, integer, float, or
boolean alternatives. Profile changes reconcile these values by stable key and compatible declared
type. Each Parameter independently multiplies Job count, while every concrete Job contains one scalar
or Base workflow choice.

Preview and Result Details render every concrete Job slot and Parameter by its frozen label and resolved
value. Run Plan also shows all frozen Batch alternatives. Each slot and Parameter independently
multiplies Job count.

Generated image cards render at their intrinsic aspect ratio without a fixed preview frame. Reference
Asset cards retain a uniform contained thumbnail frame, so neither generated nor input images are
cropped. The current Results section shows the active Run. The separate Batch Results section
accumulates Runs for the current stable Project/Batch identity in session order and restores them once
from FastAPI after refresh. Run restoration requires the stored Run to match the selected Project and
Batch. Changing the Project resets Project-scoped PromptVersion and Image Input selections plus
the gallery; changing Batch identity resets the gallery. Prompt, image, seed, and display-name
edits retain it.

The Project selector lists active SQLite Projects and exposes compact create and adoption flows.
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
workflow values and may be string, integer, float, or boolean. The Batch editor leaves each parameter
with one or more ordered Base workflow or strict typed override alternatives. Parameter dimensions
follow Image Input slots in Profile order and precede seeds.
Selecting another WorkflowVersion clears an incompatible Profile selection and
blocks Preview until a compatible version is chosen. Library reconciliation never rewrites a restored
snapshot with different content; unavailable or integrity-mismatched pairs remain detached and are
validated by the backend during Preview. ComfyUI remains the workflow editor.

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

- Batch form state, current Run ID, and Batch gallery Run IDs live only in the browser session.
- Browser working-session restoration is not a saved Batch; Saved Batch persistence lives in
  SQLite through the Saved Batch selector.
- Image import currently accepts PNG, JPEG, and WebP. Each Image Input currently has exactly one
  one or more ordered alternatives: Base workflow and Project Assets.
- Workflow snapshots can be edited as JSON. Workflow Profile mappings use the visual mapper. ComfyUI
  remains the workflow editor.
- Batch Results are not a durable Project-wide gallery or Run-history browser.
- The screen has no Run recovery, cancellation, retry, rating, filtering, or historical Run browser.
