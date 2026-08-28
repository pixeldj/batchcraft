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
- reference bindings;
- seed policy;
- exposed workflow parameter values;
- output naming configuration.

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
       +---- Reference dimensions
       +---- Seed dimensions
       +---- Workflow parameter dimensions
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

References:

```text
ref01.png
ref02.png
```

Seed:

```text
123456
```

Compilation produces six Jobs:

```text
001 cat   ref01  123456
002 cat   ref02  123456
003 dog   ref01  123456
004 dog   ref02  123456
005 bird  ref01  123456
006 bird  ref02  123456
```

## Deterministic Job Ordering

The compiler applies dimensions in this order:

```text
PromptVersion -> prompt variables -> reference bindings -> seeds -> parameter sweeps
```

PromptVersion is the first Batch dimension and preserves user selection order. Each PromptVersion is
templated independently and expands only the bindings it references, in placeholder first-occurrence
order. Reference bindings follow, then seeds, so the rightmost dimension varies fastest. User order is
preserved within every dimension.

The example above therefore varies the reference dimension fastest. This ordering must be covered by preview, compilation, manifest round-trip, and rerun tests.

## Job Count

The Batch Builder must calculate job count before a Run starts.

For independent dimensions:

```text
jobs =
sum(prompt-variable combinations for each PromptVersion)
× reference combinations
× seed values
× parameter sweep combinations
```

The UI should prominently display the resulting count.

Large job counts should produce a warning threshold rather than an arbitrary hard limit initially.

## Preview

Before execution, users should be able to preview at least:

- total Job count;
- source PromptVersion identity and name;
- resolved prompt;
- reference filename or thumbnail;
- seed;
- swept parameters.

The preview must use the same compiler logic as actual Run creation.

Do not maintain separate preview expansion logic that can disagree with execution.

## Seed Policy

Initial useful policies:

### Fixed Seed

Every applicable Job uses one chosen seed.

Useful for controlled comparisons.

### Explicit Seed List

A selected list of seeds becomes another Batch dimension.

A fixed seed input must contain exactly one seed. An explicit seed list must contain at least one seed, and compilation preserves its order.

The browser supports Random seed intent without adding randomness to the pure logical compiler. It uses Web Crypto to materialize 1 through 100 unsigned 32-bit seeds into an explicit ordered seed input before Preview. Run creation submits that exact inspected request, and successful Run publication persists the resolved values in Run provenance before execution begins.

## Reference Dimensions

The first version requires one exposed reference-image slot.

The data model should allow future Workflow Profiles with multiple reference slots, such as:

```text
identity_reference
outfit_reference
pose_reference
```

Each binding must define its selected assets and expansion behavior explicitly.

## Parameter Sweeps

Any exposed scalar workflow parameter may eventually become a Batch dimension.

Examples:

- CFG/guidance;
- steps;
- denoise;
- strength;
- model choice.

This should use the same compiler machinery as prompt variables and reference dimensions rather than separate ad hoc loops.

Parameter sweeps are not part of the v1 pure compiler milestone. The implemented v1 expansion order therefore ends with seeds while preserving the documented position for future parameter dimensions.

## Run Creation

Creating a Run should conceptually:

1. validate the Batch;
2. snapshot effective source data;
3. resolve prompt variants;
4. expand references, seeds, and parameter dimensions;
5. assign deterministic Job ordinals;
6. determine output naming;
7. publish the initial Run/manifest artifacts;
8. persist Run and Job index state;
9. mark the Run ready for scheduling.

A partially compiled Run should not be presented as a valid executable Run.

Run and Job IDs belong to later execution identity, not logical compilation.

Successful Run creation completes after the filesystem Run has been published and SQLite has indexed it. At that point the plan and provenance freeze, before scheduling begins. Execution status, timestamps, ComfyUI IDs, errors, and Results may then advance separately.

## Reproducibility

The compiler should be a pure or near-pure domain service wherever possible.

Given the same immutable input snapshot, it should produce the same ordered Job plan.

Exact rerun preserves generation inputs, base workflow, Workflow Profile mapping, references, variables, parameters, seeds, and ordering. It allocates new Run and Job IDs, timestamps, ComfyUI prompt IDs, and output namespace.

For multi-prompt Runs, generation inputs include the exact ordered PromptVersion snapshots and every
Job's PromptVersion association. Prompt resolution is single-pass; variable values never become nested
templates.

This is specification reproducibility, not a guarantee of byte-identical generated pixels across changes in the execution environment.

This logic should receive strong unit-test coverage because it is central to batchcraft's reliability.
