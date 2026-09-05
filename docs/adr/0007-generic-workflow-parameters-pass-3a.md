# ADR 0007: Generic Workflow Parameters Pass 3A

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** The deferred fixed-parameter contract and the manifest v6, Batch snapshot v3, browser session v10, and prior consolidated SQLite baseline.
- **Superseded in part by:** ADR 0008 for multi-alternative parameter dimensions and ADR 0009 for the current snapshot, browser, and SQLite baselines.

## Context

Current persistence versions and forward-only user-database policy supersede the historical baseline
replacement below; see `../FILE_FORMAT.md` and `../DEVELOPMENT.md#persistence-policy`.

Workflow Profiles could expose prompts, seeds, output prefixes, and named Image Input slots, but normal
scalar workflow inputs such as CFG, steps, denoise, duration, and LoRA settings remained fixed inside the
base workflow. Parameter sweeps are a separate decision because they affect Job counts and ordering.

## Decision

Each ProfileVersion contains a required ordered `parameters` array. Entries have stable `key`, editable
`label`, exact `node_id` and `input_name`, and `value_type`. Supported types are `string`, `integer`,
`float`, and `boolean`. Keys use the same lowercase ASCII stable-key rules as Image Input slots. Every
target must be a compatible literal workflow input. One uniqueness check covers core mappings, Image
Input slots, and parameters.

Batch/API/Saved Batch intent stores one binding per Profile parameter:

```json
{"parameter_key":"cfg","values":[7.5]}
```

Pass 3A requires exactly one value. JSON `null` means Base workflow and leaves the mapped input
unchanged. Empty string, zero, and false are concrete overrides. Integers are signed JavaScript-safe
integers. Floats are finite JSON numbers and may receive integer numeric values. Values are never
coerced across string, boolean, and numeric types.

Fixed parameters are not compiler dimensions. Every Compiled Job receives one ordered
`resolved_parameters` entry per Profile parameter. The executor forwards only concrete scalar overrides;
Base entries never reach workflow mutation. The ComfyUI adapter validates keys and types against the
frozen Profile and assigns native JSON scalars on a deep copy of the base workflow.

Published Runs use manifest v7 with Batch snapshot v4. The CSV adds
`resolved_parameters_json`. Browser working sessions use v11. The consolidated SQLite `0001` baseline
adds normalized ordered Saved Batch parameter bindings. `run.json` v1, `execution.json` v2, asset v1,
and owner formats do not change.

## Consequences

- Profile-defined scalar controls work for core and custom nodes without class-specific behavior.
- Run provenance freezes both parameter definitions and each Job's exact typed value or Base state.
- Existing development databases, manifest v6 Runs, snapshot v3 data, and browser v10 drafts are
  unsupported. The application never deletes or rewrites them automatically.
- Development databases must be inspected and recreated manually. Browser drafts reset automatically.
- Parameter values are fully resolved before execution begins.

## Deferred

Pass 3B must define parameter lists, Cartesian ordering, duplicate handling, ranges, deterministic range
materialization, and Job-count effects together. Enums, `/object_info`, LoRA discovery, random values,
zipped parameters, and linked parameters remain deferred.
