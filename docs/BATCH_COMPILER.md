# Batch Compiler

## Purpose

The Batch Compiler converts an editable Batch definition into the explicit logical Job plan used to create a frozen Run.

It is the core reproducibility boundary in batchcraft.

## Logical Compilation Boundary

The production compiler performs only logical compilation:

```text
BatchDefinition -> CompiledRunPlan
```

The plan contains ordered, fully resolved Jobs with one-based ordinals. It does not allocate Run IDs, Job IDs, timestamps, output paths, or other execution identity. A later Run creation service will add those fields without changing the compiled plan.

## Inputs

A Batch may provide:

- Workflow Profile;
- an ordered, non-empty collection of PromptVersions;
- VariableBindings;
- ordered named Image Input bindings;
- ordered independent parameter bindings and Linked Parameter Sets;
- seed policy.

Output naming is not editable Batch intent. Run creation allocates each Job identity and freezes the
concrete `batchcraft/<run-id>/<job-id>/result` prefix after compilation.

## Compilation Pipeline

```text
Ordered PromptVersions
       +
Variable Bindings
       |
       v
Prompt Resolver
       |
       v
Resolved Prompt Variants
       |
       +---- Named Image Input dimensions
       +---- Generic parameter dimensions
       +---- Seed dimensions
       |
       v
Expansion
       |
       v
Explicit Job list
       |
       v
Run with frozen plan
```

## Fundamental Rule

The output of compilation is explicit.

A Job must not rely on:

- "next image in folder";
- unresolved `{{variable}}` placeholders;
- random selection that occurs later;
- mutable UI state;
- current contents of a Prompt library item;
- a self-requeueing ComfyUI node.

Anything necessary to understand what should execute must be resolved or snapshotted at Run creation.

Each PromptVersion produces one resolved prompt string per prompt-variable combination. Every Job maps
that one final string to the existing friendly workflow prompt input. Workflows with multiple exposed
prompt or text slots are deferred.

## Example

Prompt:

```text
A {{animal}} in a park.
```

Variable binding:

```text
animal = [cat, dog, bird]
```

The canonical binding is `{placeholder: string, values: string[]}`. Zero values are valid mutable
draft intent but fail compilation when the placeholder is used. One value contributes an identity
dimension, while multiple ordered values contribute a Cartesian dimension. The compiler has no
`all`, `fixed`, or Variable List source semantics. An empty string is a concrete value and inserts no
text; it is not a zero-value binding. Exact duplicate values, including duplicate empty strings, fail
compilation.

An unlinked parameter contributes its normal Values or materialized Range axis. A Linked Parameter Set
contributes one ordered row axis at its earliest member's Profile position; later members are skipped.
Request ordering of linked sets does not affect this insertion rule.

Named Image Inputs:

```text
Identity = ref01.png
Pose     = Base workflow
```

Seed:

```text
123456
```

Compilation produces three Jobs:

```text
001 cat   Identity=ref01  Pose=Base workflow  123456
002 dog   Identity=ref01  Pose=Base workflow  123456
003 bird  Identity=ref01  Pose=Base workflow  123456
```

## Deterministic Job Ordering

The compiler applies dimensions in this order:

```text
PromptVersion -> prompt variables -> Image Input slots -> parameters -> seeds
```

PromptVersion is the first Batch dimension and preserves user selection order. Each PromptVersion is
templated independently and expands only the bindings it references, in placeholder first-occurrence
order. Profile Image Input slots follow in Profile order, then generic parameters in Profile order,
then seeds. The rightmost dimension varies fastest, so seeds vary fastest. User order is preserved
within every dimension. Each resulting Job contains one resolved Image Input value per slot and one
resolved scalar or Base workflow value per parameter. Binding-record request order does not affect
compilation.

This ordering must be covered by preview, compilation, manifest round-trip, and rerun tests.

## Job Count

The Batch Builder must calculate job count before a Run starts.

For independent dimensions:

```text
jobs =
sum(prompt-variable combinations for each PromptVersion)
× product(Image Input alternatives per Profile slot)
× product(independent parameter alternatives and linked-set row counts)
× seed values
```

A Profile may define zero Image Input slots, which contributes a multiplicative identity of one. Every
defined slot supplies at least one ordered alternative: a Reference Asset ID or `null` for Base workflow.
A Profile may likewise define zero generic parameters. Every defined parameter supplies at least one
ordered typed scalar or `null` alternative after editable intent has been materialized.

The UI should prominently display the resulting count.

Large job counts should produce a warning threshold rather than an arbitrary hard limit initially.

## Preview

Before execution, users should be able to preview at least:

- total Job count;
- source PromptVersion identity and name;
- resolved prompt;
- every named Image Input label and its selected filename or the mapped value retained by a Base workflow choice;
- seed;
- resolved parameters or the mapped value retained by a Base workflow choice.

The preview must use the same compiler logic as actual Run creation.

Base values are read locally from the exact Workflow and Workflow Profile used by the Preview request.
Historical Run Plan and Result views read them from frozen Run provenance instead of current library
versions. Missing, null, connected, or type-incompatible mapped inputs are shown as unavailable rather
than guessed. This display does not change the compiler meaning of Base workflow: no override is emitted.

