# ADR 0008: Generic Workflow Parameters Pass 3B-1

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** ADR 0007's exactly-one parameter cardinality and non-dimensional parameter behavior; the prior browser session v11 and consolidated SQLite baseline; parameter-after-seed ordering in ADRs 0001 and 0002; and ADR 0006's four-axis compiler order.
- **Superseded in part by:** ADR 0009 for deterministic numeric Range intent, Batch snapshot v5, browser session v13, and the current SQLite baseline.

## Context

Pass 3A established typed Profile parameter definitions, one scalar or Base workflow value per Batch
binding, scalar-resolved Job provenance, and type-safe ComfyUI mutation. Its reserved `values` arrays
and normalized Saved Batch rows anticipated alternatives, but compilation deliberately treated each
parameter as fixed. Controlled experiments now need explicit parameter alternatives without adding
ranges, enums, random materialization, or coupled dimensions.

## Decision

Every Profile parameter has one Batch/API/Saved Batch binding:

```json
{"parameter_key":"cfg","values":[null,7.0,7.5]}
```

`values` contains one or more ordered, unique alternatives. Each alternative is JSON `null` or a scalar
that strictly matches the Profile's `string`, `integer`, `float`, or `boolean` type. Empty string, zero,
and false are concrete overrides. Numeric values must be finite. Integers must be within the signed
JavaScript-safe range. Exact duplicate validation distinguishes booleans from numbers; float parameters
use exact numeric equality. `null` means Base workflow and appears first when included.

Parameters are independent Cartesian dimensions in Profile order:

```text
PromptVersion -> prompt variables -> Image Input slots -> parameters -> seeds
```

The rightmost dimension varies fastest. Binding-record request order does not affect compilation;
Profile order does. Alternative order within each binding is preserved. A Profile with no parameters
contributes the multiplicative identity of one. Incremental `max_jobs` validation includes each
parameter axis before the product is materialized.

A Batch and frozen Batch snapshot preserve all alternatives. Every Compiled Job, manifest Job, executor
input, and Result provenance record preserves exactly one resolved scalar or Base state per Profile
parameter. The executor omits Base values and forwards only concrete scalar overrides to the existing
ComfyUI mutation boundary. Alternative arrays never reach execution.

Manifest v7, Batch snapshot v4, CSV shape, Run v1, and execution v2 remain current. Their existing
binding arrays and scalar Job records already represent this distinction. Browser working sessions use
v12 because frontend draft state now stores ordered discriminated alternatives. The consolidated
SQLite `0001` baseline now permits multiple positive value positions for each parameter binding.

## Consequences

- Generic parameters multiply prompt, Image Input, and seed dimensions deterministically.
- Run Plan can show frozen Batch alternatives while Preview, concrete Jobs, and Results show one resolved value.
- Existing Pass 3A development databases have unsupported migration history and must be inspected and recreated manually; batchcraft never deletes or rewrites them automatically.
- Browser v11 drafts reset automatically. Existing manifest v7 Runs and snapshot v4 data remain supported.
- Parameter values remain fully resolved before scheduling and ComfyUI submission.

## Deferred

Numeric ranges, range materialization, enums, `/object_info`, LoRA discovery, random parameter values,
zipped or linked parameters, and coupled dimensions remain deferred.
