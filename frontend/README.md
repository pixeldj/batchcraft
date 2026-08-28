# batchcraft frontend

The frontend is the first browser workflow for configuring an ephemeral Batch, previewing its
compiled Jobs, creating a durable Run, starting execution, watching Job state, and viewing Results.
It communicates only with the batchcraft FastAPI application.

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

- Batch form state and the current Run ID live only in the browser session.
- The form accepts existing Project Asset IDs because the API has no asset import or listing
  endpoint yet.
- Workflow and Workflow Profile configuration use JSON textareas. ComfyUI remains the workflow
  editor.
- The screen has no Run recovery, cancellation, retry, rating, filtering, or historical Run
  browser.