Do not maintain separate preview expansion logic that can disagree with execution.

## Seed Policy

Initial useful policies:

### Fixed Seed

Every applicable Job uses one chosen seed.

Useful for controlled comparisons.

### Explicit Seed List

A selected list of seeds becomes another Batch dimension.

A fixed seed input must contain exactly one seed. An explicit seed list must contain at least one seed,
and compilation preserves its order. Both modes reuse their configured values for every non-seed
configuration.

Random x N means N fastest-varying repetitions for every ordered non-seed configuration. The backend
Preview boundary determines the final Job count and materializes one unique concrete seed per Job within
`0..2^53-1`. It then passes those ordered assignments to the pure logical compiler; the compiler performs
no randomness. The frontend submits the exact materialized assignments returned by Preview; Run creation
rejects unmaterialized or incorrectly sized Random assignments. Successful publication persists each Job
seed in immutable Run provenance before execution begins.

## Named Image Input Slots

A ProfileVersion defines zero or more ordered image slots, such as:

```text
identity_reference
outfit_reference
pose_reference
```

Each entry has `{key, label, node_id, input_name}`. Keys use readable lowercase ASCII snake case,
start with a letter, and are unique. A Batch provides one
`{slot_key, values:[asset_id|null]}` binding per Profile slot. Binding-record request order does not
affect compilation; the compiler always uses Profile slot order.

`values` contains one or more ordered, unique alternatives. Each Profile slot is an independent
Cartesian dimension. Exact duplicate Assets and duplicate Base values are invalid; the same Asset may
appear in different slots. When included, Base workflow appears first. The compiler emits each Job's
ordered `resolved_image_inputs` with one `{slot_key, asset_id}` choice per slot. `asset_id: null` means
Base workflow and requires no upload or workflow mutation. Zipped, row-linked, and collection-link
semantics remain unsupported.

## Generic Parameter Dimensions

Every exposed scalar workflow parameter is covered exactly once by either an independent binding or one
Linked Parameter Set.

Examples:

- CFG/guidance;
- steps;
- denoise;
- strength;
- duration.

Each Profile parameter has either an explicit
`{parameter_key, mode:"values", values:[scalar|null,...]}` binding or, for `integer` and `float`, a
`{parameter_key, mode:"range", include_base, range:{start,end,step}}` binding. Range fields remain
decimal strings in editable intent. One backend materializer parses them into scaled integers, computes
the exact progression without repeated binary floating-point addition, and emits ordinary finite JSON
numbers. It rejects wrong direction, zero step, fractional integer parts, unsafe integers, decimal values
that cannot round-trip through JSON without precision loss, and ranges over 10,000 numeric values.

Start is always included. Progression stops before the next value would pass End; End is included only
when reached exactly. Descending ranges require a negative Step. Start equal to End produces one value
for any nonzero Step. Base workflow is prepended after numeric materialization and never participates in
arithmetic. Explicit values retain Pass 3B-1 ordering, type, duplicate, and Base-first validation.

Independent parameters expand in Profile order before seeds. Linked sets contain explicit scalar/Base
rows only. One row assigns every member and counts once, so three Width/Height rows produce three
variants rather than nine combinations. The compiler emits complete scalar `resolved_parameters` in
Profile order plus selected-row provenance. A Profile with no parameters contributes the multiplicative
identity of one. The compiler does not parse or calculate ranges. Enums, random values, Range cells,
linked Image Inputs, and dependent expressions remain deferred.

## Run Creation

Creating a Run should conceptually:

1. validate the Batch;
2. snapshot effective source data;
3. resolve prompt variants;
4. materialize editable parameter Range intent into explicit values;
5. expand named Image Input, independent parameter, linked row, and seed dimensions;
6. assign deterministic Job ordinals;
7. determine output naming;
8. publish the initial Run/manifest artifacts;
9. refresh rebuildable historical projections;
10. admit the published Run for scheduling.

A partially compiled Run should not be presented as a valid executable Run.

Run and Job IDs belong to later execution identity, not logical compilation.

Successful Run creation completes after the filesystem Run has been published. At that point the plan
and provenance freeze, before scheduling begins. SQLite historical projections are written only after
filesystem publication. They are rebuildable and a refresh failure cannot make the published Run
invalid. Execution status, timestamps, ComfyUI IDs, errors, and Results may then advance separately.

## Reproducibility

The compiler should be a pure or near-pure domain service wherever possible.

Given the same immutable input snapshot, it should produce the same ordered Job plan.

Exact rerun preserves generation inputs, base workflow, Workflow Profile mappings and named image
slots, selected Reference Assets, variables, parameters, seeds, and ordering. It allocates new Run and
Job IDs, timestamps, ComfyUI prompt IDs, and output namespace.

For multi-prompt Runs, generation inputs include the exact ordered PromptVersion snapshots and every
Job's PromptVersion association. Prompt resolution is single-pass; variable values never become nested
templates.

This is specification reproducibility, not a guarantee of byte-identical generated pixels across changes in the execution environment.

This logic should receive strong unit-test coverage because it is central to batchcraft's reliability.
