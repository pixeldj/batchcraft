# ADR 0006: Named Image Input Slots Pass 2B

- **Status:** Accepted
- **Date:** 2026-08-31
- **Supersedes:** ADR 0005's one-effective-value cardinality and non-dimensional Image Input behavior.
- **Superseded in part by:** ADR 0007 for current durable format versions and the added fixed-parameter contract.

## Context

Pass 2A established ordered Profile-defined Image Input slots, stable slot keys, Base workflow as
`null`, scalar-resolved Job inputs, and durable binding arrays reserved for later alternatives. It did
not define how multiple values across slots combine.

## Decision

Every Profile Image Input slot is an independent Cartesian Batch dimension containing one or more
ordered alternatives. Each alternative is a nonblank Reference Asset ID or `null` for Base workflow.
Exact duplicates, including repeated `null`, are invalid. When Base workflow is present it is first.
Using the same Asset in different slots remains valid.

Compiler dimensions are ordered:

```text
PromptVersion -> prompt variables -> Image Input slots in Profile order -> seeds
```

The rightmost dimension varies fastest. Binding-record order does not affect compilation; Profile slot
order does. Alternative order within each binding is preserved. A Profile with no Image Input slots
adds no dimension. When the existing `max_jobs` bound is supplied, its incremental
pre-materialization validation includes every Image Input axis.

A Batch and its frozen Batch snapshot preserve every alternative. A Compiled Job preserves exactly one
resolved `asset_id | null` per Profile slot. Alternative selection and Cartesian iteration never reach
the executor. For each concrete Job, the executor uploads and injects selected Assets and skips Base
workflow slots exactly as in Pass 2A.

Manifest v6, Batch snapshot v3, browser session v10, and the consolidated SQLite schema remain current.
Their existing array/table shapes already represent ordered multiple values, while concrete Job records
already represent scalar choices. Existing one-value data is a valid subset, so this change requires no
database or browser-state reset and no compatibility machinery.

## Consequences

- Each named Image Input can contribute independently to deterministic Job expansion.
- Base workflow can be compared directly with one or more selected Project Assets.
- Image dimensions multiply prompt-variable and seed dimensions and participate in the existing optional Job-count safety check.
- Run provenance distinguishes editable Batch alternatives from each Job's concrete resolved choices.
- The executor, queue, upload namespace, and Workflow Profile mutation interfaces remain scalar per slot.

## Deferred

This decision does not define zipped or row-linked slots, explicit asset pairing, random Asset choice,
Reference Collection links, folder iteration, upload caching, video/file inputs, or generic workflow
parameter sweeps.
