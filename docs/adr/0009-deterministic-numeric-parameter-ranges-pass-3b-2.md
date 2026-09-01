# ADR 0009: Deterministic Numeric Parameter Ranges Pass 3B-2

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** ADR 0008's explicit-values-only editable parameter contract, Batch snapshot v4, browser session v12, and prior consolidated SQLite baseline.

## Context

Pass 3B-1 made generic parameters deterministic Cartesian dimensions backed by ordered explicit typed
alternatives. Entering long numeric progressions manually is inconvenient, but teaching the compiler or
executor to understand ranges would violate the requirement that every Job be fully resolved before
scheduling. Binary floating-point addition would also make decimal progression unstable.

## Decision

Editable Batch, API, Saved Batch, and Batch snapshot parameter intent is discriminated:

```json
{"parameter_key":"cfg","mode":"values","values":[null,4,6]}
```

or, for `integer` and `float` parameters:

```json
{
  "parameter_key":"cfg",
  "mode":"range",
  "include_base":true,
  "range":{"start":"3.0","end":"7.0","step":"0.5"}
}
```

Saved Batches and frozen Batch snapshots preserve the active intent and exact decimal strings. One
backend domain materializer converts every binding to the existing explicit `ParameterBinding` before
`compile_batch()` is called. The frontend performs exact BigInt count-only validation for immediate UX
but never generates executable Range values.

The backend parses simple finite decimal strings into signed scaled integers. Count and progression use
integer arithmetic, not repeated binary floating-point addition. Float values are converted only after
the exact decimal text is reconstructed; every value must be finite and round-trip through the JSON
number representation without decimal loss. Integer parts and generated values must be integral and
within the signed JavaScript-safe range. Decimal fields are limited to 100 characters.

Start is always included. Progression continues while the next value does not pass End. End is included
only when reached exactly. Ascending ranges require positive Step; descending ranges require negative
Step; zero Step is invalid. Start equal to End produces one value for either Step direction, provided
Step is nonzero. A Range may produce at most 10,000 numeric values. Base workflow is prepended after
numeric materialization and does not participate in arithmetic.

Dimension order remains:

```text
PromptVersion -> prompt variables -> Image Input slots -> parameters -> seeds
```

Batch snapshot v5 stores the new intent. Browser session v13 stores active mode plus retained Values and
Range drafts. The consolidated SQLite `0001` baseline stores mode, Base inclusion, and decimal Range
text on each parameter binding; child value rows are used only by Values mode. Manifest v7, CSV, Run
v1, execution v2, Compiled Jobs, executor inputs, and Result provenance do not change.

The Batch Parameters section reuses `ConfigurationSection`. Collapse state is local component state;
collapsing neither changes editable intent nor invalidates Preview.

## Consequences

- Numeric progressions are convenient while deterministic compilation remains explicit and unchanged.
- No unresolved Range object or value list crosses the materialization boundary into compilation or execution.
- Decimal progressions such as `0 -> 1 by 0.1` cannot be generated as repeated binary-float additions.
- Saved Batches reopen in Range mode and Run Plan can show compact intent while each Job and Result shows its exact scalar.
- Existing development databases and snapshot-v4 Runs are unsupported and require manual inspection/recreation; browser v12 drafts reset automatically.

## Deferred

Logarithmic ranges, count mode, percentages, random sampling, linked or zipped parameters, dependent
parameters, expressions, enums, `/object_info`, LoRA discovery, and video/file inputs remain deferred.
Closed-tab recovery is a separate milestone covering recent Project/Saved Batch restoration, active and
recent Run identities, backend-authoritative reconstruction, and stale Preview avoidance.
