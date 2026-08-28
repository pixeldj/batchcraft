# batchcraft frontend

The frontend is the first browser workflow for importing and ordering Project Reference Assets,
configuring an ephemeral Batch, previewing its compiled Jobs, creating durable Runs, watching Job
state, viewing the current Run's Results, and reviewing accumulated Batch Results from this browser
working session. It communicates only with the batchcraft FastAPI application.

The current tab stores a versioned working draft, current Run ID, and ordered unique session Run IDs
in `sessionStorage`. Version 3 safely migrates version-1 and version-2 state, retaining existing Run
IDs and defaulting the new Random seed count. A refresh restores the form, then reloads Run,
execution, and Result data from FastAPI. Result metadata
and bytes are never stored as browser truth. Preview is never restored as valid; the user must compile
the restored draft again. Closing the tab or browser session may remove this working state.

The Reference Asset picker is expanded when no references are selected and collapsed by default for
a restored selection. The collapsed summary shows only the selected count. Select All preserves the
existing selection order and appends unselected Project assets in deterministic display order; Select
None clears the selection. Both operations invalidate Preview.

Generated image cards render at their intrinsic aspect ratio without a fixed preview frame. Reference
Asset cards retain a uniform contained thumbnail frame, so neither generated nor reference images are
cropped. The current Results section shows the active Run. The separate Batch Results section
accumulates Runs for the current stable Project/Batch identity in session order and restores them once
from FastAPI after refresh. Changing the Project or Batch ID/filesystem key resets that gallery;
prompt, reference, seed, and display-name edits retain it.

The seed editor supports Fixed, Explicit list, and frontend-only Random intent. Random accepts a count
from 1 through 100 and uses Web Crypto to materialize unsigned 32-bit values into the backend's
explicit seed contract when Preview runs. Run creation reuses that exact inspected request. A
successful Random Run creation consumes its Preview; a failed creation retains it for retry. Fixed
and Explicit Previews remain reusable for repeated Runs.

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
- Browser working-session restoration is not a saved Batch and is not durable application state.
- Reference image import currently accepts PNG, JPEG, and WebP. Selection order controls Reference
  Asset expansion order in the compiled Batch.
- Workflow and Workflow Profile configuration use JSON textareas. ComfyUI remains the workflow
  editor.
- Batch Results are not a durable Project-wide gallery or Run-history browser.
- The screen has no Run recovery, cancellation, retry, rating, filtering, or historical Run browser.
