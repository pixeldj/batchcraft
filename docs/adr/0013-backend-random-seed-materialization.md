# ADR 0013: Backend Random Seed Materialization

- **Status:** Accepted
- **Date:** 2026-09-03
- **Supersedes:** ADR 0003's frontend Random materialization latitude and ADR 0012's first-Preview reuse of historical Random seeds.

## Context

Random x N is repetition intent per non-seed configuration. Materializing only N values in the browser
and treating them as an Explicit dimension reused those values across configurations, so a multi-axis
Batch did not receive a distinct Random seed for every concrete Job.

The backend already owns authoritative Range materialization, Batch expansion, Job-count validation, and
Run publication. The pure compiler must remain deterministic, and a Run must use the exact concrete plan
inspected in Preview.

## Decision

The frontend sends Preview editable Random intent as
`{ "mode": "random", "values": [], "random_seed_count": N }`. The backend performs a seed-neutral
compile to determine the complete non-seed expansion and final Job count. It then materializes one unique
seed per final Job with `secrets.randbelow(2^53)`, retries collisions, and passes the ordered assignments
to the pure compiler through an internal materialized-Random representation.

Random repetitions are the fastest-varying dimension. Fixed continues to repeat one configured seed for
every non-seed configuration. Explicit continues to repeat its configured ordered list for every non-seed
configuration.

Preview returns every concrete Job seed. The frontend retains those assignments in the inspected request
used for Run creation and retries. Run creation requires materialized, unique, correctly sized Random
assignments but does not issue or verify a Preview token; exact reuse is the same client protocol invariant
that ties all editable inputs to the inspected Preview. After successful publication, a later Preview
generates a fresh set.

Saved Batches, Batch snapshots, historical reconstruction, and browser recovery preserve only Random
count intent. Immutable Run Jobs and Result provenance preserve the exact concrete seed per Job. Loading a
historical Run as a Batch restores Random count intent and generates fresh seeds on Preview; exact replay
remains a separate operation over frozen concrete provenance, deferred beyond v1.

## Consequences

- The pure compiler and executor contain no random decisions.
- Every new Random materialization is unique within its own final Job set.
- Preview and Run publication use identical concrete assignments, including publication retries.
- Existing valid v1 manifests and SQLite schemas do not change.
- Existing historical Runs remain readable, including Runs whose older Random implementation repeated
  seeds across configurations.
