# ADR 0010: Durable Working Session Recovery

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** Tab-scoped browser session v13 and the closed-tab recovery deferral in ADR 0009.

## Context

Browser session v13 stored editable Batch intent and Run identity pointers in `sessionStorage`. Refresh
could reconstruct Run state, but closing the tab deleted the pointers and draft. Backend execution did
not stop; the browser simply lost the identities needed to observe it again.

Browser state must not become execution authority. Preview validity, execution state, Job state,
Results, frozen provenance, and materialized Random seeds already have stronger backend or in-memory
owners.

## Decision

The frontend writes one strict record under `batchcraft.working-session-recovery.v1` in `localStorage`:

```json
{
  "format_version": 1,
  "updated_at": "2026-09-01T12:00:00.000Z",
  "draft": {},
  "current_run_id": "run-123",
  "session_run_ids": ["run-120", "run-123"],
  "selected_project_id": "project-1",
  "selected_saved_batch_id": "batch-1",
  "saved_batch_base_revision": 4
}
```

`draft` stores editable Batch intent, including inactive Parameter drafts and exact numeric Range text.
Linked Workflow and Profile JSON snapshots are omitted and reconstructed from their stable version IDs.
Detached snapshots without stable version pointers remain editable draft data and are stored.

The record stores no Preview request or response, concrete Random Preview seeds, execution response,
Result metadata or bytes, frozen Run response, polling state, or status cache. Every cold load starts
with Preview invalid. The frontend verifies Project and Saved Batch identities, reconstructs linked
snapshots, then fetches each known Run and its Results from FastAPI. The current Run also fetches current
execution state. A running response enters the same polling hook used by newly started Runs.

Run restoration checks stable Project and Batch IDs plus both filesystem keys from the frozen Batch
snapshot. Missing or mismatched pointers are pruned independently. One bad historical pointer does not
block the rest of the gallery.

Writes are synchronous after meaningful state changes. Successful Run creation also writes the new Run
pointer before continuing with frozen-plan loading. A `pagehide` handler performs a final best-effort
write. Storage errors never block the live application.

Recovery v1 does not migrate or read browser session v13. Invalid, corrupt, or unsupported records fail
closed to normal defaults. Last writer wins; multi-tab coordination is deferred.

## Consequences

- Closing a tab no longer loses the current draft, Run pointer, or working-session gallery membership.
- Closing a tab does not cancel or restart backend execution.
- Runtime and Result truth remains backend-owned and is fetched after recovery.
- Unsaved edits over a Saved Batch remain the working draft while the backend revision supplies the dirty baseline.
- No backend API, SQLite, Run, execution, manifest, or Batch snapshot format changes are required.

## Deferred

Project-wide Run history, backend executor restart recovery, create-Run publication reconciliation,
cross-device synchronization, multi-user sessions, and multi-tab conflict handling remain separate work.
