# ADR 0004: Pre-release Persistence Baselines

- **Status:** Accepted
- **Date:** 2026-08-31
- **Supersedes:** Compatibility requirements in ADR 0002 and ADR 0003 for superseded development formats.
- **Superseded in part by:** ADR 0005 for named Image Input persistence and ADR 0007 for manifest v7, Batch snapshot v4, browser session v11, the replacement SQLite baseline, and typed fixed parameters.

## Context

batchcraft is under active local development and has not released a persistence compatibility
contract. Several short-lived representations accumulated while the compiler, Run store, execution
state, frontend session, and SQLite-backed Saved Batches were built. Reading each development format
required production parsers, request adapters, migrations, and tests that no current workflow needed.

Removing those paths must not remove the version boundaries needed for future changes or weaken Run
immutability, filesystem authority, deterministic compilation, or execution safety.

## Decision

Unless a task names a concrete compatibility requirement, batchcraft supports one current baseline:

- SQLite starts from the consolidated `0001_initial.sql` schema. The migration runner and
  `schema_migration` history remain for future changes.
- Variable Bindings use `{ "placeholder": string, "values": string[] }` in the domain, API, Saved
  Batch rows, Run snapshots, and browser session. They retain no Variable List identity or binding mode.
- Published Runs use manifest v5 with a required batch snapshot at `snapshot_version: 2`.
- Mutable execution state uses format v2.
- Browser working sessions use schema v9.

Superseded development databases, manifest v1-v4, snapshot v1, execution v1, browser session v1-v8,
and fixed/all Variable Binding payloads are unsupported. Readers reject them rather than normalize or
partially reconstruct them. Unsupported browser state falls back to a clean working session.

All durable formats keep explicit version fields. Unsupported local data fails closed; the application
does not silently delete, rewrite, or upgrade a database or Run directory. A developer may reset local
development state manually after inspecting what will be removed.

A future released format or external consumer may justify an explicit migration or compatibility
reader. That work requires a concrete use case, tests, and an updated decision rather than speculative
adapters in advance.

## Consequences

Production code and tests describe the format batchcraft writes now. Invalid current data and
unsupported versions remain distinct errors. Fresh databases, Runs, and browser sessions exercise the
same representations used in normal development.

Existing local development data from superseded formats may no longer open. This is an accepted
pre-release cost, but automatic data deletion remains prohibited.

Historical ADR text remains unchanged as a record of the decisions in force when it was written. This
ADR replaces only their old-format readability and Variable Binding source-revision requirements.

## Alternatives Considered

### Preserve every development format

Rejected because no released data or external consumer requires it, while every old shape expands the
production parser and test matrix.

### Remove version and migration infrastructure

Rejected because explicit versions, fail-closed validation, and ordered migrations are the mechanisms
needed when compatibility becomes a real requirement.
